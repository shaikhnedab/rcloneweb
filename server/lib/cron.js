/**
 * Vixie-cron field parser + matcher.
 * Supports star, slash-n, lists (a,b,c), ranges (a-b), range steps (a-b slash n),
 * dow 7 == 0 (Sunday), and the standard dom/dow OR semantics:
 * if both dom and dow are restricted, the entry runs when EITHER matches.
 */

function parseField(field, { min, max, isDow = false } = {}) {
  const allowed = new Set();
  for (const part of String(field).split(',')) {
    let body = part.trim();
    let step = 1;
    const slash = body.indexOf('/');
    if (slash !== -1) {
      step = Number(body.slice(slash + 1));
      body = body.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo;
    let hi;
    if (body === '*') {
      lo = min;
      hi = max;
    } else if (body.includes('-')) {
      const dash = body.indexOf('-');
      lo = Number(body.slice(0, dash));
      hi = Number(body.slice(dash + 1));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = Number(body);
      if (!Number.isInteger(lo)) return null;
      hi = step > 1 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) {
      allowed.add(isDow && v === 7 ? 0 : v);
    }
  }
  return allowed;
}

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7, isDow: true },
];

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i], FIELDS[i]);
    if (!set || set.size === 0) return null;
    parsed.push(set);
  }
  return { minutes: parsed[0], hours: parsed[1], dom: parsed[2], mon: parsed[3], dow: parsed[4] };
}

export function cronMatches(expr, date = new Date()) {
  const c = parseCron(expr);
  if (!c) return false;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  if (!c.minutes.has(minute) || !c.hours.has(hour) || !c.mon.has(mon)) return false;
  const domRestricted = c.dom.size !== 31;
  const dowRestricted = c.dow.size !== 7;
  const domOk = c.dom.has(dom);
  const dowOk = c.dow.has(dow);
  if (domRestricted && dowRestricted) return domOk || dowOk; // vixie OR semantics
  return domOk && dowOk;
}

export function cronError(expr) {
  return parseCron(expr) === null ? 'Invalid cron expression (5 fields: min hour dom month dow)' : null;
}
