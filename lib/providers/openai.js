import { parseResetHeader } from './chat.js';

// Chat Completions is used rather than Responses because it is also what every
// OpenAI-compatible gateway speaks: OpenRouter, Together, Groq, vLLM, LM Studio,
// Ollama. Point the base URL at one of those and this adapter works unchanged.
const content = parts => parts.map(p => {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.mime === 'application/pdf') return { type: 'file', file: { filename: p.name, file_data: `data:${p.mime};base64,${p.data}` } };
  if (p.mime.startsWith('audio/')) return { type: 'input_audio', input_audio: { data: p.data, format: p.mime.includes('wav') ? 'wav' : 'mp3' } };
  return { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } };
});

export default {
  id: 'openai',
  label: 'OpenAI',
  keyLabel: 'OpenAI API key',
  keyPrefix: 'sk-',
  keyEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_BASE_URL',
  defaultBaseUrl: 'https://api.openai.com/v1',
  consoleUrl: 'https://platform.openai.com/api-keys',
  caps: { image: true, pdf: true, video: 'frames', audio: false },
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  defaultMaxTokens: 16000,
  // The app's shared effort scale, translated to what this API accepts.
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'high' },

  async listModels({ key, baseUrl }) {
    const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Couldn't load OpenAI models (${res.status}). Check the API key or base URL.`);
    const j = await res.json();
    return (j.data || [])
      .map(m => ({ id: m.id, name: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  request({ model, effort, maxTokens, system, messages, baseUrl, key }) {
    const msgs = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content(m.parts) }));
    if (system?.trim()) msgs.unshift({ role: 'system', content: system });
    const body = { model, messages: msgs, stream: true, stream_options: { include_usage: true } };
    if (maxTokens) body.max_completion_tokens = maxTokens;
    if (effort) body.reasoning_effort = this.effortMap[effort] || effort;
    return {
      url: `${baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
    };
  },

  stream(ev, state) {
    if (ev.error) return { error: ev.error.message || 'Stream error' };
    const choice = ev.choices?.[0];
    const out = {};
    if (choice?.delta?.content) out.text = typeof choice.delta.content === 'string'
      ? choice.delta.content
      : choice.delta.content.map(c => c.text || '').join('');
    if (choice?.finish_reason) out.finish = choice.finish_reason;
    if (ev.usage) out.usage = { input_tokens: ev.usage.prompt_tokens, output_tokens: ev.usage.completion_tokens };
    return out;
  },

  mapError({ status, json, headers }) {
    const err = json?.error || {};
    const message = err.message;
    if (status === 429) {
      if (/quota|billing|credit/i.test(`${err.code} ${message}`)) return { kind: 'credit', message };
      return { kind: 'limit', message, resetAt: parseResetHeader(headers, ['x-ratelimit-reset-tokens', 'x-ratelimit-reset-requests']) };
    }
    if (status === 402 || /insufficient_quota/i.test(err.code || '')) return { kind: 'credit', message };
    if (status === 503) return { kind: 'overloaded', message };
    return { kind: 'error', message };
  },

  dropUnsupported(body, message) {
    if (body.reasoning_effort && /reasoning_effort|reasoning\.effort|unsupported value/i.test(message)) { delete body.reasoning_effort; return 'Reasoning effort'; }
    if (body.max_completion_tokens && /max_completion_tokens/i.test(message)) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
      return 'max_completion_tokens (used max_tokens instead)';
    }
    if (body.stream_options && /stream_options/i.test(message)) { delete body.stream_options; return 'Usage reporting'; }
    return null;
  },
};
