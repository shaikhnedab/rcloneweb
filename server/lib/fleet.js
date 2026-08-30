import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR, RUNS_DIR, safeJoin, isSafeId } from './paths.js';
import { encrypt, decrypt } from './crypto.js';
import { atomicWrite, readJson, nowIso, withLock, slugify } from './jsonfile.js';

const RUNS_HINT = path.join(RUNS_DIR, 'x');

export const HOST_RE = /^[a-zA-Z0-9.\-]+$/;
export const USER_RE = /^[a-zA-Z0-9._\-@]{1,64}$/;

function fileFor(id) {
  const p = safeJoin(FLEET_DIR, `vps-${id}.json`);
  if (!p) throw new Error('bad id');
  return p;
}

const exists = (id) => fs.existsSync(fileFor(id));

export function isValidHost(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) return false;
  return true;
}

export function isValidUser(user) {
  return typeof user === 'string' && USER_RE.test(user);
}

/** List — never exposes encrypted secrets. */
export function list() {
  const out = [];
  for (const f of fs.readdirSync(FLEET_DIR)) {
    if (!f.startsWith('vps-') || !f.endsWith('.json')) continue;
    const d = readJson(`${FLEET_DIR}/${f}`);
    if (!d || typeof d !== 'object') continue;
    out.push({
      id: d.id,
      name: d.name,
      host: d.host,
      port: d.port ?? 22,
      user: d.user,
      auth: d.auth ?? 'password',
      hasPassword: Boolean(d.passwordEnc),
      createdAt: d.createdAt ?? '',
      lastSeen: d.lastSeen ?? null,
    });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

/** Raw doc (for internal use / editing — includes ciphertext; do not return to client). */
export function read(id) {
  if (!isSafeId(id)) return null;
  const d = readJson(fileFor(id));
  return d && typeof d === 'object' ? d : null;
}

/** Client-safe doc for editing (no secrets). */
export function readSafe(id) {
  const d = read(id);
  if (!d) return null;
  const { passwordEnc, ...safe } = d;
  return safe;
}

/** Doc with decrypted password for internal operations only. */
export function readDecrypted(id) {
  const d = read(id);
  if (!d) return null;
  return { ...d, password: decrypt(d.passwordEnc) };
}

export async function create(input) {
  const name = String(input.name ?? '').trim();
  const host = String(input.host ?? '').trim();
  const user = String(input.user ?? 'root').trim();
  if (!name) throw new ValidationError('Name required');
  if (!isValidHost(host)) throw new ValidationError('Invalid host');
  if (!isValidUser(user)) throw new ValidationError('Invalid user');
  const port = Number(input.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('Invalid port');
  const base = slugify(name, 'vps');
  let id = base;
  await withLock(`${FLEET_DIR}:slug`, async () => {
    let n = 1;
    while (exists(id)) {
      n += 1;
      id = `${base}-${n}`;
    }
  });
  const doc = {
    id,
    name,
    host,
    port,
    user,
    auth: input.auth === 'key' ? 'key' : 'password',
    passwordEnc: input.password ? encrypt(String(input.password)) : null,
    keyPath: String(input.keyPath ?? '').trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastSeen: null,
  };
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
  return doc;
}

export async function update(id, input) {
  const doc = read(id);
  if (!doc) return null;
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new ValidationError('Name required');
    doc.name = name;
  }
  if (input.host !== undefined) {
    const host = String(input.host).trim();
    if (!isValidHost(host)) throw new ValidationError('Invalid host');
    doc.host = host;
  }
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('Invalid port');
    doc.port = port;
  }
  if (input.user !== undefined) {
    const user = String(input.user).trim();
    if (!isValidUser(user)) throw new ValidationError('Invalid user');
    doc.user = user;
  }
  if (input.auth !== undefined) doc.auth = input.auth === 'key' ? 'key' : 'password';
  if (typeof input.password === 'string' && input.password !== '') doc.passwordEnc = encrypt(input.password);
  if (input.keyPath !== undefined) doc.keyPath = String(input.keyPath).trim();
  doc.updatedAt = nowIso();
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
  return doc;
}

/** Delete VPS + cascade its schedules and per-VPS run shards. */
export async function remove(id) {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return false;
  await withLock(f, () => fs.rmSync(f, { force: true }));
  const { listSchedules, removeSchedule } = await import('./schedules.js');
  for (const s of listSchedules()) {
    if (s.vpsId === id) await removeSchedule(s.id);
  }
  const runsFiles = fs.readdirSync(path.dirname(RUNS_HINT)).filter((x) => x.includes(`__${id}.json`));
  for (const x of runsFiles) fs.rmSync(path.join(path.dirname(RUNS_HINT), x), { force: true });
  return true;
}

export async function touchSeen(id) {
  const doc = read(id);
  if (!doc) return;
  doc.lastSeen = nowIso();
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
}

export class ValidationError extends Error {}
