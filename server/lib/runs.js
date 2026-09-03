import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUNS_DIR, LOGS_DIR, safeJoin, isSafeId } from './paths.js';
import { withLock, atomicWrite, readJson, nowIso, randomId } from './jsonfile.js';
import * as store from './store.js';
import * as fleet from './fleet.js';
import * as destinations from './destinations.js';
import { spawnSsh, runSsh } from './ssh.js';

const MAX_RUNS = 25;
const MAX_OUTPUT = 200 * 1024;
const PERSIST_INTERVAL_MS = 500;

/** runId -> live child bookkeeping (single process owns all active runs) */
const active = new Map();

function vpsKey(vpsId) {
  return vpsId && vpsId !== 'local' ? vpsId : 'local';
}

function shardFile(scriptId, vpsId) {
  const name = vpsId && vpsId !== 'local' ? `${scriptId}__${vpsId}.json` : `${scriptId}.json`;
  const f = safeJoin(RUNS_DIR, name);
  if (!f) throw new Error('bad id');
  return f;
}

export function logFileFor(scriptId, vpsId, runId) {
  const f = safeJoin(LOGS_DIR, `${scriptId}__${vpsKey(vpsId)}__${runId}.log`);
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

/** Find one run record plus its shard/vps context (metadata only — output lives in the log file). */
export function findRun(scriptId, runId) {
  for (const r of listAllRuns(scriptId)) {
    if (r.id === runId) return r;
  }
  return null;
}

/** Full log text for a run: per-run log file, with a legacy fallback to inline output. */
export function readLog(scriptId, runId) {
  const rec = findRun(scriptId, runId);
  if (!rec) return null;
  try {
    return fs.readFileSync(logFileFor(scriptId, rec.vpsId, runId), 'utf8');
  } catch {}
  return typeof rec.output === 'string' ? rec.output : '';
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
 * output streams to a per-run log file, metadata to the shard JSON.
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
    bytes: 0,
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

  const logFile = logFileFor(scriptId, effectiveVps, runId);
  const tmpScript = path.join(RUNS_DIR, `.run-${runId}.sh`);
  // Inject stored destination credentials (placeholders + non-interactive prompts).
  const deployScript = destinations.injectSecrets(doc.script, doc.destFleetId);
  fs.writeFileSync(tmpScript, deployScript, { mode: 0o700 });

  let child;
  let remoteBase = null;
  try {
    if (!effectiveVps) {
      child = spawn('bash', [tmpScript], {
        detached: true,
        cwd: '/tmp',
        env: { ...process.env, TERM: 'dumb', DRY_RUN: dryRun ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Per-run paths on the VPS: parallel runs never collide and stops are scoped.
      // setsid makes the wrapper a process-group leader; the pidfile records the PGID.
      remoteBase = `$HOME/rw-${runId}`;
      const scriptContent = fs.readFileSync(tmpScript, 'utf8');      const remoteCmd =
        `cat > ${remoteBase}.sh && chmod 700 ${remoteBase}.sh && ` +
        `setsid bash -c "echo \\$\\$ > ${remoteBase}.pid; ` +
        `DRY_RUN=${dryRun ? 1 : 0} bash ${remoteBase}.sh 2>&1; ec=\\$?; ` +
        `rm -f ${remoteBase}.pid ${remoteBase}.sh; echo __RW_EXIT:\\$ec"`;
      child = await spawnSsh(vps, remoteCmd, { connectTimeout: 15, onStdin: scriptContent });
    }
  } catch (e) {
    await updateRec(scriptId, effectiveVps, runId, {
      finishedAt: nowIso(),
      exitCode: 127,
    });
    try { atomicWrite(logFile, `Failed to start: ${String(e.message || e)}\n`, { mode: 0o600 }); } catch {}
    fs.rmSync(tmpScript, { force: true });
    return { record: readRuns(scriptId, effectiveVps).find((r) => r.id === runId) };
  }

  const state = {
    child,
    scriptId,
    vpsId: effectiveVps,
    runId,
    tmpScript,
    logFile,
    remoteBase,
    buffer: '',
    persistTimer: null,
    done: false,
  };
  active.set(runId, state);

  const persistLog = () => {
    try { atomicWrite(state.logFile, state.buffer, { mode: 0o600 }); } catch {}
  };

  const onData = (chunk) => {
    const text = chunk.toString('utf8').replace(/\r/g, '\n');
    state.buffer = capTail(state.buffer + text);
    if (!state.persistTimer) {
      state.persistTimer = setTimeout(() => {
        state.persistTimer = null;
        if (!state.done) persistLog();
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
    if (exitCode === 143 || exitCode === -1) output += '\n[stopped by user]';
    active.delete(runId);
    try { atomicWrite(state.logFile, capTail(output), { mode: 0o600 }); } catch {}
    await updateRec(scriptId, effectiveVps, runId, { finishedAt: nowIso(), exitCode, bytes: Buffer.byteLength(output) });
    fs.rmSync(tmpScript, { force: true });
    if (effectiveVps) await fleet.touchSeen(effectiveVps).catch(() => {});
  };
  state.finish = finish;

  child.on('error', () => {
    finish(127);
  });
  // Any fatal signal (TERM, KILL, …) is recorded as user-stopped, not exit -1.
  child.on('close', (code, signal) => finish(signal ? 143 : code));

  // Fail-safe: if the child never exits, still allow reap on server restart.
  return { record: rec };
}

/** Stop a run: SIGTERM the local process group / the remote run's group, escalate to SIGKILL. */
export async function stopRun(runId) {
  const state = active.get(runId);
  if (!state) return false;
  const { child, vpsId, remoteBase } = state;

  if (vpsId && remoteBase) {
    // Scoped to this run only: its process group via the pidfile, plus its
    // uniquely-named script path. Never a blanket `pkill -f rclone`.
    const vps = fleet.readDecrypted(vpsId);
    if (vps) {
      const remoteCmd =
        `pkill -TERM -f "rw-${runId}" 2>/dev/null; ` +
        `pid=$(cat ${remoteBase}.pid 2>/dev/null); ` +
        `if [ -n "$pid" ]; then kill -TERM -- -$pid 2>/dev/null; kill -TERM $pid 2>/dev/null; fi; true`;
      runSsh(vps, remoteCmd, { timeoutMs: 10000 }).catch(() => {});
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
 * Boot-time: split legacy inline `output` fields out of shard JSON files into
 * per-run log files, and reap runs orphaned by a previous server instance.
 */
export async function migrateAndReap() {
  const reaped = [];
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(RUNS_DIR, f);
    const runs = readJson(full);
    if (!Array.isArray(runs)) continue;

    let migrated = false;
    for (const r of runs) {
      if (typeof r.output === 'string' && r.output) {
        try {
          const lf = logFileFor(r.scriptId ?? f.replace(/\.json$/, '').split('__')[0], r.vpsId, r.id);
          if (!fs.existsSync(lf)) atomicWrite(lf, r.output, { mode: 0o600 });
        } catch {}
        delete r.output;
        migrated = true;
      }
    }

    const stale = runs.filter((r) => !r.finishedAt && !active.has(r.id));
    if (stale.length) {
      for (const r of stale) {
        r.finishedAt = nowIso();
        r.exitCode = -1;
        reaped.push(r.id);
        try {
          const lf = logFileFor(r.scriptId ?? f.replace(/\.json$/, '').split('__')[0], r.vpsId, r.id);
          fs.appendFileSync(lf, '\n[server restarted — run was interrupted]\n');
        } catch {}
      }
      migrated = true;
    }

    if (migrated) {
      await withLock(full, () => {
        const fresh = readJson(full) ?? [];
        for (const r of fresh) {
          const mine = stale.find((s) => s.id === r.id);
          if (mine) {
            r.finishedAt = mine.finishedAt;
            r.exitCode = mine.exitCode;
          }
          if (typeof r.output === 'string') {
            try {
              const lf = logFileFor(r.scriptId ?? f.replace(/\.json$/, '').split('__')[0], r.vpsId, r.id);
              if (!fs.existsSync(lf) && r.output) atomicWrite(lf, r.output, { mode: 0o600 });
            } catch {}
            delete r.output;
          }
        }
        atomicWrite(full, JSON.stringify(fresh.slice(0, MAX_RUNS), null, 2));
      });
    }
  }
  return reaped;
}

/** Delete one finished run record and its log file (409 if still running). */
export async function deleteRun(scriptId, runId) {
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(RUNS_DIR, f);
    const runs = readJson(full);
    if (!Array.isArray(runs)) continue;
    const target = runs.find((r) => r.id === runId);
    if (!target) continue;
    if (!target.finishedAt && active.has(runId)) return { code: 409 };
    const logFile = logFileFor(scriptId, target.vpsId, runId);
    await withLock(full, () => {
      const fresh = (readJson(full) ?? []).filter((r) => r.id !== runId);
      if (fresh.length) atomicWrite(full, JSON.stringify(fresh, null, 2));
      else fs.rmSync(full, { force: true });
    });
    fs.rmSync(logFile, { force: true });
    return { code: 200 };
  }
  return { code: 404 };
}

function rmScriptLogs(scriptId, vpsId) {
  const prefix = `${scriptId}__${vpsKey(vpsId)}__`;
  for (const f of fs.readdirSync(LOGS_DIR)) {
    if (f.startsWith(prefix) && f.endsWith('.log')) fs.rmSync(path.join(LOGS_DIR, f), { force: true });
  }
}

/** Delete every run of one script (409 if any run is still active). */
export async function deleteAllRuns(scriptId) {
  if (!isSafeId(scriptId)) return;
  const shards = [`${scriptId}.json`];
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (f.startsWith(`${scriptId}__`) && f.endsWith('.json')) shards.push(f);
  }
  const victims = [];
  for (const f of shards) {
    const full = path.join(RUNS_DIR, f);
    const runs = readJson(full);
    if (!Array.isArray(runs)) continue;
    if (runs.some((r) => !r.finishedAt && active.has(r.id))) return { code: 409 };
    victims.push({ full, vpsId: f === `${scriptId}.json` ? null : f.slice(scriptId.length + 2, -5) });
  }
  for (const v of victims) {
    await withLock(v.full, () => fs.rmSync(v.full, { force: true }));
    rmScriptLogs(scriptId, v.vpsId);
  }
  return { code: 200 };
}

/** Delete the per-VPS shard (409 while a run on that VPS is active). */
export async function deleteRunsForVps(scriptId, vpsId) {
  const full = shardFile(scriptId, vpsId);
  const runs = readJson(full) ?? [];
  if (runs.some((r) => !r.finishedAt && active.has(r.id))) return { code: 409 };
  await withLock(full, () => fs.rmSync(full, { force: true }));
  rmScriptLogs(scriptId, vpsId);
  return { code: 200 };
}
