import { CHAT_ADAPTERS, claudeCode as cc } from './providers/index.js';

/**
 * Keeps a recent answer to "can this provider take a message?" for the
 * providers where a key isn't the whole story: a local Ollama server that may
 * be off, and a claude command that may not be installed.
 */
export class Readiness {
  constructor(settings, events) {
    this.settings = settings;
    this.events = events;
    this.probes = {};
    this.checkedAt = 0;
    this.pending = null;
  }

  async refresh({ maxAgeMs = 0 } = {}) {
    if (this.pending) return this.pending;
    if (Date.now() - this.checkedAt < maxAgeMs) return this.probes;
    this.pending = (async () => {
      const s = this.settings();
      const next = {};
      const jobs = [cc.version(s.claudeBin).then(r => { next['claude-code'] = r; })];
      for (const [id, adapter] of Object.entries(CHAT_ADAPTERS)) {
        if (adapter.probe) jobs.push(adapter.probe(s.providers[id]).then(r => { next[id] = r; }));
      }
      await Promise.all(jobs);
      const changed = JSON.stringify(next) !== JSON.stringify(this.probes);
      this.probes = next;
      this.checkedAt = Date.now();
      if (changed) this.events?.send('providers', {});
      return next;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  start(intervalMs = 60000) {
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }
}
