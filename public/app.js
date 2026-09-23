'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ACTIVE = new Set(['scheduled', 'waiting_limit', 'waiting_step', 'running']);
const EDITABLE = new Set(['scheduled', 'waiting_limit', 'waiting_step', 'blocked', 'failed', 'cancelled']);
const CUSTOM = '__custom__';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const REPEAT_TEXT = { daily: 'every day', weekdays: 'every weekday', weekly: 'every week' };

const S = {
  provider: 'anthropic',
  providers: [],
  settings: {},
  limits: {},
  jobs: new Map(),
  live: {},
  convs: [],
  sessions: [],
  models: {},          // provider -> [{ id, name }]
  modelState: {},      // provider -> 'loading' | 'ok' | error message
  drafts: JSON.parse(localStorage.getItem('ns.drafts') || '{}'),
  active: null,        // { provider, kind: 'conv'|'session'|'draft', id, cwd }
  threadData: null,
  attachments: [],
  steps: [],           // follow-ups being written before sending
  editing: null,       // job id being edited
  mode: 'now',
  skew: 0,
  authRequired: false,
};

// ---------- helpers ----------
async function http(url, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Sign in required.'); }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// The clipboard API only exists on secure pages; a self-hosted app is often
// reached over plain http on the LAN, so fall back to the old way.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
async function copyFrom(button, text) {
  const ok = await copyText(text);
  const label = button.textContent;
  button.textContent = ok ? 'Copied' : 'Copy failed';
  button.disabled = true;
  setTimeout(() => { button.textContent = label; button.disabled = false; }, 1400);
}

const now = () => Date.now() + S.skew;
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
function countdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const size = n => n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
const base = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const providerInfo = id => S.providers.find(p => p.id === id) || { id, label: id, kind: 'chat', efforts: [] };
const isChat = id => providerInfo(id).kind === 'chat';

function md(src) {
  return String(src || '').split('```').map((part, i) => {
    if (i % 2) {
      const nl = part.indexOf('\n');
      return `<div class="code"><pre><code>${esc(nl >= 0 ? part.slice(nl + 1) : part)}</code></pre><button type="button" class="ghost small code-copy" data-copy-code>Copy</button></div>`;
    }
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>')
      .split(/\n{2,}/).map(p => (p.trim() ? `<p>${p.trim().replace(/\n/g, '<br>')}</p>` : '')).join('');
  }).join('');
}

const prefsKey = p => `ns.prefs.${p}`;
const loadPrefs = p => JSON.parse(localStorage.getItem(prefsKey(p)) || '{}');
function savePrefs() {
  localStorage.setItem(prefsKey(S.provider), JSON.stringify({
    model: modelValue(), effort: $('#effort').value, maxTokens: $('#maxTokens').value, permMode: $('#permMode').value,
  }));
}
const saveDrafts = () => localStorage.setItem('ns.drafts', JSON.stringify(S.drafts));

// ---------- auth ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginPw').focus();
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await http('/api/login', { method: 'POST', body: { password: $('#loginPw').value } });
    $('#login').hidden = true;
    start();
  } catch (err) { $('#loginErr').textContent = err.message; }
});

async function boot() {
  const a = await http('/api/auth');
  S.authRequired = a.required;
  if (a.required && !a.authed) return showLogin();
  start();
}

let started = false;
async function start() {
  const st = await http('/api/state');
  S.skew = st.now - Date.now();
  S.settings = st.settings;
  S.providers = st.settings.providers;
  S.limits = st.limits || {};
  S.live = st.live || {};
  S.jobs = new Map(st.jobs.map(j => [j.id, j]));
  $('#app').hidden = false;
  $('#logoutBtn').hidden = !S.authRequired;
  if (!started) {
    started = true;
    connectEvents();
    setInterval(renderClocks, 1000);
    setInterval(renderJobs, 30000);
  }
  renderProviderTabs();
  setMode('now');
  await setProvider(landingProvider());
  renderJobs();
  renderClocks();
}

/**
 * Where to open: the provider you used last if it still works; otherwise the
 * first one that can actually send (a key is set, Ollama answers, Claude Code
 * is installed), so a new install never opens on a dead end.
 */
function landingProvider() {
  const saved = S.providers.find(p => p.id === localStorage.getItem('ns.provider'));
  if (saved?.ready) return saved.id;
  const busy = S.providers.find(p => p.ready && [...S.jobs.values()].some(j => j.provider === p.id && ACTIVE.has(j.status)));
  const ready = busy || S.providers.find(p => p.ready);
  return (ready || saved || S.providers[0]).id;
}

async function refreshProviders() {
  const list = await http('/v1/providers').catch(() => null);
  if (!list) return;
  const wasReady = providerInfo(S.provider).ready;
  S.providers = list;
  S.settings.providers = list;
  renderProviderTabs();
  renderClocks();
  if (!wasReady && providerInfo(S.provider).ready) { loadModels(S.provider); if (!S.active) loadThread(); }
}

function connectEvents() {
  const es = new EventSource('/v1/events');
  es.addEventListener('job', e => onJob(JSON.parse(e.data)));
  es.addEventListener('jobRemoved', e => { S.jobs.delete(JSON.parse(e.data).id); renderJobs(); renderPending(); });
  es.addEventListener('limits', e => { S.limits = JSON.parse(e.data); renderClocks(); });
  es.addEventListener('live', e => {
    const { jobId, text } = JSON.parse(e.data);
    S.live[jobId] = text;
    const el = document.querySelector(`[data-live="${jobId}"]`);
    if (el) { el.textContent = text.slice(-3000); scrollThread(); }
  });
  es.addEventListener('conversation', async () => {
    S.convs = await http(`/v1/conversations?provider=${S.provider}`).catch(() => S.convs);
    if (isChat(S.provider)) renderConvList();
    if (S.active?.kind === 'conv') loadThread();
  });
  es.addEventListener('providers', () => refreshProviders());
  es.addEventListener('pull', e => onPull(JSON.parse(e.data)));
  es.onopen = () => { if (started) refreshState(); };
}

async function refreshState() {
  const st = await http('/api/state').catch(() => null);
  if (!st) return;
  S.limits = st.limits;
  S.live = st.live || {};
  S.jobs = new Map(st.jobs.map(j => [j.id, j]));
  renderJobs(); renderClocks(); renderPending();
}

function onJob(job) {
  const prev = S.jobs.get(job.id);
  S.jobs.set(job.id, job);
  if (job.status !== 'running') delete S.live[job.id];
  renderJobs();

  const finished = prev?.status !== job.status && (job.status === 'done' || job.status === 'failed');
  if (finished && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(job.status === 'done' ? 'Sent' : 'Message failed', { body: job.prompt.slice(0, 120) });
  }

  if (job.provider === 'claude-code' && job.status === 'done' && job.result?.sessionId) {
    const onDraft = S.active?.kind === 'draft' && S.active.id === job.threadKey;
    if (S.drafts[job.threadKey]) { delete S.drafts[job.threadKey]; saveDrafts(); }
    loadSessions().then(() => {
      if (onDraft) openThread({ provider: 'claude-code', kind: 'session', id: job.result.sessionId, cwd: job.cwd });
      else if (S.active?.kind === 'session' && S.active.id === job.result.sessionId) loadThread();
    });
    return;
  }
  if (belongsToActive(job)) renderPending();
}

