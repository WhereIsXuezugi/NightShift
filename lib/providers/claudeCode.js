import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(configDir(), 'projects');
const SESSION_ID = /^[\w-]{6,80}$/;

// ---------- usage-limit parsing ----------

const LIMIT_RE = /(usage limit|limit reached|hit your (?:usage )?limit|limit will reset|out of (?:extra )?usage|5-hour limit|weekly limit|session limit|rate[_ -]?limit)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validTz(tz) {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}

function zonedParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, +x.value]));
  return p;
}

// Wall-clock time in a timezone -> epoch ms.
function zonedToEpoch(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= asUtc - Date.UTC(y, mo, d, h, mi);
  }
  return guess;
}

/**
 * Reads Claude Code output and decides whether it's a usage-limit message.
 * Returns null if not a limit, otherwise { resetAt: epochMs | null }.
 * Handles "usage limit reached|1726650000", "resets 3am (America/Los_Angeles)",
 * "resets Sep 21, 3pm", "resets at 3:30 PM" and "resets in 2h 15m".
 */
export function parseLimit(text, now = Date.now()) {
  if (!text || !LIMIT_RE.test(text)) return null;

  const epoch = text.match(/limit reached\|(\d{10,13})/i);
  if (epoch) {
    const n = +epoch[1];
    return { resetAt: n < 1e12 ? n * 1000 : n };
  }

  const rel = text.match(/resets?\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?/i);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    return { resetAt: now + ((+rel[1] || 0) * 1440 + (+rel[2] || 0) * 60 + (+rel[3] || 0)) * 60000 };
  }

  const m = text.match(/resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i);
  if (m) {
    const tz = validTz(m[7]?.trim()) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let hour = (+m[4]) % 12 + (m[6].toLowerCase() === 'p' ? 12 : 0);
    const minute = +(m[5] || 0);
    const today = zonedParts(now, tz);
    const monthIdx = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
    if (monthIdx >= 0) {
      let year = +(m[3] || today.year);
      let t = zonedToEpoch(year, monthIdx, +m[2], hour, minute, tz);
      if (!m[3] && t < now - 86400000) t = zonedToEpoch(year + 1, monthIdx, +m[2], hour, minute, tz);
      return { resetAt: t };
    }
    let t = zonedToEpoch(today.year, today.month - 1, today.day, hour, minute, tz);
    if (t <= now + 30000) t = zonedToEpoch(today.year, today.month - 1, today.day + 1, hour, minute, tz);
    return { resetAt: t };
  }
  return { resetAt: null };
}

// ---------- running ----------

export function version(bin) {
  return new Promise(resolve => {
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('error', e => resolve({ ok: false, error: e.code === 'ENOENT' ? `"${bin}" wasn't found` : e.message }));
    p.on('close', code => resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false, error: `exited ${code}` }));
  });
}

/**
 * Runs `claude -p` headlessly. The prompt goes over stdin, so length and quoting never matter.
 * Returns { ok, text, sessionId, costUsd } or { ok:false, kind, resetAt?, error, sessionId }.
 */
