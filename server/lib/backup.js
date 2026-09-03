import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCRIPTS_DIR, FLEET_DIR, DESTINATIONS_DIR, SCHEDULES_DIR, safeJoin, isSafeId } from './paths.js';
import { readJson, atomicWrite, withLock } from './jsonfile.js';
import { encrypt, decrypt } from './crypto.js';
import * as store from './store.js';

/**
 * Config export/import: scripts, schedules, fleet and destinations in one
 * JSON bundle. Destination secrets are re-encrypted under a user-supplied
 * passphrase (AES-256-GCM, scrypt-derived key); the panel's own auth.json
 * and .secret never leave the box.
 */

const BUNDLE_VERSION = 1;

function keyFromPassphrase(passphrase) {
  const salt = Buffer.from('rcloneweb-export-v1', 'utf8');
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function exportEncrypt(passphrase, plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromPassphrase(passphrase), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function exportDecrypt(passphrase, enc) {
  if (!enc) return null;
  try {
    const raw = Buffer.from(String(enc), 'base64');
    if (raw.length <= 12 + 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromPassphrase(passphrase), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function readDocs(dir, prefix) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    const d = readJson(path.join(dir, f));
    if (d && typeof d === 'object') out.push(d);
  }
  return out;
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function exportBundle(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw httpError('Passphrase must be at least 8 characters', 400);
  }
  const fleet = readDocs(FLEET_DIR, 'vps-').map((d) => ({
    ...d,
    passwordEnc: exportEncrypt(passphrase, decrypt(d.passwordEnc) ?? ''),
  }));
  const destinations = readDocs(DESTINATIONS_DIR, 'dest-').map((d) => ({
    ...d,
    passwordEnc: exportEncrypt(passphrase, decrypt(d.passwordEnc) ?? ''),
    s3AccessEnc: exportEncrypt(passphrase, decrypt(d.s3AccessEnc) ?? ''),
    s3SecretEnc: exportEncrypt(passphrase, decrypt(d.s3SecretEnc) ?? ''),
  }));
  const scripts = readDocs(SCRIPTS_DIR, '');
  const schedules = readDocs(SCHEDULES_DIR, '');
  return {
    bundle: 'rcloneweb-config',
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    fleet,
    destinations,
    scripts,
    schedules,
  };
}

function placeDoc(dir, prefix, id, doc) {
  if (!isSafeId(id)) return false;
  const file = safeJoin(dir, `${prefix}${id}.json`);
  if (!file) return false;
  return withLock(file, () => atomicWrite(file, JSON.stringify(doc, null, 2)));
}

export async function importBundle(bundle, passphrase) {
  if (!bundle || bundle.bundle !== 'rcloneweb-config') {
    throw httpError('Not a rcloneweb config bundle', 400);
  }
  if (typeof passphrase !== 'string' || !passphrase) {
    throw httpError('Passphrase required to decrypt bundle secrets', 400);
  }
  const probe = [...(bundle.fleet ?? []), ...(bundle.destinations ?? [])].find((d) => d.passwordEnc);
  if (probe && exportDecrypt(passphrase, probe.passwordEnc) === null) {
    throw httpError('Wrong passphrase (cannot decrypt bundle secrets)', 403);
  }

  const counts = { fleet: 0, destinations: 0, scripts: 0, schedules: 0, skipped: 0 };

  for (const d of bundle.fleet ?? []) {
    if (!d.id || !d.host) { counts.skipped += 1; continue; }
    const doc = { ...d, passwordEnc: encrypt(exportDecrypt(passphrase, d.passwordEnc) ?? '') };
    if (!placeDoc(FLEET_DIR, 'vps-', d.id, doc)) { counts.skipped += 1; continue; }
    counts.fleet += 1;
  }
  for (const d of bundle.destinations ?? []) {
    if (!d.id) { counts.skipped += 1; continue; }
    const doc = {
      ...d,
      passwordEnc: encrypt(exportDecrypt(passphrase, d.passwordEnc) ?? ''),
      s3AccessEnc: encrypt(exportDecrypt(passphrase, d.s3AccessEnc) ?? ''),
      s3SecretEnc: encrypt(exportDecrypt(passphrase, d.s3SecretEnc) ?? ''),
    };
    if (!placeDoc(DESTINATIONS_DIR, 'dest-', d.id, doc)) { counts.skipped += 1; continue; }
    counts.destinations += 1;
  }
  for (const d of bundle.scripts ?? []) {
    if (!d.id) { counts.skipped += 1; continue; }
    const doc = { ...d };
    delete doc.rawToken; // never trust a foreign token — write() regenerates one
    if (!isSafeId(doc.id)) { counts.skipped += 1; continue; }
    try { await store.write(doc); counts.scripts += 1; } catch { counts.skipped += 1; }
  }
  for (const s of bundle.schedules ?? []) {
    if (!s.id || !s.scriptId || !isSafeId(s.id)) { counts.skipped += 1; continue; }
    if (!placeDoc(SCHEDULES_DIR, '', s.id, s)) { counts.skipped += 1; continue; }
    counts.schedules += 1;
  }
  return counts;
}
