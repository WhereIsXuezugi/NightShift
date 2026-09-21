import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Events, notify } from './lib/events.js';
import { Scheduler } from './lib/scheduler.js';
import { hasFfmpeg } from './lib/media.js';
import { createApiRouter, API_VERSION } from './lib/api.js';
import { CHAT_ADAPTERS, PROVIDERS, describeProviders, normalizeProvider, claudeCode as cc } from './lib/providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const cfg = {
  port: +process.env.PORT || 8787,
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  password: process.env.APP_PASSWORD || '',
};

// This app can run Claude Code on your machine and holds your API keys,
// so it refuses to be reachable from the network without a password.
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
if (!cfg.password && !loopback && process.env.ALLOW_NO_PASSWORD !== '1') {
  console.error(`\nRefusing to listen on ${cfg.host} without APP_PASSWORD.\nSet APP_PASSWORD, or use HOST=127.0.0.1 for local-only access.\n`);
  process.exit(1);
}

fs.mkdirSync(path.join(cfg.dataDir, 'uploads'), { recursive: true });
const store = new Store(path.join(cfg.dataDir, 'db.json'));
const events = new Events();
migrate();

const secretFile = path.join(cfg.dataDir, '.secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = fs.readFileSync(secretFile, 'utf8').trim();
const sessionToken = crypto.createHmac('sha256', secret).update(`auth:${cfg.password}`).digest('hex');

/** Brings older data files up to the current shape. */
function migrate() {
  const s = store.data.settings;
  store.data.tokens ||= {};
  if (s.apiKey) { (s.providers ||= {}).anthropic = { key: s.apiKey }; delete s.apiKey; }
  for (const c of Object.values(store.data.conversations)) c.provider = normalizeProvider(c.provider || 'anthropic');
  for (const j of Object.values(store.data.jobs)) {
    j.provider = normalizeProvider(j.provider);
    j.dependsOn ??= null;
    j.delayMs ??= 0;
    j.files ||= [];
    if (!j.threadKey) j.threadKey = j.conversationId ? `conv:${j.conversationId}` : j.sessionId || `new:${j.id}`;
  }
  if (store.data.limits.api) { store.data.limits.anthropic = store.data.limits.api; delete store.data.limits.api; }
  store.save();
}

function settings() {
  const s = store.data.settings;
  const providers = {};
  for (const [id, adapter] of Object.entries(CHAT_ADAPTERS)) {
    const saved = s.providers?.[id] || {};
    const envKey = process.env[adapter.keyEnv] || '';
    providers[id] = {
      key: saved.key || envKey,
      fromEnv: !saved.key && !!envKey,
      baseUrl: (saved.baseUrl || process.env[adapter.baseUrlEnv] || adapter.defaultBaseUrl).replace(/\/$/, ''),
    };
  }
  return {
    providers,
    claudeBin: s.claudeBin || process.env.CLAUDE_BIN || 'claude',
    claudeCwd: s.claudeCwd || process.env.CLAUDE_CWD || os.homedir(),
    notifyUrl: s.notifyUrl ?? process.env.NOTIFY_URL ?? '',
    resetBufferSec: s.resetBufferSec ?? 90,
    pollMinutes: s.pollMinutes ?? 15,
    ccTimeoutMin: s.ccTimeoutMin ?? 60,
  };
}

const publicSettings = () => {
  const s = settings();
  return {
    providers: describeProviders(s),
    claudeBin: s.claudeBin, claudeCwd: s.claudeCwd, notifyUrl: s.notifyUrl,
    resetBufferSec: s.resetBufferSec, pollMinutes: s.pollMinutes, ccTimeoutMin: s.ccTimeoutMin,
    version: pkg.version, authRequired: !!cfg.password,
  };
};

const scheduler = new Scheduler({ store, events, settings });
const ctx = { store, events, scheduler, settings, dataDir: cfg.dataDir, version: pkg.version };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '64mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  next();
});

