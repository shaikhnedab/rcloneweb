import crypto from 'node:crypto';
import fs from 'node:fs';
import { SECRET_FILE, DATA_DIR } from './paths.js';

const KEY_INFO = 'rcloneweb-v2-secretbox';

let cachedKey = null;

/** 32-byte AES-256-GCM key derived from the persisted server secret. */
export function encKey() {
  if (cachedKey) return cachedKey;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  cachedKey = crypto.createHash('sha256').update(`${KEY_INFO}:${secret}`).digest();
  return cachedKey;
}

/** Rotate the in-memory key cache (used after secret regeneration). */
export function clearKeyCache() {
  cachedKey = null;
}

/** Encrypt a UTF-8 string → base64(iv|tag|ct). Returns null for empty input. */
export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt base64(iv|tag|ct) → UTF-8 string, or null on any failure. */
export function decrypt(enc) {
  if (!enc) return null;
  try {
    const raw = Buffer.from(String(enc), 'base64');
    if (raw.length <= 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
