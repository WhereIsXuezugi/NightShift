'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ACTIVE = new Set(['scheduled', 'waiting_limit', 'waiting_step', 'running']);
const EDITABLE = new Set(['scheduled', 'waiting_limit', 'waiting_step', 'blocked', 'failed', 'cancelled']);

const S = {
  provider: 'anthropic',
  providers: [],
  settings: {},
  limits: {},
  jobs: new Map(),
  live: {},
  convs: [],
  sessions: [],
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
      return `<pre><code>${esc(nl >= 0 ? part.slice(nl + 1) : part)}</code></pre>`;
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
    model: $('#model').value.trim(), effort: $('#effort').value, maxTokens: $('#maxTokens').value, permMode: $('#permMode').value,
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
  const saved = localStorage.getItem('ns.provider');
  await setProvider(S.providers.some(p => p.id === saved) ? saved : S.providers[0].id);
  renderJobs();
  renderClocks();
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
    `<button type="button" role="tab" data-p="${p.id}" aria-selected="${p.id === S.provider}" title="${p.ready ? '' : 'Needs an API key'}">${esc(p.label)}${p.ready ? '' : ' <span class="dot-warn" aria-label="needs a key">•</span>'}</button>`).join('');
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
  $('#effort').innerHTML = `<option value="">Model default</option>` +
    (info.efforts || []).map(e => `<option value="${e}">${e[0].toUpperCase()}${e.slice(1)}</option>`).join('');

  const prefs = loadPrefs(id);
  $('#model').value = prefs.model || '';
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

