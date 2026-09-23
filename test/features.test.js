import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockProviders } from './fixtures/mock-providers.mjs';
import { startNightshift, sleep } from './fixtures/server.mjs';
import { zipToBuffer, ZipReader } from '../lib/zip.js';

let mock, ns;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d2f5e20000000049454e44ae426082', 'hex');

before(async () => {
  mock = await startMockProviders();
  ns = await startNightshift(mock, () => ({}));
});
after(async () => { ns?.close(); await mock?.close(); });

// ---------- providers and models ----------

test('Ollama shows up ready without a key, because the server answers', async () => {
  const providers = await ns.api('/v1/providers');
  const ollama = providers.find(p => p.id === 'ollama');
  assert.equal(ollama.ready, true);
  assert.equal(ollama.key_set, false);
  assert.equal(ollama.key_optional, true);
  assert.equal(ollama.status_note, '2 models');
  assert.equal(providers.find(p => p.id === 'claude-code').ready, true, 'the fake claude answers --version');
});

test('every provider fills the model picker, and refresh asks again', async () => {
  const ids = async (p, query) => (await ns.api('/v1/models', { query: { provider: p, ...query } })).map(m => m.id);
  assert.deepEqual(await ids('anthropic'), ['claude-opus-5']);
  assert.deepEqual(await ids('openai'), ['gpt-test']);
  assert.deepEqual(await ids('gemini'), ['gemini-test']);
  assert.deepEqual(await ids('ollama'), ['llama-test:latest', 'no-think:latest']);
  assert.ok((await ids('claude-code')).includes('opus'));
  const cached = await ns.raw('/v1/models', { query: { provider: 'ollama' } });
  assert.ok(cached.headers.get('x-models-cached-at'), 'a second read comes from the cache');
  const fresh = await ns.raw('/v1/models', { query: { provider: 'ollama', refresh: 'true' } });
  assert.equal(fresh.headers.get('x-models-cached-at'), null);
  const named = (await ns.api('/v1/models', { query: { provider: 'ollama' } }))[0].name;
  assert.equal(named, 'llama-test:latest (3B, Q4_K_M, 2.0 GB)');
});

test('Ollama: sends with no key, streams the reply, and passes images natively', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'ollama', model: 'llama-test:latest' } });
  const img = await ns.api('/v1/uploads/base64', { method: 'POST', body: { name: 'dot.png', mime: 'image/png', data: PNG.toString('base64') } });
  const { jobs } = await ns.api('/v1/messages', { method: 'POST', body: { provider: 'ollama', conversation_id: conv.id, text: 'hello llama', files: [img.id], effort: 'high' } });
  const done = await ns.waitFor(jobs[0].id, ['done', 'failed']);
  assert.equal(done.status, 'done', done.lastError);
  assert.equal(done.result.text, 'ollama reply to: hello llama (+1 image)');
  assert.deepEqual(done.result.usage, { input_tokens: 12, output_tokens: 5 });
  const call = mock.calls.findLast(c => c.path === '/ollama/api/chat');
  assert.equal(call.body.think, 'high');
  assert.equal(call.body.messages.at(-1).images.length, 1);
});

test('Ollama: a model that cannot think still answers, with thinking left out', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'ollama', model: 'no-think:latest' } });
  const { jobs } = await ns.api('/v1/messages', { method: 'POST', body: { provider: 'ollama', conversation_id: conv.id, text: 'plain please', effort: 'medium' } });
  const done = await ns.waitFor(jobs[0].id, ['done', 'failed']);
  assert.equal(done.status, 'done', done.lastError);
  assert.match(done.result.note, /Thinking/);
  assert.equal(mock.calls.findLast(c => c.path === '/ollama/api/chat').body.think, undefined);
});