// ---------- header clocks ----------
function renderClocks() {
  $('#clocks').innerHTML = S.providers.map(p => {
    const lim = S.limits[p.id];
    const waiting = [...S.jobs.values()].filter(j => j.provider === p.id && j.status === 'waiting_limit').length;
    const limited = lim?.limitedUntil && lim.limitedUntil > now();
    if (!limited) {
      const queued = [...S.jobs.values()].filter(j => j.provider === p.id && ACTIVE.has(j.status)).length;
      if (!p.ready && p.kind === 'chat' && !queued) return '';
      return `<div class="clock"><span class="lamp"></span><span class="clock-text"><span class="clock-name">${esc(p.label)}</span>
        <span class="clock-val">${queued ? `${queued} queued` : 'Ready'}</span></span></div>`;
    }
    const when = lim.resetKnown ? `resets ${fmtTime(lim.limitedUntil)}` : `reset time unknown, next check ${fmtTime(lim.limitedUntil)}`;
    return `<div class="clock limited" title="${esc(lim.message || '')}"><span class="lamp"></span>
      <span class="clock-text"><span class="clock-name">${esc(p.label)}${waiting ? `, ${waiting} waiting` : ''}</span>
      <span class="clock-val">${countdown(lim.limitedUntil - now())}</span><span class="clock-when">${esc(when)}</span></span>
      <button class="ghost" data-clear-limit="${p.id}" title="Mark this limit as reset and send waiting messages now">Reset now</button></div>`;
  }).join('');
}
$('#clocks').addEventListener('click', async e => {
  const p = e.target.closest('[data-clear-limit]')?.dataset.clearLimit;
  if (p) await http(`/v1/limits/${p}/clear`, { method: 'POST' }).catch(err => toast(err.message));
});

// ---------- providers and conversation list ----------
function renderProviderTabs() {
  $('#providerSeg').innerHTML = S.providers.map(p =>
    `<button type="button" role="tab" data-p="${p.id}" aria-selected="${p.id === S.provider}" title="${esc(p.ready ? p.status_note || '' : p.status_note || 'Not set up yet')}">${esc(p.label)}${p.ready ? '' : ' <span class="dot-warn" aria-label="not set up">•</span>'}</button>`).join('');
}
$('#providerSeg').addEventListener('click', e => {
  const p = e.target.closest('button')?.dataset.p;
  if (p && p !== S.provider) setProvider(p);
});

async function setProvider(id) {
  S.provider = id;
  const info = providerInfo(id);
  localStorage.setItem('ns.provider', id);
  document.body.classList.toggle('kind-chat', info.kind === 'chat');
  document.body.classList.toggle('kind-agent', info.kind === 'agent');
  renderProviderTabs();
  $('#newConvBtn').textContent = info.kind === 'chat' ? 'New conversation' : 'New session';
  const who = { anthropic: 'Claude', 'claude-code': 'Claude Code', openai: 'the model', gemini: 'Gemini', ollama: 'your local model' }[id] || info.label;
  $('#prompt').placeholder = `Message ${who}. Paste or drop images, videos and files.`;
  $('#effort').innerHTML = `<option value="">Model default</option>` +
    (info.efforts || []).map(e => `<option value="${e}">${e[0].toUpperCase()}${e.slice(1)}</option>`).join('');

  const prefs = loadPrefs(id);
  renderModelOptions(prefs.model ?? '');
  $('#effort').value = prefs.effort || '';
  $('#maxTokens').value = prefs.maxTokens || '';
  $('#permMode').value = prefs.permMode || 'default';
  loadModels(id);

  if (info.kind === 'chat') S.convs = await http(`/v1/conversations?provider=${id}`).catch(() => []);
  else await loadSessions();
  renderConvList();

  const last = JSON.parse(localStorage.getItem(`ns.active.${id}`) || 'null');
  const exists = last && (last.kind === 'conv' ? S.convs.some(c => c.id === last.id)
    : last.kind === 'draft' ? !!S.drafts[last.id] || [...S.jobs.values()].some(j => j.threadKey === last.id)
    : S.sessions.some(s => s.id === last.id));
  openThread(exists ? last : null);
}

// ---------- model picker ----------
// A dropdown filled from the provider's own model list, with "Custom…" for
// anything it doesn't list (a model released this morning, a fine-tune, a gateway alias).
function modelValue() {
  const v = $('#modelSelect').value;
  return v === CUSTOM ? $('#modelCustom').value.trim() : v;
}

function setModel(value) {
  const info = providerInfo(S.provider);
  const list = S.models[S.provider] || [];
  const sel = $('#modelSelect');
  const custom = $('#modelCustom');
  if (value && list.some(m => m.id === value)) sel.value = value;
  else if (value) { sel.value = CUSTOM; custom.value = value; }
  else if (info.kind === 'agent') sel.value = '';
  else if (list.length) sel.value = list[0].id;
  else if (S.modelState[S.provider] === 'loading') sel.value = '';
  else { sel.value = CUSTOM; custom.value = ''; }
  syncModelField();
}

function syncModelField() {
  const sel = $('#modelSelect');
  $('#modelCustom').hidden = sel.value !== CUSTOM;
  const opt = sel.selectedOptions[0];
  sel.title = sel.value && sel.value !== CUSTOM ? `${opt?.textContent || ''}${opt?.textContent !== sel.value ? ` (${sel.value})` : ''}` : '';
}

function renderModelOptions(value = modelValue()) {
  const info = providerInfo(S.provider);
  const list = S.models[S.provider] || [];
  const state = S.modelState[S.provider];
  const opts = [];
  if (info.kind === 'agent') opts.push('<option value="">Default for your plan</option>');
  if (!list.length && info.kind === 'chat') {
    const why = state === 'loading' ? 'Loading models…'
      : !info.ready ? (info.key_optional ? 'Server not reachable' : 'Add a key to list models')
      : state && state !== 'ok' ? 'Couldn\'t load the list' : 'No models listed';
    opts.push(`<option value="" disabled>${esc(why)}</option>`);
  }
  opts.push(...list.map(m => `<option value="${esc(m.id)}">${esc(m.name && m.name !== m.id ? `${m.name}` : m.id)}</option>`));
  opts.push(`<option value="${CUSTOM}">Custom…</option>`);
  $('#modelSelect').innerHTML = opts.join('');
  setModel(value);
  $('#modelRefresh').title = state && !['ok', 'loading'].includes(state) ? state : 'Reload the model list from the provider';
}

async function loadModels(id, { refresh = false } = {}) {
  const keep = id === S.provider ? modelValue() : loadPrefs(id).model;
  S.modelState[id] = 'loading';
  if (id === S.provider) { renderModelOptions(keep); $('#modelRefresh').classList.add('spinning'); }
  try {
    const models = await http(`/v1/models?provider=${encodeURIComponent(id)}${refresh ? '&refresh=true' : ''}`);
    S.models[id] = models;
    S.modelState[id] = 'ok';
    if (refresh && id === S.provider) toast(models.length ? `${models.length} model${models.length === 1 ? '' : 's'} from ${providerInfo(id).label}.` : `${providerInfo(id).label} listed no models.`);
  } catch (e) {
    S.modelState[id] = e.message;
    if (refresh) toast(e.message);
  }
  if (id !== S.provider) return;
  $('#modelRefresh').classList.remove('spinning');
  renderModelOptions(keep);
}

$('#modelSelect').addEventListener('change', () => {
  syncModelField();
  if ($('#modelSelect').value === CUSTOM) $('#modelCustom').focus();
  savePrefs();
});
$('#modelCustom').addEventListener('change', savePrefs);
$('#modelRefresh').addEventListener('click', () => loadModels(S.provider, { refresh: true }));

async function loadSessions() {
  S.sessions = await http('/v1/sessions').catch(e => { toast(e.message); return []; });
  if (!isChat(S.provider)) renderConvList();
}

function ccDrafts() {
  const out = new Map(Object.values(S.drafts).map(d => [d.id, d]));
  for (const j of S.jobs.values()) {
    if (j.provider === 'claude-code' && !j.sessionId && ACTIVE.has(j.status) && !out.has(j.threadKey)) {
      out.set(j.threadKey, { id: j.threadKey, cwd: j.cwd, createdAt: j.createdAt });
    }
  }
  return [...out.values()];
}

