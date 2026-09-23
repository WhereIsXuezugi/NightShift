import { parseResetHeader } from './chat.js';

// Ollama's own API rather than its OpenAI-compatible one: it lists what is
// actually pulled, reports load errors clearly, and takes images natively.
// No key is needed for a local server; one is sent only if you set it
// (ollama.com, or a server behind an authenticating proxy).

const auth = key => (key ? { authorization: `Bearer ${key}` } : {});

function toMessage(m) {
  const text = m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
  const images = m.parts.filter(p => p.type === 'media' && p.mime.startsWith('image/')).map(p => p.data);
  const msg = { role: m.role, content: text };
  if (images.length) msg.images = images;
  return msg;
}

const sizeOf = n => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;

export default {
  id: 'ollama',
  label: 'Ollama',
  keyLabel: 'API key (optional)',
  keyOptional: true,
  keyEnv: 'OLLAMA_API_KEY',
  baseUrlEnv: 'OLLAMA_BASE_URL',
  defaultBaseUrl: 'http://127.0.0.1:11434',
  consoleUrl: 'https://ollama.com/search',
  streamFormat: 'ndjson',
  // Vision models read images; everything else arrives as text or frames.
  caps: { image: true, pdf: false, video: 'frames', audio: false },
  efforts: ['low', 'medium', 'high'],
  defaultMaxTokens: 8192,

  async listModels({ key, baseUrl }) {
    const res = await fetch(`${baseUrl}/api/tags`, { headers: auth(key), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Couldn't load Ollama models (${res.status}). Check the base URL.`);
    const j = await res.json();
    return (j.models || [])
      .map(m => {
        const d = m.details || {};
        const bits = [d.parameter_size, d.quantization_level, m.size ? sizeOf(m.size) : ''].filter(Boolean).join(', ');
        return { id: m.model || m.name, name: bits ? `${m.name} (${bits})` : m.name, modifiedAt: Date.parse(m.modified_at) || null };
      })
      .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  },

  /** Reachable, and how many models are there to talk to. */
  async probe({ key, baseUrl }) {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { headers: auth(key), signal: AbortSignal.timeout(2000) });
      if (res.status === 401 || res.status === 403) return { ok: false, reachable: true, note: 'The server wants an API key.' };
      if (!res.ok) return { ok: false, reachable: false, note: `Ollama answered ${res.status} at ${baseUrl}.` };
      const count = ((await res.json()).models || []).length;
      return count
        ? { ok: true, reachable: true, models: count }
        : { ok: false, reachable: true, models: 0, note: 'Connected, but no models are pulled yet.' };
    } catch (e) {
      return { ok: false, reachable: false, note: `Not reachable at ${baseUrl}.` };
    }
  },

  request({ model, effort, maxTokens, system, messages, baseUrl, key }) {
    const msgs = messages.map(toMessage);
    if (system?.trim()) msgs.unshift({ role: 'system', content: system });
    const body = { model, messages: msgs, stream: true, options: {} };
    if (maxTokens) body.options.num_predict = maxTokens;
    if (effort === 'minimal') body.think = false;
    else if (effort) body.think = ({ xhigh: 'high', max: 'high' })[effort] || effort;
    return { url: `${baseUrl}/api/chat`, headers: { ...auth(key), 'content-type': 'application/json' }, body };
  },

  stream(ev) {
    if (ev.error) return { error: ev.error };
    const out = {};
    if (ev.message?.content) out.text = ev.message.content;
    if (ev.done) {
      out.finish = ev.done_reason === 'length' ? 'max_tokens' : ev.done_reason || 'stop';
      out.usage = { input_tokens: ev.prompt_eval_count, output_tokens: ev.eval_count };
    }
    return out;
  },

  mapError({ status, json, raw, headers }) {
    const message = json?.error || raw;
    if (status === 404 && /not found/i.test(message || '')) {
      return { kind: 'error', message: `${message}. Pull it first, from Settings or with "ollama pull".` };
    }
    if (status === 429) return { kind: 'limit', message, resetAt: parseResetHeader(headers, []) };
    if (status === 503 || /server busy|loading model/i.test(message || '')) return { kind: 'overloaded', message };
    return { kind: 'error', message };
  },

  dropUnsupported(body, message) {
    if (body.think !== undefined && /think/i.test(message)) {
      // A named level only works on some models; try plain on/off before giving up on it.
      if (typeof body.think === 'string') { body.think = true; return 'A thinking level'; }
      delete body.think;
      return 'Thinking';
    }
    return null;
  },
};