export function run({ bin, cwd, prompt, model, effort, sessionId, permissionMode, addDirs = [], signal, timeoutMs, onDelta }) {
  return new Promise(resolve => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);
    for (const d of addDirs) args.push('--add-dir', d);

    let child;
    try {
      child = spawn(bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, kind: 'error', error: `Couldn't start Claude Code: ${e.message}` });
    }

    let buf = '', stderr = '', result = null, sid = sessionId || null, spawnErr = null, killed = null, done = false;
    const texts = [];

    const onLine = line => {
      let ev;
      try { ev = JSON.parse(line); } catch { texts.push(line); return; }
      if (ev.session_id) sid = ev.session_id;
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'text' && b.text) { texts.push(b.text); onDelta?.(b.text + '\n\n'); }
          else if (b.type === 'tool_use') onDelta?.(`[${b.name}] `);
        }
      } else if (ev.type === 'result') result = ev;
    };

    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { spawnErr = e; finish(null); });
    child.on('close', code => finish(code));
    child.stdin.end(prompt);

    const timer = setTimeout(() => { killed = 'timeout'; child.kill('SIGTERM'); }, timeoutMs);
    const onAbort = () => { killed = 'cancelled'; child.kill('SIGTERM'); };
    signal?.addEventListener('abort', onAbort, { once: true });

    function finish(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) onLine(buf.trim());

      if (killed === 'cancelled') return resolve({ ok: false, kind: 'cancelled', error: 'Cancelled', sessionId: sid });
      if (spawnErr) {
        const hint = spawnErr.code === 'ENOENT' ? `"${bin}" wasn't found. Install Claude Code or set its path in Settings.` : spawnErr.message;
        return resolve({ ok: false, kind: 'error', error: hint });
      }
      if (killed === 'timeout') return resolve({ ok: false, kind: 'error', error: `Timed out after ${Math.round(timeoutMs / 60000)} min`, sessionId: sid });

      const resultText = typeof result?.result === 'string' ? result.result : '';
      const allText = [resultText, ...texts, stderr].filter(Boolean).join('\n');
      const failed = !result || result.is_error || result.subtype !== 'success' || code !== 0;
      // A limit message can arrive either as an error or as a short "successful" reply.
      const limitSource = failed ? allText : (resultText.length < 400 ? resultText : '');
      const lim = parseLimit(limitSource);
      if (lim) return resolve({ ok: false, kind: 'limit', resetAt: lim.resetAt, error: (resultText || stderr || 'Usage limit reached').replace(/\|\d{10,13}/, '').trim().slice(0, 500), sessionId: sid });
      if (/overloaded|529|api error: 5\d\d/i.test(failed ? allText : '')) return resolve({ ok: false, kind: 'overloaded', error: allText.trim().slice(0, 500), sessionId: sid });
      if (failed) return resolve({ ok: false, kind: 'error', error: (resultText || stderr || `Claude Code exited with code ${code}`).trim().slice(0, 1500), sessionId: sid });

      resolve({ ok: true, text: resultText || texts.join('\n\n'), sessionId: sid, costUsd: result.total_cost_usd ?? null, turns: result.num_turns ?? null });
    }
  });
}

// ---------- reading sessions from ~/.claude/projects ----------

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
const isNoise = t => !t || /^\s*</.test(t) || /^Caveat:/.test(t);
const headCache = new Map();

async function readHead(file, mtime) {
  const hit = headCache.get(file);
  if (hit && hit.mtime === mtime) return hit.meta;
  const fh = await fsp.open(file, 'r');
  const { buffer, bytesRead } = await fh.read(Buffer.alloc(256 * 1024), 0, 256 * 1024, 0);
  await fh.close();
  let cwd = null, first = null, summary = null;
  for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === 'summary' && o.summary) summary = o.summary;
    if (!first && o.type === 'user' && !o.isMeta) {
      const t = textOf(o.message?.content);
      if (!isNoise(t)) first = t.trim();
    }
    if (cwd && first && summary) break;
  }
  const meta = { cwd, title: (summary || first || '').slice(0, 120) };
  headCache.set(file, { mtime, meta });
  return meta;
}

export async function listSessions(limit = 300) {
  let dirs;
  try { dirs = await fsp.readdir(projectsDir(), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    let files; try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      try {
        const st = await fsp.stat(p);
        const meta = await readHead(p, st.mtimeMs);
        if (!meta.title) continue; // skip sessions with no real user message
        out.push({ id: f.slice(0, -6), cwd: meta.cwd || d.name, title: meta.title, updatedAt: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

async function findSessionFile(id) {
  if (!SESSION_ID.test(id)) return null;
  let dirs; try { dirs = await fsp.readdir(projectsDir()); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(projectsDir(), d, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function readSession(id) {
  const file = await findSessionFile(id);
  if (!file) return null;
  const st = await fsp.stat(file);
  const MAX = 30 * 1024 * 1024;
  let raw;
  if (st.size > MAX) {
    const fh = await fsp.open(file, 'r');
    const { buffer } = await fh.read(Buffer.alloc(MAX), 0, MAX, st.size - MAX);
    await fh.close();
    raw = buffer.toString('utf8');
  } else raw = await fsp.readFile(file, 'utf8');

  const messages = [];
  let cwd = null;
  for (const line of raw.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd) cwd = o.cwd;
    if (o.type === 'user' && !o.isMeta) {
      const t = textOf(o.message?.content);
      if (!isNoise(t)) messages.push({ role: 'user', text: t, at: Date.parse(o.timestamp) || null });
    } else if (o.type === 'assistant') {
      const content = o.message?.content || [];
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
      const tools = content.filter(b => b.type === 'tool_use').map(b => b.name);
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        if (text) last.text = last.text ? `${last.text}\n\n${text}` : text;
        last.tools.push(...tools);
      } else if (text || tools.length) messages.push({ role: 'assistant', text, tools, at: Date.parse(o.timestamp) || null });
    }
  }
  return { id, cwd, messages: messages.slice(-300) };
}
