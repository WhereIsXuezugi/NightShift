import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Starts a real Nightshift against the mock providers, signed in, with an API token. */
export async function startNightshift(mock, extraEnv = {}) {
  const PASSWORD = 'test-password';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-test-'));
  const port = 9000 + Math.floor(Math.random() * 900);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_PASSWORD: PASSWORD,
      ANTHROPIC_API_KEY: 'test-anthropic', OPENAI_API_KEY: 'test-openai', GEMINI_API_KEY: 'test-gemini',
      ANTHROPIC_BASE_URL: `${mock.base}/anthropic`, OPENAI_BASE_URL: `${mock.base}/openai`,
      GEMINI_BASE_URL: `${mock.base}/gemini`, OLLAMA_BASE_URL: `${mock.base}/ollama`,
      CLAUDE_BIN: path.join(root, 'test/fixtures/fake-claude.mjs'),
      CLAUDE_CWD: dataDir, CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude'),
      NOTIFY_URL: '',
      ...extraEnv(dataDir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.env.DEBUG && console.error(`[server] ${d}`));
  server.stdout.on('data', d => process.env.DEBUG && console.error(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch { await sleep(100); }
  }
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ns = { port, dataDir, cookie, token: null, server, base: `http://127.0.0.1:${port}` };

  ns.raw = (pathname, { method = 'GET', body, auth = 'token', query, form } = {}) => {
    const url = new URL(`${ns.base}${pathname}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const headers = {};
    if (auth === 'token') headers.authorization = `Bearer ${ns.token}`;
    if (auth === 'cookie') headers.cookie = cookie;
    if (body) headers['content-type'] = 'application/json';
    return fetch(url, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  };
  ns.api = async (pathname, opts) => {
    const res = await ns.raw(pathname, opts);
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(`${res.status} ${data?.error || data}`);
    return data;
  };
  ns.waitFor = async (id, statuses, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await ns.api(`/v1/jobs/${id}`);
      if (statuses.includes(job.status)) return job;
      await sleep(250);
    }
    throw new Error(`job ${id} never reached ${statuses.join('/')}`);
  };
  ns.upload = (pathname, files, query) => {
    const form = new FormData();
    for (const [name, data] of Object.entries(files)) form.append('files', new Blob([data]), name);
    return ns.api(pathname, { method: 'POST', form, query });
  };
  ns.close = () => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); };

  ns.token = (await ns.api('/api/tokens', { method: 'POST', body: { name: 'tests' }, auth: 'cookie' })).token;
  await ns.api('/api/settings', { method: 'PUT', body: { resetBufferSec: 0 }, auth: 'cookie' });
  return ns;
}
