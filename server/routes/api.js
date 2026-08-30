import express from 'express';
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
import { isSafeId } from '../lib/paths.js';
import { cronError } from '../lib/cron.js';

const router = express.Router();

// ---- helpers ----
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = decodeURIComponent(part.slice(eq + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}
function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto === 'https') return true;
  if (req.secure) return true;
  // direct https check via forwarded header from nginx
  return false;
}
function secureSuffix(req) {
  return isSecureRequest(req) ? '; Secure' : '';
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
  res.json({ setupNeeded: !doc, authenticated: authed, username: user });
});

router.post('/api/auth/setup', express.json({ limit: '20kb' }), (req, res) => {
  if (auth.getAccount()) return res.status(409).json({ error: 'Setup already completed' });
  const { username = '', password = '' } = req.body ?? {};
  const u = String(username).trim();
  if (!u || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Username required, password must be at least 6 characters' });
  }
  const uname = u.slice(0, 40);
  try {
    auth.createAccount(uname, String(password));
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const sess = auth.makeSession(uname);
  res.setHeader('Set-Cookie', `rw_session=${encodeURIComponent(sess)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secureSuffix(req)}`);
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
  res.setHeader('Set-Cookie', `rw_session=${encodeURIComponent(sess)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secureSuffix(req)}`);
  res.json({ ok: true });
});

router.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `rw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix(req)}`);
  res.json({ ok: true });
});

// ---- account (requires auth) ----
router.get('/api/account', requireAuth, (req, res) => {
  const acc = auth.getAccount();
  res.json({ username: acc.username, createdAt: acc.createdAt });
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
      res.setHeader('Set-Cookie', `rw_session=${encodeURIComponent(sess)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secureSuffix(req)}`);
    }
    res.json({ ok: true, username: out.username });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- raw token endpoints (no session required) ----
router.get(/^\/raw\/([^/]+?)(?:\.sh)?$/, async (req, res) => {
  const m = req.path.match(/^\/raw\/([^/]+?)(?:\.sh)?$/);
  let id = m ? m[1].replace(/\.sh$/i, '') : '';
  if (!isSafeId(id)) return res.status(400).type('text/plain').send('# bad id\n');
  const doc = store.read(id);
  if (!doc || !doc.script) return res.status(404).type('text/plain').send('# script not found\n');
  const token = String(req.query.token ?? '');
  if (!doc.rawToken || token !== doc.rawToken) return res.status(401).type('text/plain').send('# unauthorized: append ?token=<token> (see panel → Install)\n');
  res.type('text/x-shellscript; charset=utf-8').set('Cache-Control', 'no-store').send(doc.script);
});
router.get(/^\/i\/([^/]+?)(?:\.sh)?$/, async (req, res) => {
  const m = req.path.match(/^\/i\/([^/]+?)(?:\.sh)?$/);
  let id = m ? m[1].replace(/\.sh$/i, '') : '';
  if (!isSafeId(id)) return res.status(400).type('text/plain').send('# bad id\n');
  const doc = store.read(id);
  if (!doc || !doc.script) return res.status(404).type('text/plain').send('# script not found\n');
  const token = String(req.query.token ?? '');
  if (!doc.rawToken || token !== doc.rawToken) return res.status(401).type('text/plain').send('# unauthorized: append ?token=<token> (see panel → Install)\n');
  res.type('text/x-shellscript; charset=utf-8').set('Cache-Control', 'no-store').send(doc.script);
});

// ---- auth gate for remaining /api/* ----
router.use('/api', (req, res, next) => {
  // already handled auth routes above; gate the rest
  if (req.path.startsWith('/auth/')) return next();
  const cookies = parseCookies(req);
  if (!auth.validSession(cookies.rw_session)) return res.status(401).json({ error: 'Not logged in' });
  // CSRF: state-changing requests must have valid Origin or be same-site
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
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
router.post('/api/scripts', express.json({ limit: '200kb' }), async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? 'untitled').trim() || 'untitled';
  const id = await store.slug(name);
  b.id = id;
  b.name = name;
  b.createdAt = new Date().toISOString();
  b.updatedAt = null;
  if (b.destFleetId) {
    const d = destinations.readDecrypted(b.destFleetId);
    if (d) enrichFromDest(b, d);
  }
  const doc = await store.write(b);
  res.status(201).json(doc);
});
router.get('/api/scripts/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = store.read(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
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
    if (d) {
      enrichFromDest(doc, d);
      if (!doc.manualEdited) doc.manualEdited = false;
    }
  }
  await store.write(doc);
  res.json(doc);
});
router.delete('/api/scripts/:id', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'bad id' });
  const doc = store.read(id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  // delete script file
  const { SCRIPTS_DIR } = await import('../lib/paths.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  try { fs.unlinkSync(path.join(SCRIPTS_DIR, `${id}.json`)); } catch {}
  // cascade: runs, schedules
  await runs.deleteAllRuns(id).catch(() => {});
  await schedules.removeSchedulesForScript(id).catch(() => {});
  res.status(204).end();
});

function enrichFromDest(b, d) {
  b.config = b.config ?? {};
  b.config.dest = b.config.dest ?? {};
  b.config.secrets = b.config.secrets ?? {};
  b.config.dest.type = d.type ?? b.config.dest.type ?? 'sftp';
  b.config.dest.host = d.host ?? '';
  b.config.dest.port = d.port ?? '';
  b.config.dest.user = d.user ?? '';
  b.config.dest.remoteName = d.remoteName ?? b.config.dest.remoteName ?? 'my-backup-remote';
  b.config.dest.remotePath = d.remotePath ?? '/';
  b.config.dest.sftpAuth = d.sftpAuth ?? 'password';
  b.config.dest.keyPath = d.keyPath ?? '';
  b.config.dest.s3Provider = d.s3Provider ?? 'AWS';
  b.config.dest.s3Bucket = d.s3Bucket ?? '';
  b.config.dest.s3Region = d.s3Region ?? '';
  b.config.dest.s3Endpoint = d.s3Endpoint ?? '';
  if (d.password) { b.config.secrets.password = d.password; b.config.secrets.embed = true; }
  if (d.s3AccessKey) b.config.secrets.s3AccessKey = d.s3AccessKey;
  if (d.s3SecretKey) { b.config.secrets.s3SecretKey = d.s3SecretKey; b.config.secrets.embed = true; }
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
    // delete shard for that vps
    const fs = await import('node:fs');
    const { RUNS_DIR, safeJoin } = await import('../lib/paths.js');
    const f = safeJoin(RUNS_DIR, vpsId === 'local' ? `${id}.json` : `${id}__${vpsId}.json`);
    if (f) try { fs.unlinkSync(f); } catch {}
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
  const list = runs.listAllRuns(id);
  const r = list.find((x) => x.id === runId);
  if (!r) return res.status(404).json({ error: 'run not found' });
  res.type('text/plain; charset=utf-8').set('Content-Disposition', `attachment; filename="run-${runId}.log"`).send(r.output ?? '');
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

// ---- schedules ----
router.get('/api/schedules', (req, res) => {
  const scriptId = req.query.scriptId ? String(req.query.scriptId) : null;
  res.json(schedules.listSchedules(scriptId));
});
router.post('/api/schedules', express.json({ limit: '20kb' }), async (req, res) => {
  const b = req.body ?? {};
  if (!b.scriptId || !b.vpsId || !b.cronExpr) return res.status(400).json({ error: 'scriptId, vpsId, cronExpr required' });
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
