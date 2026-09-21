import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const API_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_EXT = new Set(('txt md markdown json jsonl csv tsv xml yaml yml toml ini cfg conf log html htm css scss ' +
  'js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql ' +
  'lua r m pl ex exs erl hs clj scala dart vue svelte astro tex bib env gitignore dockerfile makefile').split(' '));
const MAX_IMAGE_BYTES = 3.7 * 1024 * 1024; // keeps base64 under the API's 5 MB image limit

export function classify(name, mime = '', head = Buffer.alloc(0)) {
  const ext = path.extname(name).slice(1).toLowerCase() || path.basename(name).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  if (head.length && !head.includes(0)) return 'text'; // no NUL bytes in the first chunk: probably text
  return 'binary';
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.slice(-500) || `${cmd} exited ${code}`))));
  });
}

let ffmpegOk;
export async function hasFfmpeg() {
  if (ffmpegOk === undefined) {
    ffmpegOk = await run('ffmpeg', ['-version']).then(() => true, () => false);
  }
  return ffmpegOk;
}

// Returns a path to an image the API accepts: original if fine, otherwise a
// downscaled JPEG (handles oversized photos and formats like HEIC/BMP/TIFF).
export async function apiReadyImage(file) {
  const stat = await fsp.stat(file.path);
  if (API_IMAGE_TYPES.has(file.mime) && stat.size <= MAX_IMAGE_BYTES) return { path: file.path, mime: file.mime };
  const out = path.join(path.dirname(file.path), '_api.jpg');
  if (fs.existsSync(out)) return { path: out, mime: 'image/jpeg' };
  if (!(await hasFfmpeg())) throw new Error(`"${file.name}" is too large or not a supported image type, and ffmpeg isn't installed to convert it.`);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file.path, '-vf', "scale='min(1568,iw)':-2", '-q:v', '4', '-frames:v', '1', out]);
  return { path: out, mime: 'image/jpeg' };
}

// Claude reads video as a sequence of still frames. Frames are cached next to the upload.
export async function videoFrames(file, count = 10) {
  const dir = path.join(path.dirname(file.path), '_frames');
  try {
    const cached = (await fsp.readdir(dir)).filter(f => f.endsWith('.jpg')).sort();
    if (cached.length) return { dir, frames: cached.map(f => path.join(dir, f)), duration: null };
  } catch {}
  if (!(await hasFfmpeg())) throw new Error(`Reading video "${file.name}" needs ffmpeg installed on the server.`);
  await fsp.mkdir(dir, { recursive: true });
  let duration = 0;
  try {
    duration = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file.path])) || 0;
  } catch {}
  const fps = duration > 0 ? Math.max(count / duration, 0.01) : 1;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file.path, '-vf', `fps=${fps.toFixed(4)},scale='min(1024,iw)':-2`,
    '-frames:v', String(count), '-q:v', '5', path.join(dir, 'f_%03d.jpg')]);
  const frames = (await fsp.readdir(dir)).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(dir, f));
  if (!frames.length) throw new Error(`Couldn't extract frames from "${file.name}".`);
  return { dir, frames, duration };
}
