import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipReader, isZip } from './zip.js';
import { storeFile, mimeFromName } from './files.js';
import { isChat, normalizeProvider, claudeCode as cc } from './providers/index.js';
import { ACTIVE_STATUSES } from './jobs.js';

/*
 * Every source is parsed into the same shape, previewed, and then committed:
 *
 *   { key, source, sourceId, title, createdAt, updatedAt, model, system, provider,
 *     messages: [{ role: 'user'|'assistant', text, at, model?, usage?, tools?, files: [ref] }],
 *     session?: { raw, cwd } }                     Claude Code sessions only
 *
 * A file ref points at bytes without loading them yet:
 *   { name, mime, zip, entry }   an entry in an uploaded zip
 *   { name, mime, text }         text we already have (Claude's extracted attachments)
 *   { name, mime, base64 }       Nightshift's own exports
 */

export const SOURCES = {
  chatgpt: { label: 'ChatGPT', provider: 'openai' },
  claude: { label: 'Claude', provider: 'anthropic' },
  gemini: { label: 'Gemini', provider: 'gemini' },
  aistudio: { label: 'Google AI Studio', provider: 'gemini' },
  'claude-code': { label: 'Claude Code', provider: 'anthropic' },
  nightshift: { label: 'Nightshift', provider: null },
  backup: { label: 'Nightshift backup', provider: null },
};

const MAX_JSON = 480 * 1024 * 1024; // close to the longest string V8 will hold
const toMs = v => (v == null ? null : typeof v === 'number' ? (v < 1e12 ? Math.round(v * 1000) : v) : Date.parse(v) || null);
const oneLine = (s, n = 80) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const fail = m => { throw Object.assign(new Error(m), { status: 400 }); };

function tidy(messages) {
  // Merge back-to-back turns from the same side; providers expect them to alternate.
  const out = [];
  for (const m of messages) {
    if (!m.text?.trim() && !m.files?.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.text = [prev.text, m.text].filter(s => s?.trim()).join('\n\n');
      prev.files.push(...(m.files || []));
      if (m.tools) prev.tools = [...(prev.tools || []), ...m.tools];
      prev.model ||= m.model;
    } else out.push({ ...m, files: [...(m.files || [])] });
  }
  return out;
}

function finish(conv) {
  conv.messages = tidy(conv.messages);
  conv.title = oneLine(conv.title, 120) || oneLine(conv.messages.find(m => m.role === 'user')?.text, 60) || 'Imported conversation';
  conv.createdAt ||= conv.messages[0]?.at || Date.now();
  conv.updatedAt ||= conv.messages[conv.messages.length - 1]?.at || conv.createdAt;
  conv.model ||= [...conv.messages].reverse().find(m => m.model)?.model || '';
  conv.key = `${conv.source}:${conv.sourceId}`;
  conv.provider ||= SOURCES[conv.source]?.provider || 'anthropic';
  return conv;
}

// ---------- HTML to Markdown, for Gemini's activity export ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decodeEntities = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