test('Ollama: a model that is not pulled fails with a hint instead of retrying all night', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'ollama', model: 'missing' } });
  const { jobs } = await ns.api('/v1/messages', { method: 'POST', body: { provider: 'ollama', conversation_id: conv.id, text: 'hi' } });
  const failed = await ns.waitFor(jobs[0].id, ['done', 'failed']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError, /Pull it first/);
});

test('pulling an Ollama model reports progress over events', async () => {
  const res = await fetch(`${ns.base}/v1/events`, { headers: { authorization: `Bearer ${ns.token}` } });
  const reader = res.body.getReader();
  await ns.api('/api/ollama/pull', { method: 'POST', body: { model: 'llama-test' }, auth: 'cookie' });
  let text = '';
  const deadline = Date.now() + 10000;
  while (!/"done":true/.test(text) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  assert.match(text, /event: pull/);
  assert.match(text, /"status":"success","done":true/);
});

// ---------- import ----------

function chatgptExport() {
  const conv = {
    id: 'gpt-conv-1', conversation_id: 'gpt-conv-1', title: 'Trip ideas', create_time: 1758000000, update_time: 1758000900,
    current_node: 'a2', default_model_slug: 'gpt-5',
    mapping: {
      root: { id: 'root', parent: null, children: ['sys'] },
      sys: { id: 'sys', parent: 'root', children: ['u1'], message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } } },
      u1: { id: 'u1', parent: 'sys', children: ['tool'], message: { author: { role: 'user' }, create_time: 1758000001, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-Abc123' }, 'Where was this taken?'] }, metadata: {} } },
      tool: { id: 'tool', parent: 'u1', children: ['a1'], message: { author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'code', text: 'search("x")' }, metadata: {} } },
      a1: { id: 'a1', parent: 'tool', children: ['u2'], message: { author: { role: 'assistant' }, recipient: 'all', create_time: 1758000002, content: { content_type: 'text', parts: ['Lisbon, by the look of the trams.'] }, metadata: { model_slug: 'gpt-5' } } },
      u2: { id: 'u2', parent: 'a1', children: ['a2'], message: { author: { role: 'user' }, create_time: 1758000003, content: { content_type: 'text', parts: ['Plan two days there'] }, metadata: {} } },
      a2: { id: 'a2', parent: 'u2', children: [], message: { author: { role: 'assistant' }, recipient: 'all', create_time: 1758000004, content: { content_type: 'text', parts: ['Day one: Alfama.'] }, metadata: { model_slug: 'gpt-5' } } },
    },
  };
  return zipToBuffer({ 'conversations.json': JSON.stringify([conv]), 'file-Abc123-IMG_0042.png': PNG, 'user.json': '{}', 'chat.html': '<html></html>' });
}

test('ChatGPT export: preview, import with images, and skip on re-import', async () => {
  const zip = await chatgptExport();
  const preview = await ns.upload('/v1/import', { 'chatgpt-export.zip': zip }, { preview: 'true' });
  assert.deepEqual(preview.sources, [{ id: 'chatgpt', label: 'ChatGPT' }]);
  assert.equal(preview.conversations.length, 1);
  const [p] = preview.conversations;
  assert.equal(p.title, 'Trip ideas');
  assert.equal(p.messages, 4, 'the hidden system message and the tool call are left out');
  assert.equal(p.files, 1);
  assert.equal(p.alreadyImported, false);

  const result = await ns.api(`/v1/import/${preview.id}/commit`, { method: 'POST', body: {} });
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].provider, 'openai');
  const conv = await ns.api(`/v1/conversations/${result.conversations[0].id}`);
  assert.equal(conv.model, 'gpt-5');
  assert.equal(conv.source.kind, 'chatgpt');
  assert.equal(conv.messages[0].files[0].name, 'IMG_0042.png');
  assert.equal(conv.messages[0].files[0].kind, 'image');
  assert.equal(conv.messages[0].text, 'Where was this taken?');

  // The imported conversation carries on like any other.
  const { jobs } = await ns.api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'and a third day?', model: 'gpt-test' } });
  assert.equal((await ns.waitFor(jobs[0].id, ['done', 'failed'])).status, 'done');

  const again = await ns.upload('/v1/import', { 'chatgpt-export.zip': zip }, { preview: 'true' });
  assert.equal(again.conversations[0].alreadyImported, true);
  const skipped = await ns.api(`/v1/import/${again.id}/commit`, { method: 'POST', body: {} });
  assert.equal(skipped.conversations.length, 0);
  assert.equal(skipped.skipped, 1);
});