function renderConvList() {
  const q = $('#convSearch').value.trim().toLowerCase();
  const match = (...s) => !q || s.some(x => (x || '').toLowerCase().includes(q));
  const cur = S.active;
  let html = '';
  if (isChat(S.provider)) {
    const list = S.convs.filter(c => match(c.title));
    html = list.map(c => `<button class="conv" data-kind="conv" data-id="${c.id}" aria-current="${cur?.kind === 'conv' && cur.id === c.id}">
      <span class="conv-title">${esc(c.title)}</span><span class="conv-meta">${c.source ? `${esc(sourceLabel(c.source.kind))}, ` : ''}${esc(c.model || 'no model yet')}, ${fmtTime(c.updatedAt)}</span></button>`).join('');
    if (!S.convs.length) html = `<p class="empty">No conversations yet. Start one to send or schedule messages.</p>`;
  } else {
    html += ccDrafts().filter(d => match(d.cwd)).map(d =>
      `<button class="conv" data-kind="draft" data-id="${esc(d.id)}" data-cwd="${esc(d.cwd)}" aria-current="${cur?.id === d.id}">
        <span class="conv-title">New session</span><span class="conv-meta">${esc(d.cwd)}</span></button>`).join('');
    const groups = new Map();
    for (const s of S.sessions.filter(s => match(s.title, s.cwd))) {
      if (!groups.has(s.cwd)) groups.set(s.cwd, []);
      groups.get(s.cwd).push(s);
    }
    for (const [cwd, list] of groups) {
      html += `<div class="conv-group" title="${esc(cwd)}">${esc(base(cwd))}</div>` + list.map(s =>
        `<button class="conv" data-kind="session" data-id="${esc(s.id)}" data-cwd="${esc(s.cwd)}" aria-current="${cur?.id === s.id}">
          <span class="conv-title">${esc(s.title)}</span><span class="conv-meta">${fmtTime(s.updatedAt)}</span></button>`).join('');
    }
    if (!html) html = `<p class="empty">No Claude Code sessions on this server yet. Start a new session to make one.</p>`;
  }
  $('#convList').innerHTML = html;
}
$('#convSearch').addEventListener('input', renderConvList);
$('#convList').addEventListener('click', e => {
  const b = e.target.closest('.conv');
  if (!b) return;
  openThread({ provider: S.provider, kind: b.dataset.kind, id: b.dataset.id, cwd: b.dataset.cwd });
  closeDrawers();
});

$('#newConvBtn').addEventListener('click', async () => {
  if (isChat(S.provider)) {
    try {
      const c = await http('/v1/conversations', { method: 'POST', body: { provider: S.provider, model: modelValue() } });
      S.convs.unshift(c);
      renderConvList();
      openThread({ provider: S.provider, kind: 'conv', id: c.id });
      $('#prompt').focus();
    } catch (e) { toast(e.message); }
  } else {
    $('#newCcCwd').value = S.settings.claudeCwd || '';
    $('#newCcDlg').showModal();
  }
  closeDrawers();
});
$('#newCcCreate').addEventListener('click', () => {
  const cwd = $('#newCcCwd').value.trim();
  if (!cwd) return;
  const id = `new:${crypto.randomUUID()}`;
  S.drafts[id] = { id, cwd, createdAt: Date.now() };
  saveDrafts();
  $('#newCcDlg').close();
  renderConvList();
  openThread({ provider: 'claude-code', kind: 'draft', id, cwd });
  $('#prompt').focus();
});

// ---------- thread ----------
function openThread(item) {
  S.active = item;
  S.threadData = null;
  cancelEdit();
  localStorage.setItem(`ns.active.${S.provider}`, JSON.stringify(item));
  renderConvList();
  loadThread();
}

function setExportLinks(a) {
  const menu = $('#exportMenu');
  menu.open = false;
  menu.hidden = !a || a.kind === 'draft';
  if (menu.hidden) return;
  const root = a.kind === 'conv' ? `/v1/conversations/${a.id}` : `/v1/sessions/${encodeURIComponent(a.id)}`;
  const tz = encodeURIComponent(TZ);
  $('#exportMd').href = `${root}/export?format=md&tz=${tz}`;
  $('#exportJson').href = `${root}/export?format=json&tz=${tz}`;
  $('#exportJsonl').href = `${root}/export?format=jsonl`;
  $('#exportJsonl').hidden = a.kind !== 'session';
}
$('#exportMenu').addEventListener('click', e => { if (e.target.closest('a')) setTimeout(() => ($('#exportMenu').open = false), 0); });
document.addEventListener('click', e => { if (!e.target.closest('#exportMenu')) $('#exportMenu').open = false; });

async function loadThread() {
  const a = S.active;
  $('#threadEdit').hidden = a?.kind !== 'conv';
  setExportLinks(a);
  if (!a) {
    $('#threadTitle').textContent = providerInfo(S.provider).label;
    $('#threadSub').textContent = '';
    $('#thread').innerHTML = emptyState();
    return;
  }
  try {
    if (a.kind === 'conv') {
      const c = await http(`/v1/conversations/${a.id}`);
      if (S.active !== a) return;
      const opened = S.threadData?.id !== c.id;
      S.threadData = c;
      $('#threadTitle').textContent = c.title;
      $('#threadSub').textContent = [c.model, c.system ? 'custom system prompt' : '', c.source ? `imported from ${sourceLabel(c.source.kind)}` : ''].filter(Boolean).join(', ');
      // Carry on with the model the conversation was using.
      if (opened && c.model && !S.editing) setModel(c.model);
    } else if (a.kind === 'session') {
      const s = await http(`/v1/sessions/${a.id}`);
      if (S.active !== a) return;
      S.threadData = s;
      a.cwd = s.cwd || a.cwd;
      $('#threadTitle').textContent = S.sessions.find(x => x.id === a.id)?.title || 'Claude Code session';
      $('#threadSub').textContent = s.cwd || '';
    } else {
      S.threadData = { messages: [] };
      $('#threadTitle').textContent = 'New Claude Code session';
      $('#threadSub').textContent = a.cwd || '';
    }
  } catch (e) {
    $('#thread').innerHTML = `<div class="thread-empty"><h2>Couldn't open this</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  renderThread();
}

const SOURCE_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', aistudio: 'AI Studio', 'claude-code': 'Claude Code', nightshift: 'Nightshift' };
const sourceLabel = k => SOURCE_LABELS[k] || k;

function emptyState() {
  const info = providerInfo(S.provider);
  const settingsBtn = '<button type="button" class="outline" data-open-settings>Open Settings</button>';
  if (!S.providers.some(p => p.ready)) {
    return `<div class="thread-empty welcome"><h2>Set up somewhere to send</h2>
      <p>Nightshift needs at least one provider before it can queue anything:</p>
      <ul>
        <li><strong>Claude Code</strong> uses your Pro or Max plan. Install it on this server and run <code>claude</code> once to sign in.</li>
        <li><strong>Claude API, OpenAI or Gemini</strong> take an API key, pasted in Settings.</li>
        <li><strong>Ollama</strong> runs models on your own hardware, with no key. Start it, and point Settings at it if it isn't on this machine.</li>
      </ul>
      <p>${settingsBtn} <button type="button" class="ghost" data-open-import>Import old chats</button></p></div>`;
  }
  if (info.id === 'ollama' && !info.ready) {
    return `<div class="thread-empty"><h2>${esc(info.status_note || 'Ollama is not ready')}</h2>
      <p>${/no models/i.test(info.status_note) ? 'Pull a model from Settings, or run <code>ollama pull llama3.2</code> on the server.' : `Start Ollama, or set its address in Settings. It's looked for at <code>${esc(info.base_url)}</code>.`}</p><p>${settingsBtn}</p></div>`;
  }
  if (info.id === 'claude-code' && !info.ready) {
    return `<div class="thread-empty"><h2>Claude Code isn't installed here</h2><p>${esc(info.status_note)}. Install it with <code>npm install -g @anthropic-ai/claude-code</code>, or set its path in Settings.</p><p>${settingsBtn}</p></div>`;
  }
  if (info.kind === 'chat' && !info.ready) {
    return `<div class="thread-empty"><h2>Add your ${esc(info.label)} key</h2><p>Open Settings and paste a key to send messages through ${esc(info.label)}.</p><p>${settingsBtn}</p></div>`;
  }
  return `<div class="thread-empty"><h2>Nothing open</h2><p>Pick a conversation on the left, or start a new one. Queue messages for later and they go out on their own.</p></div>`;
}

