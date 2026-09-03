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
  if (input.type !== undefined && !TYPES.includes(input.type)) throw new ValidationError('Invalid type');
  if (input.host !== undefined) {
    const host = String(input.host).trim();
    if (host && !HOST_RE.test(host)) throw new ValidationError('Invalid host');
  }
  if (input.user !== undefined) {
    const user = String(input.user).trim();
    if (user && !USER_RE.test(user)) throw new ValidationError('Invalid user');
  }
  if (input.port !== undefined) {
    const port = String(input.port).trim();
    if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new ValidationError('Invalid port');
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

const shqEscape = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

/**
 * Make a stored script self-contained for deployment (runs + /raw download).
 * - Replaces generator placeholders with the destination's stored secrets
 *   (embed mode with no secret typed in the builder).
 * - If the script would prompt interactively for a password/keys — which can
 *   never work in a panel-launched run (no TTY) — prepend exports from the
 *   destination store instead.
 * Operates on the in-memory script text only; nothing is persisted.
 */
export function injectSecrets(script, destId) {
  if (typeof script !== 'string' || !script || !destId || !isSafeId(destId)) return script;
  const d = readDecrypted(destId);
  if (!d) return script;
  let out = script;
  if (out.includes(`'__RW_DEST_PASSWORD__'`)) {
    out = out.split(`'__RW_DEST_PASSWORD__'`).join(d.password ? shqEscape(d.password) : `"$FTP_PASS"`);
  }
  if (out.includes(`'__RW_S3_ACCESS_KEY__'`)) {
    out = out.split(`'__RW_S3_ACCESS_KEY__'`).join(d.s3AccessKey ? shqEscape(d.s3AccessKey) : `"$AWS_ACCESS_KEY_ID"`);
  }
  if (out.includes(`'__RW_S3_SECRET_KEY__'`)) {
    out = out.split(`'__RW_S3_SECRET_KEY__'`).join(d.s3SecretKey ? shqEscape(d.s3SecretKey) : `"$AWS_SECRET_ACCESS_KEY"`);
  }
  const pre = [];
  if (/read -rsp "Enter (FTP|SFTP) password/.test(out) && d.password && !out.includes('FTP_PASS=')) {
    pre.push(`export FTP_PASS=${shqEscape(d.password)}`);
  }
  if (/AWS_ACCESS_KEY_ID/.test(out) && d.s3AccessKey && d.s3SecretKey && !out.includes('AWS_ACCESS_KEY_ID=')) {
    pre.push(`export AWS_ACCESS_KEY_ID=${shqEscape(d.s3AccessKey)}`);
    pre.push(`export AWS_SECRET_ACCESS_KEY=${shqEscape(d.s3SecretKey)}`);
  }
  if (pre.length) out = `${pre.join('\n')}\n\n${out}`;
  return out;
}