export function htmlToText(html) {
  let s = String(html || '');
  const blocks = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => {
    blocks.push(decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/\s*\n\s*/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (m, n) => `\n\n${'#'.repeat(Math.min(+n + 1, 6))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|table|blockquote)>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '_$2_')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
      const text = t.replace(/<[^>]+>/g, '');
      return text && decodeEntities(href) !== decodeEntities(text) ? `[${text}](${href})` : text;
    })
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `\n\n\`\`\`\n${blocks[+i].replace(/\n+$/, '')}\n\`\`\`\n\n`);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function parseTakeoutDate(s) {
  const clean = decodeEntities(String(s || '')).replace(/[\u202f\u00a0]/g, ' ').trim();
  let t = Date.parse(clean);
  if (isNaN(t)) t = Date.parse(clean.replace(/\s+[A-Z]{2,5}$/, '')); // an abbreviation Node doesn't know: read as local
  return isNaN(t) ? null : t;
}

// ---------- ChatGPT ----------

// ChatGPT marks citations with private-use characters: \ue200cite\ue202turn0search3\ue201
const stripCitations = s => s.replace(/\ue200[^\ue201]*\ue201/g, '').replace(/[\ue200-\ue2ff]/g, '');

function chatgptFileIndex(zip) {
  const index = new Map();
  if (!zip) return index;
  for (const e of zip.entries) {
    const m = path.posix.basename(e.name).match(/^(file[-_][A-Za-z0-9]+)/);
    if (m && !index.has(m[1])) index.set(m[1], e.name);
  }
  return index;
}

function chatgptConversation(c, zipId, fileIndex) {
  const mapping = c.mapping || {};
  let nodeId = c.current_node;
  if (!mapping[nodeId]) {
    // No pointer to the branch that was showing: take the newest leaf.
    const leaves = Object.values(mapping).filter(n => !n.children?.length);
    nodeId = leaves.sort((a, b) => (b.message?.create_time || 0) - (a.message?.create_time || 0))[0]?.id;
  }
  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  chain.reverse();

  const messages = [];
  let system = '';
  for (const node of chain) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    const meta = m.metadata || {};
    const ct = m.content?.content_type;
    if (ct === 'user_editable_context' && !system) {
      system = [m.content.user_profile, m.content.user_instructions].filter(Boolean).join('\n\n');
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    if (meta.is_visually_hidden_from_conversation) continue;
    if (role === 'assistant' && m.recipient && m.recipient !== 'all') continue; // a tool call, not a reply

    let text = '';
    const files = [];
    const addFile = (pointer, name, mime) => {
      const id = String(pointer || '').replace(/^[a-z-]+:\/\//, '');
      const entry = fileIndex.get(id) || [...fileIndex.entries()].find(([k]) => id.startsWith(k))?.[1];
      const known = (meta.attachments || []).find(a => a.id && id.startsWith(a.id));
      const fallback = path.posix.basename(entry || '').replace(/^file[-_][A-Za-z0-9]+[-_]/, '') || path.posix.basename(entry || '');
      name = name || known?.name;
      mime = mime || known?.mime_type;
      if (entry) files.push({ name: name || fallback, mime: mime || mimeFromName(entry), zip: zipId, entry });
      else if (name) text += `\n\n_(Attachment not included in the export: ${name})_`;
    };
    if (ct === 'text') text = (m.content.parts || []).filter(p => typeof p === 'string').join('\n');
    else if (ct === 'multimodal_text') {
      for (const part of m.content.parts || []) {
        if (typeof part === 'string') text += (text ? '\n' : '') + part;
        else if (part?.asset_pointer && role === 'user') addFile(part.asset_pointer);
      }
    } else if (ct === 'code' && role === 'assistant') text = `\`\`\`${m.content.language && m.content.language !== 'unknown' ? m.content.language : ''}\n${m.content.text}\n\`\`\``;
    else continue; // thoughts, browsing, execution output and other internals

    if (role === 'user') {
      const pointed = new Set(files.map(f => f.entry));
      for (const a of meta.attachments || []) {
        const entry = fileIndex.get(a.id);
        if (entry && pointed.has(entry)) continue; // already added from the image pointer
        addFile(a.id, a.name, a.mime_type);
      }
    }
    messages.push({ role, text: stripCitations(text).trim(), files, at: toMs(m.create_time), model: meta.model_slug });
  }
  return finish({
    source: 'chatgpt', sourceId: c.conversation_id || c.id || hash(JSON.stringify(c).slice(0, 2000)),
    title: c.title, createdAt: toMs(c.create_time), updatedAt: toMs(c.update_time),
    model: c.default_model_slug || '', system, messages,
  });
}

// ---------- Claude (claude.ai export) ----------

function claudeConversation(c) {
  const messages = (c.chat_messages || []).map(m => {
    const role = m.sender === 'human' ? 'user' : 'assistant';
    let text = '';
    if (Array.isArray(m.content) && m.content.length) {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push(b.text);
        // Artifacts live in tool calls; keep the ones that carry whole content.
        if (b.type === 'tool_use' && b.name === 'artifacts' && b.input?.content && ['create', 'rewrite'].includes(b.input.command)) {
          parts.push(`**${b.input.title || 'Artifact'}**\n\n\`\`\`${b.input.language || ''}\n${b.input.content}\n\`\`\``);
        }
      }
      text = parts.join('\n\n');
    }
    if (!text) text = m.text || '';
    const files = [];
    for (const a of m.attachments || []) {
      if (a.extracted_content) files.push({ name: a.file_name || 'attachment.txt', mime: 'text/plain', text: a.extracted_content });
      else if (a.file_name) text += `\n\n_(Attachment not included in the export: ${a.file_name})_`;
    }
    for (const f of m.files || m.files_v2 || []) {
      if (f.file_name && !files.some(x => x.name === f.file_name)) text += `\n\n_(File not included in the export: ${f.file_name})_`;
    }
    return { role, text: text.trim(), files, at: toMs(m.created_at) };
  });
  return finish({
    source: 'claude', sourceId: c.uuid || hash(JSON.stringify(c).slice(0, 2000)),
    title: c.name, createdAt: toMs(c.created_at), updatedAt: toMs(c.updated_at),
    model: c.model || '', system: '', messages,
  });
}

// ---------- Gemini (Google Takeout "My Activity > Gemini Apps") ----------

function geminiEntriesFromJson(arr) {
  return arr
    .filter(e => /^Prompted\s/.test(e.title || '') && (!e.header || /gemini|bard/i.test(e.header)))
    .map(e => ({
      prompt: e.title.replace(/^Prompted\s+/, ''),
      at: Date.parse(e.time) || null,
      html: (e.safeHtmlItem || []).map(x => x.html).join('\n'),
      files: [...(e.attachedFiles || []), ...(e.imageFile ? [e.imageFile] : [])],
    }));
}

function geminiEntriesFromHtml(html) {
  const out = [];
  for (const cell of html.split(/<div class="outer-cell/).slice(1)) {
    if (!/mdl-typography--title">\s*(Gemini|Bard)/i.test(cell)) continue;
    const start = cell.indexOf('mdl-typography--body-1">');
    if (start < 0) continue;
    let body = cell.slice(start + 24);
    const end = body.search(/<div class="content-cell/);
    if (end >= 0) body = body.slice(0, end);
    body = body.replace(/(<\/div>\s*)+$/, '');
    const m = body.match(/^\s*Prompted(?:&nbsp;|\s)+([\s\S]*?)<br>\s*([A-Z][^<]{8,60}?\d{1,2}:\d{2}(?::\d{2})?[^<]*)<br>([\s\S]*)$/);
    if (!m) continue;
    out.push({ prompt: htmlToText(m[1]), at: parseTakeoutDate(m[2]), html: m[3], files: [] });
  }
  return out;
}

/** Takeout keeps single prompts, not conversations, so turns close together in time are grouped. */
function geminiConversations(entries, { gapMinutes = 30, zipId = null, dir = '', zip = null } = {}) {
  entries = entries.filter(e => e.prompt || e.html).sort((a, b) => (a.at || 0) - (b.at || 0));
  const groups = [];
  for (const e of entries) {
    const g = groups[groups.length - 1];
    if (g && e.at && g.last && e.at - g.last <= gapMinutes * 60000) { g.items.push(e); g.last = e.at; }
    else groups.push({ items: [e], last: e.at });
  }
  return groups.map(g => {
    const messages = [];
    for (const e of g.items) {
      const files = [];
      for (const name of e.files) {
        const entry = zip?.find(x => x.name === path.posix.join(dir, name) || x.name.endsWith(`/${name}`));
        if (entry) files.push({ name, mime: mimeFromName(name), zip: zipId, entry: entry.name });
      }
      messages.push({ role: 'user', text: e.prompt, files, at: e.at });
      const reply = htmlToText(e.html);
      if (reply) messages.push({ role: 'assistant', text: reply, files: [], at: e.at });
    }
    return finish({ source: 'gemini', sourceId: `activity-${g.items[0].at || hash(g.items[0].prompt)}`, title: '', messages });
  });
}

// ---------- Google AI Studio saved prompts ----------

function aiStudioConversation(obj, name) {
  const chunks = obj.chunkedPrompt?.chunks || [];
  const messages = chunks.filter(c => !c.isThought && (c.text || c.parts)).map(c => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    text: c.text ?? (c.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''),
    files: [],
    at: null,
  }));
  const system = obj.systemInstruction?.text ?? (obj.systemInstruction?.parts || []).map(p => p.text).join('\n');
  return finish({
    source: 'aistudio', sourceId: hash(`${name}\n${JSON.stringify(chunks).slice(0, 4000)}`),
    title: name.replace(/\.json$/i, ''), model: String(obj.runSettings?.model || '').replace(/^models\//, ''),
    system: system || '', messages,
  });
}

// ---------- Claude Code ----------

function claudeCodeConversation(raw, name) {
  const s = cc.parseSessionLines(raw);
  if (!s.messages.length) return null;
  return finish({
    source: 'claude-code', sourceId: s.sessionId || hash(raw.slice(0, 4000)), title: s.title || name,
    createdAt: s.createdAt, updatedAt: s.updatedAt, model: s.model || '',
    messages: s.messages.map(m => ({ role: m.role, text: m.text, tools: m.tools, at: m.at, model: m.model, files: [] })),
    session: { raw, cwd: s.cwd, id: s.sessionId },
  });
}

// ---------- Nightshift ----------

function nightshiftConversations(obj) {
  return (obj.conversations || []).map(c => finish({
    source: 'nightshift', sourceId: c.source ? `${c.source.kind}:${c.source.id}` : c.id,
    title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, model: c.model, system: c.system,
    provider: isChat(normalizeProvider(c.provider)) ? normalizeProvider(c.provider) : null,
    originalSource: c.source,
    messages: (c.messages || []).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant', text: m.text || '', at: m.at, model: m.model,
      usage: m.usage, tools: m.tools, stopReason: m.stopReason,
      files: (m.files || []).filter(f => f.data).map(f => ({ name: f.name, mime: f.mime, base64: f.data })),
    })),
  }));
}

// ---------- detection ----------

function fromJson(obj, name, ctx) {
  if (Array.isArray(obj)) {
    const first = obj.find(x => x && typeof x === 'object') || {};
    if ('mapping' in first) return { source: 'chatgpt', conversations: obj.map(c => chatgptConversation(c, ctx.zipId, ctx.fileIndex)) };
    if ('chat_messages' in first) return { source: 'claude', conversations: obj.map(claudeConversation) };
    if ('header' in first && 'title' in first && 'time' in first) {
      return { source: 'gemini', conversations: geminiConversations(geminiEntriesFromJson(obj), ctx) };
    }
    if (!obj.length) return { source: null, conversations: [] };
  } else if (obj && typeof obj === 'object') {
    if (obj.format === 'nightshift.conversations') return { source: 'nightshift', conversations: nightshiftConversations(obj) };
    if (obj.format === 'nightshift.backup') return { source: 'backup', backup: obj, conversations: nightshiftConversations({ conversations: Object.values(obj.conversations || {}) }) };
    if (obj.chunkedPrompt) return { source: 'aistudio', conversations: [aiStudioConversation(obj, name)] };
    if (obj.mapping) return { source: 'chatgpt', conversations: [chatgptConversation(obj, ctx.zipId, ctx.fileIndex)] };
    if (obj.chat_messages) return { source: 'claude', conversations: [claudeConversation(obj)] };
    if (Array.isArray(obj.conversations)) return fromJson(obj.conversations, name, ctx);
  }
  return null;
}

async function parseZip(file, zipId, zips, opts) {
  const zip = await ZipReader.open(file.path);
  zips[zipId] = zip;
  const results = [];
  const base = n => path.posix.basename(n);

  const backup = zip.find(e => base(e.name) === 'nightshift-backup.json');
  if (backup) {
    const obj = JSON.parse(await zip.text(backup, MAX_JSON));
    const r = fromJson(obj, backup.name, { zipId });
    if (r?.source === 'backup') {
      r.backupZip = zipId;
      r.backupDir = path.posix.dirname(backup.name) === '.' ? '' : path.posix.dirname(backup.name);
      return [r];
    }
  }

  const convFiles = zip.filter(e => /(^|\/)conversations(-\d+)?\.json$/i.test(e.name));
  if (convFiles.length) {
    const fileIndex = chatgptFileIndex(zip);
    for (const e of convFiles) {
      const r = fromJson(JSON.parse(await zip.text(e, MAX_JSON)), e.name, { zipId, fileIndex });
      if (r) results.push(r);
    }
  }

  for (const e of zip.filter(x => /(Gemini Apps|Bard)\/MyActivity\.(json|html)$/i.test(x.name))) {
    const dir = path.posix.dirname(e.name);
    const raw = await zip.text(e, MAX_JSON);
    const entries = e.name.endsWith('.json') ? geminiEntriesFromJson(JSON.parse(raw)) : geminiEntriesFromHtml(raw);
    results.push({ source: 'gemini', conversations: geminiConversations(entries, { ...opts, zipId, dir, zip }) });
  }

  const sessions = zip.filter(x => x.name.endsWith('.jsonl') && !/(^|\/)agent-[^/]*\.jsonl$/.test(x.name) && !x.name.includes('/subagents/'));
  if (sessions.length) {
    const conversations = [];
    for (const e of sessions) {
      const c = claudeCodeConversation(await zip.text(e, 200 * 1024 * 1024), base(e.name).replace(/\.jsonl$/, ''));
      if (c) conversations.push(c);
    }
    if (conversations.length) results.push({ source: 'claude-code', conversations });
  }

  if (!results.length) {
    // Loose JSON files: AI Studio prompts from a Drive download, or Nightshift exports.
    for (const e of zip.filter(x => (x.name.endsWith('.json') || !path.posix.extname(x.name)) && x.size < 50 * 1024 * 1024)) {
      let obj;
      try { obj = JSON.parse(await zip.text(e)); } catch { continue; }
      const r = fromJson(obj, base(e.name), { zipId });
      if (r?.conversations?.length) results.push(r);
    }
  }
  return results;
}

async function parseOne(file, zipId, zips, opts) {
  const name = file.name || path.basename(file.path);
  if (await isZip(file.path)) return parseZip(file, zipId, zips, opts);
  const st = await fsp.stat(file.path);
  if (st.size > MAX_JSON) fail(`"${name}" is too large to read as one file. Upload the export zip instead.`);
  const raw = await fsp.readFile(file.path, 'utf8');
  const trimmed = raw.trimStart();

  if (/\.jsonl$/i.test(name) || (trimmed.startsWith('{') && trimmed.split('\n', 3).length > 2 && /"sessionId"/.test(trimmed.slice(0, 5000)))) {
    const c = claudeCodeConversation(raw, name.replace(/\.jsonl$/i, ''));
    return c ? [{ source: 'claude-code', conversations: [c] }] : [];
  }
  if (trimmed.startsWith('<')) {
    if (/Gemini Apps|Bard/.test(raw.slice(0, 200000))) return [{ source: 'gemini', conversations: geminiConversations(geminiEntriesFromHtml(raw), opts) }];
    fail(`"${name}" is HTML. For ChatGPT, upload the whole export zip or conversations.json instead of chat.html.`);
  }
  let obj;
  try { obj = JSON.parse(raw); } catch { fail(`"${name}" isn't a format this app can import.`); }
  const r = fromJson(obj, name, { zipId: null, fileIndex: new Map(), ...opts });
  return r ? [r] : [];
}

/**
 * Reads uploaded files and works out what they are. Returns a preview the
 * caller keeps until the import is committed, plus open zip readers to close.
 */
export async function parseImport(files, opts = {}) {
  const zips = {};
  const results = [];
  const warnings = [];
  try {
    for (let i = 0; i < files.length; i++) {
      try {
        const found = await parseOne(files[i], `z${i}`, zips, opts);
        if (!found.length) warnings.push(`Nothing to import was found in "${files[i].name}".`);
        results.push(...found);
      } catch (e) {
        if (files.length === 1) throw e;
        warnings.push(`${files[i].name}: ${e.message}`);
      }
    }
  } catch (e) {
    for (const z of Object.values(zips)) await z.close().catch(() => {});
    if (e instanceof SyntaxError) fail(`That file couldn't be read as JSON: ${e.message}`);
    throw e;
  }

  const conversations = [];
  const seen = new Set();
  for (const r of results) {
    for (const c of r.conversations || []) {
      if (!c || !c.messages.length || seen.has(c.key)) continue;
      seen.add(c.key);
      conversations.push(c);
    }
  }
  const sources = [...new Set(results.map(r => r.source).filter(Boolean))];
  const backup = results.find(r => r.source === 'backup');
  if (!conversations.length && !backup) {
    for (const z of Object.values(zips)) await z.close().catch(() => {});
    fail(warnings[0] || 'Nothing to import was found. Upload an export zip from ChatGPT, Claude or Google Takeout, a Claude Code .jsonl, or a Nightshift export.');
  }
  return { sources, conversations, backup: backup || null, warnings, zips };
}

// ---------- committing ----------

const importedKeys = store => new Set(Object.values(store.data.conversations).filter(c => c.source).map(c => `${c.source.kind}:${c.source.id}`));

/** The part of a parsed import that is safe to send to the browser. */
export function describeImport(store, parsed) {
  const done = importedKeys(store);
  const existingIds = new Set(Object.keys(store.data.conversations));
  const b = parsed.backup?.backup;
  return {
    sources: parsed.sources.map(s => ({ id: s, label: SOURCES[s]?.label || s })),
    warnings: parsed.warnings,
    backup: b ? {
      exportedAt: b.exportedAt, app: b.app, jobs: Object.keys(b.jobs || {}).length, files: Object.keys(b.files || {}).length,
      hasSettings: !!b.settings, includesKeys: !!b.includesKeys,
    } : null,
    conversations: parsed.conversations.map(c => ({
      key: c.key, source: c.source, title: c.title, messages: c.messages.length, createdAt: c.createdAt, updatedAt: c.updatedAt,
      model: c.model, provider: c.provider,
      files: c.messages.reduce((n, m) => n + m.files.length, 0),
      alreadyImported: done.has(c.key) || (c.originalSource && done.has(`${c.originalSource.kind}:${c.originalSource.id}`))
        || (c.source === 'nightshift' && existingIds.has(c.sourceId)),
      cwd: c.session?.cwd || undefined,
    })),
  };
}

async function materialize(ctx, ref, zips) {
  let buffer;
  if (ref.zip) buffer = await zips[ref.zip].buffer(ref.entry, 512 * 1024 * 1024);
  else if (ref.text != null) buffer = Buffer.from(ref.text, 'utf8');
  else if (ref.base64) buffer = Buffer.from(ref.base64, 'base64');
  else return null;
  return storeFile(ctx, { name: ref.name, mime: ref.mime, buffer });
}

/**
 * Writes the chosen conversations into the store.
 *   keys           which conversations (default: all not imported before)
 *   provider       put every conversation under this chat provider
 *   target         'claude-code' adds Claude Code sessions to this machine's history instead
 *   cwd            the folder those sessions belong to here
 *   restoreSettings  for a backup, also restore settings (browser session only)
 */
export async function commitImport(ctx, parsed, opts = {}) {
  const { store, events } = ctx;
  const done = importedKeys(store);
  const wanted = opts.keys ? new Set(opts.keys) : null;
  const override = opts.provider ? normalizeProvider(opts.provider) : null;
  if (override && !isChat(override)) fail('Imported conversations need a chat provider: anthropic, openai, gemini or ollama.');
  const out = { conversations: [], sessions: [], skipped: 0, errors: [], restored: null };

  if (parsed.backup) out.restored = await restoreBackup(ctx, parsed, opts);

  for (const c of parsed.conversations) {
    if (wanted ? !wanted.has(c.key) : done.has(c.key)) { out.skipped++; continue; }
    if (parsed.backup && store.data.conversations[c.sourceId]) { out.skipped++; continue; }
    try {
      if (c.session && opts.target === 'claude-code') {
        const cwd = opts.cwd || c.session.cwd;
        if (!cwd) fail('Choose the folder these Claude Code sessions belong to.');
        const r = await cc.installSession(c.session.raw, cwd, { overwrite: !!opts.overwrite });
        if (r.skipped) out.skipped++;
        else out.sessions.push({ id: r.sessionId, title: c.title, cwd });
        continue;
      }
      if (parsed.backup) continue; // already restored with its original ids
      const provider = override || c.provider || 'anthropic';
      const messages = [];
      for (const m of c.messages) {
        const fileIds = [];
        for (const ref of m.files) {
          try {
            const f = await materialize(ctx, ref, parsed.zips);
            if (f) fileIds.push(f.id);
          } catch (e) { out.errors.push(`${c.title}: ${ref.name}: ${e.message}`); }
        }
        const msg = { role: m.role, text: m.text, files: fileIds, at: m.at || c.createdAt };
        if (m.model) msg.model = m.model;
        if (m.usage) msg.usage = m.usage;
        if (m.tools?.length) msg.tools = m.tools;
        if (m.stopReason) msg.stopReason = m.stopReason;
        messages.push(msg);
      }
      const src = c.originalSource || { kind: c.source, id: c.sourceId };
      const conv = {
        id: crypto.randomUUID(), provider, title: c.title, titled: true, system: c.system || '', model: c.model || '',
        messages, createdAt: c.createdAt, updatedAt: c.updatedAt,
        source: { kind: src.kind, id: src.id, importedAt: Date.now() },
      };
      store.data.conversations[conv.id] = conv;
      out.conversations.push({ id: conv.id, title: conv.title, provider, messages: messages.length });
    } catch (e) {
      out.errors.push(`${c.title}: ${e.message}`);
    }
  }
  store.save();
  if (out.conversations.length || out.restored) events.send('conversation', { imported: out.conversations.length });
  return out;
}

async function restoreBackup(ctx, parsed, opts) {
  const { store, events } = ctx;
  const b = parsed.backup.backup;
  const zip = parsed.zips[parsed.backup.backupZip];
  const r = { conversations: 0, jobs: 0, files: 0, settings: false };

  for (const [id, meta] of Object.entries(b.files || {})) {
    if (store.data.files[id]) continue;
    const entry = meta.archivePath && zip?.find(path.posix.join(parsed.backup.backupDir || '', meta.archivePath));
    if (!entry) continue;
    try {
      await storeFile(ctx, { id, name: meta.name, mime: meta.mime, buffer: await zip.buffer(entry), createdAt: meta.createdAt });
      r.files++;
    } catch {}
  }
  for (const [id, c] of Object.entries(b.conversations || {})) {
    if (store.data.conversations[id]) continue;
    store.data.conversations[id] = { ...c, messages: (c.messages || []).map(m => ({ ...m, files: (m.files || []).filter(f => store.data.files[f]) })) };
    r.conversations++;
  }
  for (const [id, j] of Object.entries(b.jobs || {})) {
    if (store.data.jobs[id]) continue;
    const job = { ...j, files: (j.files || []).filter(f => store.data.files[f]) };
    if (ACTIVE_STATUSES.has(job.status)) {
      // Never send something just because a backup was restored.
      Object.assign(job, { status: 'cancelled', finishedAt: Date.now(), lastError: 'Restored from a backup. Press Send now to queue it again.' });
    }
    store.data.jobs[id] = job;
    events.send('job', job);
    r.jobs++;
  }
  if (opts.restoreSettings && opts.isSession && b.settings) {
    const s = store.data.settings;
    const { providers, ...rest } = b.settings;
    Object.assign(s, rest);
    for (const [id, conf] of Object.entries(providers || {})) {
      s.providers ||= {};
      s.providers[id] = { ...(s.providers[id] || {}), ...conf };
    }
    r.settings = true;
  }
  store.save();
  return r;
}

/** Closes the zip readers and removes the uploaded files of an import. */
export async function disposeImport(parsed) {
  for (const z of Object.values(parsed.zips || {})) await z.close().catch(() => {});
  for (const p of parsed.tmpPaths || []) await fsp.unlink(p).catch(() => {});
}
