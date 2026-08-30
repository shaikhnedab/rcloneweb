import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Shared rclone helper — ephemeral remotes defined entirely via environment
 * variables (RCLONE_CONFIG_*), so credentials never touch argv or a shell.
 * Each invocation is a fresh process, so a fixed remote name is safe.
 */
const REMOTE = 'rwpanel';
const REMOTE_ENV = REMOTE.toUpperCase();

export function rcloneAvailable() {
  return new Promise((resolve) => {
    execFile('which', ['rclone'], (err) => resolve(!err));
  });
}

export const RCLONE_MISSING = 'rclone not found on panel server (install: curl https://rclone.org/install.sh | sudo bash)';

/** Obscure a password via stdin (never on the command line). */
export function obscure(plain) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', ['obscure', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? RCLONE_MISSING : String(e.message || e))));
    child.on('close', (code) => {
      const val = out.trim();
      if (code !== 0 || !val) reject(new Error(`rclone obscure failed: ${errOut.trim().slice(0, 200)}`));
      else resolve(val);
    });
    child.stdin.write(String(plain));
    child.stdin.end();
  });
}

/**
 * Build env additions that define the ephemeral remote `rwpanel` for the
 * given destination params. Throws a human-readable error on bad input.
 */
export async function buildRemoteEnv(p) {
  const type = p?.type;
  const env = {};
  const set = (k, v) => {
    env[`RCLONE_CONFIG_${REMOTE_ENV}_${k}`] = String(v);
  };
  set('TYPE', type);
  if (type === 'sftp') {
    if (!p.host) throw new Error('Host is required');
    set('HOST', p.host);
    set('USER', p.user ?? '');
    set('PORT', String(Number(p.port) || 22));
    if (p.sftpAuth === 'key') {
      if (!p.keyPath) throw new Error('SSH key path required');
      set('KEY_FILE', p.keyPath);
    } else {
      if (!p.password) throw new Error('Password required');
      set('PASS', await obscure(p.password));
    }
  } else if (type === 'ftp') {
    if (!p.host) throw new Error('Host is required');
    set('HOST', p.host);
    set('USER', p.user ?? '');
    set('PORT', String(Number(p.port) || 21));
    if (!p.password) throw new Error('Password required');
    set('PASS', await obscure(p.password));
  } else if (type === 's3') {
    if (!p.s3AccessKey || !p.s3SecretKey) throw new Error('Access key and secret required');
    set('PROVIDER', p.s3Provider || 'AWS');
    set('REGION', p.s3Region || 'us-east-1');
    set('ACCESS_KEY_ID', p.s3AccessKey);
    set('SECRET_ACCESS_KEY', p.s3SecretKey);
    if (p.s3Endpoint) set('ENDPOINT', p.s3Endpoint);
    set('NO_CHECK_BUCKET', 'true');
  } else {
    throw new Error('Unknown remote type');
  }
  return env;
}

/**
 * Run rclone with extra env. stdout and stderr stay separate so JSON output
 * is always clean (fixes v1's NOTICE-polluted merged streams).
 */
export function runRclone(args, { env = {}, timeoutMs = 20000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'rclone',
      args,
      { env: { ...process.env, ...env, RCLONE_CONFIG: '/dev/null' }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 255) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * Normalize destination params from either an inline request body or a stored
 * destination doc (both key styles accepted, mirroring v1's API).
 */
export function normalizeParams(input = {}) {
  return {
    type: input.type ?? input.destType ?? '',
    host: String(input.host ?? '').trim(),
    port: String(input.port ?? '').trim(),
    user: String(input.user ?? '').trim(),
    password: input.password ?? input.pass ?? null,
    sftpAuth: input.sftpAuth ?? 'password',
    keyPath: String(input.keyPath ?? '').trim(),
    s3Bucket: String(input.bucket ?? input.s3Bucket ?? '').trim(),
    s3Region: String(input.region ?? input.s3Region ?? '').trim(),
    s3Endpoint: String(input.endpoint ?? input.s3Endpoint ?? '').trim(),
    s3Provider: String(input.provider ?? input.s3Provider ?? 'AWS').trim() || 'AWS',
    s3AccessKey: String(input.accessKey ?? input.s3AccessKey ?? '').trim(),
    s3SecretKey: input.secretKey ?? input.s3SecretKey ?? null,
  };
}

/** Target address for the ephemeral remote (s3 prefixes the bucket). */
export function remoteTarget(p, subPath = '') {
  if (p.type === 's3') {
    const bucket = p.s3Bucket ? `${p.s3Bucket}/` : '';
    return `${REMOTE}:${bucket}${String(subPath).replace(/^\/+/, '')}`;
  }
  return `${REMOTE}:${String(subPath).replace(/^\/+/, '')}`;
}

export function tempRemoteName() {
  return REMOTE;
}

export function randomTmpToken() {
  return crypto.randomBytes(6).toString('hex');
}