function fileBadges(files) {
  if (!files?.length) return '';
  return `<div class="msg-files">${files.map(f => f.kind === 'image'
    ? `<a href="/v1/uploads/${f.id}" target="_blank" rel="noopener"><img src="/v1/uploads/${f.id}" alt="${esc(f.name)}" loading="lazy"></a>`
    : `<a class="file-tag" href="/v1/uploads/${f.id}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div>`;
}

function renderThread() {
  const d = S.threadData;
  if (!d) return;
  const html = d.messages.map((m, i) => {
    if (m.role === 'user') return `<div class="msg user">${fileBadges(m.files)}${md(m.text)}</div>`;
    const tools = m.tools?.length ? `<div class="tools">Used ${esc([...new Set(m.tools)].join(', '))}</div>` : '';
    const meta = m.usage ? `${esc(m.model || '')}, ${m.usage.input_tokens ?? '?'} in / ${m.usage.output_tokens ?? '?'} out${m.stopReason === 'max_tokens' ? ', cut off at max tokens' : ''}`
      : m.model ? esc(m.model) : '';
    const copy = m.text?.trim() ? `<button type="button" class="ghost small" data-copy-msg="${i}">Copy</button>` : '';
    return `<div class="msg assistant">${md(m.text)}${tools}<div class="msg-foot"><span class="msg-meta">${meta}</span>${copy}</div></div>`;
  }).join('');
  $('#thread').innerHTML = (html || '') + '<div id="pendingWrap"></div>';
  if (!html) $('#thread').insertAdjacentHTML('afterbegin', `<div class="thread-empty"><h2>Empty so far</h2><p>Write below, then send now, pick a time, or queue it for when your limit resets.</p></div>`);
  renderPending();
  scrollThread(true);
}

function belongsToActive(j) {
  const a = S.active;
  if (!a || j.provider !== a.provider) return false;
  if (a.kind === 'conv') return j.conversationId === a.id;
  return j.sessionId === a.id || j.threadKey === a.id;
}

function statusText(j) {
  switch (j.status) {
    case 'scheduled': return j.nextAttemptAt > now() + 5000 ? `Sends ${fmtTime(j.nextAttemptAt)}${j.repeat ? `, then ${REPEAT_TEXT[j.repeat.every]}` : ''}` : 'Up next';
    case 'waiting_step': return 'Waits for the reply before it';
    case 'waiting_limit': {
      const lim = S.limits[j.provider];
      return lim?.limitedUntil > now()
        ? `Waiting for the limit to reset, sends ${fmtTime(j.nextAttemptAt)}`
        : `Queued behind an earlier message, sends ${fmtTime(j.nextAttemptAt)}`;
    }
    case 'running': return 'Sending';
    case 'done': return `Sent ${fmtTime(j.finishedAt)}`;
    case 'blocked': return 'Held back';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return j.status;
  }
}

function renderPending() {
  const wrap = $('#pendingWrap');
  if (!wrap) return;
  const list = [...S.jobs.values()]
    .filter(j => belongsToActive(j) && (ACTIVE.has(j.status) || ['failed', 'blocked'].includes(j.status) || (j.status === 'done' && S.active.kind === 'draft')))
    .sort((a, b) => a.createdAt - b.createdAt);
  wrap.innerHTML = list.map(j => `<div class="pending ${j.status}${S.editing === j.id ? ' editing' : ''}">
      <div>${esc(j.prompt).replace(/\n/g, '<br>') || '<em>(attachments only)</em>'}</div>
      ${j.files?.length ? `<div class="status">${j.files.length} attachment${j.files.length > 1 ? 's' : ''}</div>` : ''}
      <div class="status">${esc(statusText(j))}${j.lastError && j.status !== 'done' ? `: ${esc(j.lastError)}` : ''}</div>
      ${j.status === 'running' ? `<div class="live" data-live="${j.id}">${esc((S.live[j.id] || '').slice(-3000))}</div>` : ''}
      <div class="pending-actions">
        ${EDITABLE.has(j.status) ? `<button class="ghost small" data-edit="${j.id}">Edit</button>` : ''}
        ${['blocked', 'failed', 'cancelled'].includes(j.status) ? `<button class="ghost small" data-retry="${j.id}">Send now</button>` : ''}
        ${ACTIVE.has(j.status) ? `<button class="ghost small" data-cancel="${j.id}">Cancel</button>` : ''}
        ${j.status !== 'running' ? `<button class="ghost small" data-del="${j.id}">Delete</button>` : ''}
      </div>
    </div>`).join('');
}

$('#thread').addEventListener('click', e => {
  const msg = e.target.closest('[data-copy-msg]');
  if (msg) return copyFrom(msg, S.threadData?.messages[+msg.dataset.copyMsg]?.text || '');
  const code = e.target.closest('[data-copy-code]');
  if (code) return copyFrom(code, code.closest('.code').querySelector('code').textContent);
  if (e.target.closest('[data-open-settings]')) return openSettings();
  if (e.target.closest('[data-open-import]')) return openImport();
  jobAction(e);
});

function scrollThread(force) {
  const t = $('#thread');
  if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 200) t.scrollTop = t.scrollHeight;
}

// conversation settings
$('#threadEdit').addEventListener('click', () => {
  const c = S.threadData;
  $('#convTitle').value = c.title;
  $('#convSystem').value = c.system || '';
  $('#convDlg').showModal();
});
$('#convSave').addEventListener('click', async () => {
  try {
    await http(`/v1/conversations/${S.active.id}`, { method: 'PATCH', body: { title: $('#convTitle').value, system: $('#convSystem').value } });
    $('#convDlg').close();
    S.convs = await http(`/v1/conversations?provider=${S.provider}`);
    renderConvList();
    loadThread();
  } catch (e) { toast(e.message); }
});
$('#convDelete').addEventListener('click', async () => {
  if (!confirm('Delete this conversation and cancel its queued messages?')) return;
  await http(`/v1/conversations/${S.active.id}`, { method: 'DELETE' });
  $('#convDlg').close();
  S.convs = S.convs.filter(c => c.id !== S.active.id);
  openThread(null);
});

// ---------- attachments ----------
function renderChips() {
  $('#chips').innerHTML = S.attachments.map((a, i) => {
    const kind = a.info?.kind || '';
    const caps = providerInfo(S.provider).caps || {};
    const unreadable = caps.anyFile ? false : (kind === 'binary' || (kind === 'audio' && !caps.audio));
    const warn = unreadable ? `<span class="warn">Claude Code only</span>` : '';
    const thumb = a.preview ? `<img src="${a.preview}" alt="">` : '';
    const state = a.status === 'uploading' ? 'uploading…' : a.status === 'error' ? 'failed' : `${kind}, ${size(a.file.size)}`;
    return `<span class="chip ${a.status}">${thumb}<span class="name" title="${esc(a.file.name)}">${esc(a.file.name)}</span>
      <span class="kind">${esc(state)}</span>${warn}<button type="button" data-rm="${i}" aria-label="Remove ${esc(a.file.name)}">×</button></span>`;
  }).join('');
}
$('#chips').addEventListener('click', e => {
  const i = e.target.closest('[data-rm]')?.dataset.rm;
  if (i === undefined) return;
  const [a] = S.attachments.splice(+i, 1);
  if (a.preview) URL.revokeObjectURL(a.preview);
  if (a.info) http(`/v1/uploads/${a.info.id}`, { method: 'DELETE' }).catch(() => {});
  renderChips();
});

