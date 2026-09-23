import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { storeFile, fileInfo } from './files.js';
import { PROVIDERS, CLAUDE_CODE_MODELS, describeProviders, adapterFor, isChat, normalizeProvider, claudeCode as cc } from './providers/index.js';
import { parseSpec, createChain, patchJob, deleteJob, listJobs, BadRequest, ACTIVE_STATUSES } from './jobs.js';
import { parseImport, describeImport, commitImport, disposeImport } from './importers.js';
import { fromConversation, fromSession, toMarkdown, toJson, writeMarkdownZip, slug } from './exporters.js';

export const API_VERSION = 'v1';
const INLINE = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|application\/pdf)$/;
const MODEL_TTL = 10 * 60 * 1000;
const IMPORT_TTL = 30 * 60 * 1000;
const truthy = v => ['1', 'true', 'yes'].includes(String(v).toLowerCase());
const attachmentName = name => `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApiRouter(ctx) {
  const { store, scheduler, events, settings, dataDir, version, readiness } = ctx;
  const router = express.Router();
  const upload = multer({ dest: path.join(dataDir, 'tmp'), limits: { fileSize: 1024 * 1024 * 1024, files: 20 } });
  const importUpload = multer({ dest: path.join(dataDir, 'tmp'), limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 50 } });
  const modelCache = new Map(); // provider -> { key, at, models }
  const imports = new Map();    // import id -> { parsed, expires }

  const conv = id => {
    const c = store.data.conversations[id];
    if (!c) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    return c;
  };
  const job = id => {
    const j = store.data.jobs[id];
    if (!j) throw Object.assign(new Error('Message not found.'), { status: 404 });
    return j;
  };
  const convSummary = c => ({
    id: c.id, provider: normalizeProvider(c.provider), title: c.title, model: c.model,
    system: c.system, messageCount: c.messages.length, createdAt: c.createdAt, updatedAt: c.updatedAt,
    source: c.source ? { kind: c.source.kind, importedAt: c.source.importedAt } : undefined,
  });

  // ---------- service ----------
  router.get('/ping', (req, res) => res.json({ ok: true, name: 'nightshift', version, api: API_VERSION, now: Date.now() }));

  router.get('/providers', wrap(async (req, res) => {
    const s = settings();
    const probes = readiness ? await readiness.refresh({ maxAgeMs: 30000 }) : {};
    res.json(describeProviders(s, probes).map(p => ({
      ...p,
      limit: store.data.limits[p.id] || { limitedUntil: null },
      queued: Object.values(store.data.jobs).filter(j => j.provider === p.id && ACTIVE_STATUSES.has(j.status)).length,
    })));
  }));

  // Model lists are cached for a few minutes; ?refresh=true asks the provider again.
  router.get('/models', wrap(async (req, res) => {
    const provider = normalizeProvider(String(req.query.provider || 'anthropic'));
    if (provider === 'claude-code') return res.json(CLAUDE_CODE_MODELS);
    const adapter = adapterFor(provider);
    if (!adapter) throw new BadRequest(`Unknown provider "${provider}".`);
    const conf = settings().providers[provider];
    if (!conf?.key && !adapter.keyOptional) return res.json([]);
    const cacheKey = `${conf.baseUrl}|${conf.key || ''}`;
    const hit = modelCache.get(provider);
    if (hit && hit.key === cacheKey && Date.now() - hit.at < MODEL_TTL && !truthy(req.query.refresh)) {
      res.set('X-Models-Cached-At', String(hit.at));
      return res.json(hit.models);
    }
    let models;
    try {
      models = await adapter.listModels(conf);
    } catch (e) {
      if (hit?.key === cacheKey) { res.set('X-Models-Stale', '1'); return res.json(hit.models); }
      const msg = e.name === 'TimeoutError' || e.cause ? `Couldn't reach ${adapter.label} at ${conf.baseUrl}.` : e.message;
      return res.status(502).json({ error: msg });
    }
    modelCache.set(provider, { key: cacheKey, at: Date.now(), models });
    res.json(models);
  }));

  router.post('/limits/:provider/clear', (req, res) => {
    const provider = normalizeProvider(req.params.provider);
    if (!PROVIDERS[provider]) throw new BadRequest('Unknown provider.');
    scheduler.setLimit(provider, null);
    for (const j of Object.values(store.data.jobs)) {
      if (j.provider === provider && j.status === 'waiting_limit') scheduler.update(j, { status: 'scheduled', nextAttemptAt: Date.now(), force: true });
    }
    scheduler.kick();
    res.json({ ok: true });
  });

  // ---------- conversations ----------
  router.get('/conversations', (req, res) => {
    const provider = req.query.provider ? normalizeProvider(String(req.query.provider)) : null;
    res.json(Object.values(store.data.conversations)
      .filter(c => !provider || normalizeProvider(c.provider) === provider)
      .map(convSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt));
  });

  router.post('/conversations', (req, res) => {
    const provider = normalizeProvider(String(req.body?.provider || 'anthropic'));
    if (!isChat(provider)) throw new BadRequest('Conversations belong to a chat provider. Claude Code uses its own sessions.');
    const now = Date.now();
    const c = {
      id: crypto.randomUUID(), provider, title: String(req.body?.title || 'New conversation').slice(0, 120),
      titled: !!req.body?.title, system: String(req.body?.system || ''), model: String(req.body?.model || ''),
      messages: [], createdAt: now, updatedAt: now,
    };
    store.data.conversations[c.id] = c;
    store.save();
    events.send('conversation', { id: c.id });
    res.status(201).json(convSummary(c));
  });

  router.get('/conversations/:id', (req, res) => {
    const c = conv(req.params.id);
    res.json({
      ...convSummary(c),
      messages: c.messages.map(m => ({
        role: m.role,
        text: m.text ?? (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n'),
        files: (m.files || []).map(id => fileInfo(store.data.files[id]) || { id, name: 'removed' }),
        model: m.model, usage: m.usage, stopReason: m.stopReason, at: m.at, jobId: m.jobId, tools: m.tools,
      })),
    });
  });

  router.patch('/conversations/:id', (req, res) => {
    const c = conv(req.params.id);
    if (typeof req.body.title === 'string' && req.body.title.trim()) { c.title = req.body.title.trim().slice(0, 120); c.titled = true; }
    if (typeof req.body.system === 'string') c.system = req.body.system;
    if (typeof req.body.model === 'string') c.model = req.body.model;
    c.updatedAt = Date.now();
    store.save();
    events.send('conversation', { id: c.id });
    res.json(convSummary(c));
  });

  router.delete('/conversations/:id', (req, res) => {
    const c = conv(req.params.id);
    for (const j of Object.values(store.data.jobs)) {
      if (j.conversationId === c.id && ACTIVE_STATUSES.has(j.status)) scheduler.cancel(j);
    }
    delete store.data.conversations[c.id];
    store.save();
    res.json({ ok: true });
  });

  // ---------- Claude Code sessions ----------
  router.get('/sessions', wrap(async (req, res) => res.json(await cc.listSessions())));
  router.get('/sessions/:id', wrap(async (req, res) => {
    const s = await cc.readSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found in the Claude Code history folder.' });
    res.json(s);
  }));

  // ---------- attachments ----------
  const saveUpload = (name, mime, size, tmpPath, buffer) => storeFile(ctx, { name, mime, size, tmpPath, buffer });

  router.post('/uploads', upload.array('files'), wrap(async (req, res) => {
    const out = [];
    for (const f of req.files || []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      out.push(fileInfo(await saveUpload(name, f.mimetype, f.size, f.path)));
    }
    if (!out.length) throw new BadRequest('No files in the request. Send them as multipart form field "files".');
    res.status(201).json(out);
  }));

  // Easier for scripts than multipart.
  router.post('/uploads/base64', wrap(async (req, res) => {
    const { name, mime } = req.body || {};
    const data = req.body?.data || req.body?.content_base64;
    if (!name || !data) throw new BadRequest('Send { "name": "photo.png", "data": "<base64>" }.');
    const buffer = Buffer.from(String(data), 'base64');
    if (!buffer.length) throw new BadRequest('That base64 payload decoded to nothing.');
    res.status(201).json(fileInfo(await saveUpload(String(name), mime, buffer.length, null, buffer)));
  }));

  router.get('/uploads/:id', (req, res) => {
    const f = store.data.files[req.params.id];
    if (!f || !fs.existsSync(f.path)) return res.status(404).json({ error: 'Attachment not found.' });
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'");
    if (INLINE.test(f.mime)) res.type(f.mime).set('Content-Disposition', 'inline');
    else res.type('application/octet-stream').attachment(f.name);
    res.sendFile(f.path);
  });

  router.delete('/uploads/:id', wrap(async (req, res) => {
    const f = store.data.files[req.params.id];
    const inUse = Object.values(store.data.jobs).some(j => j.files?.includes(req.params.id)) ||
      Object.values(store.data.conversations).some(c => c.messages.some(m => m.files?.includes(req.params.id)));
    if (f && !inUse) {
      await fsp.rm(path.dirname(f.path), { recursive: true, force: true });
      delete store.data.files[req.params.id];
      store.save();
    }
    res.json({ ok: true, kept: inUse });
  }));

  // ---------- messages (the queue) ----------
  router.post('/messages', (req, res) => {
    const steps = parseSpec(req.body || {}, { store, settings: settings() });
    const jobs = createChain(ctx, steps, req.auth?.kind === 'token' ? 'api' : 'web');
    res.status(201).json({ jobs });
  });

  router.get('/jobs', (req, res) => {
    res.json(listJobs(store, {
      status: req.query.status, provider: req.query.provider, limit: req.query.limit, since: req.query.since,
      conversationId: req.query.conversation_id || req.query.conversationId,
      sessionId: req.query.session_id || req.query.sessionId,
      threadKey: req.query.thread_key || req.query.threadKey,
    }));
  });

  // ?wait=30 holds the request open until the message finishes: handy in a script
  // that wants the reply without polling.
  router.get('/jobs/:id', wrap(async (req, res) => {
    let j = job(req.params.id);
    const wait = Math.min(300, Math.max(0, +req.query.wait || 0));
    const deadline = Date.now() + wait * 1000;
    while (ACTIVE_STATUSES.has(j.status) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      j = store.data.jobs[req.params.id];
      if (!j) return res.status(404).json({ error: 'Message was deleted while waiting.' });
    }
    res.json({ ...j, live: scheduler.live.get(j.id) || undefined });
  }));

  router.patch('/jobs/:id', (req, res) => res.json(patchJob(ctx, job(req.params.id), req.body || {})));

  router.delete('/jobs/:id', (req, res) => {
    const j = job(req.params.id);
    if (j.status === 'running' && req.query.force === 'true') scheduler.cancel(j);
    deleteJob(ctx, j, { cascade: req.query.cascade !== 'false' });
    res.json({ ok: true });
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    const j = job(req.params.id);
    if (ACTIVE_STATUSES.has(j.status)) scheduler.cancel(j);
    res.json(j);
  });

  router.post('/jobs/:id/retry', (req, res) => {
    const j = job(req.params.id);
    if (j.status === 'running') throw new BadRequest('That message is sending right now.');
    if (j.status === 'done') throw new BadRequest('That message has already been sent.');
    scheduler.update(j, { status: 'scheduled', nextAttemptAt: Date.now(), force: true, lastError: null, transientTries: 0 });
    scheduler.kick();
    res.json(j);
  });

  // ---------- export ----------
  const tzOf = req => String(req.query.tz || '');
  const sendExport = async (res, req, convs, base) => {
    const format = String(req.query.format || 'md').toLowerCase();
    if (format === 'md' || format === 'markdown') {
      res.type('text/markdown; charset=utf-8').set('Content-Disposition', attachmentName(`${base}.md`));
      return res.send(toMarkdown(convs[0], { tz: tzOf(req), version }));
    }
    if (format === 'json') {
      const inlineFiles = req.query.attachments === undefined ? true : truthy(req.query.attachments);
      res.set('Content-Disposition', attachmentName(`${base}.json`));
      return res.json(await toJson(convs, { version, inlineFiles }));
    }
    throw new BadRequest('format must be "md" or "json".');
  };

  router.get('/conversations/:id/export', wrap(async (req, res) => {
    const c = conv(req.params.id);
    await sendExport(res, req, [fromConversation(c, store.data.files)], slug(c.title));
  }));

  router.get('/sessions/:id/export', wrap(async (req, res) => {
    if (String(req.query.format) === 'jsonl') {
      const file = await cc.sessionFile(req.params.id);
      if (!file) return res.status(404).json({ error: 'Session not found in the Claude Code history folder.' });
      res.type('application/x-ndjson').set('Content-Disposition', attachmentName(`${req.params.id}.jsonl`));
      return fs.createReadStream(file).pipe(res);
    }
    const s = await cc.readSession(req.params.id, { all: true });
    if (!s) return res.status(404).json({ error: 'Session not found in the Claude Code history folder.' });
    const title = (await cc.listSessions()).find(x => x.id === s.id)?.title;
    const c = fromSession(s, title);
    await sendExport(res, req, [c], slug(c.title));
  }));

  // Every conversation at once: one JSON file, or a zip of Markdown files.
  router.get('/export', wrap(async (req, res) => {
    const provider = req.query.provider ? normalizeProvider(String(req.query.provider)) : null;
    const convs = Object.values(store.data.conversations)
      .filter(c => !provider || normalizeProvider(c.provider) === provider)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(c => fromConversation(c, store.data.files));
    const day = new Date().toISOString().slice(0, 10);
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'json') {
      res.set('Content-Disposition', attachmentName(`nightshift-conversations-${day}.json`));
      return res.json(await toJson(convs, { version, inlineFiles: truthy(req.query.attachments) }));
    }
    if (format === 'md' || format === 'markdown') {
      res.type('application/zip').set('Content-Disposition', attachmentName(`nightshift-conversations-${day}.zip`));
      await writeMarkdownZip(res, convs, { tz: tzOf(req), version });
      return res.end();
    }
    throw new BadRequest('format must be "json" or "md".');
  }));

  // ---------- import ----------
  // POST /v1/import with the files. With ?preview=true you get back what was found
  // and an id to commit later; without it, everything new is imported straight away.
  const expireImports = async () => {
    for (const [id, item] of imports) {
      if (item.expires < Date.now()) { imports.delete(id); await disposeImport(item.parsed); }
    }
  };
  setInterval(() => expireImports().catch(() => {}), 60000).unref();

  const commitOptions = (b, req) => ({
    keys: Array.isArray(b.keys) ? b.keys.map(String) : undefined,
    provider: b.provider ? String(b.provider) : undefined,
    target: b.target === 'claude-code' ? 'claude-code' : 'conversations',
    cwd: typeof b.cwd === 'string' && b.cwd.trim() ? b.cwd.trim() : undefined,
    restoreSettings: truthy(b.restore_settings ?? b.restoreSettings),
    isSession: req.auth?.kind === 'session',
  });

  const checkCwd = opts => {
    if (opts.target === 'claude-code' && opts.cwd && !fs.existsSync(opts.cwd)) throw new BadRequest(`Folder not found on the server: ${opts.cwd}`);
  };

  router.post('/import', importUpload.array('files'), wrap(async (req, res) => {
    const uploaded = req.files || [];
    if (!uploaded.length) throw new BadRequest('Send the export as multipart form field "files".');
    await expireImports();
    const files = uploaded.map(f => ({ path: f.path, name: Buffer.from(f.originalname, 'latin1').toString('utf8') }));
    const gapMinutes = Math.min(1440, Math.max(1, +(req.query.gap_minutes || req.body?.gap_minutes) || 30));
    let parsed;
    try {
      parsed = await parseImport(files, { gapMinutes });
    } catch (e) {
      for (const f of uploaded) await fsp.unlink(f.path).catch(() => {});
      throw e;
    }
    parsed.tmpPaths = uploaded.map(f => f.path);
    if (truthy(req.query.preview ?? req.body?.preview)) {
      if (imports.size >= 5) {
        const oldest = [...imports.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
        imports.delete(oldest[0]);
        await disposeImport(oldest[1].parsed);
      }
      const id = crypto.randomUUID();
      imports.set(id, { parsed, expires: Date.now() + IMPORT_TTL });
      return res.status(201).json({ id, expiresAt: Date.now() + IMPORT_TTL, ...describeImport(store, parsed) });
    }
    try {
      const opts = commitOptions(req.body || {}, req);
      checkCwd(opts);
      res.status(201).json(await commitImport(ctx, parsed, opts));
    } finally { await disposeImport(parsed); }
  }));

  router.post('/import/:id/commit', wrap(async (req, res) => {
    const item = imports.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'That import has expired. Upload the file again.' });
    const opts = commitOptions(req.body || {}, req);
    checkCwd(opts);
    imports.delete(req.params.id);
    try { res.json(await commitImport(ctx, item.parsed, opts)); } finally { await disposeImport(item.parsed); }
  }));

  router.delete('/import/:id', wrap(async (req, res) => {
    const item = imports.get(req.params.id);
    if (item) { imports.delete(req.params.id); await disposeImport(item.parsed); }
    res.json({ ok: true });
  }));

  router.get('/events', (req, res) => events.attach(req, res));

  router.use((err, req, res, next) => {
    const status = err.status || (err instanceof BadRequest ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return router;
}