async function loadModels(id) {
  try {
    const models = await http(`/v1/models?provider=${id}`);
    if (id !== S.provider) return;
    $('#modelList').innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    if (!$('#model').value && models.length) $('#model').value = models[0].id;
  } catch (e) { toast(e.message); }
}

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
      <span class="conv-title">${esc(c.title)}</span><span class="conv-meta">${esc(c.model || 'no model yet')}, ${fmtTime(c.updatedAt)}</span></button>`).join('');
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
      const c = await http('/v1/conversations', { method: 'POST', body: { provider: S.provider, model: $('#model').value.trim() } });
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

async function loadThread() {
  const a = S.active;
  $('#threadEdit').hidden = a?.kind !== 'conv';
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
      S.threadData = c;
      $('#threadTitle').textContent = c.title;
      $('#threadSub').textContent = [c.model, c.system ? 'custom system prompt' : ''].filter(Boolean).join(', ');
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

function emptyState() {
  const info = providerInfo(S.provider);
  if (info.kind === 'chat' && !info.ready) {
    return `<div class="thread-empty"><h2>Add your ${esc(info.label)} key</h2><p>Open Settings and paste a key to send messages through ${esc(info.label)}.</p></div>`;
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
  const html = d.messages.map(m => {
    if (m.role === 'user') return `<div class="msg user">${fileBadges(m.files)}${md(m.text)}</div>`;
    const tools = m.tools?.length ? `<div class="tools">Used ${esc([...new Set(m.tools)].join(', '))}</div>` : '';
    const meta = m.usage ? `<div class="msg-meta">${esc(m.model || '')}, ${m.usage.input_tokens ?? '?'} in / ${m.usage.output_tokens ?? '?'} out${m.stopReason === 'max_tokens' ? ', cut off at max tokens' : ''}</div>` : '';
    return `<div class="msg assistant">${md(m.text)}${tools}${meta}</div>`;
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
    case 'scheduled': return j.nextAttemptAt > now() + 5000 ? `Sends ${fmtTime(j.nextAttemptAt)}` : 'Up next';
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

$('#thread').addEventListener('click', e => jobAction(e));

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
  const verb = S.mode === 'now' ? 'Send' : S.mode === 'at' ? 'Schedule' : 'Queue for reset';
  $('#sendBtn').textContent = n > 1 ? `${verb} ${n} messages` : (S.mode === 'now' ? 'Send now' : verb);
}

// ---------- editing a queued message ----------
function startEdit(job) {
  S.editing = job.id;
  $('#editBar').hidden = false;
  $('#prompt').value = job.prompt;
  $('#model').value = job.model || '';
  $('#effort').value = job.effort || '';
  if (job.maxTokens) $('#maxTokens').value = job.maxTokens;
  if (job.permissionMode) $('#permMode').value = job.permissionMode;
  setMode(job.mode === 'after' ? 'after' : job.mode);
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
  $('#retryWrap').hidden = S.mode === 'reset';
  if (S.mode === 'at' && !$('#runAt').value) {
    const d = new Date(Date.now() + 3600e3);
    d.setMinutes(0, 0, 0);
    $('#runAt').value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  updateSendLabel();
}
$('#modeSeg').addEventListener('click', e => { const m = e.target.closest('button')?.dataset.m; if (m) setMode(m); });
['model', 'effort', 'maxTokens', 'permMode'].forEach(id => $(`#${id}`).addEventListener('change', savePrefs));
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
    text: d.prompt, model: $('#model').value.trim(), effort: $('#effort').value, mode: S.mode,
    runAt: S.mode === 'at' ? new Date($('#runAt').value).getTime() : undefined,
    permissionMode: $('#permMode').value,
  };
  if (d.files.length) patch.files = d.files;
  if ($('#maxTokens').value) patch.maxTokens = +$('#maxTokens').value;
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
    model: $('#model').value.trim(),
    effort: $('#effort').value,
    retryOnLimit: $('#retryOnLimit').checked,
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
  renderSteps();
  clearComposer();
  renderJobs();
  renderPending();
  scrollThread(true);
  const first = jobs[0];
  const many = jobs.length > 1 ? `${jobs.length} messages queued. ` : '';
  if (first.status === 'waiting_limit') toast(`${many}The first sends when the limit resets, ${fmtTime(first.nextAttemptAt)}.`);
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
      ${j.lastError && j.status !== 'done' ? `<div class="job-err">${esc(j.lastError)}</div>` : ''}
      ${j.result?.note ? `<div class="job-where">${esc(j.result.note)}</div>` : ''}
      <div class="job-actions">
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
function renderProviderSettings() {
  $('#providerSettings').innerHTML = S.providers.filter(p => p.kind === 'chat').map(p => `
    <fieldset data-provider="${p.id}">
      <legend>${esc(p.label)}</legend>
      <label>${esc(p.key_label || 'API key')}
        <input type="password" data-key="${p.id}" autocomplete="off"
          placeholder="${p.key_set ? `Saved (${esc(p.key_hint)})${p.key_from_env ? ', from the environment' : ''}. Paste to replace.` : 'Not set'}"></label>
      <label>Base URL <input data-baseurl="${p.id}" spellcheck="false" placeholder="${esc(p.default_base_url)}"></label>
      <p class="hint">${p.id === 'openai'
        ? 'Any OpenAI-compatible service works here: OpenRouter, Groq, Together, vLLM, LM Studio, Ollama.'
        : `Keys come from <a href="${esc(p.console_url)}" target="_blank" rel="noopener">${esc(new URL(p.console_url).host)}</a>.`}</p>
    </fieldset>`).join('');
  for (const p of S.providers.filter(p => p.kind === 'chat')) {
    const input = document.querySelector(`[data-baseurl="${p.id}"]`);
    if (input) input.value = p.base_url === p.default_base_url ? '' : p.base_url;
  }
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

$('#settingsBtn').addEventListener('click', async () => {
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
  $('#settingsDlg').showModal();
  renderTokens();
  try {
    const h = await http('/api/health');
    $('#healthHint').textContent = `${h.claudeCode.ok ? `Claude Code found (${h.claudeCode.version}).` : `Claude Code not available: ${h.claudeCode.error}.`} ${h.ffmpeg ? 'ffmpeg found, so video and oversized images work.' : 'ffmpeg not found: video frames and image conversion are unavailable.'}`;
  } catch { $('#healthHint').textContent = ''; }
});

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