async function addFiles(fileList) {
  const items = [...fileList].map(file => ({
    file, status: 'uploading', info: null,
    preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  }));
  if (!items.length) return;
  S.attachments.push(...items);
  renderChips();
  const fd = new FormData();
  items.forEach(it => fd.append('files', it.file, it.file.name));
  try {
    const infos = await http('/v1/uploads', { method: 'POST', body: fd });
    items.forEach((it, i) => { it.info = infos[i]; it.status = 'ready'; });
  } catch (e) {
    items.forEach(it => (it.status = 'error'));
    toast(`Upload failed: ${e.message}`);
  }
  renderChips();
}
$('#fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
$('#prompt').addEventListener('paste', e => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
const main = document.querySelector('.main');
let dragDepth = 0;
main.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#composer').classList.add('dragging'); } });
main.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#composer').classList.remove('dragging'); } });
main.addEventListener('dragover', e => e.preventDefault());
main.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#composer').classList.remove('dragging');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// ---------- composing a chain ----------
function renderSteps() {
  $('#steps').innerHTML = S.steps.map((s, i) => `<li class="step">
      <span class="step-text">${esc(s.prompt) || '<em>(attachments only)</em>'}</span>
      <span class="step-meta">${s.files.length ? `${s.files.length} file${s.files.length > 1 ? 's' : ''}, ` : ''}${i === 0 ? 'sends first' : 'after the reply before it'}</span>
      <button type="button" class="ghost small" data-step-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button type="button" class="ghost small" data-step-rm="${i}" aria-label="Remove">×</button>
    </li>`).join('');
  updateSendLabel();
}
$('#steps').addEventListener('click', e => {
  const up = e.target.closest('[data-step-up]')?.dataset.stepUp;
  const rm = e.target.closest('[data-step-rm]')?.dataset.stepRm;
  if (up !== undefined) { const i = +up; [S.steps[i - 1], S.steps[i]] = [S.steps[i], S.steps[i - 1]]; }
  if (rm !== undefined) S.steps.splice(+rm, 1);
  if (up !== undefined || rm !== undefined) renderSteps();
});

function currentDraft() {
  const prompt = $('#prompt').value;
  const files = S.attachments.filter(x => x.status === 'ready').map(x => x.info.id);
  return { prompt, files };
}
function clearComposer() {
  $('#prompt').value = '';
  S.attachments.forEach(x => x.preview && URL.revokeObjectURL(x.preview));
  S.attachments = [];
  renderChips();
}

$('#addStep').addEventListener('click', () => {
  if (S.editing) return toast('Finish editing first.');
  const d = currentDraft();
  if (!d.prompt.trim() && !d.files.length) return toast('Write the message first, then add a follow-up.');
  if (S.attachments.some(x => x.status === 'uploading')) return toast('Wait for uploads to finish.');
  S.steps.push(d);
  clearComposer();
  renderSteps();
  $('#prompt').focus();
  toast('Added. Write the next message, then send them all.');
});

function updateSendLabel() {
  const n = S.steps.length + 1;
  if (S.editing) { $('#sendBtn').textContent = 'Save changes'; return; }
  const repeat = S.mode === 'at' && $('#repeat').value;
  const verb = S.mode === 'now' ? 'Send' : S.mode === 'at' ? (repeat ? `Schedule ${repeat === 'weekdays' ? 'on weekdays' : repeat}` : 'Schedule') : 'Queue for reset';
  $('#sendBtn').textContent = n > 1 ? `${verb} ${n} messages` : (S.mode === 'now' ? 'Send now' : verb);
}

// ---------- editing a queued message ----------
function startEdit(job) {
  S.editing = job.id;
  $('#editBar').hidden = false;
  $('#prompt').value = job.prompt;
  setModel(job.model || '');
  $('#effort').value = job.effort || '';
  if (job.maxTokens) $('#maxTokens').value = job.maxTokens;
  if (job.permissionMode) $('#permMode').value = job.permissionMode;
  setMode(job.mode === 'after' ? 'after' : job.mode);
  $('#repeat').value = job.repeat?.every || '';
  $('#repeat').disabled = !!job.dependsOn;
  if (job.mode === 'at' && job.runAt) {
    const d = new Date(job.runAt);
    $('#runAt').value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  renderPending();
  $('#prompt').focus();
  $('#prompt').scrollIntoView({ block: 'nearest' });
}
function cancelEdit() {
  if (!S.editing) return;
  S.editing = null;
  $('#editBar').hidden = true;
  $('#prompt').value = '';
  $('#repeat').value = '';
  $('#repeat').disabled = false;
  setMode('now');
  renderPending();
  updateSendLabel();
}
$('#cancelEdit').addEventListener('click', cancelEdit);

// ---------- when to send ----------
function setMode(m) {
  S.mode = m === 'after' ? 'after' : m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.m === S.mode)));
  $('#runAt').hidden = S.mode !== 'at';
  $('#repeat').hidden = S.mode !== 'at';
  $('#retryWrap').hidden = S.mode === 'reset';
  if (S.mode === 'at' && !$('#runAt').value) {
    const d = new Date(Date.now() + 3600e3);
    d.setMinutes(0, 0, 0);
    $('#runAt').value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  updateSendLabel();
}
$('#modeSeg').addEventListener('click', e => { const m = e.target.closest('button')?.dataset.m; if (m) setMode(m); });
$('#repeat').addEventListener('change', updateSendLabel);
['effort', 'maxTokens', 'permMode'].forEach(id => $(`#${id}`).addEventListener('change', savePrefs));
$('#permMode').addEventListener('change', e => {
  if (e.target.value === 'bypassPermissions') toast('Claude Code will run commands and edit files without asking. Use it only in a folder you trust it with.');
});
$('#prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#composer').requestSubmit(); }
});

$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  if (S.attachments.some(x => x.status === 'uploading')) return toast('Wait for uploads to finish.');
  $('#sendBtn').disabled = true;
  try {
    if (S.editing) await saveEdit();
    else await sendChain();
  } catch (err) {
    toast(err.message);
  } finally {
    $('#sendBtn').disabled = false;
  }
});

async function saveEdit() {
  const d = currentDraft();
  const patch = {
    text: d.prompt, model: modelValue(), effort: $('#effort').value, mode: S.mode,
    runAt: S.mode === 'at' ? new Date($('#runAt').value).getTime() : undefined,
    permissionMode: $('#permMode').value,
  };
  if (d.files.length) patch.files = d.files;
  if ($('#maxTokens').value) patch.maxTokens = +$('#maxTokens').value;
  if (!S.jobs.get(S.editing)?.dependsOn) {
    patch.repeat = S.mode === 'at' && $('#repeat').value ? $('#repeat').value : 'none';
    patch.timezone = TZ;
  }
  await http(`/v1/jobs/${S.editing}`, { method: 'PATCH', body: patch });
  cancelEdit();
  clearComposer();
  toast('Message updated.');
}

async function sendChain() {
  const a = S.active;
  if (!a) return toast(isChat(S.provider) ? 'Start or pick a conversation first.' : 'Start or pick a session first.');
  const d = currentDraft();
  const messages = [...S.steps];
  if (d.prompt.trim() || d.files.length) messages.push(d);
  if (!messages.length) return toast('Write a message or attach a file.');

  const body = {
    provider: a.provider,
    model: modelValue(),
    effort: $('#effort').value,
    retryOnLimit: $('#retryOnLimit').checked,
    repeat: S.mode === 'at' && $('#repeat').value ? $('#repeat').value : undefined,
    timezone: TZ,
    messages: messages.map((m, i) => ({
      text: m.prompt,
      files: m.files,
      mode: i === 0 ? S.mode : 'after',
      runAt: i === 0 && S.mode === 'at' ? new Date($('#runAt').value).getTime() : undefined,
    })),
  };
  if (isChat(a.provider)) {
    body.conversationId = a.id;
    if ($('#maxTokens').value) body.maxTokens = +$('#maxTokens').value;
  } else {
    body.permissionMode = $('#permMode').value;
    body.cwd = a.cwd;
    body.threadKey = a.id;
    if (a.kind === 'session') body.sessionId = a.id;
  }

  const { jobs } = await http('/v1/messages', { method: 'POST', body });
  for (const j of jobs) S.jobs.set(j.id, j);
  savePrefs();
  S.steps = [];
  $('#repeat').value = '';
  renderSteps();
  clearComposer();
  renderJobs();
  renderPending();
  scrollThread(true);
  const first = jobs[0];
  const many = jobs.length > 1 ? `${jobs.length} messages queued. ` : '';
  if (first.status === 'waiting_limit') toast(`${many}The first sends when the limit resets, ${fmtTime(first.nextAttemptAt)}.`);
  else if (S.mode === 'at' && first.repeat) toast(`${many}First send ${fmtTime(first.nextAttemptAt)}, then ${REPEAT_TEXT[first.repeat.every]} at that time.`);
  else if (S.mode === 'at') toast(`${many}The first sends ${fmtTime(first.nextAttemptAt)}.`);
  else if (S.mode === 'reset') toast(`${many}It will try now and wait for the reset if you are limited.`);
  else if (many) toast(`${many}They go out one after another.`);
}

