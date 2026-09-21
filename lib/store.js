import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  settings: {},
  conversations: {}, // API conversations, stored locally
  jobs: {},          // scheduled / queued messages
  files: {},         // uploaded attachments
  limits: {},        // per-provider limit state
});

// Small JSON-file database. Writes are debounced and atomic (write temp, rename),
// so a crash mid-write never corrupts the file.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.timer = null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      this.data = { ...EMPTY(), ...JSON.parse(raw) };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const backup = `${file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(file, backup); } catch {}
        console.error(`[store] Could not read ${file} (${e.message}). Backed up to ${backup}, starting fresh.`);
      }
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