test('Claude export: messages, artifacts and attachment text come across', async () => {
  const conversations = [{
    uuid: 'claude-1', name: 'Budget sheet', created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-01T09:05:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', created_at: '2026-09-01T09:00:00Z', text: 'Check my numbers', content: [{ type: 'text', text: 'Check my numbers' }],
        attachments: [{ file_name: 'budget.csv', file_type: 'text/csv', extracted_content: 'rent,1200\nfood,400' }], files: [] },
      { uuid: 'm2', sender: 'assistant', created_at: '2026-09-01T09:01:00Z', text: '',
        content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'They add up.' },
          { type: 'tool_use', name: 'artifacts', input: { command: 'create', title: 'Summary', language: 'markdown', content: '# Total 1600' } }] },
    ],
  }];
  const zip = await zipToBuffer({ 'conversations.json': JSON.stringify(conversations), 'users.json': '[]', 'projects.json': '[]' });
  const r = await ns.upload('/v1/import', { 'claude-export.zip': zip });
  assert.equal(r.conversations.length, 1);
  assert.equal(r.conversations[0].provider, 'anthropic');
  const conv = await ns.api(`/v1/conversations/${r.conversations[0].id}`);
  assert.equal(conv.title, 'Budget sheet');
  assert.equal(conv.messages[0].files[0].name, 'budget.csv');
  assert.match(conv.messages[1].text, /They add up\.\n\n\*\*Summary\*\*\n\n```markdown\n# Total 1600\n```/);
  assert.doesNotMatch(conv.messages[1].text, /hmm/);
});

test('Gemini Takeout: prompts close together become one conversation', async () => {
  const t = iso => new Date(Date.parse(iso)).toISOString();
  const activity = [
    { header: 'Gemini Apps', title: 'Prompted what is a good name for a cat', time: t('2026-09-02T10:00:00Z'), products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>Try <b>Miso</b>.</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted a shorter one', time: t('2026-09-02T10:04:00Z'), products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>Bo.</p>' }] },
    { header: 'Gemini Apps', title: 'Used an Assistant feature', time: t('2026-09-02T10:05:00Z'), products: ['Gemini Apps'] },
    { header: 'Gemini Apps', title: 'Prompted explain tides', time: t('2026-09-05T18:00:00Z'), products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>The moon.</p>' }] },
  ].reverse();
  const zip = await zipToBuffer({ 'Takeout/My Activity/Gemini Apps/MyActivity.json': JSON.stringify(activity), 'Takeout/archive_browser.html': '<html></html>' });
  const preview = await ns.upload('/v1/import', { 'takeout.zip': zip }, { preview: 'true' });
  assert.deepEqual(preview.conversations.map(c => [c.title, c.messages]), [['what is a good name for a cat', 4], ['explain tides', 2]]);
  const r = await ns.api(`/v1/import/${preview.id}/commit`, { method: 'POST', body: { provider: 'ollama' } });
  assert.deepEqual(r.conversations.map(c => c.provider), ['ollama', 'ollama'], 'a chosen provider overrides the matching one');
  const conv = await ns.api(`/v1/conversations/${r.conversations[0].id}`);
  assert.deepEqual(conv.messages.map(m => m.text), ['what is a good name for a cat', 'Try **Miso**.', 'a shorter one', 'Bo.']);
});

