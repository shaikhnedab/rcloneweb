import crypto from 'node:crypto';
import fs from 'node:fs';
import { AUTH_FILE, SECRET_FILE, DATA_DIR } from './paths.js';

const USERNAME_RE = /^[a-zA-Z0-9._-]{1,40}$/;
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

function readAuth() {
  try {
    const doc = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return doc && typeof doc === 'object' && doc.username && doc.hash ? doc : null;
  } catch {
    return null;
  }
}

function writeAuth(doc) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
  const tmp = `${AUTH_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
}

export function secret() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim();
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function exists() {
  return readAuth() !== null;
}

export function getAccount() {
  const a = readAuth();
  return a ? { username: a.username, createdAt: a.createdAt ?? null, pwVersion: a.pwVersion ?? 1 } : null;
}

/** Create the first admin account (only succeeds when none exists). */
export function createAccount(username, password) {
  if (!isValidUsername(username)) throw new AuthError('Username must be 1-40 chars: letters, digits, dot, dash, underscore');
  if (typeof password !== 'string' || password.length < 6) throw new AuthError('Password must be at least 6 characters');
  if (readAuth()) throw new AuthError('Setup already completed', 409);
  const doc = {
    username,
    hash: hashPassword(password),
    createdAt: new Date().toISOString(),
    pwVersion: 1,
  };
  writeAuth(doc);
  return doc;
}

/**
 * Change credentials. If `currentPassword` is provided it must verify first.
 * Bumps pwVersion, which invalidates all previously issued sessions.
 */
export function updateAccount({ currentPassword, username, password }) {
  const a = readAuth();
  if (!a) throw new AuthError('No account exists', 404);
  if (!verifyPassword(String(currentPassword ?? ''), a.hash)) throw new AuthError('Current password is incorrect', 403);
  const next = { ...a };
  if (username !== undefined && username !== a.username) {
    if (!isValidUsername(username)) throw new AuthError('Username must be 1-40 chars: letters, digits, dot, dash, underscore');
    next.username = username;
  }
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 6) throw new AuthError('Password must be at least 6 characters');
    next.hash = hashPassword(password);
  }
  if (next.username === a.username && next.hash === a.hash) throw new AuthError('Nothing to change');
  next.pwVersion = (a.pwVersion ?? 1) + 1;
  writeAuth(next);
  return { username: next.username, pwVersion: next.pwVersion };
}

/** Used by the CLI reset tool: rewrite credentials without touching anything else. */
export function resetCredentials(username, password) {
  if (!isValidUsername(username)) throw new AuthError('Username must be 1-40 chars: letters, digits, dot, dash, underscore');
  if (typeof password !== 'string' || password.length < 6) throw new AuthError('Password must be at least 6 characters');
  const a = readAuth();
  const doc = {
    username,
    hash: hashPassword(password),
    createdAt: a?.createdAt ?? new Date().toISOString(),
    pwVersion: (a?.pwVersion ?? 1) + 1,
  };
  writeAuth(doc);
  return doc;
}

/** Invalidate every issued session (pwVersion bump) without changing credentials. */
export function revokeSessions() {
  const a = readAuth();
  if (!a) throw new AuthError('No account exists', 404);
  writeAuth({ ...a, pwVersion: (a.pwVersion ?? 1) + 1 });
  return { username: a.username, pwVersion: (a.pwVersion ?? 1) + 1 };
}

// Dummy hash so unknown usernames cost the same scrypt time as real ones.
const DUMMY_HASH = hashPassword('timing-equalizer');

export function verifyLogin(username, password) {
  const a = readAuth();
  if (!a) return false;
  const userOk = a.username === username;
  const passOk = verifyPassword(password, userOk ? a.hash : DUMMY_HASH);
  return userOk && passOk;
}

function sessionKey() {
  const a = readAuth();
  const pwVersion = a?.pwVersion ?? 1;
  // Password/username changes bump pwVersion → all old signatures become invalid.
  return crypto.createHash('sha256').update(`${secret()}:session:${pwVersion}`).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

/** Stateless signed session: <b64url payload>.<hmac> */
export function makeSession(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function validSession(cookieValue) {
  if (!readAuth()) return false; // fail closed when no account exists
  if (typeof cookieValue !== 'string') return false;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = Buffer.from(sign(payload), 'utf8');
  const actual = Buffer.from(sig, 'utf8');
  if (expected.length !== actual.length) return false;
  if (!crypto.timingSafeEqual(expected, actual)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.u === 'string' && typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionUser(cookieValue) {
  if (!validSession(cookieValue)) return null;
  try {
    const payload = cookieValue.slice(0, cookieValue.lastIndexOf('.'));
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).u;
  } catch {
    return null;
  }
}

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- login rate limiting (per IP, in-memory, swept + capped) ----
const attempts = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_TRACKED_IPS = 10_000;

/** Drop expired entries; if still over cap, drop the soonest-expiring. */
function sweep(now) {
  if (attempts.size < MAX_TRACKED_IPS) return;
  for (const [ip, rec] of attempts) {
    if (now > rec.resetAt) attempts.delete(ip);
  }
  while (attempts.size >= MAX_TRACKED_IPS) {
    let oldestIp = null;
    let oldestAt = Infinity;
    for (const [ip, rec] of attempts) {
      if (rec.resetAt < oldestAt) { oldestAt = rec.resetAt; oldestIp = ip; }
    }
    if (!oldestIp) break;
    attempts.delete(oldestIp);
  }
}

export function rateLimitCheck(ip) {
  const now = Date.now();
  sweep(now);
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) return true;
  return rec.count < MAX_ATTEMPTS;
}

export function rateLimitRecord(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  rec.count += 1;
}

export function rateLimitClear(ip) {
  attempts.delete(ip);
}
