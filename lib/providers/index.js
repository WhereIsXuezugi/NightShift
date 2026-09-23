import anthropic from './anthropic.js';
import openai from './openai.js';
import gemini from './gemini.js';
import ollama from './ollama.js';
import * as claudeCode from './claudeCode.js';
import * as chat from './chat.js';

export const CHAT_ADAPTERS = { anthropic, openai, gemini, ollama };

export const CLAUDE_CODE = {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'agent',
  // Files are handed over by path, so Claude Code can open anything on disk.
  caps: { image: true, pdf: true, video: 'path', audio: 'path', anyFile: true },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export const PROVIDERS = {
  anthropic: { ...anthropic, kind: 'chat' },
  'claude-code': CLAUDE_CODE,
  openai: { ...openai, kind: 'chat' },
  gemini: { ...gemini, kind: 'chat' },
  ollama: { ...ollama, kind: 'chat' },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const isChat = id => PROVIDERS[id]?.kind === 'chat';
export const adapterFor = id => CHAT_ADAPTERS[id];
export const runChat = chat.run;
export const messageText = chat.messageText;
export { claudeCode };

// Claude Code's --model takes these aliases, which always point at the latest of each.
export const CLAUDE_CODE_MODELS = [
  { id: 'opus', name: 'Opus (latest)' },
  { id: 'sonnet', name: 'Sonnet (latest)' },
  { id: 'haiku', name: 'Haiku (latest)' },
  { id: 'opusplan', name: 'Opus for planning, Sonnet for the work' },
  { id: 'fable', name: 'Fable (if your plan includes it)' },
];

// Older versions stored the Claude API under the id "api".
export const normalizeProvider = id => (id === 'api' ? 'anthropic' : id);

/** Whether a provider can actually take a message right now, and why not. */
export function readinessOf(id, settings, probes = {}) {
  const p = PROVIDERS[id];
  const conf = settings.providers?.[id] || {};
  if (id === 'claude-code') {
    const probe = probes[id];
    if (!probe) return { ready: true };
    return probe.ok ? { ready: true, note: probe.version } : { ready: false, note: probe.error || 'Claude Code was not found.' };
  }
  if (p.keyOptional) {
    const probe = probes[id];
    if (!probe) return { ready: false, note: 'Checking…' };
    return { ready: !!probe.ok, note: probe.note || (probe.models != null ? `${probe.models} model${probe.models === 1 ? '' : 's'}` : '') };
  }
  return conf.key ? { ready: true } : { ready: false, note: `Add your ${p.keyLabel} in Settings.` };
}

/** What the browser and the public API need to know about each provider. */
export function describeProviders(settings, probes = {}) {
  return PROVIDER_IDS.map(id => {
    const p = PROVIDERS[id];
    const conf = settings.providers?.[id] || {};
    const r = readinessOf(id, settings, probes);
    return {
      id,
      label: p.label,
      kind: p.kind,
      efforts: p.efforts,
      caps: p.caps,
      ready: r.ready,
      status_note: r.note || '',
      key_set: p.kind === 'chat' ? !!conf.key : undefined,
      key_optional: !!p.keyOptional,
      key_hint: conf.key ? `…${conf.key.slice(-4)}` : '',
      key_from_env: !!conf.fromEnv,
      key_label: p.keyLabel,
      console_url: p.consoleUrl,
      base_url: conf.baseUrl,
      default_base_url: p.defaultBaseUrl,
      supports_conversations: p.kind === 'chat',
    };
  });
}
