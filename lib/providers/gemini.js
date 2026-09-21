import { parseDuration } from './chat.js';

const parts = ps => ps.map(p => p.type === 'text'
  ? { text: p.text }
  : { inline_data: { mime_type: p.mime, data: p.data } });

export default {
  id: 'gemini',
  label: 'Gemini',
  keyLabel: 'Google AI Studio API key',
  keyPrefix: 'AIza',
  keyEnv: 'GEMINI_API_KEY',
  baseUrlEnv: 'GEMINI_BASE_URL',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  consoleUrl: 'https://aistudio.google.com/apikey',
  // Gemini reads video and audio directly, so short clips go up as-is.
  caps: { image: true, pdf: true, video: 'native', audio: 'native' },
  efforts: ['minimal', 'low', 'medium', 'high'],
  defaultMaxTokens: 16000,
  effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },

  async listModels({ key, baseUrl }) {
    const res = await fetch(`${baseUrl}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new Error(`Couldn't load Gemini models (${res.status}). Check the API key.`);
    const j = await res.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
  },

  request({ model, effort, maxTokens, system, messages, baseUrl, key }) {
    const body = {
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: parts(m.parts) })),
      generationConfig: {},
    };
    if (system?.trim()) body.systemInstruction = { parts: [{ text: system }] };
    if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
    if (effort) body.generationConfig.thinkingConfig = { thinkingLevel: this.effortMap[effort] || effort };
    return {
      url: `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body,
    };
  },

  stream(ev) {
    if (ev.error) return { error: ev.error.message || 'Stream error' };
    const cand = ev.candidates?.[0];
    const out = {};
    const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (text) out.text = text;
    if (cand?.finishReason) out.finish = cand.finishReason;
    if (ev.usageMetadata) out.usage = { input_tokens: ev.usageMetadata.promptTokenCount, output_tokens: ev.usageMetadata.candidatesTokenCount };
    return out;
  },

  mapError({ status, json, headers }) {
    const err = json?.error || {};
    const message = err.message;
    if (status === 429) {
      // Gemini returns the wait as a RetryInfo detail, e.g. { retryDelay: "35s" }.
      const detail = (err.details || []).find(d => d.retryDelay);
      const ms = detail ? parseDuration(detail.retryDelay) : null;
      const retryAfter = headers.get('retry-after');
      const resetAt = ms != null ? Date.now() + ms
        : retryAfter && !isNaN(+retryAfter) ? Date.now() + +retryAfter * 1000
        : null;
      if (/quota|billing/i.test(message || '') && !resetAt) return { kind: 'limit', message, resetAt: null };
      return { kind: 'limit', message, resetAt };
    }
    if (status === 503 || /overloaded/i.test(message || '')) return { kind: 'overloaded', message };
    return { kind: 'error', message };
  },

  dropUnsupported(body, message) {
    const cfg = body.generationConfig || {};
    if (cfg.thinkingConfig && /thinking|thinkingLevel|thinking_config/i.test(message)) { delete cfg.thinkingConfig; return 'Thinking level'; }
    return null;
  },
};
