import { normalizeParams, buildRemoteEnv, runRclone, rcloneAvailable, remoteTarget, RCLONE_MISSING } from './rclone.js';
import { runSsh } from './ssh.js';
import * as fleet from './fleet.js';

/** Probe a destination (sftp/ftp/s3) via an ephemeral rclone remote. */
export async function testDestination(rawInput) {
  const p = normalizeParams(rawInput);
  if (!['sftp', 'ftp', 's3'].includes(p.type)) return fail('Unknown type');
  if (p.type !== 's3' && !p.host) return fail('Host is required');

  if (!(await rcloneAvailable())) return fail(RCLONE_MISSING);

  let env;
  try {
    env = await buildRemoteEnv(p);
  } catch (e) {
    return fail(String(e.message || e));
  }

  const target = remoteTarget(p);
  const res = await runRclone(['lsd', '--max-depth', '1', target], { env, timeoutMs: 20000 });

  if (res.code === 0) {
    const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const cnt = lines.length;
    const preview = cnt ? ' — ' + lines.slice(0, 3).map((l) => l.split(/\s+/).pop()).join(', ').slice(0, 120) : '';
    return { ok: true, msg: `Connection OK — found ${cnt} items${preview}` };
  }

  const raw = (res.stderr || res.stdout).trim();
  return { ok: false, msg: humanizeRemoteError(raw) };
}

function humanizeRemoteError(raw) {
  const lower = raw.toLowerCase();
  if (lower.includes('signaturedoesnotmatch')) {
    return 'S3 signature mismatch — check: 1) Region matches endpoint, 2) Endpoint URL is exact (https://... no trailing slash), 3) System clock (NTP), 4) Access/Secret key. Raw: ' + raw.slice(0, 250);
  }
  if (lower.includes('auth') || lower.includes('password') || lower.includes('login') || lower.includes('permission')) {
    return 'Authentication failed — check user/password. Raw: ' + raw.slice(0, 250);
  }
  if (lower.includes('timeout') || lower.includes('refused') || lower.includes('no route')) {
    return 'Cannot reach host — check host/port/firewall';
  }
  if (lower.includes('no such host') || lower.includes('could not resolve') || lower.includes('lookup')) {
    return 'DNS lookup failed';
  }
  if (lower.includes('403') || lower.includes('accessdenied')) {
    return 'S3 access denied — check bucket name, region, and IAM permissions';
  }
  return raw.slice(0, 500) || 'Connection failed';
}

function fail(msg) {
  return { ok: false, msg };
}

/** Test SSH connectivity + required packages on a fleet VPS. */
export async function testSource(vpsId) {
  const vps = fleet.readDecrypted(vpsId);
  if (!vps) return fail('VPS not found');
  const remoteCmd = `echo ok; echo "RCLONE:\$(command -v rclone >/dev/null && echo 0 || echo 1)"; echo "CURL:\$(command -v curl >/dev/null && echo 0 || echo 1)"; echo "BASH:\$(command -v bash >/dev/null && echo 0 || echo 1)"; rclone version 2>/dev/null | head -1`;
  const res = await runSsh(vps, remoteCmd, { timeoutMs: 20000, connectTimeout: 8 });
  const out = (res.stdout + res.stderr).trim();

  if (res.code === 0 && out.includes('ok')) {
    await fleet.touchSeen(vpsId);
    const checks = {
      rclone: out.includes('RCLONE:0'),
      curl: out.includes('CURL:0'),
      bash: out.includes('BASH:0'),
    };
    const missing = [];
    if (!checks.rclone) missing.push('rclone (install: curl https://rclone.org/install.sh | sudo bash)');
    if (!checks.curl) missing.push('curl (apt install curl)');
    if (missing.length) {
      return { ok: true, msg: `SSH OK, but missing: ${missing.join(', ')} — install on source VPS`, checks, missing };
    }
    return { ok: true, msg: 'SSH OK, rclone found', checks };
  }

  const lower = out.toLowerCase();
  if (lower.includes('permission denied')) {
    return { ok: false, msg: 'Permission denied — check: 1) password correct, 2) PasswordAuthentication yes, 3) PermitRootLogin yes (or use a non-root user), 4) try SSH key auth. Raw: ' + out.slice(0, 250) };
  }
  if (lower.includes('connection timed out') || lower.includes('connection refused')) {
    return { ok: false, msg: 'Cannot reach host — check host/port/firewall' };
  }
  return { ok: false, msg: out.slice(0, 400) || 'SSH connection failed' };
}
