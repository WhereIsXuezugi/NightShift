import fsp from 'node:fs/promises';
import { apiReadyImage, videoFrames } from '../media.js';

const MAX_TEXT_FILE = 400 * 1024;
const MAX_INLINE = 15 * 1024 * 1024; // above this, big media is sent as frames instead

const b64 = async p => (await fsp.readFile(p)).toString('base64');
const note = text => ({ type: 'text', text });

export const messageText = m => m.text ?? (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');

/**
 * Turns a stored turn (text + uploaded file ids) into provider-neutral parts:
 *   { type: 'text', text }
 *   { type: 'media', mime, data (base64), name }
 * Each adapter declares what it can take in `caps`, and anything it can't read
 * is either converted (video to frames) or described in words.
 */
export async function buildParts(text, fileIds, files, caps) {
  const parts = [];
  for (const id of fileIds || []) {
    const f = files[id];
    if (!f) { parts.push(note('[An attachment was removed from the server]')); continue; }
    try {
      if (f.kind === 'image' && caps.image) {
        const img = await apiReadyImage(f);
        parts.push({ type: 'media', mime: img.mime, data: await b64(img.path), name: f.name });
      } else if (f.kind === 'pdf' && caps.pdf) {
        parts.push({ type: 'media', mime: 'application/pdf', data: await b64(f.path), name: f.name });
      } else if ((f.kind === 'video' || f.kind === 'audio') && caps[f.kind] === 'native' && f.size <= MAX_INLINE) {
        parts.push({ type: 'media', mime: f.mime, data: await b64(f.path), name: f.name });
      } else if (f.kind === 'video') {
        const { frames, duration } = await videoFrames(f);
        parts.push(note(`The next ${frames.length} images are evenly spaced frames from the video "${f.name}"${duration ? ` spanning about ${Math.round(duration)}s` : ''}, in order.`));
        for (const fr of frames) parts.push({ type: 'media', mime: 'image/jpeg', data: await b64(fr), name: f.name });
      } else if (f.kind === 'text') {
        let body = await fsp.readFile(f.path, 'utf8');
        if (body.length > MAX_TEXT_FILE) body = `${body.slice(0, MAX_TEXT_FILE)}\n[…truncated]`;
        parts.push(note(`<file name="${f.name}">\n${body}\n</file>`));
      } else {
        parts.push(note(`[Attached "${f.name}" (${f.mime || f.kind}) can't be read by this model. Claude Code can work with it by path.]`));
      }
    } catch (e) {
      parts.push(note(`[Couldn't prepare "${f.name}": ${e.message}]`));
    }
  }
  if (text && text.trim()) parts.push(note(text));
  return parts.length ? parts : [note('(empty message)')];
}

// Reads an SSE body and hands each JSON payload to the adapter.
async function readStream(res, adapter, onDelta) {
  const decoder = new TextDecoder();
  const state = { text: '', usage: null, error: null, finish: null };
  let buf = '';
  const feed = payload => {
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    const out = adapter.stream(obj, state) || {};
    if (out.text) { state.text += out.text; onDelta?.(out.text); }
    if (out.usage) state.usage = { ...state.usage, ...out.usage };
    if (out.finish) state.finish = out.finish;
    if (out.error) state.error = out.error;
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      feed(data);
    }
  }
  if (buf.trim().startsWith('data:')) feed(buf.trim().slice(5).trim());
  return state;
}

/**
 * Runs one turn against any chat adapter.
 * Returns { ok: true, text, usage, note } or
 *         { ok: false, kind: 'limit'|'credit'|'overloaded'|'error'|'cancelled', resetAt?, error }
 */
export async function run({ adapter, key, baseUrl, model, effort, maxTokens, system, history, prompt, fileIds, files, signal, onDelta }) {
  const messages = [];
  try {
    for (const m of history) {
      if (m.role === 'user') messages.push({ role: 'user', parts: await buildParts(m.text, m.files, files, adapter.caps) });
      else messages.push({ role: 'assistant', parts: [note(messageText(m) || '(no text)')] });
    }
    messages.push({ role: 'user', parts: await buildParts(prompt, fileIds, files, adapter.caps) });
  } catch (e) {
    return { ok: false, kind: 'error', error: e.message };
  }

  const req = adapter.request({ model, effort, maxTokens, system, messages, baseUrl, key });
  let note_ = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (e) {
      if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'Cancelled' };
      return { ok: false, kind: 'overloaded', error: `Network error: ${e.message}` };
    }

    if (!res.ok) {
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      const mapped = adapter.mapError({ status: res.status, json, raw, headers: res.headers }) || {};
      const message = mapped.message || raw.slice(0, 500);
      // Some models reject effort or other optional knobs: drop them and try again
      // rather than losing a message that was queued for the middle of the night.
      if (res.status === 400 && attempt < 2) {
        const dropped = adapter.dropUnsupported?.(req.body, message);
        if (dropped) { note_ = `${dropped} isn't supported by this model, so it was left out.`; continue; }
      }
      if (mapped.kind === 'limit' || mapped.kind === 'credit') return { ok: false, kind: mapped.kind, resetAt: mapped.resetAt, error: message };
      if (mapped.kind === 'overloaded' || res.status >= 500) return { ok: false, kind: 'overloaded', error: message };
      return { ok: false, kind: 'error', error: `${adapter.label} ${res.status}: ${message}` };
    }

    try {
      const state = await readStream(res, adapter, onDelta);
      if (state.error) {
        const kind = /overload|unavailable|try again/i.test(state.error) ? 'overloaded' : /rate|quota|limit/i.test(state.error) ? 'limit' : 'error';
        return { ok: false, kind, error: state.error };
      }
      return { ok: true, text: state.text, usage: state.usage, stopReason: state.finish, note: note_ };
    } catch (e) {
      if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'Cancelled' };
      return { ok: false, kind: 'overloaded', error: `Stream interrupted: ${e.message}` };
    }
  }
  return { ok: false, kind: 'error', error: 'Request rejected repeatedly.' };
}

// Shared helpers for adapters
export const parseResetHeader = (h, names) => {
  const retry = h.get('retry-after');
  if (retry && !isNaN(+retry)) return Date.now() + +retry * 1000;
  if (retry) { const t = Date.parse(retry); if (!isNaN(t)) return t; }
  for (const n of names) {
    const v = h.get(n);
    if (!v) continue;
    const ms = parseDuration(v);
    if (ms != null) return Date.now() + ms;
    const t = Date.parse(v);
    if (!isNaN(t) && t > Date.now()) return t;
  }
  return null;
};

// "1s", "6m0s", "2h13m5.2s", "350ms"
export function parseDuration(v) {
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return +s * 1000;
  const m = s.match(/^((\d+)h)?((\d+)m(?!s))?((\d+(\.\d+)?)s)?((\d+)ms)?$/);
  if (!m || !(m[2] || m[4] || m[6] || m[9])) return null;
  return ((+m[2] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[6] || 0)) * 1000 + (+m[9] || 0);
}
