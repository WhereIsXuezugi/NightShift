import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLimit } from '../lib/providers/claudeCode.js';
import { parseDuration } from '../lib/providers/chat.js';

process.env.TZ ||= 'America/Los_Angeles';
const NOW = Date.parse('2026-09-18T23:40:00-07:00');
const local = ts => new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

test('reads an epoch reset out of the limit message', () => {
  const r = parseLimit('Claude AI usage limit reached|1758272400', NOW);
  assert.equal(r.resetAt, 1758272400000);
});

test('reads a clock time and rolls over to tomorrow when it has passed', () => {
  assert.equal(local(parseLimit('5-hour limit reached ∙ resets 3am', NOW).resetAt), '9/19/2026, 3:00:00 AM');
  assert.equal(local(parseLimit('Your limit will reset at 11pm.', NOW).resetAt), '9/19/2026, 11:00:00 PM');
});

test('honours a timezone printed with the reset', () => {
  assert.equal(local(parseLimit("You've hit your limit · resets 3:30pm (America/New_York)", NOW).resetAt), '9/19/2026, 12:30:00 PM');
});

test('reads a dated weekly reset', () => {
  assert.equal(local(parseLimit('Weekly limit reached ∙ resets Sep 21, 5pm', NOW).resetAt), '9/21/2026, 5:00:00 PM');
});

test('reads a relative reset', () => {
  assert.equal(parseLimit('Session limit reached, resets in 2h 15m', NOW).resetAt, NOW + 135 * 60000);
});

test('recognises a limit even when no time is given', () => {
  assert.deepEqual(parseLimit('API Error: 429 rate_limit_error', NOW), { resetAt: null });
});

test('ordinary output is not treated as a limit', () => {
  assert.equal(parseLimit('Done: refactored the auth module', NOW), null);
  assert.equal(parseLimit('', NOW), null);
});

test('parses the duration formats rate-limit headers use', () => {
  assert.equal(parseDuration('1s'), 1000);
  assert.equal(parseDuration('6m0s'), 360000);
  assert.equal(parseDuration('350ms'), 350);
  assert.equal(parseDuration('2h13m5s'), (2 * 3600 + 13 * 60 + 5) * 1000);
  assert.equal(parseDuration('later'), null);
});
