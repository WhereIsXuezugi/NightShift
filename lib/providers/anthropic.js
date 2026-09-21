import { parseResetHeader } from './chat.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const content = parts => parts.map(p => {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.mime === 'application/pdf') return { type: 'document', title: p.name, source: { type: 'base64', media_type: p.mime, data: p.data } };
  return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } };
});

export default {
  id: 'anthropic',
  label: 'Claude API',
  keyLabel: 'Anthropic API key',
  keyPrefix: 'sk-ant-',
  keyEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: 'ANTHROPIC_BASE_URL',
  defaultBaseUrl: 'https://api.anthropic.com',
  consoleUrl: 'https://console.anthropic.com/settings/keys',
  caps: { image: true, pdf: true, video: 'frames', audio: false },
  efforts: EFFORTS,
  defaultMaxTokens: 16000,

  async listModels({ key, baseUrl }) {
    const out = [];
    let after = null;
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${baseUrl}/v1/models`);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
      const res = await fetch(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      if (!res.ok) throw new Error(`Couldn't load Claude models (${res.status}). Check the API key.`);
      const j = await res.json();
      for (const m of j.data || []) out.push({ id: m.id, name: m.display_name || m.id });
      if (!j.has_more) break;
      after = j.last_id;
    }
    return out;
  },

  request({ model, effort, maxTokens, system, messages, baseUrl, key }) {
    const body = {
      model,
      max_tokens: maxTokens || this.defaultMaxTokens,
      stream: true,
      messages: messages.map(m => ({ role: m.role, content: content(m.parts) })),
    };
    if (system?.trim()) body.system = system;
    if (effort) body.output_config = { effort };
    return {
      url: `${baseUrl}/v1/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body,
    };
  },

  stream(ev, state) {
    switch (ev.type) {
      case 'message_start': return { usage: ev.message?.usage };
      case 'content_block_delta': return ev.delta?.type === 'text_delta' ? { text: ev.delta.text } : null;
      case 'message_delta': return { usage: ev.usage, finish: ev.delta?.stop_reason };
      case 'error': return { error: ev.error?.message || 'Stream error' };
      default: return null;
    }
  },

  mapError({ status, json, headers }) {
    const message = json?.error?.message;
    if (status === 429) {
      return {
        kind: 'limit',
        message,
        resetAt: parseResetHeader(headers, ['anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-requests-reset',
          'anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-output-tokens-reset']),
      };
    }
    if (/credit balance/i.test(message || '')) return { kind: 'credit', message };
    if (status === 529) return { kind: 'overloaded', message };
    return { kind: 'error', message };
  },

  dropUnsupported(body, message) {
    if (body.output_config && /effort|output_config/i.test(message)) { delete body.output_config; return 'Effort'; }
    return null;
  },
};