// ---------- authentication ----------
// Two ways in: the browser session cookie, or an API token for scripts and
// orchestration tools. Tokens are stored as hashes and shown only once.
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = req => (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(([k]) => k === 'ns_auth')?.[1];
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

function bearerOf(req) {
  const h = req.headers.authorization || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return req.headers['x-api-key'] || (req.path === '/events' ? String(req.query.token || '') : '') || '';
}

function authenticate(req) {
  const c = cookieOf(req);
  if (!cfg.password || (c && eq(c, sessionToken))) return { kind: 'session' };
  const raw = bearerOf(req);
  if (raw) {
    const hash = hashToken(raw);
    const token = Object.values(store.data.tokens).find(t => eq(t.hash, hash));
    if (token) {
      token.lastUsedAt = Date.now();
      store.save();
      return { kind: 'token', token: { id: token.id, name: token.name } };
    }
  }
  return null;
}

const requireAuth = (req, res, next) => {
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Sign in, or send an API token as "Authorization: Bearer <token>".' });
  req.auth = auth;
  next();
};
const requireSession = (req, res, next) => {
  if (req.auth?.kind === 'session') return next();
  res.status(403).json({ error: 'This needs a signed-in browser session, not an API token.' });
};

// ---------- open endpoints ----------
app.get('/healthz', (req, res) => res.json({ ok: true, version: pkg.version }));
app.get('/api/auth', (req, res) => res.json({ required: !!cfg.password, authed: !!authenticate(req) }));
app.post('/api/login', async (req, res) => {
  const given = String(req.body?.password || '');
  if (!cfg.password || !eq(given, cfg.password)) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `ns_auth=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', 'ns_auth=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- the API, for the browser and for scripts ----------
app.use(`/${API_VERSION}`, requireAuth, createApiRouter(ctx));

// ---------- admin, browser session only ----------
const admin = express.Router();
admin.use(requireAuth, requireSession);

admin.get('/state', (req, res) => res.json({
  settings: publicSettings(),
  limits: store.data.limits,
  jobs: Object.values(store.data.jobs),
  live: Object.fromEntries(scheduler.live),
  now: Date.now(),
}));

admin.put('/settings', (req, res) => {
  const b = req.body || {}, s = store.data.settings;
  if (b.providers && typeof b.providers === 'object') {
    s.providers ||= {};
    for (const [id, conf] of Object.entries(b.providers)) {
      if (!CHAT_ADAPTERS[id]) continue;
      s.providers[id] ||= {};
      if (typeof conf.key === 'string' && conf.key.trim()) s.providers[id].key = conf.key.trim();
      if (conf.key === null) delete s.providers[id].key;
      if (typeof conf.baseUrl === 'string') {
        const url = conf.baseUrl.trim().replace(/\/$/, '');
        if (url && !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'A base URL must start with http:// or https://' });
        s.providers[id].baseUrl = url;
      }
    }
  }
  if (typeof b.claudeBin === 'string') s.claudeBin = b.claudeBin.trim();
  if (typeof b.claudeCwd === 'string') {
    const dir = b.claudeCwd.trim();
    if (dir && !fs.existsSync(dir)) return res.status(400).json({ error: `Folder not found: ${dir}` });
    s.claudeCwd = dir;
  }
  if (typeof b.notifyUrl === 'string') {
    if (b.notifyUrl && !/^https?:\/\//.test(b.notifyUrl)) return res.status(400).json({ error: 'The notification URL must start with http:// or https://' });
    s.notifyUrl = b.notifyUrl.trim();
  }
  for (const [k, min, max] of [['resetBufferSec', 0, 3600], ['pollMinutes', 1, 240], ['ccTimeoutMin', 1, 720]]) {
    if (b[k] !== undefined) s[k] = Math.min(max, Math.max(min, Math.round(+b[k] || min)));
  }
  store.save();
  res.json(publicSettings());
});

admin.get('/health', async (req, res) => {
  const s = settings();
  res.json({
    version: pkg.version,
    claudeCode: await cc.version(s.claudeBin),
    ffmpeg: await hasFfmpeg(),
    providers: Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, !!s.providers[id]?.key || id === 'claude-code'])),
  });
});

admin.post('/notify/test', async (req, res) => {
  res.json(await notify(settings().notifyUrl, 'Nightshift test', 'Notifications are working.'));
});

// API tokens for orchestration tools
admin.get('/tokens', (req, res) => {
  res.json(Object.values(store.data.tokens).map(t => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null })));
});
admin.post('/tokens', (req, res) => {
  const name = String(req.body?.name || 'Untitled token').slice(0, 60);
  const raw = `ns_${crypto.randomBytes(24).toString('base64url')}`;
  const token = { id: crypto.randomUUID(), name, prefix: `${raw.slice(0, 7)}…`, hash: hashToken(raw), createdAt: Date.now() };
  store.data.tokens[token.id] = token;
  store.save();
  res.status(201).json({ id: token.id, name, prefix: token.prefix, createdAt: token.createdAt, token: raw });
});
admin.delete('/tokens/:id', (req, res) => {
  delete store.data.tokens[req.params.id];
  store.save();
  res.json({ ok: true });
});

app.use('/api', admin);

// ---------- static files ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

scheduler.start();
const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Nightshift ${pkg.version} on http://${cfg.host}:${cfg.port}${cfg.password ? ' (password protected)' : ''}`);
  console.log(`API at /${API_VERSION}, data in ${cfg.dataDir}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { scheduler.stop(); store.flush(); server.close(); process.exit(0); });
}

export { app, store, scheduler };