test('Gemini Takeout in HTML, and AI Studio prompts, are read too', async () => {
  const html = `<html><body><div class="outer-cell mdl-cell"><div class="mdl-grid"><div class="header-cell mdl-cell"><p class="mdl-typography--title">Gemini Apps<br></p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;hello there<br>Sep 3, 2026, 9:15:00 AM UTC<br><p>General Kenobi.</p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div></div></div></body></html>`;
  const studio = { runSettings: { model: 'models/gemini-3-pro' }, systemInstruction: { text: 'Answer in French.' },
    chunkedPrompt: { chunks: [{ role: 'user', text: 'Hello' }, { role: 'model', text: 'thinking…', isThought: true }, { role: 'model', text: 'Bonjour' }] } };
  const preview = await ns.upload('/v1/import', { 'MyActivity.html': html, 'Greeting prompt': JSON.stringify(studio) }, { preview: 'true' });
  assert.deepEqual(preview.sources.map(s => s.id).sort(), ['aistudio', 'gemini']);
  const r = await ns.api(`/v1/import/${preview.id}/commit`, { method: 'POST', body: {} });
  const convs = await Promise.all(r.conversations.map(c => ns.api(`/v1/conversations/${c.id}`)));
  const fromHtml = convs.find(c => c.title === 'hello there');
  assert.deepEqual(fromHtml.messages.map(m => m.text), ['hello there', 'General Kenobi.']);
  assert.equal(fromHtml.messages[0].at, Date.parse('2026-09-03T09:15:00Z'));
  const studioConv = convs.find(c => c.title === 'Greeting prompt');
  assert.equal(studioConv.model, 'gemini-3-pro');
  assert.equal(studioConv.system, 'Answer in French.');
  assert.deepEqual(studioConv.messages.map(m => m.text), ['Hello', 'Bonjour']);
});

function claudeCodeSession(id, cwd) {
  const line = o => JSON.stringify({ sessionId: id, cwd, timestamp: '2026-09-04T08:00:00Z', ...o });
  return [
    line({ type: 'user', message: { role: 'user', content: 'Fix the flaky test' } }),
    line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: {} }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file' }] } }),
    line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Fixed: it raced the clock.' }] } }),
  ].join('\n');
}

test('Claude Code sessions go into this machine\'s history, resumable, or become a conversation', async () => {
  const project = path.join(ns.dataDir, 'proj');
  fs.mkdirSync(project);
  const zip = await zipToBuffer({
    'projects/-Users-me-app/sess-import-01.jsonl': claudeCodeSession('sess-import-01', '/Users/me/app'),
    'projects/-Users-me-app/agent-123.jsonl': claudeCodeSession('sess-agent', '/Users/me/app'),
  });
  const preview = await ns.upload('/v1/import', { 'claude-projects.zip': zip }, { preview: 'true' });
  assert.equal(preview.conversations.length, 1, 'sub-agent transcripts are left out');
  assert.equal(preview.conversations[0].cwd, '/Users/me/app');
  const r = await ns.api(`/v1/import/${preview.id}/commit`, { method: 'POST', body: { target: 'claude-code', cwd: project } });
  assert.deepEqual(r.sessions.map(s => s.id), ['sess-import-01']);

  const sessions = await ns.api('/v1/sessions');
  const found = sessions.find(s => s.id === 'sess-import-01');
  assert.equal(found.cwd, project, 'the session now points at the folder on this server');
  assert.equal(found.title, 'Fix the flaky test');
  const transcript = await ns.api('/v1/sessions/sess-import-01');
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[0].text, 'Fix the flaky test');

  // The same session file straight up, as a chat conversation instead.
  const plain = await ns.upload('/v1/import', { 'sess-import-02.jsonl': claudeCodeSession('sess-import-02', '/tmp') });
  assert.equal(plain.conversations.length, 1);
  const conv = await ns.api(`/v1/conversations/${plain.conversations[0].id}`);
  assert.equal(conv.provider, 'anthropic');
  assert.deepEqual(conv.messages[1].tools, ['Read']);
});

