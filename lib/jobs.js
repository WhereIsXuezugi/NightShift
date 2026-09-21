import crypto from 'node:crypto';
import fs from 'node:fs';
import { PROVIDERS, isChat, normalizeProvider } from './providers/index.js';

export const MODES = ['now', 'at', 'reset', 'after'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const ACTIVE_STATUSES = new Set(['scheduled', 'waiting_limit', 'waiting_step', 'running']);
export const EDITABLE_STATUSES = new Set(['scheduled', 'waiting_limit', 'waiting_step', 'blocked', 'failed', 'cancelled']);

class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const bad = m => { throw new BadRequest(m); };

// Accepts snake_case (nicer for scripts) or camelCase (nicer for the browser).
const pick = (o, ...names) => {
  for (const n of names) if (o?.[n] !== undefined) return o[n];
  return undefined;
};

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

/**
 * Normalizes a request body into a chain of steps, whichever shape it arrived in:
 *   { text: "…" }                      one message
 *   { messages: [{ text }, { text }] }  several, each sent after the one before
 */
export function parseSpec(body, { store, settings }) {
  const provider = normalizeProvider(str(pick(body, 'provider'), 'anthropic'));
  if (!PROVIDERS[provider]) bad(`Unknown provider "${provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);

  const rawSteps = pick(body, 'messages', 'steps');
  const steps = Array.isArray(rawSteps) && rawSteps.length ? rawSteps : [body];
  if (steps.length > 50) bad('A chain can hold at most 50 messages.');

  const shared = {};
  if (isChat(provider)) {
    const convId = str(pick(body, 'conversation_id', 'conversationId'));
    const conv = store.data.conversations[convId];
    if (!conv) bad('Set conversation_id to an existing conversation (create one first).');
    if (normalizeProvider(conv.provider) !== provider) bad(`That conversation belongs to "${conv.provider}", not "${provider}".`);
    shared.conversationId = conv.id;
    shared.threadKey = `conv:${conv.id}`;
  } else {
    const sessionId = str(pick(body, 'session_id', 'sessionId'));
    if (sessionId && !/^[\w-]{6,80}$/.test(sessionId)) bad('session_id does not look like a Claude Code session id.');
    const cwd = str(pick(body, 'cwd', 'folder'), settings.claudeCwd);
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) bad(`Folder not found on the server: ${cwd}`);
    shared.sessionId = sessionId || null;
    shared.cwd = cwd;
    shared.threadKey = str(pick(body, 'thread_key', 'threadKey')) || sessionId || `new:${crypto.randomUUID()}`;
    const perm = str(pick(body, 'permission_mode', 'permissionMode'), 'default');
    if (!PERMISSION_MODES.includes(perm)) bad(`permission_mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
    shared.permissionMode = perm;
  }

  const webhookUrl = str(pick(body, 'webhook_url', 'webhookUrl'));
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) bad('webhook_url must start with http:// or https://');

  const parsed = steps.map((s, i) => {
    const prompt = str(pick(s, 'text', 'prompt', 'content'));
    const files = (pick(s, 'files', 'attachments', 'file_ids') || []).map(String);
    for (const id of files) if (!store.data.files[id]) bad(`Unknown attachment id "${id}". Upload it first.`);
    if (!prompt.trim() && !files.length) bad(`Message ${i + 1} is empty. Add text or an attachment.`);

    const model = str(pick(s, 'model'), str(pick(body, 'model')));
    if (model && !/^[\w.\-:[\]@/]{1,100}$/.test(model)) bad('That model name has characters it should not.');
    const effort = str(pick(s, 'effort'), str(pick(body, 'effort')));
    if (!EFFORTS.includes(effort)) bad(`effort must be one of: ${EFFORTS.filter(Boolean).join(', ')}.`);

    // The first message defaults to sending now; the rest wait for the reply before them.
    let mode = str(pick(s, 'mode', 'when'), str(pick(body, 'mode', 'when'), i === 0 ? 'now' : 'after'));
    if (i === 0 && mode === 'after') mode = 'now';
    if (!MODES.includes(mode)) bad(`mode must be one of: ${MODES.join(', ')}.`);

    let runAt = pick(s, 'run_at', 'runAt') ?? pick(body, 'run_at', 'runAt');
    if (typeof runAt === 'string') runAt = Date.parse(runAt);
    if (mode === 'at') {
      if (!runAt || isNaN(runAt)) bad('mode "at" needs run_at (epoch milliseconds or an ISO timestamp).');
      if (runAt < Date.now() - 60000) bad('run_at is in the past.');
    }

    const delaySeconds = +(pick(s, 'delay_seconds', 'delaySeconds') ?? 0) || 0;
    if (delaySeconds < 0 || delaySeconds > 86400) bad('delay_seconds must be between 0 and 86400.');

    const maxTokens = +(pick(s, 'max_tokens', 'maxTokens') ?? pick(body, 'max_tokens', 'maxTokens') ?? 0) || 0;
    const retry = pick(s, 'retry_on_limit', 'retryOnLimit') ?? pick(body, 'retry_on_limit', 'retryOnLimit');

    return {
      ...shared,
      provider,
      prompt,
      files,
      model,
      effort,
      mode,
      runAt: mode === 'at' ? runAt : null,
      delayMs: Math.round(delaySeconds * 1000),
      maxTokens: maxTokens ? Math.min(200000, Math.max(256, maxTokens)) : 0,
      retryOnLimit: retry !== false,
      webhookUrl: str(pick(s, 'webhook_url', 'webhookUrl'), webhookUrl),
      label: str(pick(s, 'label')).slice(0, 80),
    };
  });

  if (isChat(provider)) {
    const conv = store.data.conversations[shared.conversationId];
    for (const p of parsed) {
      if (!p.model) p.model = conv.model;
      if (!p.model) bad('No model set. Pass model, or set one on the conversation.');
      if (!p.maxTokens) p.maxTokens = PROVIDERS[provider].defaultMaxTokens;
    }
  }
  return parsed;
}

