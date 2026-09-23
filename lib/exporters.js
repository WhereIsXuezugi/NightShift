import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ZipWriter } from './zip.js';
import { PROVIDERS } from './providers/index.js';
import { SOURCES } from './importers.js';
import { validTz, serverTz } from './time.js';

const labelOf = id => PROVIDERS[id]?.label || id;

export const slug = s => String(s || 'conversation').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
  .trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'conversation';

function stamp(ts, tz) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: validTz(tz) || serverTz(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(ts)).replace(',', '');
}

/**
 * A conversation in the one shape both exporters take:
 *   { id, provider, title, model, system, createdAt, updatedAt, source?, cwd?,
 *     messages: [{ role, text, at, model?, usage?, tools?, files: [fileMeta] }] }
 */
export function fromConversation(c, files) {
  return {
    id: c.id, provider: c.provider, title: c.title, model: c.model, system: c.system,
    createdAt: c.createdAt, updatedAt: c.updatedAt, source: c.source,
    messages: c.messages.map(m => ({
      role: m.role, at: m.at, model: m.model, usage: m.usage, tools: m.tools, stopReason: m.stopReason,
      text: m.text ?? (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n'),
      files: (m.files || []).map(id => files[id]).filter(Boolean),
    })),
  };
}

export function fromSession(s, title) {
  const at = s.messages.map(m => m.at).filter(Boolean);
  return {
    id: s.id, provider: 'claude-code', title: title || s.title || 'Claude Code session', cwd: s.cwd,
    createdAt: at[0] || null, updatedAt: at[at.length - 1] || null,
    messages: s.messages.map(m => ({ role: m.role, text: m.text, at: m.at, tools: m.tools, model: m.model, files: [] })),
  };
}

export function toMarkdown(conv, { tz, version } = {}) {
  const lines = [`# ${conv.title}`, ''];
  const meta = [
    ['Provider', labelOf(conv.provider)],
    ['Model', conv.model],
    ['Folder', conv.cwd],
    ['Started', stamp(conv.createdAt, tz)],
    ['Last message', stamp(conv.updatedAt, tz)],
    ['Imported from', conv.source ? SOURCES[conv.source.kind]?.label || conv.source.kind : ''],
  ].filter(([, v]) => v);
  for (const [k, v] of meta) lines.push(`- **${k}:** ${v}`);
  lines.push(`- **Exported:** ${stamp(Date.now(), tz)}${version ? ` from Nightshift ${version}` : ''}`, '');
  if (conv.system?.trim()) lines.push('## System prompt', '', ...conv.system.trim().split('\n').map(l => `> ${l}`), '');
  lines.push('---', '');
  for (const m of conv.messages) {
    const who = m.role === 'user' ? 'You' : `Assistant${m.model ? ` (${m.model})` : ''}`;
    lines.push(`## ${who}${m.at ? `, ${stamp(m.at, tz)}` : ''}`, '');
    if (m.files?.length) lines.push(`Attachments: ${m.files.map(f => f.name).join(', ')}`, '');
    lines.push((m.text || '').trim() || '_(no text)_', '');
    if (m.tools?.length) lines.push(`_Used ${[...new Set(m.tools)].join(', ')}_`, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Nightshift's own format. Attachments ride along as base64 so an import is complete. */
export async function toJson(convs, { version, inlineFiles = true, maxInlineBytes = 200 * 1024 * 1024 } = {}) {
  let budget = maxInlineBytes;
  const out = [];
  for (const c of convs) {
    const messages = [];
    for (const m of c.messages) {
      const files = [];
      for (const f of m.files || []) {
        const item = { name: f.name, mime: f.mime, size: f.size };
        if (inlineFiles && f.size <= budget && fs.existsSync(f.path)) {
          item.data = (await fsp.readFile(f.path)).toString('base64');
          budget -= f.size;
        }
        files.push(item);
      }
      const msg = { role: m.role, text: m.text, at: m.at ?? null };
      for (const k of ['model', 'usage', 'tools', 'stopReason']) if (m[k] != null && !(Array.isArray(m[k]) && !m[k].length)) msg[k] = m[k];
      if (files.length) msg.files = files;
      messages.push(msg);
    }
    const conv = { id: c.id, provider: c.provider, title: c.title, model: c.model || '', system: c.system || '', createdAt: c.createdAt, updatedAt: c.updatedAt };
    if (c.cwd) conv.cwd = c.cwd;
    if (c.source) conv.source = { kind: c.source.kind, id: c.source.id };
    conv.messages = messages;
    out.push(conv);
  }
  return { format: 'nightshift.conversations', version: 1, app: `Nightshift ${version || ''}`.trim(), exportedAt: new Date().toISOString(), conversations: out };
}

export const markdownName = conv => `${conv.createdAt ? new Date(conv.createdAt).toISOString().slice(0, 10) : 'undated'}-${slug(conv.title)}.md`;

/** Every conversation as Markdown files in a zip, one folder per provider. */
export async function writeMarkdownZip(out, convs, opts) {
  const zip = new ZipWriter(out);
  for (const c of convs) await zip.add(`nightshift/${c.provider}/${markdownName(c)}`, toMarkdown(c, opts), { mtime: new Date(c.updatedAt || Date.now()) });
  await zip.finish();
}

/**
 * The whole app in one zip: conversations, the queue, attachments and settings.
 * API keys are left out unless asked for, since a backup tends to get copied around.
 */
export async function writeBackup(out, { store, version, includeKeys = false }) {
  const zip = new ZipWriter(out);
  const settings = JSON.parse(JSON.stringify(store.data.settings || {}));
  if (!includeKeys) for (const conf of Object.values(settings.providers || {})) delete conf.key;
  const files = {};
  for (const [id, f] of Object.entries(store.data.files)) {
    if (!fs.existsSync(f.path)) continue;
    const archivePath = `files/${id}/${f.name}`;
    files[id] = { id, name: f.name, mime: f.mime, size: f.size, kind: f.kind, createdAt: f.createdAt, archivePath };
  }
  const manifest = {
    format: 'nightshift.backup', version: 1, app: `Nightshift ${version}`, exportedAt: new Date().toISOString(),
    includesKeys: includeKeys, settings, conversations: store.data.conversations, jobs: store.data.jobs, files,
  };
  await zip.add('nightshift-backup.json', JSON.stringify(manifest, null, 1));
  for (const [id, meta] of Object.entries(files)) {
    try { await zip.add(meta.archivePath, await fsp.readFile(store.data.files[id].path), { mtime: new Date(meta.createdAt || Date.now()) }); } catch {}
  }
  await zip.finish();
}
