import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { classify } from './media.js';

export const safeName = n => path.basename(String(n)).replace(/[^\w.\- ()]+/g, '_').slice(0, 150) || 'file';
export const fileInfo = f => f && ({ id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind });

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  m4a: 'audio/mp4', ogg: 'audio/ogg',
};
export const mimeFromName = name => MIME[path.extname(name).slice(1).toLowerCase()] || '';

/**
 * Saves an attachment under data/uploads/<id>/ and records it.
 * Give it either a temp file to move (tmpPath) or the bytes (buffer).
 */
export async function storeFile({ store, dataDir }, { name, mime, size, tmpPath, buffer, id = crypto.randomUUID(), createdAt = Date.now() }) {
  const clean = safeName(name);
  const dir = path.join(dataDir, 'uploads', id);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, clean);
  if (buffer) await fsp.writeFile(dest, buffer);
  else await fsp.rename(tmpPath, dest).catch(async () => { await fsp.copyFile(tmpPath, dest); await fsp.unlink(tmpPath); });
  const fh = await fsp.open(dest, 'r');
  const { buffer: head, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0);
  await fh.close();
  const meta = {
    id, name: clean, size: size ?? (await fsp.stat(dest)).size,
    mime: mime || mimeFromName(clean) || 'application/octet-stream', path: dest, createdAt,
  };
  meta.kind = classify(clean, meta.mime, head.subarray(0, bytesRead));
  store.data.files[id] = meta;
  store.save();
  return meta;
}