// ---------- queue panel ----------
function jobWhere(j) {
  const label = providerInfo(j.provider).label;
  if (isChat(j.provider)) return `${label}: ${S.convs.find(c => c.id === j.conversationId)?.title || 'conversation'}`;
  const s = S.sessions.find(x => x.id === j.sessionId || x.id === j.result?.sessionId);
  return `${label}: ${s?.title || (j.sessionId ? 'session' : 'new session')} in ${base(j.cwd)}`;
}

function renderJobs() {
  const all = [...S.jobs.values()];
  const active = all.filter(j => ACTIVE.has(j.status) || j.status === 'blocked')
    .sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt));
  const done = all.filter(j => ['done', 'failed', 'cancelled'].includes(j.status))
    .sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt)).slice(0, 60);
  $('#queueCount').textContent = active.length || '';
  const card = j => `<article class="job ${j.status}">
      <div class="job-top"><span class="job-status">${esc(statusText(j))}</span><span>${j.model ? esc(j.model) : ''}${j.effort ? `, ${esc(j.effort)}` : ''}</span></div>
      <div class="job-prompt">${esc(j.prompt) || '<em>(attachments only)</em>'}</div>
      <button class="job-where" data-open="${j.id}">${esc(jobWhere(j))}${j.dependsOn ? ', in a chain' : ''}${j.source === 'api' ? ', via API' : ''}</button>
      ${j.repeat && ACTIVE.has(j.status) ? `<div class="job-repeat">Repeats ${esc(REPEAT_TEXT[j.repeat.every])}</div>` : ''}
      ${j.lastError && j.status !== 'done' ? `<div class="job-err">${esc(j.lastError)}</div>` : ''}
      ${j.result?.note ? `<div class="job-where">${esc(j.result.note)}</div>` : ''}
      <div class="job-actions">
        ${j.repeat && ACTIVE.has(j.status) && j.status !== 'running' ? `<button class="ghost small" data-norepeat="${j.id}" title="Send this one, then stop">Stop repeating</button>` : ''}
        ${EDITABLE.has(j.status) ? `<button class="ghost small" data-editopen="${j.id}">Edit</button>` : ''}
        ${['scheduled', 'waiting_limit', 'waiting_step', 'failed', 'cancelled', 'blocked'].includes(j.status) ? `<button class="ghost small" data-retry="${j.id}">Send now</button>` : ''}
        ${ACTIVE.has(j.status) ? `<button class="ghost small" data-cancel="${j.id}">Cancel</button>` : `<button class="ghost small" data-del="${j.id}">Remove</button>`}
      </div></article>`;
  $('#jobList').innerHTML = (active.length || done.length)
    ? active.map(card).join('') + done.map(card).join('')
    : `<p class="empty">Nothing queued. Messages you schedule, or that are waiting for a limit to reset, show up here.</p>`;
}

async function openJobThread(j) {
  if (j.provider !== S.provider) await setProvider(j.provider);
  if (isChat(j.provider)) openThread({ provider: j.provider, kind: 'conv', id: j.conversationId });
  else {
    const sid = j.sessionId || j.result?.sessionId;
    openThread(sid ? { provider: j.provider, kind: 'session', id: sid, cwd: j.cwd } : { provider: j.provider, kind: 'draft', id: j.threadKey, cwd: j.cwd });
  }
  closeDrawers();
}

async function jobAction(e) {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.retry) await http(`/v1/jobs/${d.retry}/retry`, { method: 'POST' });
    else if (d.norepeat) { await http(`/v1/jobs/${d.norepeat}`, { method: 'PATCH', body: { repeat: 'none' } }); toast('It sends once more, then stops.'); }
    else if (d.cancel) await http(`/v1/jobs/${d.cancel}/cancel`, { method: 'POST' });
    else if (d.del) {
      await http(`/v1/jobs/${d.del}`, { method: 'DELETE' });
      S.jobs.delete(d.del);
      renderJobs();
      renderPending();
    } else if (d.edit) startEdit(S.jobs.get(d.edit));
    else if (d.editopen) { await openJobThread(S.jobs.get(d.editopen)); startEdit(S.jobs.get(d.editopen)); }
    else if (d.open) await openJobThread(S.jobs.get(d.open));
  } catch (err) { toast(err.message); }
}
$('#jobList').addEventListener('click', jobAction);

$('#clearDone').addEventListener('click', async () => {
  for (const j of [...S.jobs.values()].filter(j => ['done', 'cancelled'].includes(j.status))) {
    await http(`/v1/jobs/${j.id}?cascade=false`, { method: 'DELETE' }).catch(() => {});
    S.jobs.delete(j.id);
  }
  renderJobs();
});

// ---------- import ----------
const IMP = { preview: null, selected: new Set() };

function openImport() {
  resetImport();
  $('#importDlg').showModal();
  closeDrawers();
}
$('#importBtn').addEventListener('click', openImport);

function resetImport() {
  if (IMP.preview) http(`/v1/import/${IMP.preview.id}`, { method: 'DELETE' }).catch(() => {});
  IMP.preview = null;
  IMP.selected = new Set();
  $('#importPick').hidden = false;
  $('#importReview').hidden = true;
  $('#importGo').hidden = true;
  $('#importBack').hidden = true;
  $('#importErr').textContent = '';
  $('#importProgress').hidden = true;
  $('#importFile').value = '';
  $('#importFilter').value = '';
}
$('#importBack').addEventListener('click', resetImport);
$('#importDlg').addEventListener('close', () => { if (IMP.preview) resetImport(); });

// XHR rather than fetch, for upload progress: exports with images run to gigabytes.
function uploadWithProgress(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) { showLogin(); return reject(new Error('Sign in required.')); }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted.'));
    xhr.send(form);
  });
}

