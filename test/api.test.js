import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProviders } from './fixtures/mock-providers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'test-password';
let mock, server, dataDir, port, token, cookie;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(pathname, { method = 'GET', body, auth = 'token', query } = {}) {
  const url = new URL(`http://127.0.0.1:${port}${pathname}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers = {};
  if (auth === 'token') headers.authorization = `Bearer ${token}`;
  if (auth === 'cookie') headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${res.status} ${data?.error || data}`);
  return data;
}

/** Waits until a job reaches one of the given statuses. */
async function waitFor(id, statuses, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(`/v1/jobs/${id}`);
    if (statuses.includes(job.status)) return job;
    await sleep(250);
  }
  throw new Error(`job ${id} never reached ${statuses.join('/')}`);
}

before(async () => {
  mock = await startMockProviders({ anthropicLimitOnce: true, retryAfter: 3 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-test-'));
  port = 9000 + Math.floor(Math.random() * 900);

  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      APP_PASSWORD: PASSWORD,
      ANTHROPIC_API_KEY: 'test-anthropic',
      OPENAI_API_KEY: 'test-openai',
      GEMINI_API_KEY: 'test-gemini',
      ANTHROPIC_BASE_URL: `${mock.base}/anthropic`,
      OPENAI_BASE_URL: `${mock.base}/openai`,
      GEMINI_BASE_URL: `${mock.base}/gemini`,
      OLLAMA_BASE_URL: `${mock.base}/ollama`,
      CLAUDE_BIN: path.join(root, 'test/fixtures/fake-claude.mjs'),
      CLAUDE_CWD: dataDir,
      CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude'),
      FAKE_CLAUDE_LIMIT_ONCE: path.join(dataDir, 'cc-limit-used'),
      FAKE_CLAUDE_RESET_SECONDS: '4',
      FAKE_CLAUDE_ARGS_LOG: path.join(dataDir, 'cc-args.log'),
      NOTIFY_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.env.DEBUG && console.error(`[server] ${d}`));

  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch { await sleep(100); }
  }
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const created = await api('/api/tokens', { method: 'POST', body: { name: 'tests' }, auth: 'cookie' });
  token = created.token;
  // Send as soon as a limit lifts, so the tests don't idle.
  await api('/api/settings', { method: 'PUT', body: { resetBufferSec: 0 }, auth: 'cookie' });
});

after(async () => {
  server?.kill();
  await mock?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects requests without credentials', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/jobs`);
  assert.equal(res.status, 401);
});

test('an API token can read the service, and cannot manage tokens', async () => {
  const ping = await api('/v1/ping');
  assert.equal(ping.ok, true);
  const res = await fetch(`http://127.0.0.1:${port}/api/tokens`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test('lists every provider with its capabilities', async () => {
  const providers = await api('/v1/providers');
  assert.deepEqual(providers.map(p => p.id).sort(), ['anthropic', 'claude-code', 'gemini', 'ollama', 'openai']);
  assert.equal(providers.find(p => p.id === 'openai').ready, true);
  assert.equal(providers.find(p => p.id === 'gemini').caps.video, 'native');
});

test('OpenAI: sends a message and stores the reply', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  const { jobs } = await api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'hello openai', effort: 'low' } });
  const done = await waitFor(jobs[0].id, ['done', 'failed']);
  assert.equal(done.status, 'done');
  assert.match(done.result.text, /openai reply to: hello openai/);
  const call = mock.calls.findLast(c => c.path === '/openai/chat/completions');
  assert.equal(call.body.reasoning_effort, 'low');
  const full = await api(`/v1/conversations/${conv.id}`);
  assert.equal(full.messages.length, 2);
  assert.equal(full.title, 'hello openai');
});

test('Gemini: effort becomes a thinking level, and attachments ride along', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'gemini', model: 'gemini-test' } });
  const file = await api('/v1/uploads/base64', { method: 'POST', body: { name: 'notes.txt', data: Buffer.from('remember the milk').toString('base64'), mime: 'text/plain' } });
  const { jobs } = await api('/v1/messages', { method: 'POST', body: { provider: 'gemini', conversation_id: conv.id, text: 'hello gemini', files: [file.id], effort: 'high' } });
  const done = await waitFor(jobs[0].id, ['done', 'failed']);
  assert.equal(done.status, 'done');
  const call = mock.calls.findLast(c => c.path.startsWith('/gemini/models/'));
  assert.equal(call.body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.match(JSON.stringify(call.body.contents), /remember the milk/);
});

