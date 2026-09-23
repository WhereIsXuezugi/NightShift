import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

// Enough zip for chat exports and backups, without a dependency.
// The reader seeks to the entries it needs rather than loading the archive,
// so a multi-gigabyte ChatGPT export with years of images is fine.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return ~crc >>> 0;
}

const MAX32 = 0xFFFFFFFF;

// ---------- reading ----------

export async function isZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && buffer.readUInt32LE(0) === 0x04034b50;
  } finally { await fh.close(); }
}

export class ZipReader {
  static async open(file) {
    const z = new ZipReader();
    z.fh = await fsp.open(file, 'r');
    z.size = (await z.fh.stat()).size;
    await z.readDirectory();
    return z;
  }

  async read(pos, len) {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await this.fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  }

  async readDirectory() {
    const tailLen = Math.min(this.size, 65557);
    const tail = await this.read(this.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This is not a zip file, or it is damaged.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (cdOffset === MAX32 || count === 0xFFFF) {
      // zip64: the real numbers are in the zip64 end record, found through its locator.
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const recPos = Number(tail.readBigUInt64LE(loc + 8));
        const rec = await this.read(recPos, 56);
        if (rec.readUInt32LE(0) === 0x06064b50) {
          count = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
        }
      }
    }

    const cd = await this.read(cdOffset, cdSize);
    this.entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e), len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === MAX32) { size = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === MAX32) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (offset === MAX32) { offset = Number(extra.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) this.entries.push({ name, method, compressedSize, size, offset, encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  find(pred) { return this.entries.find(typeof pred === 'string' ? e => e.name === pred : pred); }
  filter(pred) { return this.entries.filter(pred); }

  async buffer(entry, maxBytes = 1024 * 1024 * 1024) {
    if (typeof entry === 'string') entry = this.find(entry);
    if (!entry) throw new Error('Entry not found in the zip.');
    if (entry.encrypted) throw new Error(`"${entry.name}" is encrypted.`);
    if (entry.size > maxBytes) throw new Error(`"${entry.name}" is too large to read (${Math.round(entry.size / 1e6)} MB).`);
    const head = await this.read(entry.offset, 30);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`Damaged zip entry "${entry.name}".`);
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = await this.read(start, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) + 1024 });
    throw new Error(`"${entry.name}" uses a compression method this app can't read (${entry.method}).`);
  }

  async text(entry, maxBytes) { return (await this.buffer(entry, maxBytes)).toString('utf8'); }
  async close() { await this.fh?.close(); this.fh = null; }
}

// ---------- writing ----------

// Formats that are already compressed gain nothing from deflate.
const STORED = /\.(png|jpe?g|gif|webp|heic|avif|mp4|mov|webm|mkv|mp3|m4a|ogg|opus|zip|gz|7z|pdf|woff2?)$/i;

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Writes a zip to any writable stream, one entry at a time. Each entry is
 * held in memory while it is compressed, so the archive itself can be any size.
 */
export class ZipWriter {
  constructor(out) {
    this.out = out;
    this.pos = 0;
    this.central = [];
    this.names = new Set();
  }

  async write(buf) {
    this.pos += buf.length;
    if (!this.out.write(buf)) await new Promise(r => this.out.once('drain', r));
  }

  uniqueName(name) {
    let n = name.replace(/\\/g, '/').replace(/^\/+/, ''), i = 1;
    const dot = n.lastIndexOf('.');
    while (this.names.has(n)) n = dot > n.lastIndexOf('/') ? `${name.slice(0, dot)} (${++i})${name.slice(dot)}` : `${name} (${++i})`;
    this.names.add(n);
    return n;
  }

  async add(name, data, { mtime = new Date() } = {}) {
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    name = this.uniqueName(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflate = !STORED.test(name) && data.length > 64;
    const body = deflate ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const method = deflate ? 8 : 0;
    const { time, date } = dosTime(mtime);
    const offset = this.pos;
    const big = data.length >= MAX32 || body.length >= MAX32 || offset >= MAX32;

    const zip64Local = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      zip64Local.writeUInt16LE(0x0001, 0); zip64Local.writeUInt16LE(16, 2);
      zip64Local.writeBigUInt64LE(BigInt(data.length), 4); zip64Local.writeBigUInt64LE(BigInt(body.length), 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(big ? MAX32 : body.length, 18);
    local.writeUInt32LE(big ? MAX32 : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(zip64Local.length, 28);
    await this.write(Buffer.concat([local, nameBuf, zip64Local]));
    await this.write(body);
    this.central.push({ nameBuf, crc, method, time, date, size: data.length, csize: body.length, offset, big });
  }

  async finish() {
    const cdStart = this.pos;
    for (const e of this.central) {
      const extra = e.big ? Buffer.alloc(28) : Buffer.alloc(0);
      if (e.big) {
        extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4); extra.writeBigUInt64LE(BigInt(e.csize), 12); extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(e.big ? 45 : 20, 4); h.writeUInt16LE(e.big ? 45 : 20, 6);
      h.writeUInt16LE(0x800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.big ? MAX32 : e.csize, 20);
      h.writeUInt32LE(e.big ? MAX32 : e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(e.big ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.nameBuf, extra]));
    }
    const cdSize = this.pos - cdStart;
    const count = this.central.length;
    const need64 = count >= 0xFFFF || cdStart >= MAX32 || cdSize >= MAX32;
    if (need64) {
      const recPos = this.pos;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
      rec.writeBigUInt64LE(BigInt(count), 24); rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40); rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(recPos), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, 0xFFFF), 8);
    end.writeUInt16LE(Math.min(count, 0xFFFF), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(need64 ? MAX32 : cdStart, 16);
    await this.write(end);
  }
}

/** Collects a zip in memory. For tests and small exports. */
export async function zipToBuffer(files) {
  const chunks = [];
  const sink = { write: b => { chunks.push(Buffer.from(b)); return true; }, once() {} };
  const w = new ZipWriter(sink);
  for (const [name, data] of Object.entries(files)) await w.add(name, data);
  await w.finish();
  return Buffer.concat(chunks);
}
