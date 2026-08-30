import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUNS_DIR, safeJoin, isSafeId } from './paths.js';
import { withLock, atomicWrite, readJson, nowIso, randomId } from './jsonfile.js';
import * as store from './store.js';
import * as fleet from './fleet.js';
import { spawnSsh } from './ssh.js';

const MAX_RUNS = 25;
const MAX_OUTPUT = 200 * 1024;
const PERSIST_INTERVAL_MS = 500;

/** runId -> live child bookkeeping (single process owns all active runs) */
const active = new Map();

function shardFile(scriptId, vpsId) {
  const name = vpsId && vpsId !== 'local' ? `${scriptId}__${vpsId}.json` : `${scriptId}.json`;
  const f = safeJoin(RUNS_DIR, name);
  if (!f) throw new Error('bad id');
  return f;
}

export function readRuns(scriptId, vpsId = null) {
  return readJson(shardFile(scriptId, vpsId)) ?? [];
}

/** All runs for a script across every shard, newest first (exact shard names only). */
export function listAllRuns(scriptId) {
  if (!isSafeId(scriptId)) return [];
  const all = [];
  const names = new Set([`${scriptId}.json`]);
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (f.startsWith(`${scriptId}__`) && f.endsWith('.json')) names.add(f);
  }
  for (const f of names) {
    const j = readJson(path.join(RUNS_DIR, f));
    if (Array.isArray(j)) all.push(...j);
  }
  all.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return all.slice(0, MAX_RUNS);
}

async function writeShard(scriptId, vpsId, runs) {
  const f = shardFile(scriptId, vpsId);
  const trimmed = JSON.stringify(runs.slice(0, MAX_RUNS), null, 2);
  await withLock(f, () => atomicWrite(f, trimmed));
}

/** Keep the tail of the output so live stats stay fresh on long runs. */
function capTail(buf) {
  if (buf.length <= MAX_OUTPUT) return buf;
  const sliced = buf.slice(buf.length - MAX_OUTPUT);
  const nl = sliced.indexOf('\n');
  return nl > 0 ? sliced.slice(nl + 1) : sliced;
}

function updateRec(scriptId, vpsId, runId, patch) {
  const f = shardFile(scriptId, vpsId);
  return withLock(f, () => {
    const runs = readJson(f) ?? [];
    const rec = runs.find((r) => r.id === runId);
    if (!rec) return;
    Object.assign(rec, patch);
    // write inside the same lock so the read-modify-write is atomic
    atomicWrite(f, JSON.stringify(runs.slice(0, MAX_RUNS), null, 2));
  });
}

/**
 * Start a run (local or remote). Resolves with the run record immediately;
 * output is streamed to the shard file in the background.
 */
