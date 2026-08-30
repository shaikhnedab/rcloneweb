import fs from 'node:fs';
import path from 'node:path';
import { normalizeParams, buildRemoteEnv, runRclone, rcloneAvailable, remoteTarget, RCLONE_MISSING } from './rclone.js';
import { runSsh } from './ssh.js';
import * as fleet from './fleet.js';
import { DATA_DIR } from './paths.js';

function sortEntries(entries) {
  entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return entries;
}

function parentOf(p) {
  const trimmed = String(p).replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return null;
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Browse the panel server's own filesystem (admin tool = shell-equivalent access). */
export function browseLocal(rawPath) {
  const requested = String(rawPath || '/').trim() || '/';
  let real = path.resolve(requested);
  // Guard: never expose the panel's own data dir (contains auth + secrets)
  if (real === DATA_DIR || real.startsWith(DATA_DIR + path.sep)) {
    return { ok: false, msg: 'Access to the panel data directory is not allowed', path: requested, entries: [] };
  }
  let stat = null;
  try {
    stat = fs.statSync(real);
  } catch {
    real = path.dirname(real);
    try {
      stat = fs.statSync(real);
    } catch {
      return { ok: false, msg: 'Path not found', path: requested, entries: [] };
    }
  }
  if (!stat.isDirectory()) real = path.dirname(real);
  const entries = [];
  for (const name of fs.readdirSync(real)) {
    const full = path.join(real, name);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      isDir = false;
    }
    entries.push({ name, path: full, isDir });
  }
  sortEntries(entries);
  const parent = parentOf(real);
  if (parent) entries.unshift({ name: '..', path: parent, isDir: true, isParent: true });
  return { ok: true, path: real, entries };
}

