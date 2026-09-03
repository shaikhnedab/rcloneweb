import { cronMatches } from './cron.js';
import { listSchedules, markLastRun } from './schedules.js';
import { startRun } from './runs.js';
import { nowIso } from './jsonfile.js';

const DEBOUNCE_MS = 90 * 1000;

// scheduleId -> cron-minute bucket last attempted. Prevents retrying a failed
// or already_running trigger on every 30s tick within the same cron minute.
const attempted = new Map();

function minuteBucket(local) {
  return Math.floor(local.getTime() / 60000);
}

/**
 * Check every schedule; start runs for due ones. Called by the in-process
 * timer, the manual trigger endpoint, and `node server/cli.js cron`.
 * Returns the list of started run records.
 */
export async function triggerDueSchedules() {
  const triggered = [];
  for (const s of listSchedules()) {
    if (!s.enabled || !s.cronExpr || !s.scriptId) continue;
    const tz = s.timezone && isValidTz(s.timezone) ? s.timezone : 'UTC';
    const local = getDateInTz(new Date(), tz);
    if (!cronMatches(s.cronExpr, local)) continue;
    const bucket = `${s.id}:${minuteBucket(local)}`;
    if (attempted.get(s.id) === bucket) continue;
    const last = s.lastRun ? Date.parse(s.lastRun) : 0;
    if (last && Date.now() - last < DEBOUNCE_MS) continue;
    attempted.set(s.id, bucket);
    const vpsId = s.vpsId && s.vpsId !== 'local' ? s.vpsId : null;
    let started = null;
    try {
      const res = await startRun(s.scriptId, { dryRun: false, vpsId });
      started = res.record ?? null;
    } catch (e) {
      console.error(`[scheduler] start failed for schedule ${s.id} (script ${s.scriptId}):`, e?.message || e);
      started = null;
    }
    if (started) {
      await markLastRun(s.id, nowIso());
      triggered.push(started);
    }
  }
  // keep the attempt map from growing without bound
  if (attempted.size > 1000) attempted.clear();
  return triggered;
}

function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getDateInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Construct a Date in server's local time (UTC) with the target TZ's wall time
  // so that getHours()/getMinutes() return the TZ's time.
  return new Date(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
}

/** One scheduler tick — safe to call repeatedly. */
export async function schedulerTick() {
  return triggerDueSchedules();
}

/** Scheduler status for the panel UI. */
export function schedulerStatus() {
  const schedules = listSchedules();
  return {
    total: schedules.length,
    enabled: schedules.filter((s) => s.enabled).length,
    nextCheck: new Date(Math.ceil(Date.now() / 60000) * 60000).toISOString(),
    now: nowIso(),
  };
}
