// Wall-clock helpers. Reset messages ("resets 3am") and repeating schedules
// ("every weekday at 7:00") are both about a time on someone's clock, not a
// fixed number of milliseconds, so they have to survive DST changes.

export function validTz(tz) {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return undefined; }
}

export const serverTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function zonedParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, +x.value]));
}

/** Wall-clock time in a timezone -> epoch ms. Day and month overflow roll over like Date.UTC. */
export function zonedToEpoch(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= asUtc - Date.UTC(y, mo, d, h, mi);
  }
  return guess;
}

export const REPEATS = ['daily', 'weekdays', 'weekly'];

/**
 * The next time a repeating message is due, after `now`, keeping the wall-clock
 * time of `fromTs` in `tz`. A server that was off for a week sends once when it
 * comes back, not seven times.
 */
export function nextOccurrence(fromTs, every, tz, now = Date.now()) {
  if (!REPEATS.includes(every)) return null;
  tz = validTz(tz) || serverTz();
  const p = zonedParts(fromTs, tz);
  let day = p.day;
  for (let i = 0; i < 800; i++) {
    day += every === 'weekly' ? 7 : 1;
    if (every === 'weekdays') {
      const wd = new Date(Date.UTC(p.year, p.month - 1, day)).getUTCDay();
      if (wd === 0 || wd === 6) continue;
    }
    const t = zonedToEpoch(p.year, p.month - 1, day, p.hour, p.minute, tz);
    if (t > now + 30000) return t;
  }
  return null;
}

export const describeRepeat = every => ({ daily: 'every day', weekdays: 'every weekday', weekly: 'every week' })[every] || '';