async function startImport(files) {
  if (!files?.length) return;
  $('#importErr').textContent = '';
  const bar = $('#importProgress');
  bar.hidden = false;
  bar.value = 0;
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  try {
    const preview = await uploadWithProgress('/v1/import?preview=true', form, v => { bar.value = v; if (v >= 1) bar.removeAttribute('value'); });
    IMP.preview = preview;
    IMP.selected = new Set(preview.conversations.filter(c => !c.alreadyImported).map(c => c.key));
    renderImportReview();
  } catch (e) {
    $('#importErr').textContent = e.message;
  } finally { bar.hidden = true; }
}
$('#importFile').addEventListener('change', e => startImport(e.target.files));
const drop = $('#importDrop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); startImport(e.dataTransfer.files); });

function renderImportReview() {
  const p = IMP.preview;
  const sources = p.sources.map(x => x.label).join(' and ');
  const already = p.conversations.filter(c => c.alreadyImported).length;
  const isCc = p.sources.some(x => x.id === 'claude-code');
  $('#importPick').hidden = true;
  $('#importReview').hidden = false;
  $('#importBack').hidden = false;
  $('#importGo').hidden = false;

  let summary = `Found ${p.conversations.length} conversation${p.conversations.length === 1 ? '' : 's'} from ${esc(sources)}.`;
  if (already) summary += ` ${already} ${already === 1 ? 'is' : 'are'} already here and left unticked.`;
  if (p.backup) summary += ` The backup also holds ${p.backup.jobs} queued or finished message${p.backup.jobs === 1 ? '' : 's'} and ${p.backup.files} attachment${p.backup.files === 1 ? '' : 's'}; anything still queued comes back cancelled, so nothing sends by surprise.`;
  $('#importSummary').innerHTML = summary;
  $('#importWarnings').innerHTML = p.warnings.map(w => `<li>${esc(w)}</li>`).join('');

  // Where the conversations go. "Match" sends ChatGPT to OpenAI, Claude to the Claude API, and so on.
  const chat = S.providers.filter(x => x.kind === 'chat');
  $('#importProvider').innerHTML = `<option value="">The matching provider (ChatGPT to OpenAI, Claude to Claude API, Gemini to Gemini)</option>` +
    chat.map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join('');
  $('#importProviderWrap').hidden = !!p.backup && !p.conversations.length;
  $('#importCcTarget').hidden = !isCc;
  $('#importCwd').value = '';
  $('#importSettingsWrap').hidden = !p.backup?.hasSettings;
  $('#importSettings').checked = false;
  syncImportTarget();
  renderImportList();
}

function syncImportTarget() {
  const cc = !$('#importCcTarget').hidden && document.querySelector('input[name="ccTarget"]:checked')?.value === 'claude-code';
  $('#importCwdWrap').hidden = !cc;
  const onlyCc = IMP.preview?.sources.every(x => x.id === 'claude-code');
  $('#importProviderWrap').hidden = (cc && onlyCc) || (!!IMP.preview?.backup && !IMP.preview.conversations.length);
}
$('#importCcTarget').addEventListener('change', syncImportTarget);

function renderImportList() {
  const q = $('#importFilter').value.trim().toLowerCase();
  const list = IMP.preview.conversations.filter(c => !q || c.title.toLowerCase().includes(q));
  $('#importList').innerHTML = list.length ? list.map(c => `<label class="import-row${c.alreadyImported ? ' done' : ''}">
      <input type="checkbox" data-key="${esc(c.key)}" ${IMP.selected.has(c.key) ? 'checked' : ''}>
      <span class="import-title">${esc(c.title)}</span>
      <span class="import-meta">${c.messages} message${c.messages === 1 ? '' : 's'}${c.files ? `, ${c.files} file${c.files === 1 ? '' : 's'}` : ''}, ${c.updatedAt ? new Date(c.updatedAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'undated'}${c.alreadyImported ? ', already here' : ''}</span>
    </label>`).join('') : '<p class="empty">Nothing matches that filter.</p>';
  const all = IMP.preview.conversations;
  $('#importAll').checked = all.length > 0 && all.every(c => IMP.selected.has(c.key));
  $('#importAll').indeterminate = IMP.selected.size > 0 && !$('#importAll').checked;
  const n = IMP.selected.size;
  $('#importGo').textContent = IMP.preview.backup && !n ? 'Restore backup' : `Import ${n} conversation${n === 1 ? '' : 's'}`;
  $('#importGo').disabled = !n && !IMP.preview.backup;
}
$('#importFilter').addEventListener('input', renderImportList);
$('#importList').addEventListener('change', e => {
  const key = e.target.dataset.key;
  if (!key) return;
  if (e.target.checked) IMP.selected.add(key); else IMP.selected.delete(key);
  renderImportList();
});
$('#importAll').addEventListener('change', e => {
  const q = $('#importFilter').value.trim().toLowerCase();
  for (const c of IMP.preview.conversations) {
    if (q && !c.title.toLowerCase().includes(q)) continue;
    if (e.target.checked) IMP.selected.add(c.key); else IMP.selected.delete(c.key);
  }
  renderImportList();
});

$('#importGo').addEventListener('click', async () => {
  const p = IMP.preview;
  if (!p) return;
  const ccTarget = !$('#importCcTarget').hidden ? document.querySelector('input[name="ccTarget"]:checked').value : 'conversations';
  const body = {
    keys: [...IMP.selected],
    provider: $('#importProvider').value || undefined,
    target: ccTarget,
    cwd: $('#importCwd').value.trim() || undefined,
    restoreSettings: $('#importSettings').checked,
  };
  $('#importGo').disabled = true;
  $('#importGo').textContent = 'Importing…';
  $('#importErr').textContent = '';
  try {
    const r = await http(`/v1/import/${p.id}/commit`, { method: 'POST', body });
    IMP.preview = null;
    $('#importDlg').close();
    const parts = [];
    if (r.conversations.length) parts.push(`${r.conversations.length} conversation${r.conversations.length === 1 ? '' : 's'}`);
    if (r.sessions.length) parts.push(`${r.sessions.length} Claude Code session${r.sessions.length === 1 ? '' : 's'}`);
    if (r.restored) parts.push(`the backup (${r.restored.conversations} conversations, ${r.restored.jobs} queue items${r.restored.settings ? ', settings' : ''})`);
    toast(`${parts.length ? `Imported ${parts.join(' and ')}.` : 'Nothing new to import.'}${r.skipped ? ` ${r.skipped} skipped.` : ''}${r.errors.length ? ` ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}, see the browser console.` : ''}`);
    if (r.errors.length) console.warn('Import problems:', r.errors);
    if (r.restored?.settings) { const st = await http('/api/state'); S.settings = st.settings; S.providers = st.settings.providers; renderProviderTabs(); }
    const landed = r.sessions.length ? 'claude-code' : r.conversations[0]?.provider;
    if (landed) {
      await setProvider(landed);
      if (r.conversations[0] && landed !== 'claude-code') openThread({ provider: landed, kind: 'conv', id: r.conversations[0].id });
    } else if (isChat(S.provider)) {
      S.convs = await http(`/v1/conversations?provider=${S.provider}`).catch(() => S.convs);
      renderConvList();
    }
  } catch (e) {
    $('#importErr').textContent = e.message;
    renderImportList();
  }
});

// ---------- drawers ----------
function toggleDrawer(el, btn, force) {
  const open = force ?? !el.classList.contains('open');
  el.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
}
function closeDrawers() { toggleDrawer($('#side'), $('#navToggle'), false); toggleDrawer($('#queue'), $('#queueToggle'), false); }
$('#navToggle').addEventListener('click', () => toggleDrawer($('#side'), $('#navToggle')));
$('#queueToggle').addEventListener('click', () => {
  if (window.innerWidth > 1150) return $('#jobList').scrollIntoView({ behavior: 'smooth' });
  toggleDrawer($('#queue'), $('#queueToggle'));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawers(); });

// ---------- settings ----------
const HINTS = {
  openai: 'Any OpenAI-compatible service works here: OpenRouter, Groq, Together, vLLM, LM Studio.',
  ollama: 'No key needed for your own Ollama. In Docker, see “Ollama in Docker” in the getting-started guide. A key is only for ollama.com or a server behind an authenticating proxy.',
};