/** Browse a fleet VPS filesystem over SSH. */
export async function browseVps(vpsId, rawPath) {
  const requested = String(rawPath || '/').trim() || '/';
  if (!vpsId) return browseLocal(requested);
  const vps = fleet.readDecrypted(vpsId);
  if (!vps) return { ok: false, msg: 'VPS not found', path: requested, entries: [] };

  // ls -1 -p marks dirs with a trailing slash; __RW_ markers delimit sections.
  const remoteCmd = `ls -1 -p --group-directories-first -- '${requested.replace(/'/g, `'\\''`)}' 2>&1; echo "__RW_:$?"; echo "__RW_PATH:$PWD"`;
  const res = await runSsh(vps, remoteCmd, { timeoutMs: 20000, connectTimeout: 8 });
  const out = res.stdout;

  if (/Permission denied\s*\(publickey|Permission denied, please try again/i.test(out + res.stderr)) {
    return { ok: false, msg: `SSH Permission denied — verify password/keys on ${vps.host}`, path: requested, entries: [] };
  }
  const m = out.match(/__RW_:(\d+)/);
  const code = m ? Number(m[1]) : res.code;
  const listing = out.replace(/__RW_:\d+[\s\S]*$/, '').replace(/__RW_PATH:[^\n]*\n?/g, '');
  if (code !== 0 || /No such file|cannot access/i.test(listing)) {
    return { ok: false, msg: `Path not found: ${requested}`, path: requested, entries: [] };
  }
  const entries = [];
  for (const line of listing.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (!l.trim()) continue;
    const isDir = l.endsWith('/');
    const name = isDir ? l.slice(0, -1) : l;
    if (!name) continue;
    entries.push({ name, path: `${requested.replace(/\/+$/, '')}/${name}`, isDir });
  }
  sortEntries(entries);
  const parent = parentOf(requested);
  if (parent) entries.unshift({ name: '..', path: parent, isDir: true, isParent: true });
  return { ok: true, path: requested, entries };
}

/** Browse remote storage (sftp/ftp/s3) via ephemeral rclone lsjson. */
export async function browseRemote(rawInput) {
  const p = normalizeParams(rawInput);
  const requested = String(rawInput?.path ?? '').trim();
  if (!(await rcloneAvailable())) return { ok: false, msg: RCLONE_MISSING, path: requested, entries: [] };

  let env;
  try {
    env = await buildRemoteEnv(p);
  } catch (e) {
    return { ok: false, msg: String(e.message || e), path: requested, entries: [] };
  }

  const target = remoteTarget(p, requested);
  const res = await runRclone(['lsjson', target], { env, timeoutMs: 20000 });
  if (res.code !== 0) {
    const raw = (res.stderr || '').trim();
    if (/directory not found|not found/i.test(raw)) return { ok: true, path: requested, entries: [] };
    return { ok: false, msg: raw.slice(0, 400) || 'Failed to list', path: requested, entries: [] };
  }
  let list;
  try {
    list = JSON.parse(res.stdout);
  } catch {
    return { ok: false, msg: 'Unexpected rclone output', path: requested, entries: [] };
  }
  const entries = list.map((e) => ({
    name: e.Name ?? e.name ?? '',
    isDir: Boolean(e.IsDir ?? e.isDir),
    path: `${requested.replace(/\/+$/, '')}/${e.Name ?? e.name ?? ''}`,
  }));
  sortEntries(entries);
  const parent = parentOf(requested);
  if (parent !== null) entries.unshift({ name: '..', path: parent, isDir: true, isParent: true });
  return { ok: true, path: requested, entries };
}

export async function mkdirVps(vpsId, rawPath) {
  const p = String(rawPath ?? '').trim();
  if (!p || p === '/') return { ok: false, msg: 'Enter a folder name' };
  if (!vpsId) {
    if (p === DATA_DIR || p.startsWith(DATA_DIR + path.sep)) return { ok: false, msg: 'Cannot create inside the panel data directory' };
    try {
      fs.mkdirSync(p, { recursive: true });
      return { ok: true, msg: `Created ${p}` };
    } catch (e) {
      return { ok: false, msg: `mkdir failed: ${e.message}` };
    }
  }
  const vps = fleet.readDecrypted(vpsId);
  if (!vps) return { ok: false, msg: 'VPS not found' };
  const quoted = p.replace(/'/g, `'\\''`);
  const res = await runSsh(vps, `mkdir -p -- '${quoted}' 2>&1; echo "__RW_:$?"`, { timeoutMs: 20000, connectTimeout: 8 });
  const m = res.stdout.match(/__RW_:(\d+)/);
  const code = m ? Number(m[1]) : res.code;
  if (/Permission denied/i.test(res.stdout) || code !== 0) {
    return { ok: false, msg: 'mkdir failed: ' + res.stdout.replace(/__RW_:\d+/, '').trim().slice(0, 300) };
  }
  return { ok: true, msg: `Created ${p}` };
}

export async function mkdirRemote(rawInput) {
  const p = normalizeParams(rawInput);
  const target = String(rawInput?.path ?? '').trim();
  if (!target) return { ok: false, msg: 'Enter a folder name' };
  if (!(await rcloneAvailable())) return { ok: false, msg: RCLONE_MISSING };
  let env;
  try {
    env = await buildRemoteEnv(p);
  } catch (e) {
    return { ok: false, msg: String(e.message || e) };
  }

  if (p.type === 's3') {
    // S3 folders are virtual — upload a zero-byte marker object so the prefix shows up.
    const marker = `${remoteTarget(p, target).replace(/\/+$/, '')}/.keep`;
    const res = await runRclone(['rcat', marker], { env, timeoutMs: 20000 });
    if (res.code !== 0) return { ok: false, msg: (res.stderr || 'S3 mkdir failed').slice(0, 400) };
    return { ok: true, msg: `Created ${target}` };
  }

  const res = await runRclone(['mkdir', remoteTarget(p, target)], { env, timeoutMs: 20000 });
  if (res.code !== 0) return { ok: false, msg: (res.stderr || 'mkdir failed').slice(0, 400) };
  return { ok: true, msg: `Created ${target}` };
}
