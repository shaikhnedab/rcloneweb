import fs from 'node:fs';
import crypto from 'node:crypto';

const locks = new Map(); // file -> promise chain

/** Serialize read-modify-write cycles per file (single-process, promise-queue lock). */
export function withLock(file, fn) {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    file,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/** Atomic write: tmp file + rename, 0600 for sensitive, 0640 otherwise. */
export function atomicWrite(file, data, { mode = 0o640 } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Unique id allocation under a lock (fixes v1 slug races). */
export async function allocateId(dir, base, existsFn) {
  let id = base;
  await withLock(existsFn.lockKey ?? dir, async () => {
    let n = 1;
    while (existsFn(id)) {
      n += 1;
      id = `${base}-${n}`;
    }
  });
  return id;
}

export function slugify(name, fallback) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || fallback;
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}