test('Claude API: waits out a 429 and sends itself after the reset', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'anthropic', model: 'claude-opus-5' } });
  const { jobs } = await api('/v1/messages', { method: 'POST', body: { provider: 'anthropic', conversation_id: conv.id, text: 'hello claude', mode: 'reset' } });
  const waiting = await waitFor(jobs[0].id, ['waiting_limit', 'done']);
  if (waiting.status === 'waiting_limit') {
    const providers = await api('/v1/providers');
    assert.ok(providers.find(p => p.id === 'anthropic').limit.limitedUntil > Date.now());
  }
  const done = await waitFor(jobs[0].id, ['done', 'failed'], 30000);
  assert.equal(done.status, 'done');
  assert.ok(done.attempts >= 2, 'should have retried after the reset');
});

test('a chain of three messages runs in order, each after the reply before it', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  const { jobs } = await api('/v1/messages', {
    method: 'POST',
    body: {
      provider: 'openai',
      conversation_id: conv.id,
      webhook_url: `${mock.base}/webhook`,
      messages: [{ text: 'step one' }, { text: 'step two' }, { text: 'step three' }],
    },
  });
  assert.equal(jobs.length, 3);
  assert.equal(jobs[1].dependsOn, jobs[0].id);
  assert.equal(jobs[2].mode, 'after');

  for (const j of jobs) assert.equal((await waitFor(j.id, ['done', 'failed'])).status, 'done');
  const full = await api(`/v1/conversations/${conv.id}`);
  const texts = full.messages.filter(m => m.role === 'user').map(m => m.text);
  assert.deepEqual(texts, ['step one', 'step two', 'step three']);
  assert.equal(mock.webhooks.filter(w => w.event === 'message.sent').length >= 3, true);
});

test('a queued message can be edited and deleted, and the chain re-links', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  const runAt = Date.now() + 3600_000;
  const { jobs } = await api('/v1/messages', {
    method: 'POST',
    body: {
      provider: 'openai', conversation_id: conv.id, mode: 'at', run_at: runAt,
      messages: [{ text: 'first draft' }, { text: 'second' }, { text: 'third' }],
    },
  });
  const [a, b, c] = jobs;

  const edited = await api(`/v1/jobs/${a.id}`, { method: 'PATCH', body: { text: 'final wording', effort: 'medium', run_at: runAt + 60_000 } });
  assert.equal(edited.prompt, 'final wording');
  assert.equal(edited.effort, 'medium');
  assert.equal(edited.nextAttemptAt, runAt + 60_000);

  await api(`/v1/jobs/${b.id}`, { method: 'DELETE' });
  const third = await api(`/v1/jobs/${c.id}`);
  assert.equal(third.dependsOn, a.id, 'the message behind the deleted one now follows the first');
  await assert.rejects(() => api(`/v1/jobs/${b.id}`), /404/);

  await api(`/v1/jobs/${a.id}/cancel`, { method: 'POST' });
  assert.equal((await api(`/v1/jobs/${a.id}`)).status, 'cancelled');
  assert.equal((await waitFor(c.id, ['blocked'])).status, 'blocked');
});

test('editing rejects nonsense and refuses finished messages', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  await assert.rejects(() => api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: '' } }), /empty/i);
  await assert.rejects(() => api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'x', mode: 'at', run_at: Date.now() - 600000 } }), /past/i);
  const { jobs } = await api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'quick one' } });
  await waitFor(jobs[0].id, ['done', 'failed']);
  await assert.rejects(() => api(`/v1/jobs/${jobs[0].id}`, { method: 'PATCH', body: { text: 'too late' } }), /already been sent/);
});

test('Claude Code: runs headless, waits out its usage limit, then resumes the session', async () => {
  const { jobs } = await api('/v1/messages', {
    method: 'POST',
    body: {
      provider: 'claude-code', cwd: dataDir, thread_key: 'test-thread', model: 'sonnet', effort: 'high',
      messages: [{ text: 'first task' }, { text: 'second task' }],
    },
  });
  const first = await waitFor(jobs[0].id, ['done', 'failed'], 30000);
  assert.equal(first.status, 'done', first.lastError);
  assert.equal(first.result.sessionId, 'sess-test0001');
  assert.ok(first.attempts >= 2, 'the fake CLI reports a usage limit on its first run');

  const second = await waitFor(jobs[1].id, ['done', 'failed'], 30000);
  assert.equal(second.status, 'done');
  assert.equal(second.sessionId, 'sess-test0001', 'the follow-up resumes the session the first one created');
  const argsLog = fs.readFileSync(path.join(dataDir, 'cc-args.log'), 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(argsLog.some(l => l.includes('--resume sess-test0001')));
  assert.ok(argsLog.some(l => l.includes('--effort high')));
});

test('long polling returns the finished message', async () => {
  const conv = await api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  const { jobs } = await api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'wait for me' } });
  const job = await api(`/v1/jobs/${jobs[0].id}`, { query: { wait: '20' } });
  assert.equal(job.status, 'done');
  assert.match(job.result.text, /wait for me/);
});
