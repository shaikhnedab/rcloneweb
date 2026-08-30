import fs from 'node:fs';
import { DESTINATIONS_DIR, safeJoin, isSafeId } from './paths.js';
import { encrypt, decrypt } from './crypto.js';
import { atomicWrite, readJson, nowIso, withLock, slugify } from './jsonfile.js';
import { HOST_RE, USER_RE, ValidationError } from './fleet.js';

const TYPES = ['sftp', 'ftp', 's3'];

function fileFor(id) {
  const p = safeJoin(DESTINATIONS_DIR, `dest-${id}.json`);
  if (!p) throw new Error('bad id');
  return p;
}

const exists = (id) => fs.existsSync(fileFor(id));

export function list() {
  const out = [];
  for (const f of fs.readdirSync(DESTINATIONS_DIR)) {
    if (!f.startsWith('dest-') || !f.endsWith('.json')) continue;
    const d = readJson(`${DESTINATIONS_DIR}/${f}`);
    if (!d || typeof d !== 'object') continue;
    out.push({
      id: d.id,
      name: d.name,
      type: d.type ?? 'sftp',
      host: d.host ?? '',
      port: d.port ?? '',
      user: d.user ?? '',
      remoteName: d.remoteName ?? '',
      remotePath: d.remotePath ?? '',
      sftpAuth: d.sftpAuth ?? 'password',
      hasPassword: Boolean(d.passwordEnc),
      hasSecret: Boolean(d.s3SecretEnc),
      s3Provider: d.s3Provider ?? 'AWS',
      s3Bucket: d.s3Bucket ?? '',
      s3Region: d.s3Region ?? '',
      s3Endpoint: d.s3Endpoint ?? '',
      createdAt: d.createdAt ?? '',
      lastSeen: d.lastSeen ?? null,
    });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

export function read(id) {
  if (!isSafeId(id)) return null;
  const d = readJson(fileFor(id));
  return d && typeof d === 'object' ? d : null;
}

/** Client-safe doc for editing (no secrets). */
export function readSafe(id) {
  const d = read(id);
  if (!d) return null;
  const { passwordEnc, s3AccessEnc, s3SecretEnc, ...safe } = d;
  return safe;
}

export function readDecrypted(id) {
  const d = read(id);
  if (!d) return null;
  return {
    ...d,
    password: decrypt(d.passwordEnc),
    s3AccessKey: decrypt(d.s3AccessEnc) ?? '',
    s3SecretKey: decrypt(d.s3SecretEnc),
  };
}

export async function create(input) {
  const type = TYPES.includes(input.type) ? input.type : 'sftp';
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('Name required');
  const host = String(input.host ?? '').trim();
  const user = String(input.user ?? '').trim();
  if (type !== 's3') {
    if (!host) throw new ValidationError('Host required for sftp/ftp');
    if (!HOST_RE.test(host)) throw new ValidationError('Invalid host');
    if (user && !USER_RE.test(user)) throw new ValidationError('Invalid user');
  }
  const base = slugify(name, 'dest');
  let id = base;
  await withLock(`${DESTINATIONS_DIR}:slug`, async () => {
    let n = 1;
    while (exists(id)) {
      n += 1;
      id = `${base}-${n}`;
    }
  });
  const doc = {
    id,
    name,
    type,
    host,
    port: String(input.port ?? '').trim(),
    user,
    remoteName: String(input.remoteName ?? 'my-backup-remote').trim() || 'my-backup-remote',
    remotePath: String(input.remotePath ?? '/').trim() || '/',
    sftpAuth: input.sftpAuth === 'key' ? 'key' : 'password',
    keyPath: String(input.keyPath ?? '').trim(),
    s3Provider: String(input.s3Provider ?? 'AWS').trim() || 'AWS',
    s3Bucket: String(input.s3Bucket ?? '').trim(),
    s3Region: String(input.s3Region ?? '').trim(),
    s3Endpoint: String(input.s3Endpoint ?? '').trim(),
    passwordEnc: input.password ? encrypt(String(input.password)) : null,
    s3AccessEnc: input.s3AccessKey ? encrypt(String(input.s3AccessKey)) : null,
    s3SecretEnc: input.s3SecretKey ? encrypt(String(input.s3SecretKey)) : null,
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
  if (input.host !== undefined) {
    const host = String(input.host).trim();
    if (host && !HOST_RE.test(host)) throw new ValidationError('Invalid host');
  }
  if (input.user !== undefined) {
    const user = String(input.user).trim();
    if (user && !USER_RE.test(user)) throw new ValidationError('Invalid user');
  }
  for (const k of ['name', 'type', 'host', 'port', 'user', 'remoteName', 'remotePath', 'sftpAuth', 'keyPath', 's3Provider', 's3Bucket', 's3Region', 's3Endpoint']) {
    if (input[k] !== undefined) doc[k] = String(input[k]).trim();
  }
  if (typeof input.password === 'string' && input.password !== '') doc.passwordEnc = encrypt(input.password);
  if (typeof input.s3AccessKey === 'string' && input.s3AccessKey !== '') doc.s3AccessEnc = encrypt(input.s3AccessKey);
  if (typeof input.s3SecretKey === 'string' && input.s3SecretKey !== '') doc.s3SecretEnc = encrypt(input.s3SecretKey);
  doc.updatedAt = nowIso();
  await withLock(fileFor(id), () => {
    atomicWrite(fileFor(id), JSON.stringify(doc, null, 2));
  });
  return doc;
}

export async function remove(id) {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return false;
  await withLock(f, () => fs.rmSync(f, { force: true }));
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