function renderProviderSettings() {
  $('#providerSettings').innerHTML = S.providers.filter(p => p.kind === 'chat').map(p => `
    <fieldset data-provider="${p.id}">
      <legend>${esc(p.label)} <span class="status ${p.ready ? 'ok' : 'off'}">${esc(p.ready ? p.status_note || 'Ready' : p.status_note || 'Not set up')}</span></legend>
      <label>${esc(p.key_label || 'API key')}
        <input type="password" data-key="${p.id}" autocomplete="off"
          placeholder="${p.key_set ? `Saved (${esc(p.key_hint)})${p.key_from_env ? ', from the environment' : ''}. Paste to replace.` : p.key_optional ? 'Not needed for a local server' : 'Not set'}"></label>
      ${p.key_set && !p.key_from_env ? `<button type="button" class="ghost small start" data-clear-key="${p.id}">Remove the saved key</button>` : ''}
      <label>${p.id === 'ollama' ? 'Server address' : 'Base URL'} <input data-baseurl="${p.id}" spellcheck="false" placeholder="${esc(p.default_base_url)}"></label>
      <p class="hint">${HINTS[p.id] || `Keys come from <a href="${esc(p.console_url)}" target="_blank" rel="noopener">${esc(new URL(p.console_url).host)}</a>.`}</p>
      ${p.id === 'ollama' ? `<div class="row">
          <input id="pullName" placeholder="Model to pull, e.g. llama3.2 or qwen3:8b" aria-label="Model to pull" spellcheck="false">
          <button type="button" class="outline small" id="pullBtn">Pull model</button>
        </div>
        <p class="hint">Browse models at <a href="https://ollama.com/search" target="_blank" rel="noopener">ollama.com/search</a>.</p>
        <div class="pull-status" id="pullStatus" hidden><progress max="1" value="0"></progress><span></span></div>` : ''}
    </fieldset>`).join('');
  for (const p of S.providers.filter(p => p.kind === 'chat')) {
    const input = document.querySelector(`[data-baseurl="${p.id}"]`);
    if (input) input.value = p.base_url === p.default_base_url ? '' : p.base_url;
  }
}

$('#providerSettings').addEventListener('click', async e => {
  const clear = e.target.closest('[data-clear-key]')?.dataset.clearKey;
  if (clear) {
    if (!confirm(`Remove the saved ${providerInfo(clear).label} key?`)) return;
    try {
      S.settings = await http('/api/settings', { method: 'PUT', body: { providers: { [clear]: { key: null } } } });
      S.providers = S.settings.providers;
      renderProviderSettings();
      renderProviderTabs();
      toast('Key removed.');
    } catch (err) { $('#settingsErr').textContent = err.message; }
  }
  if (e.target.closest('#pullBtn')) {
    const model = $('#pullName').value.trim();
    if (!model) return $('#pullName').focus();
    try {
      await http('/api/ollama/pull', { method: 'POST', body: { model } });
      onPull({ model, status: 'starting' });
    } catch (err) { $('#settingsErr').textContent = err.message; }
  }
});

function onPull(p) {
  const box = $('#pullStatus');
  if (p.done) {
    toast(p.error ? `Pulling ${p.model} failed: ${p.error}` : `${p.model} is ready.`);
    if (!p.error) { if (S.provider === 'ollama') loadModels('ollama', { refresh: true }); refreshProviders(); }
  }
  if (!box) return;
  box.hidden = false;
  const bar = box.querySelector('progress');
  if (p.total) bar.value = (p.completed || 0) / p.total; else bar.removeAttribute('value');
  if (p.done) bar.value = p.error ? 0 : 1;
  const pct = p.total ? `, ${Math.floor(((p.completed || 0) / p.total) * 100)}%` : '';
  box.querySelector('span').textContent = p.error ? `${p.model}: ${p.error}` : p.done ? `${p.model} is ready.` : `${p.model}: ${p.status || 'working'}${pct}`;
}

async function renderTokens() {
  const tokens = await http('/api/tokens').catch(() => []);
  $('#tokenList').innerHTML = tokens.length
    ? tokens.map(t => `<div class="token-row"><span><strong>${esc(t.name)}</strong> <code>${esc(t.prefix)}</code></span>
        <span class="hint">${t.lastUsedAt ? `used ${fmtTime(t.lastUsedAt)}` : 'never used'}</span>
        <button type="button" class="ghost small" data-revoke="${t.id}">Revoke</button></div>`).join('')
    : `<p class="hint">No tokens yet.</p>`;
}
$('#tokenList').addEventListener('click', async e => {
  const id = e.target.closest('[data-revoke]')?.dataset.revoke;
  if (!id || !confirm('Revoke this token? Anything using it stops working.')) return;
  await http(`/api/tokens/${id}`, { method: 'DELETE' });
  renderTokens();
});
$('#createToken').addEventListener('click', async () => {
  try {
    const t = await http('/api/tokens', { method: 'POST', body: { name: $('#tokenName').value.trim() || 'Untitled token' } });
    $('#tokenName').value = '';
    const box = $('#newToken');
    box.hidden = false;
    box.innerHTML = `<p>Copy this now, it is not shown again.</p><code>${esc(t.token)}</code>`;
    renderTokens();
  } catch (e) { $('#settingsErr').textContent = e.message; }
});

$('#settingsBtn').addEventListener('click', () => openSettings());
async function openSettings() {
  const s = S.settings;
  renderProviderSettings();
  $('#setBin').value = s.claudeBin;
  $('#setCwd').value = s.claudeCwd;
  $('#setTimeout').value = s.ccTimeoutMin;
  $('#setBuffer').value = s.resetBufferSec;
  $('#setPoll').value = s.pollMinutes;
  $('#setNotify').value = s.notifyUrl;
  $('#settingsErr').textContent = '';
  $('#newToken').hidden = true;
  $('#healthHint').textContent = 'Checking Claude Code…';
  updateBackupLinks();
  if (!$('#settingsDlg').open) $('#settingsDlg').showModal();
  renderTokens();
  try {
    const h = await http('/api/health');
    $('#healthHint').textContent = `${h.claudeCode.ok ? `Claude Code found (${h.claudeCode.version}).` : `Claude Code not available: ${h.claudeCode.error}.`} ${h.ffmpeg ? 'ffmpeg found, so video and oversized images work.' : 'ffmpeg not found: video frames and image conversion are unavailable.'}`;
  } catch { $('#healthHint').textContent = ''; }
}

function updateBackupLinks() {
  const tz = encodeURIComponent(TZ);
  $('#exportAllJson').href = '/v1/export?format=json&attachments=true';
  $('#exportAllMd').href = `/v1/export?format=md&tz=${tz}`;
  $('#backupLink').href = `/api/backup${$('#backupKeys').checked ? '?keys=1' : ''}`;
}
$('#backupKeys').addEventListener('change', updateBackupLinks);
$('#openImport').addEventListener('click', () => { $('#settingsDlg').close(); openImport(); });

$('#saveSettings').addEventListener('click', async () => {
  const providers = {};
  for (const p of S.providers.filter(p => p.kind === 'chat')) {
    const key = document.querySelector(`[data-key="${p.id}"]`).value.trim();
    const baseUrl = document.querySelector(`[data-baseurl="${p.id}"]`).value.trim();
    providers[p.id] = { ...(key ? { key } : {}), baseUrl };
  }
  const body = {
    providers,
    claudeBin: $('#setBin').value, claudeCwd: $('#setCwd').value, notifyUrl: $('#setNotify').value,
    ccTimeoutMin: $('#setTimeout').value, resetBufferSec: $('#setBuffer').value, pollMinutes: $('#setPoll').value,
  };
  try {
    S.settings = await http('/api/settings', { method: 'PUT', body });
    S.providers = S.settings.providers;
    $('#settingsDlg').close();
    toast('Settings saved.');
    renderProviderTabs();
    renderClocks();
    loadModels(S.provider);
    if (!S.active) loadThread();
  } catch (e) { $('#settingsErr').textContent = e.message; }
});
$('#testNotify').addEventListener('click', async () => {
  try {
    await http('/api/settings', { method: 'PUT', body: { notifyUrl: $('#setNotify').value } });
    const r = await http('/api/notify/test', { method: 'POST' });
    toast(r.ok ? 'Test notification sent.' : r.skipped ? 'Add a URL first.' : `Didn't go through (${r.status || r.error}).`);
  } catch (e) { $('#settingsErr').textContent = e.message; }
});
$('#browserNotify').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('This browser does not support notifications.');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Browser alerts are on while this tab is open.' : 'Browser alerts are blocked.');
});
$('#logoutBtn').addEventListener('click', async () => { await http('/api/logout', { method: 'POST' }); location.reload(); });

const syncTop = () => document.documentElement.style.setProperty('--top-h', `${document.querySelector('.top').offsetHeight}px`);
new ResizeObserver(syncTop).observe(document.querySelector('.top'));

boot().catch(e => toast(e.message));
