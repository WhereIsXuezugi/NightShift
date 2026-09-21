import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { classify } from './media.js';
import { PROVIDERS, describeProviders, adapterFor, isChat, normalizeProvider, claudeCode as cc } from './providers/index.js';
import { parseSpec, createChain, patchJob, deleteJob, listJobs, BadRequest, ACTIVE_STATUSES } from './jobs.js';

export const API_VERSION = 'v1';
const INLINE = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|application\/pdf)$/;
const safeName = n => path.basename(n).replace(/[^\w.\- ()]+/g, '_').slice(0, 150) || 'file';
const fileInfo = f => f && ({ id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApiRouter(ctx) {
  const { store, scheduler, events, settings, dataDir, version } = ctx;
  const router = express.Router();
  const upload = multer({ dest: path.join(dataDir, 'tmp'), limits: { fileSize: 1024 * 1024 * 1024, files: 20 } });

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
  });

  // ---------- service ----------
  router.get('/ping', (req, res) => res.json({ ok: true, name: 'nightshift', version, api: API_VERSION, now: Date.now() }));

  router.get('/providers', (req, res) => {
    const s = settings();
    res.json(describeProviders(s).map(p => ({
      ...p,
      limit: store.data.limits[p.id] || { limitedUntil: null },
      queued: Object.values(store.data.jobs).filter(j => j.provider === p.id && ACTIVE_STATUSES.has(j.status)).length,
    })));
  });

  router.get('/models', wrap(async (req, res) => {
    const provider = normalizeProvider(String(req.query.provider || 'anthropic'));
    if (provider === 'claude-code') {
      return res.json([
        { id: 'opus', name: 'Opus (latest)' }, { id: 'sonnet', name: 'Sonnet (latest)' },
        { id: 'haiku', name: 'Haiku (latest)' }, { id: 'fable', name: 'Fable (if your plan includes it)' },
      ]);
    }
    const adapter = adapterFor(provider);
    if (!adapter) throw new BadRequest(`Unknown provider "${provider}".`);
    const conf = settings().providers[provider];
    if (!conf?.key) return res.json([]);
    res.json(await adapter.listModels(conf));
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
        model: m.model, usage: m.usage, stopReason: m.stopReason, at: m.at, jobId: m.jobId,
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
  const storeFile = async (name, mime, size, tmpPath, buffer) => {
    const id = crypto.randomUUID();
    const clean = safeName(name);
    const dir = path.join(dataDir, 'uploads', id);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, clean);
    if (buffer) await fsp.writeFile(dest, buffer);
    else await fsp.rename(tmpPath, dest).catch(async () => { await fsp.copyFile(tmpPath, dest); await fsp.unlink(tmpPath); });
    const fh = await fsp.open(dest, 'r');
    const { buffer: head, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0);
    await fh.close();
    const meta = { id, name: clean, size: size ?? (await fsp.stat(dest)).size, mime: mime || 'application/octet-stream', path: dest, createdAt: Date.now() };
    meta.kind = classify(clean, meta.mime, head.subarray(0, bytesRead));
    store.data.files[id] = meta;
    store.save();
    return meta;
  };

  router.post('/uploads', upload.array('files'), wrap(async (req, res) => {
    const out = [];
    for (const f of req.files || []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      out.push(fileInfo(await storeFile(name, f.mimetype, f.size, f.path)));
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
    res.status(201).json(fileInfo(await storeFile(String(name), mime, buffer.length, null, buffer)));
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

  router.get('/events', (req, res) => events.attach(req, res));

  router.use((err, req, res, next) => {
    const status = err.status || (err instanceof BadRequest ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return router;
}
