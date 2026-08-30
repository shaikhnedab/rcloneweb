import fs from 'node:fs';
import { SCRIPTS_DIR, safeJoin, isSafeId } from './paths.js';
import { withLock, atomicWrite, readJson, nowIso, randomToken, randomId } from './jsonfile.js';

const exists = (id) => fs.existsSync(fileFor(id));

function fileFor(id) {
  const p = safeJoin(SCRIPTS_DIR, `${id}.json`);
  if (!p) throw new Error('bad id');
  return p;
}

export function read(id) {
  if (!isSafeId(id)) return null;
  const doc = readJson(fileFor(id));
  if (!doc || typeof doc !== 'object') return null;
  if (!doc.rawToken) {
    doc.rawToken = randomToken(12);
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  }
  return doc;
}

export async function write(doc) {
  const id = doc.id;
  if (!isSafeId(id)) throw new Error('bad id');
  doc.updatedAt = nowIso();
  if (!doc.rawToken) doc.rawToken = randomToken(12);
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
  return doc;
}

/** List summaries — never exposes rawToken or script contents. */
export function list() {
  const out = [];
  for (const f of fs.readdirSync(SCRIPTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const d = readJson(`${SCRIPTS_DIR}/${f}`);
    if (!d || typeof d !== 'object' || !d.id) continue;
    out.push({ id: d.id, name: d.name ?? d.id, updatedAt: d.updatedAt ?? '' });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

/** Random id — no more untitled-2 collisions. */
export async function slug(_name) {
  let id = randomId(6);
  await withLock(`${SCRIPTS_DIR}:slug`, async () => {
    while (exists(id)) id = randomId(6);
  });
  return id;
}
