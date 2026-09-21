#!/usr/bin/env node
// Stands in for the Claude Code CLI during tests. It speaks the same
// stream-json output, and can pretend to hit a usage limit once.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0-fake'); process.exit(0); }

const flagFile = process.env.FAKE_CLAUDE_LIMIT_ONCE;
const log = process.env.FAKE_CLAUDE_ARGS_LOG;
if (log) fs.appendFileSync(log, `${args.join(' ')}\n`);

let stdin = '';
process.stdin.on('data', d => (stdin += d));
process.stdin.on('end', () => {
  const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'sess-test0001';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));

  if (flagFile && !fs.existsSync(flagFile)) {
    fs.writeFileSync(flagFile, 'used');
    const resetAt = Math.floor(Date.now() / 1000) + Number(process.env.FAKE_CLAUDE_RESET_SECONDS || 4);
    console.log(JSON.stringify({
      type: 'result', subtype: 'success', is_error: true,
      result: `Claude AI usage limit reached|${resetAt}`, session_id: sessionId,
    }));
    process.exit(1);
  }

  const first = stdin.split('\n')[0].trim();
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on: ${first}` }] } }));
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: `Done: ${first}`, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1,
  }));
});