test('nonsense uploads get a clear error', async () => {
  await assert.rejects(() => ns.upload('/v1/import', { 'notes.json': '{"hello":"world"}' }), /400 Nothing to import/);
  await assert.rejects(() => ns.upload('/v1/import', { 'chat.html': '<html>ChatGPT</html>' }), /400 .*conversations\.json/);
  await assert.rejects(() => ns.api('/v1/import/nope/commit', { method: 'POST', body: {} }), /404/);
});

// ---------- export ----------

test('a conversation exports as Markdown and as JSON, and the JSON imports back whole', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test', title: 'Export me', system: 'Be kind.' } });
  const img = await ns.api('/v1/uploads/base64', { method: 'POST', body: { name: 'dot.png', mime: 'image/png', data: PNG.toString('base64') } });
  const { jobs } = await ns.api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'export test', files: [img.id] } });
  await ns.waitFor(jobs[0].id, ['done']);

  const mdRes = await ns.raw(`/v1/conversations/${conv.id}/export`, { query: { format: 'md', tz: 'UTC' } });
  assert.match(mdRes.headers.get('content-disposition'), /export-me\.md/);
  const md = await mdRes.text();
  assert.match(md, /^# Export me/);
  assert.match(md, /Attachments: dot\.png\n\nexport test/);
  assert.match(md, /## Assistant \(gpt-test\)/);

  const json = await ns.api(`/v1/conversations/${conv.id}/export`, { query: { format: 'json' } });
  assert.equal(json.format, 'nightshift.conversations');
  assert.equal(json.conversations[0].messages[0].files[0].data, PNG.toString('base64'));

  const r = await ns.upload('/v1/import', { 'export-me.json': JSON.stringify(json) });
  const copy = await ns.api(`/v1/conversations/${r.conversations[0].id}`);
  assert.equal(copy.title, 'Export me');
  assert.equal(copy.system, 'Be kind.');
  assert.equal(copy.provider, 'openai');
  assert.equal(copy.messages[0].files[0].size, PNG.length);
});

test('a Claude Code session exports as Markdown, JSON and its raw .jsonl', async () => {
  const md = await (await ns.raw('/v1/sessions/sess-import-01/export', { query: { format: 'md' } })).text();
  assert.match(md, /# Fix the flaky test/);
  assert.match(md, /_Used Read_/);
  const raw = await (await ns.raw('/v1/sessions/sess-import-01/export', { query: { format: 'jsonl' } })).text();
  assert.equal(raw.trim().split('\n').length, 4);
});

test('everything exports at once, as JSON or a zip of Markdown files', async () => {
  const all = await ns.api('/v1/export', { query: { format: 'json' } });
  assert.ok(all.conversations.length >= 5);
  const res = await ns.raw('/v1/export', { query: { format: 'md' } });
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const file = path.join(ns.dataDir, 'all.zip');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const z = await ZipReader.open(file);
  assert.ok(z.entries.some(e => /^nightshift\/openai\/\d{4}-\d{2}-\d{2}-export-me\.md$/.test(e.name)));
  await z.close();
});

test('a full backup restores a deleted conversation and brings queued work back cancelled', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test', title: 'Keep me safe' } });
  const later = await ns.api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'tomorrow', mode: 'at', run_at: Date.now() + 86400000 } });

  const tokenTry = await ns.raw('/api/backup');
  assert.equal(tokenTry.status, 403, 'a token cannot take a backup with keys in it');
  const res = await ns.raw('/api/backup', { auth: 'cookie' });
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const file = path.join(ns.dataDir, 'backup.zip');
  fs.writeFileSync(file, zipBuf);
  const z = await ZipReader.open(file);
  const manifest = JSON.parse(await z.text('nightshift-backup.json'));
  assert.equal(manifest.includesKeys, false);
  assert.ok(z.entries.some(e => e.name.startsWith('files/')), 'attachments ride along');
  await z.close();

  await ns.api(`/v1/jobs/${later.jobs[0].id}`, { method: 'DELETE' });
  await ns.api(`/v1/conversations/${conv.id}`, { method: 'DELETE' });

  const preview = await ns.upload('/v1/import', { 'backup.zip': zipBuf }, { preview: 'true' });
  assert.deepEqual(preview.sources, [{ id: 'backup', label: 'Nightshift backup' }]);
  assert.ok(preview.backup.jobs > 0);
  const r = await ns.api(`/v1/import/${preview.id}/commit`, { method: 'POST', body: {} });
  assert.ok(r.restored.conversations >= 1);
  const back = await ns.api(`/v1/conversations/${conv.id}`);
  assert.equal(back.title, 'Keep me safe');
  const job = await ns.api(`/v1/jobs/${later.jobs[0].id}`);
  assert.equal(job.status, 'cancelled');
  assert.match(job.lastError, /Restored from a backup/);
});

