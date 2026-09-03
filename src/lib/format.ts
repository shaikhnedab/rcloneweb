// Formatting + run-stats parsing helpers (no React here).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Human summary of a cron expression; falls back to the raw expression. */
export function friendlyCron(expr: string | undefined | null): string {
  if (!expr) return '—';
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mi, h, dom, , dow] = parts;
  if (/^\*\/\d+$/.test(mi) && h === '*') return `Every ${mi.slice(2)} min`;
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) return `Every ${h.slice(2)} h`;
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h)) return expr;
  const hm = `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return `Daily at ${hm}`;
  if (dow !== '*' && dom === '*') {
    const names = dow.split(',').map((d) => DAYS[Number(d)] ?? d).join(', ');
    return `${names} at ${hm}`;
  }
  if (dom !== '*') return `Day ${dom} · ${hm}`;
  return expr;
}

export interface RunStats { pct: number | null; transferred: string; speed: string; eta: string; checks: string }

/** Parse the newest rclone --progress stats out of a run log tail. */
export function parseRunStats(out: string): RunStats {
  const stats: RunStats = { pct: null, transferred: '', speed: '', eta: '', checks: '' };
  if (!out) return stats;
  const transfers = out.matchAll(/Transferred:[^\n]*/gi);
  let last: string | null = null;
  for (const m of transfers) last = m[0];
  if (last) {
    const num = last.match(/([\d.]+\s*[KMGT]?i?B)\s*\/\s*([\d.]+\s*[KMGT]?i?B)/i);
    if (num) stats.transferred = `${num[1].trim()} / ${num[2].trim()}`;
    const pct = last.match(/,\s*(\d{1,3})%/);
    if (pct) stats.pct = Math.min(100, Number(pct[1]));
    const speed = last.match(/([\d.]+\s*[KMGT]?i?B\/s)/i);
    if (speed) stats.speed = speed[1].trim();
    const eta = last.match(/ETA\s+([\w\d.:]+)/i);
    if (eta) stats.eta = eta[1].trim();
  }
  let checks: string | null = null;
  for (const m of out.matchAll(/Checks:\s*([^\n,]+)/gi)) checks = m[1].trim();
  if (checks) stats.checks = checks;
  return stats;
}

export function elapsedSince(startedAt: string, finishedAt?: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function fmtBytes(n: number | undefined): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${Number.isInteger(v) || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Trigger a client-side download of a text blob. */
export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Compact 4-line live view of a running rclone job. */
export function compactView(out: string, startedAt: string): string {
  const raw = (out || '').replace(/\r/g, '\n');
  const lines = raw.split('\n');
  let starting = '', transferred = '', checks = '', elapsed = '';
  for (const l of lines) {
    const t = l.trim();
    if (!t || /^\[setup\]|^\[warn\]|^---/.test(t)) continue;
    if (/Starting sync for:/.test(t)) starting = t;
    else if (/Transferred:/i.test(t) || (/\d+(?:\.\d+)?\s*[KMGT]?i?B\s*\/\s*\d/.test(t) && /B\/s|ETA/i.test(t))) {
      const clean = t.replace(/^.*\b(?:INFO|NOTICE)\s*:\s*/i, '').trim();
      transferred = /Transferred:/i.test(t) ? t : `Transferred: ${clean}`;
    } else if (/Checks:/i.test(t)) checks = t;
    else if (/Elapsed time:|Elapsed:/i.test(t)) elapsed = t;
  }
  if (starting || transferred || checks || elapsed) {
    const start = new Date(startedAt).getTime();
    const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
    return [
      starting || 'Starting sync for: …',
      transferred || 'Transferred: waiting for first stats…',
      checks || 'Checks: —',
      elapsed || `Elapsed time: ${Math.floor(secs / 60)}m ${secs % 60}s`,
    ].join('\n');
  }
  return lines.slice(-24).join('\n').trim() || '(no output yet — waiting for rclone --progress)';
}
