import fs from 'node:fs';
import { SCHEDULES_DIR, safeJoin, isSafeId } from './paths.js';
import { atomicWrite, readJson, nowIso, randomId, withLock } from './jsonfile.js';

function fileFor(id) {
  const p = safeJoin(SCHEDULES_DIR, `${id}.json`);
  if (!p) throw new Error('bad id');
  return p;
}

export function listSchedules(scriptId = null) {
  const out = [];
  for (const f of fs.readdirSync(SCHEDULES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const d = readJson(`${SCHEDULES_DIR}/${f}`);
    if (!d || typeof d !== 'object' || !d.id) continue;
    if (scriptId && d.scriptId !== scriptId) continue;
    out.push(d);
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out;
}

export function getSchedule(id) {
  if (!isSafeId(id)) return null;
  const d = readJson(fileFor(id));
  return d && typeof d === 'object' ? d : null;
}

export async function createSchedule(input) {
  const { scriptId, vpsId, cronExpr } = input;
  if (!scriptId || !vpsId || !cronExpr) throw new Error('scriptId, vpsId, cronExpr required');
  let tz = String(input.timezone ?? 'UTC');
  if (!isValidTimezone(tz)) tz = 'UTC';
  const doc = {
    id: randomId(6),
    scriptId,
    vpsId,
    cronExpr: String(cronExpr),
    timezone: tz,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdAt: nowIso(),
    lastRun: null,
  };
  await withLock(fileFor(doc.id), () => {
    atomicWrite(fileFor(doc.id), JSON.stringify(doc, null, 2));
  });
  return doc;
}

export async function updateSchedule(id, input) {
  const doc = getSchedule(id);
  if (!doc) return null;
  if (input.vpsId !== undefined) doc.vpsId = String(input.vpsId);
  if (input.cronExpr !== undefined) doc.cronExpr = String(input.cronExpr);
  if (input.enabled !== undefined) doc.enabled = Boolean(input.enabled);
  if (input.timezone !== undefined && isValidTimezone(String(input.timezone))) doc.timezone = String(input.timezone);
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
  return doc;
}

/** Remove a schedule + every schedule belonging to a script (cascade). */
export async function removeSchedule(id) {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return false;
  await withLock(f, () => fs.rmSync(f, { force: true }));
  return true;
}

export async function removeSchedulesForScript(scriptId) {
  for (const s of listSchedules()) {
    if (s.scriptId === scriptId) await removeSchedule(s.id);
  }
}

export async function markLastRun(id, iso) {
  const doc = getSchedule(id);
  if (!doc) return;
  doc.lastRun = iso;
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-u-ca-gregory', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