// ---------- repeating schedules ----------

test('a repeating chain queues its next occurrence, a day later, once it has run', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  const runAt = Date.now() + 1500;
  const { jobs } = await ns.api('/v1/messages', {
    method: 'POST',
    body: { provider: 'openai', conversation_id: conv.id, mode: 'at', run_at: runAt, repeat: 'daily', timezone: 'UTC',
      messages: [{ text: 'morning report' }, { text: 'and the follow-up' }] },
  });
  assert.deepEqual(jobs[0].repeat, { every: 'daily', timezone: 'UTC' });
  assert.equal(jobs[1].repeat, undefined);

  const head = await ns.waitFor(jobs[0].id, ['done', 'failed'], 30000);
  assert.equal(head.status, 'done');
  assert.ok(head.repeatedBy, 'the next occurrence was queued');
  const next = await ns.api(`/v1/jobs/${head.repeatedBy}`);
  assert.equal(next.mode, 'at');
  // Repeats keep the wall-clock minute, so seconds drop off.
  assert.equal(next.runAt, Math.floor(runAt / 60000) * 60000 + 86400000);
  assert.equal(next.prompt, 'morning report');
  assert.deepEqual(next.repeat, { every: 'daily', timezone: 'UTC' });
  const chain = await ns.api('/v1/jobs', { query: { conversation_id: conv.id, status: 'active' } });
  const follow = chain.find(j => j.dependsOn === next.id);
  assert.equal(follow.prompt, 'and the follow-up');
  assert.equal(follow.status, 'waiting_step');

  // The follow-up of today's run still goes out; tomorrow's chain doesn't hold it up.
  assert.equal((await ns.waitFor(jobs[1].id, ['done', 'failed'])).status, 'done');

  const stopped = await ns.api(`/v1/jobs/${next.id}`, { method: 'PATCH', body: { repeat: 'none' } });
  assert.equal(stopped.repeat, null);
  await ns.api(`/v1/jobs/${next.id}/cancel`, { method: 'POST' });
});

test('a repeat needs a time of day to repeat at', async () => {
  const conv = await ns.api('/v1/conversations', { method: 'POST', body: { provider: 'openai', model: 'gpt-test' } });
  await assert.rejects(() => ns.api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'x', mode: 'reset', repeat: 'daily' } }), /needs mode "at"/);
  await assert.rejects(() => ns.api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'x', mode: 'at', run_at: Date.now() + 60000, repeat: 'hourly' } }), /repeat must be one of/);
  await assert.rejects(() => ns.api('/v1/messages', { method: 'POST', body: { provider: 'openai', conversation_id: conv.id, text: 'x', mode: 'at', run_at: Date.now() + 60000, repeat: 'daily', timezone: 'Mars/Olympus' } }), /Unknown timezone/);
});
