import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as auth from '../lib/auth.js';
import * as store from '../lib/store.js';
import * as fleet from '../lib/fleet.js';
import * as destinations from '../lib/destinations.js';
import * as runs from '../lib/runs.js';
import * as browse from '../lib/browse.js';
import * as connTest from '../lib/connection-test.js';
import * as webhook from '../lib/webhook.js';
import * as schedules from '../lib/schedules.js';
import * as scheduler from '../lib/scheduler.js';
import * as backup from '../lib/backup.js';
import { SCRIPTS_DIR, safeJoin, isSafeId } from '../lib/paths.js';
import { cronError } from '../lib/cron.js';

const router = express.Router();

// ---- helpers ----
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed cookie (e.g. "%") must never 500 the whole API.
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}
function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',').some((p) => p.trim() === 'https')) return true;
  if (req.secure) return true;
  return false;
}
function secureSuffix(req) {
  return isSecureRequest(req) ? '; Secure' : '';
}
function sessionCookie(req, sess, maxAge = 30 * 24 * 3600) {
  return `rw_session=${encodeURIComponent(sess)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureSuffix(req)}`;
}
/** Constant-time comparison for raw tokens (never short-circuit on length). */
function tokenOk(provided, expected) {
  if (!expected || typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
function noStore(res) {
  res.set('Cache-Control', 'no-store');
  return res;
}
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (auth.validSession(cookies.rw_session)) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

// ---- auth status always open ----
router.get('/api/auth/status', (req, res) => {
  const cookies = parseCookies(req);
  const doc = auth.getAccount();
  const authed = auth.validSession(cookies.rw_session);
  const user = authed ? auth.sessionUser(cookies.rw_session) : null;
  noStore(res).json({ setupNeeded: !doc, authenticated: authed, username: user });
});

router.post('/api/auth/setup', express.json({ limit: '20kb' }), (req, res) => {
  if (auth.getAccount()) return res.status(409).json({ error: 'Setup already completed' });
  // Rate-limit setup like login: two racing first requests must not both pass.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!auth.rateLimitCheck(ip)) return res.status(429).json({ error: 'Too many attempts, try again later' });
  auth.rateLimitRecord(ip);
  const { username = '', password = '' } = req.body ?? {};
  const u = String(username).trim();
  if (!u || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Username required, password must be at least 6 characters' });
  }
  const uname = u.slice(0, 40);
  try {
    if (auth.getAccount()) return res.status(409).json({ error: 'Setup already completed' });
    auth.createAccount(uname, String(password));
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  auth.rateLimitClear(ip);
  const sess = auth.makeSession(uname);
  res.setHeader('Set-Cookie', sessionCookie(req, sess));
  res.json({ ok: true });
});

router.post('/api/auth/login', express.json({ limit: '20kb' }), (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!auth.rateLimitCheck(ip)) return res.status(429).json({ error: 'Too many login attempts, try again later' });
  const { username = '', password = '' } = req.body ?? {};
  if (!auth.verifyLogin(String(username), String(password))) {
    auth.rateLimitRecord(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  auth.rateLimitClear(ip);
  const sess = auth.makeSession(String(username));
  res.setHeader('Set-Cookie', sessionCookie(req, sess));
  res.json({ ok: true });
});

router.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

// Invalidate every issued session (e.g. a suspected cookie leak) and issue a
// fresh one for the caller so they stay signed in.
router.post('/api/auth/revoke-sessions', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  try {
    const out = auth.revokeSessions();
    const sess = auth.makeSession(out.username);
    res.setHeader('Set-Cookie', sessionCookie(req, sess));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- account (requires auth) ----
router.get('/api/account', requireAuth, (req, res) => {
  const acc = auth.getAccount();
  noStore(res).json({ username: acc.username, createdAt: acc.createdAt });
});

router.post('/api/account', requireAuth, express.json({ limit: '20kb' }), (req, res) => {
  const { currentPassword, username, password } = req.body ?? {};
  try {
    const out = auth.updateAccount({ currentPassword: String(currentPassword ?? ''), username: username !== undefined ? String(username) : undefined, password: password !== undefined ? String(password) : undefined });
    // issue new session if username changed
    const cookies = parseCookies(req);
    const currentUser = auth.sessionUser(cookies.rw_session);
    const newUser = out.username;
    if (newUser !== currentUser) {
      const sess = auth.makeSession(newUser);
      res.setHeader('Set-Cookie', sessionCookie(req, sess));
    }
    res.json({ ok: true, username: out.username });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- raw token endpoints (no session required) ----
function rawHandler(req, res) {
  const m = req.path.match(/^\/(?:raw|i)\/([^/]+?)(?:\.sh)?$/);
  const id = m ? m[1].replace(/\.sh$/i, '') : '';
  if (!isSafeId(id)) return res.status(400).type('text/plain').send('# bad id\n');
  const doc = store.read(id);
  if (!doc || !doc.script) return res.status(404).type('text/plain').send('# script not found\n');
  const token = String(req.query.token ?? '');
  if (!tokenOk(token, doc.rawToken)) return res.status(401).type('text/plain').send('# unauthorized: append ?token=<token> (see panel → Install)\n');
  // Deployed copies must be self-contained: inject stored destination
  // credentials (the panel copy never holds them).
  const script = destinations.injectSecrets(doc.script, doc.destFleetId);
  res.type('text/x-shellscript; charset=utf-8').set('Cache-Control', 'no-store').send(script);
}
router.get(/^\/raw\/([^/]+?)(?:\.sh)?$/, rawHandler);
router.get(/^\/i\/([^/]+?)(?:\.sh)?$/, rawHandler);

// ---- auth gate for remaining /api/* ----
router.use('/api', (req, res, next) => {
  // already handled auth routes above; gate the rest
  if (req.path.startsWith('/auth/')) return next();
  const cookies = parseCookies(req);
  if (!auth.validSession(cookies.rw_session)) return res.status(401).json({ error: 'Not logged in' });
  // CSRF: state-changing requests must come from our own frontend. Browsers
  // always attach Origin; the custom header closes the no-Origin gap (a
  // cross-site attacker cannot set a custom header on a simple form request).
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    if (String(req.headers['x-requested-with'] || '').toLowerCase() !== 'xmlhttprequest') {
      return res.status(403).json({ error: 'CSRF check failed' });
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        const oUrl = new URL(origin);
        const host = req.headers.host || '';
        if (oUrl.host !== host) return res.status(403).json({ error: 'CSRF check failed' });
      } catch {
        return res.status(403).json({ error: 'CSRF check failed' });
      }
    }
  }
  next();
});

// ---- fleet ----
router.get('/api/fleet', (req, res) => {
  res.json(fleet.list());
});
router.post('/api/fleet', express.json({ limit: '50kb' }), async (req, res) => {
  const b = req.body ?? {};
  if (!b.host || !b.name) return res.status(400).json({ error: 'Name and host required' });
  try {
    const doc = await fleet.create(b);
    // Never expose ciphertext to client (strip before responding)
    const { passwordEnc, ...safe } = doc;
    res.status(201).json(safe);
  } catch (e) {
    if (e instanceof fleet.ValidationError) return res.status(400).json({ error: e.message });
    res.status(400).json({ error: String(e.message || e) });
  }
});
router.post('/api/fleet/:id/test', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const out = await connTest.testSource(id);
  res.status(out.ok ? 200 : 502).json(out);
});
router.get('/api/fleet/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = fleet.readSafe(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  // For editing, also return keyPath but never password
  const raw = fleet.read(id);
  res.json({ ...doc, keyPath: raw.keyPath ?? '' });
});
router.put('/api/fleet/:id', express.json({ limit: '50kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const doc = await fleet.update(id, req.body ?? {});
    if (!doc) return res.status(404).json({ error: 'not found' });
    const { passwordEnc, ...safe } = doc;
    res.json(safe);
  } catch (e) {
    if (e instanceof fleet.ValidationError) return res.status(400).json({ error: e.message });
    res.status(400).json({ error: String(e.message || e) });
  }
});
router.delete('/api/fleet/:id', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  await fleet.remove(id);
  res.status(204).end();
});

// ---- destinations ----
router.get('/api/destinations', (req, res) => {
  res.json(destinations.list());
});
router.post('/api/destinations', express.json({ limit: '50kb' }), async (req, res) => {
  const b = req.body ?? {};
  if (!b.name) return res.status(400).json({ error: 'Name required' });
  if (!b.host && (b.type ?? 'sftp') !== 's3') return res.status(400).json({ error: 'Host required for sftp/ftp' });
  try {
    const doc = await destinations.create(b);
    const { passwordEnc, s3AccessEnc, s3SecretEnc, ...safe } = doc;
    res.status(201).json(safe);
  } catch (e) {
    if (e instanceof fleet.ValidationError) return res.status(400).json({ error: e.message });
    res.status(400).json({ error: String(e.message || e) });
  }
});
router.post('/api/destinations/:id/test', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const d = destinations.readDecrypted(id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const payload = {
    type: d.type, host: d.host, port: d.port, user: d.user, password: d.password ?? null,
    sftpAuth: d.sftpAuth ?? 'password', keyPath: d.keyPath ?? '',
    bucket: d.s3Bucket ?? '', region: d.s3Region ?? '', endpoint: d.s3Endpoint ?? '',
    provider: d.s3Provider ?? 'AWS', accessKey: d.s3AccessKey ?? '', secretKey: d.s3SecretKey ?? null,
  };
  const out = await connTest.testDestination(payload);
  if (out.ok) await destinations.touchSeen(id);
  res.status(out.ok ? 200 : 502).json(out);
});
router.post('/api/destinations/:id/browse', express.json({ limit: '20kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const d = destinations.readDecrypted(id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const p = String(req.body?.path ?? '').trim();
  const payload = {
    type: d.type, host: d.host, port: d.port, user: d.user, password: d.password ?? null,
    sftpAuth: d.sftpAuth ?? 'password', keyPath: d.keyPath ?? '',
    bucket: d.s3Bucket ?? '', region: d.s3Region ?? '', endpoint: d.s3Endpoint ?? '',
    provider: d.s3Provider ?? 'AWS', accessKey: d.s3AccessKey ?? '', secretKey: d.s3SecretKey ?? null,
    path: p,
  };
  const out = await browse.browseRemote(payload);
  res.status(out.ok ? 200 : 502).json(out);
});
router.get('/api/destinations/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = destinations.readSafe(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  const raw = destinations.read(id);
  res.json({ ...doc, keyPath: raw.keyPath ?? '' });
});
router.put('/api/destinations/:id', express.json({ limit: '50kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const doc = await destinations.update(id, req.body ?? {});
    if (!doc) return res.status(404).json({ error: 'not found' });
    const { passwordEnc, s3AccessEnc, s3SecretEnc, ...safe } = doc;
    res.json(safe);
  } catch (e) {
    if (e instanceof fleet.ValidationError) return res.status(400).json({ error: e.message });
    res.status(400).json({ error: String(e.message || e) });
  }
});
router.delete('/api/destinations/:id', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  await destinations.remove(id);
  res.status(204).end();
});

// ---- generic connection test (inline params) ----
router.post('/api/test/connection', express.json({ limit: '50kb' }), async (req, res) => {
  const out = await connTest.testDestination(req.body ?? {});
  res.status(out.ok ? 200 : 502).json(out);
});

// ---- browse: vps, local, remote, mkdir ----
router.post('/api/fleet/:id/browse', express.json({ limit: '20kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const p = String(req.body?.path ?? '/').trim() || '/';
  const out = await browse.browseVps(id, p);
  res.status(out.ok ? 200 : 502).json(out);
});
router.post('/api/browse/local', express.json({ limit: '20kb' }), async (req, res) => {
  const p = String(req.body?.path ?? '/').trim() || '/';
  const out = await browse.browseVps(null, p);
  res.status(out.ok ? 200 : 502).json(out);
});
router.post('/api/browse/remote', express.json({ limit: '50kb' }), async (req, res) => {
  const out = await browse.browseRemote(req.body ?? {});
  res.status(out.ok ? 200 : 502).json(out);
});
router.post('/api/fleet/:id/mkdir', express.json({ limit: '20kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const p = String(req.body?.path ?? '').trim();
  const out = await browse.mkdirVps(id, p);
  res.status(out.ok ? 200 : 400).json(out);
});
router.post('/api/destinations/:id/mkdir', express.json({ limit: '20kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const d = destinations.readDecrypted(id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const p = String(req.body?.path ?? '').trim();
  const payload = {
    type: d.type, host: d.host, port: d.port, user: d.user, password: d.password ?? null,
    sftpAuth: d.sftpAuth ?? 'password', keyPath: d.keyPath ?? '',
    bucket: d.s3Bucket ?? '', region: d.s3Region ?? '', endpoint: d.s3Endpoint ?? '',
    provider: d.s3Provider ?? 'AWS', accessKey: d.s3AccessKey ?? '', secretKey: d.s3SecretKey ?? null,
    path: p,
  };
  const out = await browse.mkdirRemote(payload);
  res.status(out.ok ? 200 : 400).json(out);
});
router.post('/api/browse/mkdir-remote', express.json({ limit: '50kb' }), async (req, res) => {
  const out = await browse.mkdirRemote(req.body ?? {});
  res.status(out.ok ? 200 : 400).json(out);
});
router.post('/api/browse/mkdir-local', express.json({ limit: '20kb' }), async (req, res) => {
  const p = String(req.body?.path ?? '').trim();
  const out = await browse.mkdirVps(null, p);
  res.status(out.ok ? 200 : 400).json(out);
});

// ---- scripts ----
router.get('/api/scripts', (req, res) => {
  res.json(store.list());
});

/**
 * Secrets are only kept in the stored doc when the user explicitly chose to
 * embed them in the generated script (embed=true). Un-embedded secrets are
 * stripped before write so they never sit on disk next to the encrypted
 * destination credentials.
 */
function sanitizeSecrets(doc) {
  const s = doc?.config?.secrets;
  if (s && !s.embed) {
    delete s.password;
    delete s.s3AccessKey;
    delete s.s3SecretKey;
  }
  return doc;
}

router.post('/api/scripts', express.json({ limit: '200kb' }), async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? 'untitled').trim() || 'untitled';
  const id = await store.slug(name);
  b.id = id;
  b.name = name;
  b.createdAt = new Date().toISOString();
  b.updatedAt = null;
  delete b.rawToken; // always server-generated — a client-supplied token is ignored
  if (b.destFleetId) {
    const d = destinations.readDecrypted(b.destFleetId);
    if (d) enrichFromDest(b, d);
  }
  const doc = await store.write(sanitizeSecrets(b));
  res.status(201).json(doc);
});
router.get('/api/scripts/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = store.read(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  noStore(res).json(doc);
});
router.put('/api/scripts/:id', express.json({ limit: '200kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const ex = store.read(id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body ?? {};
  const doc = { ...ex, ...b, id: ex.id, createdAt: ex.createdAt, rawToken: ex.rawToken };
  if (doc.destFleetId) {
    const d = destinations.readDecrypted(doc.destFleetId);
    if (d) enrichFromDest(doc, d);
  }
  await store.write(sanitizeSecrets(doc));
  res.json(doc);
});
router.delete('/api/scripts/:id', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = store.read(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  // delete script file
  try { fs.unlinkSync(path.join(SCRIPTS_DIR, `${id}.json`)); } catch (e) {
    console.error(`[scripts] failed to delete ${id}:`, e.message);
  }
  // cascade: runs, schedules
  await runs.deleteAllRuns(id).catch((e) => console.error(`[scripts] cascade runs ${id}:`, e.message));
  await schedules.removeSchedulesForScript(id).catch((e) => console.error(`[scripts] cascade schedules ${id}:`, e.message));
  res.status(204).end();
});

/**
 * Sync non-secret destination fields into the script's builder config.
 * Secrets are deliberately NOT copied here: the generated script embeds them
 * client-side only when config.secrets.embed is set, and persisting a second
 * plaintext copy (or force-enabling embed) undermined destination encryption.
 */
function enrichFromDest(b, d) {
  b.config = b.config ?? {};
  b.config.dest = {
    ...(b.config.dest ?? {}),
    type: d.type ?? 'sftp',
    host: d.host ?? '',
    port: d.port ?? '',
    user: d.user ?? '',
    remoteName: d.remoteName ?? b.config.dest?.remoteName ?? 'my-backup-remote',
    remotePath: d.remotePath ?? '/',
    sftpAuth: d.sftpAuth ?? 'password',
    keyPath: d.keyPath ?? '',
    s3Provider: d.s3Provider ?? 'AWS',
    s3Bucket: d.s3Bucket ?? '',
    s3Region: d.s3Region ?? '',
    s3Endpoint: d.s3Endpoint ?? '',
  };
  if (!b.config.secrets) b.config.secrets = { embed: false, password: '', s3AccessKey: '', s3SecretKey: '' };
}

// ---- runs ----
router.get('/api/scripts/:id/runs', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const vpsId = req.query.vpsId ? String(req.query.vpsId) : null;
  if (vpsId) return res.json(runs.readRuns(id, vpsId));
  res.json(runs.listAllRuns(id));
});
router.delete('/api/scripts/:id/runs', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const vpsId = req.query.vpsId ? String(req.query.vpsId) : null;
  if (vpsId) {
    const out = await runs.deleteRunsForVps(id, vpsId);
    if (out.code === 409) return res.status(409).json({ error: 'Cannot delete while a run is active on this VPS' });
    return res.json({ ok: true });
  }
  const out = await runs.deleteAllRuns(id);
  if (out?.code === 409) return res.status(409).json({ error: 'Cannot delete while a run is active' });
  res.json({ ok: true });
});
router.delete('/api/scripts/:id/runs/:runId', async (req, res) => {
  const id = req.params.id;
  const runId = req.params.runId;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  if (!/^[a-z0-9]{6,64}$/i.test(runId)) return res.status(400).json({ error: 'bad run id' });
  const out = await runs.deleteRun(id, runId);
  if (out.code === 404) return res.status(404).json({ error: 'run not found' });
  if (out.code === 409) return res.status(409).json({ error: 'Cannot delete a running log — stop it first' });
  res.json({ ok: true });
});
router.get('/api/scripts/:id/runs/:runId/log', (req, res) => {
  const id = req.params.id;
  const runId = req.params.runId;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  if (!/^[a-z0-9]{6,64}$/i.test(runId)) return res.status(400).json({ error: 'bad run id' });
  const text = runs.readLog(id, runId);
  if (text === null) return res.status(404).json({ error: 'run not found' });
  res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send(text);
});

// ---- live log stream (SSE) ----
router.get('/api/scripts/:id/runs/:runId/events', (req, res) => {
  const id = req.params.id;
  const runId = req.params.runId;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  if (!/^[a-z0-9]{6,64}$/i.test(runId)) return res.status(400).json({ error: 'bad run id' });
  const rec = runs.findRun(id, runId);
  if (!rec) return res.status(404).json({ error: 'run not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  let offset = 0;
  let quietTicks = 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  const tick = () => {
    if (closed) {
      clearInterval(timer);
      return;
    }
    const cur = runs.findRun(id, runId);
    if (!cur) {
      send('end', { missing: true });
      clearInterval(timer);
      res.end();
      return;
    }
    try {
      const logFile = runs.logFileFor(id, cur.vpsId, runId);
      const size = fs.statSync(logFile).size;
      if (size < offset) offset = 0; // log was truncated to its tail — resend
      if (size > offset) {
        const fd = fs.openSync(logFile, 'r');
        try {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          send('log', { text: buf.toString('utf8') });
        } finally {
          fs.closeSync(fd);
        }
        quietTicks = 0;
      } else {
        quietTicks += 1;
      }
    } catch {
      quietTicks += 1; // log file not written yet
    }
    if (cur.finishedAt && quietTicks >= 2) {
      send('end', { exitCode: cur.exitCode, finishedAt: cur.finishedAt });
      clearInterval(timer);
      res.end();
    }
  };
  const timer = setInterval(tick, 700);
  timer.unref();
  tick();
});
router.post('/api/scripts/:id/run', express.json({ limit: '20kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const b = req.body ?? {};
  let vpsId = b.vpsId ?? null;
  if (vpsId === 'local') vpsId = null;
  if (vpsId && !isSafeId(vpsId)) return res.status(400).json({ error: 'bad vpsId' });
  const out = await runs.startRun(id, { dryRun: Boolean(b.dryRun), vpsId });
  if (out.error === 'script_not_found') return res.status(404).json({ error: 'script not found or has no script content' });
  if (out.error === 'already_running') return res.status(409).json({ error: 'A run is already in progress for this VPS — wait for it to finish or stop it first' });
  if (out.error === 'vps_not_found') return res.status(404).json({ error: 'VPS not found' });
  res.status(202).json(out.record);
});
router.post('/api/runs/:runId/stop', async (req, res) => {
  const runId = req.params.runId;
  if (!/^[a-z0-9_-]{6,64}$/i.test(runId)) return res.status(400).json({ error: 'bad run id' });
  const ok = await runs.stopRun(runId);
  if (!ok) return res.status(404).json({ error: 'run not active' });
  res.json({ ok: true });
});

// ---- webhook test ----
router.post('/api/test-webhook', express.json({ limit: '50kb' }), async (req, res) => {
  const out = await webhook.testWebhook(req.body ?? {});
  res.status(out.code).json(out.body);
});

// ---- config export / import ----
router.post('/api/export', express.json({ limit: '1kb' }), (req, res) => {
  try {
    const bundle = backup.exportBundle(String(req.body?.passphrase ?? ''));
    noStore(res).json(bundle);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});
router.post('/api/import', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const counts = await backup.importBundle(req.body?.bundle ?? req.body, String(req.body?.passphrase ?? ''));
    res.json({ ok: true, counts });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- schedules ----
router.get('/api/schedules', (req, res) => {
  const scriptId = req.query.scriptId ? String(req.query.scriptId) : null;
  res.json(schedules.listSchedules(scriptId));
});
router.post('/api/schedules', express.json({ limit: '20kb' }), async (req, res) => {
  const b = req.body ?? {};
  if (!b.scriptId || !b.vpsId || !b.cronExpr) return res.status(400).json({ error: 'scriptId, vpsId, cronExpr required' });
  if (!isSafeId(String(b.scriptId)) || !isSafeId(String(b.vpsId))) return res.status(400).json({ error: 'bad scriptId or vpsId' });
  const err = cronError(String(b.cronExpr));
  if (err) return res.status(400).json({ error: err });
  let tz = String(b.timezone ?? 'UTC');
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
  const doc = await schedules.createSchedule({ scriptId: String(b.scriptId), vpsId: String(b.vpsId), cronExpr: String(b.cronExpr), timezone: tz, enabled: b.enabled ?? true });
  res.status(201).json(doc);
});
router.post('/api/schedules/trigger', async (req, res) => {
  const triggered = await scheduler.triggerDueSchedules();
  res.json({ triggered, count: triggered.length });
});
router.get('/api/scheduler/status', (req, res) => {
  res.json(scheduler.schedulerStatus());
});
router.get('/api/schedules/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = schedules.getSchedule(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});
router.put('/api/schedules/:id', express.json({ limit: '20kb' }), async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = schedules.getSchedule(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (req.body?.cronExpr) {
    const err = cronError(String(req.body.cronExpr));
    if (err) return res.status(400).json({ error: err });
  }
  if (req.body?.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: req.body.timezone }); } catch { return res.status(400).json({ error: 'Invalid timezone' }); }
  }
  const updated = await schedules.updateSchedule(id, req.body ?? {});
  res.json(updated);
});
router.delete('/api/schedules/:id', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  await schedules.removeSchedule(id);
  res.status(204).end();
});

export default router;
