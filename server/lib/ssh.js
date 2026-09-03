import { execFile, spawn } from 'node:child_process';

/**
 * SSH helper — argument arrays only, no shell string concatenation.
 * Password auth uses sshpass with the password in the environment (SSHPASS),
 * so credentials never appear in argv or a shell command line.
 */

export function sshpassAvailable() {
  return new Promise((resolve) => {
    execFile('which', ['sshpass'], (err) => resolve(!err));
  });
}

/**
 * Build argv + env for running a command on a fleet VPS.
 * Returns { cmd, args, env } or throws with a human-readable message.
 */
export async function buildSshInvocation(vps, remoteCommand, { connectTimeout = 10 } = {}) {
  if (!vps?.host || !vps?.user) throw new Error('VPS host/user not configured');
  const port = String(Number(vps.port) || 22);
  const auth = vps.auth === 'key' ? 'key' : 'password';

  let cmd = 'ssh';
  let args = [];
  const env = { ...process.env };

  if (auth === 'password') {
    if (!vps.password) throw new Error('Password auth selected but no password stored');
    if (!(await sshpassAvailable())) throw new Error('Password auth requested but sshpass is not installed on the panel server (apt install sshpass)');
    env.SSHPASS = String(vps.password);
    cmd = 'sshpass';
    args = ['-e', 'ssh'];
  }

  args.push(
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=' + connectTimeout,
    '-o', 'LogLevel=ERROR',
    '-p', port,
  );
  if (auth === 'password') {
    args.push('-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive');
  } else {
    args.push('-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey');
    if (vps.keyPath) args.push('-i', String(vps.keyPath));
  }
  args.push(`${vps.user}@${vps.host}`, remoteCommand);
  return { cmd, args, env };
}

/** Run a command on a VPS and collect output. Rejects on non-zero exit or timeout. */
export function runSsh(vps, remoteCommand, { timeoutMs = 20000, connectTimeout = 10 } = {}) {
  return new Promise(async (resolve) => {
    let inv;
    try {
      inv = await buildSshInvocation(vps, remoteCommand, { connectTimeout });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message || e) });
    }
    const child = execFile(
      inv.cmd,
      inv.args,
      { env: inv.env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 255) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    child.on('error', () => {});
  });
}

/** Streaming ssh invocation for long-running remote commands (used by runs). */
export async function spawnSsh(vps, remoteCommand, { connectTimeout = 10, onStdin = null } = {}) {
  const inv = await buildSshInvocation(vps, remoteCommand, { connectTimeout });
  const child = spawn(inv.cmd, inv.args, {
    env: inv.env,
    detached: true,
    stdio: onStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (onStdin) {
    child.stdin.write(onStdin);
    child.stdin.end();
  }
  return child;
}
