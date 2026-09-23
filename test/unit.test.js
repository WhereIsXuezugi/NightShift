import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextOccurrence } from '../lib/time.js';
import { htmlToText, parseImport, disposeImport } from '../lib/importers.js';
import { ZipReader, zipToBuffer } from '../lib/zip.js';
import { toMarkdown } from '../lib/exporters.js';

const wall = (ts, tz) => new Date(ts).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'numeric', day: 'numeric' });

test('a daily repeat keeps its wall-clock time across a DST change', () => {
  const tz = 'America/New_York';
  const from = Date.parse('2026-10-31T07:00:00-04:00'); // the day before clocks go back
  const now = from + 60000;
  const next = nextOccurrence(from, 'daily', tz, now);
  assert.equal(wall(next, tz), 'Sun, 11/1, 7:00 AM');
  assert.equal(next - from, 25 * 3600 * 1000, 'that day is 25 hours long');
});

test('a weekday repeat skips the weekend', () => {
  const tz = 'Europe/Berlin';
  const friday = Date.parse('2026-09-25T08:30:00+02:00');
  assert.equal(wall(nextOccurrence(friday, 'weekdays', tz, friday + 1000), tz), 'Mon, 9/28, 8:30 AM');
});

test('a weekly repeat lands on the same weekday', () => {
  const tz = 'Asia/Tokyo';
  const from = Date.parse('2026-09-23T21:00:00+09:00');
  assert.equal(wall(nextOccurrence(from, 'weekly', tz, from + 1000), tz), 'Wed, 9/30, 9:00 PM');
});

test('a repeat that missed several runs catches up once, not once per missed run', () => {
  const tz = 'UTC';
  const from = Date.parse('2026-09-01T06:00:00Z');
  const now = Date.parse('2026-09-10T12:00:00Z');
  assert.equal(new Date(nextOccurrence(from, 'daily', tz, now)).toISOString(), '2026-09-11T06:00:00.000Z');
});

test('Gemini activity HTML becomes readable Markdown', () => {
  const html = '<p>Here are <b>two</b> options:</p><ul><li>First &amp; best</li><li><a href="https://example.com">Example</a></li></ul><pre>x = 1\ny = 2</pre>';
  assert.equal(htmlToText(html), 'Here are **two** options:\n\n- First & best\n- [Example](https://example.com)\n\n```\nx = 1\ny = 2\n```');
});

test('zip entries written here read back through the reader', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-zip-'));
  const file = path.join(dir, 'x.zip');
  fs.writeFileSync(file, await zipToBuffer({ 'a/b.json': '{"ok":true}', 'big.txt': 'z'.repeat(100000), 'pic.png': Buffer.from([137, 80, 78, 71]) }));
  const z = await ZipReader.open(file);
  assert.deepEqual(z.entries.map(e => e.name), ['a/b.json', 'big.txt', 'pic.png']);
  assert.equal(JSON.parse(await z.text('a/b.json')).ok, true);
  assert.equal((await z.text('big.txt')).length, 100000);
  assert.ok(z.find('big.txt').compressedSize < 1000, 'text is deflated');
  await z.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ChatGPT conversation follows the branch that was on screen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-imp-'));
  const conv = {
    id: 'c1', title: 'Branches', create_time: 1758000000, update_time: 1758000600, current_node: 'b2',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: { id: 'u1', parent: 'root', children: ['a1', 'b1'], message: { author: { role: 'user' }, create_time: 1758000001, content: { content_type: 'text', parts: ['Pick a colour'] } } },
      a1: { id: 'a1', parent: 'u1', children: [], message: { author: { role: 'assistant' }, create_time: 1758000002, content: { content_type: 'text', parts: ['Old answer: red'] } } },
      b1: { id: 'b1', parent: 'u1', children: ['b2'], message: { author: { role: 'assistant' }, create_time: 1758000003, recipient: 'all', metadata: { model_slug: 'gpt-5' }, content: { content_type: 'text', parts: ['Blue\ue200cite\ue202turn0search0\ue201.'] } } },
      b2: { id: 'b2', parent: 'b1', children: [], message: { author: { role: 'user' }, create_time: 1758000004, content: { content_type: 'text', parts: ['Why?'] } } },
    },
  };
  const file = path.join(dir, 'conversations.json');
  fs.writeFileSync(file, JSON.stringify([conv]));
  const parsed = await parseImport([{ path: file, name: 'conversations.json' }]);
  assert.deepEqual(parsed.sources, ['chatgpt']);
  const [c] = parsed.conversations;
  assert.deepEqual(c.messages.map(m => m.text), ['Pick a colour', 'Blue.', 'Why?']);
  assert.equal(c.model, 'gpt-5');
  assert.equal(c.provider, 'openai');
  await disposeImport(parsed);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Markdown export reads like a transcript', () => {
  const md = toMarkdown({
    title: 'Plan', provider: 'openai', model: 'gpt-5', system: 'Be brief.', createdAt: Date.UTC(2026, 8, 1), updatedAt: Date.UTC(2026, 8, 1),
    messages: [
      { role: 'user', text: 'Hello', at: Date.UTC(2026, 8, 1, 10), files: [{ name: 'a.png' }] },
      { role: 'assistant', text: 'Hi.', model: 'gpt-5', at: Date.UTC(2026, 8, 1, 10, 1), files: [] },
    ],
  }, { tz: 'UTC', version: '9.9.9' });
  assert.match(md, /^# Plan\n/);
  assert.match(md, /- \*\*Provider:\*\* OpenAI/);
  assert.match(md, /> Be brief\./);
  assert.match(md, /## You, 2026-09-01 10:00 UTC\n\nAttachments: a\.png\n\nHello/);
  assert.match(md, /## Assistant \(gpt-5\), 2026-09-01 10:01 UTC\n\nHi\./);
});
