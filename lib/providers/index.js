import anthropic from './anthropic.js';
import openai from './openai.js';
import gemini from './gemini.js';
import * as claudeCode from './claudeCode.js';
import * as chat from './chat.js';

export const CHAT_ADAPTERS = { anthropic, openai, gemini };

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
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const isChat = id => PROVIDERS[id]?.kind === 'chat';
export const adapterFor = id => CHAT_ADAPTERS[id];
export const runChat = chat.run;
export const messageText = chat.messageText;
export { claudeCode };

// Older versions stored the Claude API under the id "api".
export const normalizeProvider = id => (id === 'api' ? 'anthropic' : id);

/** What the browser and the public API need to know about each provider. */
export function describeProviders(settings) {
  return PROVIDER_IDS.map(id => {
    const p = PROVIDERS[id];
    const conf = settings.providers?.[id] || {};
    return {
      id,
      label: p.label,
      kind: p.kind,
      efforts: p.efforts,
      caps: p.caps,
      ready: p.kind === 'chat' ? !!conf.key : true,
      key_set: p.kind === 'chat' ? !!conf.key : undefined,
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