/** Creates one job per step, each waiting on the one before it. */
export function createChain({ store, scheduler, events }, steps, source = 'web') {
  const now = Date.now();
  const jobs = [];
  let previous = null;
  for (const step of steps) {
    const job = {
      id: crypto.randomUUID(),
      ...step,
      dependsOn: previous?.id || null,
      source,
      status: 'scheduled',
      attempts: 0,
      createdAt: now + jobs.length, // keeps chain order stable when created in one call
      updatedAt: now,
      nextAttemptAt: now,
      result: null,
      lastError: null,
    };
    scheduler.plan(job);
    store.data.jobs[job.id] = job;
    jobs.push(job);
    previous = job;
  }
  store.save();
  for (const j of jobs) events.send('job', j);
  scheduler.kick();
  return jobs;
}

/** Edits a queued message. Only fields that make sense for its state can change. */
export function patchJob({ store, scheduler }, job, patch) {
  if (job.status === 'running') bad('That message is sending right now. Cancel it first.');
  if (job.status === 'done') bad('That message has already been sent.');

  const set = {};
  const text = pick(patch, 'text', 'prompt');
  if (text !== undefined) {
    const files = pick(patch, 'files') ?? job.files;
    if (!str(text).trim() && !files.length) bad('A message needs text or an attachment.');
    set.prompt = str(text);
  }
  const files = pick(patch, 'files', 'attachments');
  if (files !== undefined) {
    for (const id of files) if (!store.data.files[id]) bad(`Unknown attachment id "${id}".`);
    set.files = files.map(String);
  }
  const model = pick(patch, 'model');
  if (model !== undefined) {
    if (model && !/^[\w.\-:[\]@/]{1,100}$/.test(model)) bad('That model name has characters it should not.');
    set.model = str(model);
  }
  const effort = pick(patch, 'effort');
  if (effort !== undefined) {
    if (!EFFORTS.includes(str(effort))) bad(`effort must be one of: ${EFFORTS.filter(Boolean).join(', ')}.`);
    set.effort = str(effort);
  }
  const perm = pick(patch, 'permission_mode', 'permissionMode');
  if (perm !== undefined) {
    if (!PERMISSION_MODES.includes(perm)) bad(`permission_mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
    set.permissionMode = perm;
  }
  const maxTokens = pick(patch, 'max_tokens', 'maxTokens');
  if (maxTokens !== undefined) set.maxTokens = Math.min(200000, Math.max(256, +maxTokens || 0));
  const retry = pick(patch, 'retry_on_limit', 'retryOnLimit');
  if (retry !== undefined) set.retryOnLimit = retry !== false;
  const webhook = pick(patch, 'webhook_url', 'webhookUrl');
  if (webhook !== undefined) {
    if (webhook && !/^https?:\/\//.test(webhook)) bad('webhook_url must start with http:// or https://');
    set.webhookUrl = str(webhook);
  }
  const delaySeconds = pick(patch, 'delay_seconds', 'delaySeconds');
  if (delaySeconds !== undefined) set.delayMs = Math.round(Math.min(86400, Math.max(0, +delaySeconds || 0)) * 1000);

  const mode = pick(patch, 'mode', 'when');
  let runAt = pick(patch, 'run_at', 'runAt');
  if (typeof runAt === 'string') runAt = Date.parse(runAt);
  if (mode !== undefined || runAt !== undefined) {
    const newMode = mode === undefined ? job.mode : str(mode);
    if (!MODES.includes(newMode)) bad(`mode must be one of: ${MODES.join(', ')}.`);
    if (newMode === 'after' && !job.dependsOn) bad('mode "after" only applies to a message that follows another one.');
    if (newMode === 'at') {
      const when = runAt === undefined ? job.runAt : runAt;
      if (!when || isNaN(when)) bad('mode "at" needs run_at.');
      if (when < Date.now() - 60000) bad('run_at is in the past.');
      set.runAt = when;
    } else set.runAt = null;
    set.mode = newMode;
  }

  Object.assign(job, set, { updatedAt: Date.now(), lastError: null });
  // Editing a message that had given up puts it back in the queue.
  if (['failed', 'cancelled', 'blocked'].includes(job.status)) {
    job.status = 'scheduled';
    job.attempts = 0;
    job.transientTries = 0;
    job.limitWaits = 0;
    job.finishedAt = null;
  }
  scheduler.plan(job);
  store.save();
  scheduler.kick();
  return job;
}

export function deleteJob({ store, scheduler, events }, job, { cascade = true } = {}) {
  if (job.status === 'running') bad('That message is sending right now. Cancel it first.');
  const removed = [job.id];
  if (cascade) {
    // Re-link anything queued behind it so the rest of the chain still runs.
    for (const j of Object.values(store.data.jobs)) {
      if (j.dependsOn === job.id) {
        j.dependsOn = job.dependsOn;
        if (!j.dependsOn && j.mode === 'after') { j.mode = 'now'; scheduler.plan(j); }
        events.send('job', j);
      }
    }
  }
  delete store.data.jobs[job.id];
  store.save();
  events.send('jobRemoved', { id: job.id });
  return removed;
}

export function listJobs(store, { status, provider, conversationId, sessionId, threadKey, limit = 100, since } = {}) {
  let jobs = Object.values(store.data.jobs);
  if (status) {
    const wanted = new Set(String(status).split(',').map(s => s.trim()));
    if (wanted.has('active')) for (const s of ACTIVE_STATUSES) wanted.add(s);
    jobs = jobs.filter(j => wanted.has(j.status));
  }
  if (provider) jobs = jobs.filter(j => j.provider === normalizeProvider(provider));
  if (conversationId) jobs = jobs.filter(j => j.conversationId === conversationId);
  if (sessionId) jobs = jobs.filter(j => j.sessionId === sessionId);
  if (threadKey) jobs = jobs.filter(j => j.threadKey === threadKey);
  if (since) jobs = jobs.filter(j => j.updatedAt >= +since);
  return jobs.sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.min(500, +limit || 100));
}

export { BadRequest };
