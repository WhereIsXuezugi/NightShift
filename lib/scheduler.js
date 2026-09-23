import path from 'node:path';
import { PROVIDERS, adapterFor, isChat, runChat, claudeCode as cc } from './providers/index.js';
import { ACTIVE_STATUSES } from './jobs.js';
import { notify } from './events.js';
import crypto from 'node:crypto';
import { nextOccurrence, describeRepeat } from './time.js';

const MAX_LIMIT_WAITS = 40;  // stop waiting out limits after this many tries
const MAX_TRANSIENT = 6;     // overloaded / network retries
// What a repeat copies from the chain it repeats; everything else starts fresh.
const SPEC_FIELDS = ['provider', 'prompt', 'files', 'model', 'effort', 'mode', 'delayMs', 'maxTokens', 'retryOnLimit',
  'webhookUrl', 'label', 'conversationId', 'threadKey', 'sessionId', 'cwd', 'permissionMode', 'newSession', 'source'];
const fmt = ts => new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export class Scheduler {
  constructor({ store, events, settings }) {
    this.store = store;
    this.events = events;
    this.settings = settings;
    this.running = new Map(); // provider -> { jobId, controller }
    this.live = new Map();    // jobId -> text streamed so far
  }

  start() {
    for (const job of Object.values(this.store.data.jobs)) {
      if (job.status === 'running') { job.status = 'scheduled'; job.nextAttemptAt = Date.now(); }
    }
    this.store.save();
    this.interval = setInterval(() => this.tick(), 5000);
    this.tick();
  }

  stop() { clearInterval(this.interval); }
  kick() { setImmediate(() => this.tick()); }

  limitFor(provider) { return this.store.data.limits[provider] || null; }

  setLimit(provider, patch) {
    this.store.data.limits[provider] = patch ? { ...patch, updatedAt: Date.now() } : { limitedUntil: null, updatedAt: Date.now() };
    this.store.save();
    this.events.send('limits', this.store.data.limits);
  }

  update(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.store.save();
    this.events.send('job', job);
  }

  afterReset(lim) {
    return lim.limitedUntil + (lim.resetKnown ? this.settings().resetBufferSec * 1000 : 0);
  }

  /** Decides when a job should first be attempted. */
  plan(job) {
    const now = Date.now();
    if (job.mode === 'at') job.nextAttemptAt = job.runAt;
    else if (job.mode === 'reset') {
      const lim = this.limitFor(job.provider);
      job.nextAttemptAt = lim?.limitedUntil && lim.limitedUntil > now ? this.afterReset(lim) : now;
      if (job.nextAttemptAt > now) job.status = 'waiting_limit';
    } else job.nextAttemptAt = now + (job.mode === 'after' ? job.delayMs || 0 : 0);
    if (this.depState(job) === 'waiting') job.status = 'waiting_step';
    return job;
  }

  /** Messages in one conversation go out in the order they were written. */
  threadOf(j) { return j.threadKey || (j.conversationId ? `conv:${j.conversationId}` : `cc:${j.sessionId}`); }

  depState(job) {
    if (!job.dependsOn) return 'ready';
    const dep = this.store.data.jobs[job.dependsOn];
    if (!dep || dep.status === 'done') return 'ready';
    if (['failed', 'cancelled', 'blocked'].includes(dep.status)) return 'broken';
    return 'waiting';
  }

  tick() {
    const now = Date.now();
    const jobs = Object.values(this.store.data.jobs);

    // Keep chain states honest before picking what to run next.
    for (const j of jobs) {
      if (j.status === 'running') continue;
      const dep = this.depState(j);
      if (ACTIVE_STATUSES.has(j.status)) {
        if (dep === 'waiting' && j.status !== 'waiting_step') this.update(j, { status: 'waiting_step' });
        else if (dep === 'broken') this.update(j, { status: 'blocked', lastError: 'The message before this one did not send.' });
        else if (dep === 'ready' && j.status === 'waiting_step') this.update(j, { status: 'scheduled' });
      }
    }

    for (const provider of Object.keys(PROVIDERS)) {
      if (this.running.has(provider)) continue;
      const due = jobs
        .filter(j => j.provider === provider && ['scheduled', 'waiting_limit'].includes(j.status)
          && this.depState(j) === 'ready' && j.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt);
      if (!due.length) continue;

      let job = due[0];
      // Something written earlier in the same thread goes first, unless it is waiting on a
      // clock of its own (a set time, or a chain whose first message has a set time).
      const earlier = jobs.filter(j => ACTIVE_STATUSES.has(j.status) && this.threadOf(j) === this.threadOf(job)
        && j.createdAt < job.createdAt && j.mode !== 'at' && j.status !== 'waiting_step');
      if (earlier.length) {
        const first = earlier.sort((a, b) => a.createdAt - b.createdAt)[0];
        if (first.nextAttemptAt <= now && this.depState(first) === 'ready' && first.status !== 'running') job = first;
        else if (!job.force) { this.update(job, { nextAttemptAt: Math.max(first.nextAttemptAt, now) + 1000 }); continue; }
      }

      const lim = this.limitFor(provider);
      if (lim?.limitedUntil && lim.limitedUntil > now && !job.force) {
        for (const j of due) {
          if (j.mode === 'reset' || j.retryOnLimit) this.update(j, { status: 'waiting_limit', nextAttemptAt: this.afterReset(lim) });
          else this.update(j, { status: 'failed', lastError: `A usage limit is active until ${fmt(lim.limitedUntil)} and "wait for the reset" was off.`, finishedAt: now });
        }
        continue;
      }

      this.execute(job).catch(e => {
        console.error('[scheduler]', e);
        this.running.delete(provider);
        this.update(job, { status: 'failed', lastError: `Internal error: ${e.message}`, finishedAt: Date.now() });
      });
    }
  }

  cancel(job) {
    const r = this.running.get(job.provider);
    if (r?.jobId === job.id) r.controller.abort();
    this.update(job, { status: 'cancelled', finishedAt: Date.now() });
    this.releaseDependents(job, false);
  }

  async execute(job) {
    const controller = new AbortController();
    this.running.set(job.provider, { jobId: job.id, controller });
    this.live.set(job.id, '');
    this.update(job, { status: 'running', startedAt: Date.now(), attempts: (job.attempts || 0) + 1, force: false });

    let lastPush = 0;
    const onDelta = chunk => {
      const text = (this.live.get(job.id) || '') + chunk;
      this.live.set(job.id, text);
      if (Date.now() - lastPush > 400) { lastPush = Date.now(); this.events.send('live', { jobId: job.id, text }); }
    };

    const r = isChat(job.provider)
      ? await this.runChatJob(job, controller.signal, onDelta)
      : await this.runCodeJob(job, controller.signal, onDelta);

    this.running.delete(job.provider);
    this.live.delete(job.id);
    if (job.status === 'cancelled') { this.kick(); return; }
    await this.settle(job, r);
    this.kick();
  }

  async runChatJob(job, signal, onDelta) {
    const conv = this.store.data.conversations[job.conversationId];
    if (!conv) return { ok: false, kind: 'error', error: 'That conversation was deleted.' };
    const s = this.settings();
    const conf = s.providers[job.provider] || {};
    const adapter = adapterFor(job.provider);
    if (!adapter) return { ok: false, kind: 'error', error: `Provider "${job.provider}" is not available.` };
    if (!conf.key && !adapter.keyOptional) return { ok: false, kind: 'error', error: `No ${adapter.label} API key. Add one in Settings.` };
    const model = job.model || conv.model;
    if (!model) return { ok: false, kind: 'error', error: 'Choose a model.' };

    const r = await runChat({
      adapter, key: conf.key, baseUrl: conf.baseUrl, model, effort: job.effort,
      maxTokens: job.maxTokens || adapter.defaultMaxTokens, system: conv.system,
      history: conv.messages, prompt: job.prompt, fileIds: job.files, files: this.store.data.files, signal, onDelta,
    });

    if (r.ok && job.status !== 'cancelled') {
      const now = Date.now();
      conv.messages.push({ role: 'user', text: job.prompt, files: job.files, at: job.startedAt, jobId: job.id });
      conv.messages.push({ role: 'assistant', text: r.text, model, usage: r.usage, stopReason: r.stopReason, at: now, jobId: job.id });
      conv.model = model;
      if (!conv.titled && job.prompt.trim()) { conv.title = job.prompt.trim().replace(/\s+/g, ' ').slice(0, 60); conv.titled = true; }
      conv.updatedAt = now;
      this.events.send('conversation', { id: conv.id });
    }
    return r;
  }

  async runCodeJob(job, signal, onDelta) {
    const s = this.settings();
    const files = (job.files || []).map(id => this.store.data.files[id]).filter(Boolean);
    let prompt = job.prompt;
    const addDirs = [...new Set(files.map(f => path.dirname(f.path)))];
    if (files.length) {
      prompt += '\n\nAttached files (read them with your tools):\n' + files.map(f => `- ${f.path}  (${f.name}, ${f.kind})`).join('\n');
      if (files.some(f => f.kind === 'video')) prompt += '\nFor videos, pull a few frames with ffmpeg if you need to see them.';
    }
    return cc.run({
      bin: s.claudeBin, cwd: job.cwd || s.claudeCwd, prompt, model: job.model, effort: job.effort,
      sessionId: job.sessionId, permissionMode: job.permissionMode, addDirs, signal,
      timeoutMs: s.ccTimeoutMin * 60000, onDelta,
    });
  }

  /**
   * A repeating message has just run (or failed for good): queue the next
   * occurrence of its whole chain, at the same time of day.
   */
  repeatChain(head) {
    if (!head.repeat || head.dependsOn || head.repeatedBy) return null;
    const from = head.runAt || head.anchorAt || head.startedAt || Date.now();
    const at = nextOccurrence(from, head.repeat.every, head.repeat.timezone);
    if (!at) return null;
    const all = Object.values(this.store.data.jobs);
    const order = [head];
    for (let cur = head, next; (next = all.find(j => j.dependsOn === cur.id && j.chainId === head.chainId)); cur = next) order.push(next);

    const now = Date.now();
    const chainId = crypto.randomUUID();
    const fresh = head.provider === 'claude-code' && head.newSession;
    const threadKey = fresh ? `new:${crypto.randomUUID()}` : head.threadKey;
    let prev = null;
    const created = [];
    order.forEach((t, i) => {
      const job = Object.fromEntries(SPEC_FIELDS.filter(k => t[k] !== undefined).map(k => [k, t[k]]));
      Object.assign(job, {
        id: crypto.randomUUID(), chainId, dependsOn: prev?.id || null, repeatOf: t.id,
        status: 'scheduled', attempts: 0, createdAt: now + i, updatedAt: now, nextAttemptAt: now, result: null, lastError: null,
      });
      if (i === 0) Object.assign(job, { mode: 'at', runAt: at, repeat: head.repeat });
      if (fresh) Object.assign(job, { sessionId: null, threadKey });
      this.plan(job);
      this.store.data.jobs[job.id] = job;
      created.push(job);
      prev = job;
    });
    head.repeatedBy = created[0].id;
    this.store.save();
    for (const j of created) this.events.send('job', j);
    this.events.send('job', head);
    return created[0];
  }

  /** Releases whatever was queued behind a job that just finished. */
  releaseDependents(job, ok) {
    const now = Date.now();
    for (const j of Object.values(this.store.data.jobs)) {
      if (j.dependsOn !== job.id || !ACTIVE_STATUSES.has(j.status)) continue;
      if (!ok) { this.update(j, { status: 'blocked', lastError: 'The message before this one did not send.' }); continue; }
      if (j.provider === 'claude-code' && !j.sessionId && job.result?.sessionId) j.sessionId = job.result.sessionId;
      const at = j.mode === 'at' ? Math.max(j.runAt, now) : now + (j.delayMs || 0);
      this.update(j, { status: 'scheduled', nextAttemptAt: at });
    }
  }

  async settle(job, r) {
    const s = this.settings();
    const now = Date.now();
    const label = PROVIDERS[job.provider]?.label || job.provider;
    const snippet = job.prompt.trim().replace(/\s+/g, ' ').slice(0, 80);

    if (r.ok) {
      this.setLimit(job.provider, null);
      const result = { text: r.text, usage: r.usage, costUsd: r.costUsd, sessionId: r.sessionId, note: r.note };
      this.update(job, { status: 'done', result, finishedAt: now, lastError: null });

      // A brand-new Claude Code session: point queued follow-ups at the session it created.
      if (job.provider === 'claude-code' && !job.sessionId && r.sessionId && job.threadKey) {
        for (const j of Object.values(this.store.data.jobs)) {
          if (j.id !== job.id && j.threadKey === job.threadKey && !j.sessionId && ACTIVE_STATUSES.has(j.status)) this.update(j, { sessionId: r.sessionId });
        }
      }
      this.releaseDependents(job, true);
      const next = this.repeatChain(job);
      await this.callWebhook(job);
      if (job.mode !== 'now' || job.attempts > 1) {
        const again = next ? `\n\nRepeats ${describeRepeat(job.repeat.every)}, next ${fmt(next.runAt)}.` : '';
        await notify(s.notifyUrl, `Sent to ${label}`, `"${snippet}"\n\nReply: ${(r.text || '').slice(0, 600)}${again}`);
      }
      return;
    }

    if (r.kind === 'cancelled') { this.releaseDependents(job, false); return; }

    if (r.kind === 'limit' || r.kind === 'credit') {
      const known = !!r.resetAt && r.resetAt > now;
      const pollMs = (r.kind === 'credit' ? Math.max(s.pollMinutes, 30) : s.pollMinutes) * 60000;
      const until = known ? r.resetAt : now + pollMs;
      this.setLimit(job.provider, { limitedUntil: until, resetKnown: known, reason: r.kind, message: r.error });
      const waits = (job.limitWaits || 0) + 1;
      if ((job.mode === 'reset' || job.retryOnLimit) && waits <= MAX_LIMIT_WAITS) {
        const next = this.afterReset({ limitedUntil: until, resetKnown: known });
        this.update(job, { status: 'waiting_limit', nextAttemptAt: next, limitWaits: waits, lastError: r.error });
        if (waits === 1) {
          const when = known ? `at ${fmt(next)}` : `(reset time unknown, checking every ${Math.round(pollMs / 60000)} min)`;
          await notify(s.notifyUrl, `${label} limit reached`, `Will send "${snippet}" ${when}.`);
        }
        return;
      }
      this.update(job, { status: 'failed', lastError: r.error, finishedAt: now });
      this.releaseDependents(job, false);
      this.repeatChain(job);
      await this.callWebhook(job);
      await notify(s.notifyUrl, `Message not sent (${label})`, `${r.error}\n\n"${snippet}"`);
      return;
    }

    if (r.kind === 'overloaded') {
      const tries = (job.transientTries || 0) + 1;
      if (tries <= MAX_TRANSIENT) {
        const delay = Math.min(2 ** tries, 30) * 60000;
        this.update(job, { status: 'scheduled', nextAttemptAt: now + delay, transientTries: tries, lastError: `${r.error} (retrying at ${fmt(now + delay)})` });
        return;
      }
    }

    this.update(job, { status: 'failed', lastError: r.error, finishedAt: now, result: r.sessionId ? { sessionId: r.sessionId } : job.result });
    this.releaseDependents(job, false);
    this.repeatChain(job);
    await this.callWebhook(job);
    await notify(s.notifyUrl, `Message failed (${label})`, `${r.error}\n\n"${snippet}"`);
  }

  /** Per-message callback, so orchestration tools don't have to poll. */
  async callWebhook(job) {
    if (!job.webhookUrl) return;
    try {
      await fetch(job.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Nightshift' },
        body: JSON.stringify({
          event: job.status === 'done' ? 'message.sent' : 'message.failed',
          job,
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      console.warn(`[webhook] ${job.id}: ${e.message}`);
    }
  }
}