export async function startRun(scriptId, { dryRun = false, vpsId = null } = {}) {
  if (!isSafeId(scriptId)) throw new Error('bad id');
  const doc = store.read(scriptId);
  if (!doc || !doc.script) return { error: 'script_not_found' };

  const effectiveVps = vpsId && vpsId !== 'local' ? vpsId : null;
  const existing = readRuns(scriptId, effectiveVps);
  if (existing.some((r) => !r.finishedAt)) return { error: 'already_running' };

  const vps = effectiveVps ? fleet.readDecrypted(effectiveVps) : null;
  if (effectiveVps && (!vps || !vps.host)) return { error: 'vps_not_found' };

  const runId = randomId(3) + Date.now().toString(36);
  const rec = {
    id: runId,
    scriptId,
    vpsId: effectiveVps ?? 'local',
    vpsName: effectiveVps ? vps.name ?? effectiveVps : 'localhost',
    name: doc.name,
    dryRun: Boolean(dryRun),
    startedAt: nowIso(),
    finishedAt: null,
    exitCode: null,
    output: '',
  };

  const shard = shardFile(scriptId, effectiveVps);
  try {
    await withLock(shard, async () => {
      const runs = readJson(shard) ?? [];
      if (runs.some((r) => !r.finishedAt)) {
        const e = new Error('already_running');
        e.code = 'ALREADY_RUNNING';
        throw e;
      }
      atomicWrite(shard, JSON.stringify([rec, ...runs].slice(0, MAX_RUNS), null, 2));
    });
  } catch (e) {
    if (e?.code === 'ALREADY_RUNNING') return { error: 'already_running' };
    throw e;
  }

  const tmpScript = path.join(RUNS_DIR, `.run-${runId}.sh`);
  fs.writeFileSync(tmpScript, doc.script, { mode: 0o700 });

  let child;
  let remoteTmp = null;
  try {
    if (!effectiveVps) {
      child = spawn('bash', [tmpScript], {
        detached: true,
        cwd: '/tmp',
        env: { ...process.env, TERM: 'dumb', DRY_RUN: dryRun ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Persistent deploy path on VPS — update if exists, create if not (option A)
      remoteTmp = '~/backup.sh';
      const scriptContent = fs.readFileSync(tmpScript, 'utf8');
      const remoteCmd =
        `if [ -f ~/backup.sh ]; then cp ~/backup.sh ~/backup.sh.bak 2>/dev/null || true; fi; ` +
        `cat > ~/backup.sh && chmod 700 ~/backup.sh && ` +
        `DRY_RUN=${dryRun ? '1' : '0'} bash ~/backup.sh 2>&1; ec=$?; echo "__RW_EXIT:$ec"`;
      child = await spawnSsh(vps, remoteCmd, { connectTimeout: 15, onStdin: scriptContent });
    }
  } catch (e) {
    await updateRec(scriptId, effectiveVps, runId, {
      finishedAt: nowIso(),
      exitCode: 127,
      output: `Failed to start: ${String(e.message || e)}`,
    });
    fs.rmSync(tmpScript, { force: true });
    return { record: readRuns(scriptId, effectiveVps).find((r) => r.id === runId) };
  }

  const state = {
    child,
    scriptId,
    vpsId: effectiveVps,
    runId,
    tmpScript,
    remoteTmp,
    buffer: '',
    persistTimer: null,
    done: false,
  };
  active.set(runId, state);

  const persist = () => updateRec(scriptId, effectiveVps, runId, { output: state.buffer });

  const onData = (chunk) => {
    state.buffer = capTail(state.buffer + chunk.toString('utf8'));
    if (!state.persistTimer) {
      state.persistTimer = setTimeout(async () => {
        state.persistTimer = null;
        if (!state.done) await persist();
      }, PERSIST_INTERVAL_MS);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const finish = async (code) => {
    if (state.done) return;
    state.done = true;
    if (state.persistTimer) clearTimeout(state.persistTimer);
    const m = state.buffer.match(/__RW_EXIT:(-?\d+)/);
    let exitCode = code ?? (m ? Number(m[1]) : null);
    let output = state.buffer;
    if (m) {
      exitCode = Number(m[1]);
      output = output.replace(/__RW_EXIT:-?\d+/, `[exit ${exitCode}]`);
    }
    if (exitCode === null || Number.isNaN(exitCode)) exitCode = code ?? -1;
    if (exitCode === 143) output += '\n[stopped by user]';
    active.delete(runId);
    await updateRec(scriptId, effectiveVps, runId, { output: capTail(output), finishedAt: nowIso(), exitCode });
    fs.rmSync(tmpScript, { force: true });
    if (effectiveVps) await fleet.touchSeen(effectiveVps).catch(() => {});
  };
  state.finish = finish;

  child.on('error', () => {
    finish(127);
  });
  child.on('close', (code, signal) => finish(signal === 'SIGTERM' ? 143 : code));

  // Fail-safe: if the child never exits, still allow reap on server restart.
  return { record: rec };
}

/** Stop a run: SIGTERM the process group, escalate to SIGKILL. */
export async function stopRun(runId) {
  const state = active.get(runId);
  if (!state) return false;
  const { child, vpsId, remoteTmp } = state;

  if (vpsId && remoteTmp) {
    // Kill only this run's remote process — for persistent ~/backup.sh, match backup.sh
    const vps = fleet.readDecrypted(vpsId);
    if (vps) {
      const { runSsh } = await import('./ssh.js');
      const pattern = remoteTmp === '~/backup.sh' ? 'backup.sh' : remoteTmp;
      const quoted = pattern.replace(/'/g, `'\\''`);
      runSsh(vps, `pkill -f -- '${quoted}' >/dev/null 2>&1; pkill -TERM -f rclone >/dev/null 2>&1; true`, { timeoutMs: 10000 }).catch(() => {});
    }
  }

  const pid = child.pid;
  if (pid) {
    try {
      // child spawned detached → it leads its own process group
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }, 3000);
  }
  return true;
}

/** Is a run still active? */
export function isActive(runId) {
  return active.has(runId);
}

/**
 * Boot-time reaping: any run recorded as unfinished but not owned by this
 * process was orphaned by a previous server instance (or a crash).
 */
export async function reapStaleRuns() {
  const reaped = [];
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(RUNS_DIR, f);
    const runs = readJson(full);
    if (!Array.isArray(runs)) continue;
    const stale = runs.filter((r) => !r.finishedAt && !active.has(r.id));
    if (!stale.length) continue;
    await withLock(full, () => {
      const fresh = readJson(full) ?? [];
      for (const r of fresh) {
        if (r.finishedAt || active.has(r.id)) continue;
        if (!stale.some((s) => s.id === r.id)) continue;
        r.finishedAt = nowIso();
        r.exitCode = -1;
        r.output = (r.output ?? '') + '\n[server restarted — run was interrupted]';
        reaped.push(r.id);
      }
      atomicWrite(full, JSON.stringify(fresh.slice(0, MAX_RUNS), null, 2));
    });
  }
  return reaped;
}

/** Delete one finished run record (409 if still running). */
export async function deleteRun(scriptId, runId) {
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(RUNS_DIR, f);
    const runs = readJson(full);
    if (!Array.isArray(runs)) continue;
    const target = runs.find((r) => r.id === runId);
    if (!target) continue;
    if (!target.finishedAt && active.has(runId)) return { code: 409 };
    await withLock(full, () => {
      const fresh = (readJson(full) ?? []).filter((r) => r.id !== runId);
      if (fresh.length) atomicWrite(full, JSON.stringify(fresh, null, 2));
      else fs.rmSync(full, { force: true });
    });
    return { code: 200 };
  }
  return { code: 404 };
}

/** Delete all run logs for a script (stops nothing — caller must not have active runs). */
export async function deleteAllRuns(scriptId) {
  if (!isSafeId(scriptId)) return;
  for (const r of listAllRuns(scriptId)) {
    if (active.has(r.id)) return { code: 409 };
  }
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith('.json')) continue;
    if (f !== `${scriptId}.json` && !f.startsWith(`${scriptId}__`)) continue;
    fs.rmSync(path.join(RUNS_DIR, f), { force: true });
  }
  return { code: 200 };
}
