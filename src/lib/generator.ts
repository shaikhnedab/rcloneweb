// rcloneweb v2 — bash script generator + discord payload builder
// Ported from legacy generator.js with security + webhook wiring fixes.

export type DestType = 'sftp' | 'ftp' | 's3';
export interface SourceRow { path: string; dest: string; include: string; exclude: string; preserveParent?: boolean }
export interface DestCfg {
  type: DestType; remoteName: string; remotePath: string;
  host: string; port: string; user: string;
  sftpAuth: 'password' | 'key'; keyPath: string;
  s3Provider: string; s3Bucket: string; s3Region: string; s3Endpoint: string;
}
export interface SecretsCfg { embed: boolean; password: string; s3AccessKey: string; s3SecretKey: string }
export interface OptionsCfg { mode: 'sync' | 'copy'; dryRun: boolean; bandwidth: string; retentionDays: number; logfile: string; extraFlags: string }
export interface WebhookCfg {
  enabled: boolean; onlyOnFail: boolean; url: string; username: string; avatarUrl: string;
  title: string; description: string; colorOk: string; colorFail: string; logLines: number; sendLogOnFail: boolean; sendLogOnSuccess: boolean;
}
export interface AppConfig {
  name: string; script?: string; manualEdited?: boolean;
  sources: SourceRow[]; dest: DestCfg; secrets: SecretsCfg; options: OptionsCfg; webhook: WebhookCfg;
}

const shq = (s: string) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

export function defaultConfig(): AppConfig {
  return {
    name: 'My Backup',
    script: '',
    manualEdited: false,
    sources: [{ path: '/', dest: '', include: '', exclude: '', preserveParent: false }],
    dest: {
      type: 'sftp', remoteName: 'my-backup-remote', remotePath: '/',
      host: '', port: '', user: '',
      sftpAuth: 'password', keyPath: '~/.ssh/id_ed25519',
      s3Provider: 'AWS', s3Bucket: '', s3Region: '', s3Endpoint: '',
    },
    secrets: { embed: false, password: '', s3AccessKey: '', s3SecretKey: '' },
    options: {
      mode: 'sync', dryRun: false, bandwidth: '', retentionDays: 0,
      logfile: '/var/log/rclone-backup.log',
      extraFlags: '--transfers 8 --checkers=32 --fast-list --progress --log-level=INFO --retries 5 --low-level-retries 20 --retries-sleep 10s',
    },
    webhook: {
      enabled: true, onlyOnFail: false, url: '', username: 'Backup Bot', avatarUrl: '',
      title: 'Backup {STATUS}: {NAME}',
      description: 'Host: {HOST}\nSources: {SOURCES}\nDestination: {DEST}\nDuration: {DURATION}',
      colorOk: '#57f287', colorFail: '#ed4245', logLines: 10, sendLogOnFail: true, sendLogOnSuccess: true,
    },
  };
}

export function normalize(cfg: Partial<AppConfig>): AppConfig {
  const d = defaultConfig();
  const out: AppConfig = { ...d, ...cfg } as AppConfig;
  out.dest = { ...d.dest, ...(cfg.dest || {}) } as DestCfg;
  out.secrets = { ...d.secrets, ...(cfg.secrets || {}) } as SecretsCfg;
  out.options = { ...d.options, ...(cfg.options || {}) } as OptionsCfg;
  out.webhook = { ...d.webhook, ...(cfg.webhook || {}) } as WebhookCfg;
  if (!Array.isArray(out.sources) || !out.sources.length) out.sources = d.sources;
  out.sources = out.sources.map((s) => {
    const base = Object.assign({ dest: '', include: '', exclude: '', path: '/', preserveParent: true }, s) as SourceRow;
    if (s.preserveParent === undefined) base.preserveParent = base.path !== '/' && base.path !== '';
    return base;
  });
  return out;
}

const hexToDecimal = (hex: string) => {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0x57f287;
};

export const destString = (cfg: AppConfig) => {
  const t = cfg.dest;
  let remote = `${t.remoteName}:`;
  if (t.type === 's3') remote += t.s3Bucket ? `${t.s3Bucket}/` : '';
  const p = String(t.remotePath || '').trim();
  if (!p || p === '/') return remote + '/';
  return remote + p.replace(/^\/+/, '');
};

const srcBase = (p: string) => String(p).split('/').filter(Boolean).pop() || '.';
const cleanPath = (p: string) => String(p).replace(/^\/+|\/+$/g, '');

const toFilterRules = (entry: string, srcPath: string, sign: string): string[] => {
  const src = cleanPath(srcPath);
  let rel = cleanPath(String(entry).trim());
  if (entry.startsWith('/') && src) {
    if (rel === src) return [`${sign} *`];
    if (rel.startsWith(src + '/')) rel = rel.slice(src.length + 1);
    else rel = cleanPath(entry);
  }
  if (!rel) return [];
  const hasExtension = /\.[A-Za-z0-9]{1,16}$/.test(rel);
  const rules = [`${sign} ${rel}`];
  if (!hasExtension) rules.push(`${sign} ${rel}/**`);
  return rules;
};

const filterExtraFor = (s: SourceRow, bwRaw: string): string[] => {
  const rules: string[] = [];
  const appendRel = (entry: string, sign: string) =>
    toFilterRules(entry, s.path, sign).forEach((r) => {
      if (!rules.includes(r)) rules.push(r);
    });
  if (s.include) s.include.split(/[,\s]+/).filter(Boolean).forEach((p) => appendRel(p, '+'));
  if (s.exclude) s.exclude.split(/[,\s]+/).filter(Boolean).forEach((p) => appendRel(p, '-'));
  if (s.include) rules.push('- *');
  const tokens: string[] = [];
  for (const r of rules) tokens.push('--filter ' + shq(r));
  if (bwRaw && bwRaw.toLowerCase() !== 'off') tokens.push('--bwlimit ' + shq(bwRaw));
  return tokens;
};

const destForSource = (s: SourceRow, cfg: AppConfig): string => {
  const raw = String(s.dest || '').trim();
  const shouldPreserve = s.preserveParent !== undefined ? s.preserveParent : s.path !== '/' && s.path !== '';
  if (raw) {
    const baseRaw = raw.includes(':') ? raw : `${cfg.dest.remoteName}:${cleanPath(raw) || ''}`;
    if (shouldPreserve && s.path !== '/') {
      const clean = baseRaw.replace(/\/+$/,'');
      return `${clean}/${srcBase(s.path)}`;
    }
    return baseRaw;
  }
  const t = cfg.dest;
  const base = cleanPath(t.remotePath);
  if (!base) return `${t.remoteName}:/${srcBase(s.path)}`;
  return `${t.remoteName}:${base}/${srcBase(s.path)}`;
};

function staticVars(cfg: AppConfig): Record<string, string> {
  return {
    '{NAME}': cfg.name,
    '{SOURCES}': cfg.sources.map((s) => s.path).join(', '),
    '{DEST}': destString(cfg),
    '{STATUS}': '@STATUS@',
    '{HOST}': '@HOST@',
    '{DURATION}': '@DUR@s',
    '{DATE}': '@DATE@',
  };
}

const fillTemplate = (tpl: string, vars: Record<string, string>) => {
  let s = String(tpl ?? '');
  for (const [k, v] of Object.entries(vars)) s = s.split(k).join(v);
  return s;
};

export function buildPayload(cfg: Partial<AppConfig>, status: string, opts: { host?: string; duration?: string; logTail?: string | null } = {}) {
  const c = normalize(cfg);
  const w = c.webhook;
  const ok = status === 'SUCCESS';
  const vars = { ...staticVars(c) };
  vars['{STATUS}'] = status;
  vars['{HOST}'] = opts.host || 'myserver';
  vars['{DURATION}'] = opts.duration ?? '42s';
  vars['{DATE}'] = new Date().toLocaleString();
  const embed: Record<string, unknown> = {
    title: fillTemplate(w.title, vars),
    description: fillTemplate(w.description, vars),
    color: hexToDecimal(ok ? w.colorOk : w.colorFail),
    footer: { text: `rclone · ${c.name}` },
    timestamp: new Date().toISOString(),
  };
  if (!ok && opts.logTail) embed['description'] = (embed['description'] as string) + '\n```' + String(opts.logTail).slice(-1400) + '```';
  const payload: Record<string, unknown> = { username: w.username || 'Backup Bot', embeds: [embed] };
  if (w.avatarUrl) payload['avatar_url'] = w.avatarUrl;
  return payload;
}

function buildConfigCreate(cfg: AppConfig): string {
  const t = cfg.dest;
  const emb = cfg.secrets.embed;
  const setupHeader = (label: string) => `echo "[setup] configuring rclone remote '${t.remoteName}' (${label})..." `;
  const L: string[] = [];
  if (t.type === 'sftp') {
    L.push(setupHeader('sftp'));
    L.push(`rclone config create ${shq(t.remoteName)} sftp \\`);
    L.push(`  host ${shq(t.host)} user ${shq(t.user)} \\`);
    if (t.port) L.push(`  port ${shq(t.port)} \\`);
    if (t.sftpAuth === 'key') L.push(`  key_file ${shq(t.keyPath)}`);
    else if (emb) L.push(`  pass "$(_obscure ${shq(cfg.secrets.password)})"`);
    else L.push(`  pass "$(_obscure "$FTP_PASS")"`);
  } else if (t.type === 'ftp') {
    L.push(setupHeader('ftp'));
    L.push(`rclone config create ${shq(t.remoteName)} ftp \\`);
    L.push(`  host ${shq(t.host)} user ${shq(t.user)} \\`);
    if (t.port) L.push(`  port ${shq(t.port)} \\`);
    if (emb) L.push(`  pass "$(_obscure ${shq(cfg.secrets.password)})"`);
    else L.push(`  pass "$(_obscure "$FTP_PASS")"`);
  } else {
    L.push(setupHeader('s3'));
    L.push(`rclone config create ${shq(t.remoteName)} s3 \\`);
    L.push(`  provider ${shq(t.s3Provider)} region ${shq(t.s3Region)} \\`);
    if (t.s3Endpoint) L.push(`  endpoint ${shq(t.s3Endpoint)} \\`);
    if (emb) L.push(`  access_key_id ${shq(cfg.secrets.s3AccessKey)} secret_access_key ${shq(cfg.secrets.s3SecretKey)} \\`);
    else L.push('  access_key_id "$AWS_ACCESS_KEY_ID" secret_access_key "$AWS_SECRET_ACCESS_KEY" \\');
    L.push('  no_check_bucket true');
  }
  return L.join('\n');
}

export function buildScript(rawCfg: Partial<AppConfig>): string {
  const cfg = normalize(rawCfg);
  const t = cfg.dest;
  const o = cfg.options;
  const w = cfg.webhook;
  const emb = cfg.secrets.embed;
  const cleanDst = (d: string) => String(d).replace(/\\:/g, ':');
  const L: string[] = [];

  L.push('#!/usr/bin/env bash');
  L.push('# =============================================================');
  L.push(`# ${cfg.name} — generated by rcloneweb v2 on ${new Date().toISOString()}`);
  L.push(`# destination : ${cleanDst(destString(cfg))} (${t.type})`);
  L.push(`# sources     : ${cfg.sources.map((s) => `${s.path} → ${cleanDst(s.dest || destForSource(s, cfg))}`).join(', ')}`);
  L.push('# usage       : ./backup.sh            (run backup)');
  L.push('#               DRY_RUN=1 ./backup.sh  (force dry-run)');
  L.push('# install     : curl -fsSL <panel-url>/raw/<id>.sh -o backup.sh && chmod 700 backup.sh');
  L.push('# =============================================================');
  L.push('');
  L.push('set -uo pipefail');
  L.push('');
  L.push('SCRIPT_NAME=' + shq(cfg.name));
  L.push('REMOTE=' + shq(destString(cfg)));
  L.push('');

  // Embed webhook templates as base64 so single quotes/newlines never break bash quoting.
  const b64 = (s: string) => {
    const str = String(s ?? '');
    try { return btoa(unescape(encodeURIComponent(str))); } catch { return btoa(str); }
  };
  const webhookEnabled = w.enabled && Boolean(w.url);
  const onlyOnFail = Boolean(w.onlyOnFail);
  const okColorNum = hexToDecimal(w.colorOk);
  const failColorNum = hexToDecimal(w.colorFail);
  const logLines = Math.max(0, Math.min(200, Number(w.logLines) || 0));

  L.push('# ---------- credentials ----------');
  if (emb) L.push('# WARNING: credentials are embedded below. Keep this file root-owned: chmod 700.');
  else if ((t.type === 'sftp' && t.sftpAuth === 'password') || t.type === 'ftp') L.push('# Password comes from $FTP_PASS (env var) or an interactive prompt.');
  else if (t.type === 's3') L.push('# Keys come from $AWS_ACCESS_KEY_ID / $AWS_SECRET_ACCESS_KEY env vars.');
  else L.push('# Uses SSH key auth — no password needed.');
  L.push('_obscure() { rclone obscure "$1"; }');
  L.push('');

  const needsPass = !emb && ((t.type === 'sftp' && t.sftpAuth === 'password') || t.type === 'ftp');
  if (needsPass) {
    L.push('if [[ -z "${FTP_PASS:-}" ]]; then');
    L.push(`  read -rsp "Enter ${t.type.toUpperCase()} password for ${t.user} on ${t.host}: " FTP_PASS; echo`);
    L.push('fi');
    L.push('export FTP_PASS');
    L.push('');
  }
  if (!emb && t.type === 's3') {
    L.push('if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then');
    L.push('  echo "ERROR: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY before running." >&2');
    L.push('  exit 1');
    L.push('fi');
    L.push('');
  }

  L.push('# ---------- ensure rclone remote exists ----------');
  L.push(buildConfigCreate(cfg));
  L.push('');
  L.push('START_TS=$(date +%s)');
  L.push('FAILED=0');
  L.push('');

  if (o.logfile) {
    L.push('# ---------- logging ----------');
    L.push(`LOGFILE=${shq(o.logfile)}`);
    L.push('LOG_FILE="$LOGFILE"');
    L.push('mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || LOGFILE="/tmp/rclone-backup.log"; LOG_FILE="$LOGFILE"');
    L.push('exec > >(tee -a "$LOGFILE") 2>&1');
    L.push('echo "--- backup started $(date) ---"');
    L.push('');
  } else {
    L.push('LOG_FILE="/tmp/rclone-backup.log"');
    L.push('LOGFILE="$LOG_FILE"');
  }

  L.push('# ---------- rclone defaults ----------');
  const rawFlags = String(o.extraFlags || '');
  if (/[;|&$`<>]/.test(rawFlags) || /\$\(/.test(rawFlags)) {
    throw new Error('Extra flags contains invalid shell characters (; | & $ ` < >)');
  }
  const normalizedFlags = rawFlags
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  L.push(`RCLONE_OPTS=${shq(normalizedFlags || '--transfers 8 --checkers=32 --fast-list --progress --log-level=INFO --retries 5 --low-level-retries 20 --retries-sleep 10s')}`);
  L.push('');

  // ---------- discord helpers (now wired to user templates) ----------
  L.push('# ---------- discord helpers ----------');
  if (webhookEnabled) {
    L.push(`DISCORD_WEBHOOK_URL=${shq(w.url)}`);
    L.push(`DISCORD_USERNAME=${shq(w.username || 'Backup Bot')}`);
    if (w.avatarUrl) L.push(`DISCORD_AVATAR_URL=${shq(w.avatarUrl)}`);
    L.push(`DISCORD_TITLE_B64=${shq(b64(w.title))}`);
    L.push(`DISCORD_DESC_B64=${shq(b64(w.description))}`);
    L.push(`DISCORD_COLOR_OK=${okColorNum}`);
    L.push(`DISCORD_COLOR_FAIL=${failColorNum}`);
    L.push(`DISCORD_ONLY_ON_FAIL=${onlyOnFail ? '1' : '0'}`);
    L.push(`DISCORD_LOG_LINES=${logLines}`);
    L.push(`DISCORD_SENDLOG_FAIL=${w.sendLogOnFail ? '1' : '0'}`);
    L.push(`DISCORD_SENDLOG_SUCCESS=${w.sendLogOnSuccess ? '1' : '0'}`);
    L.push('esc_json() { sed -e \'s/\\\\/\\\\\\\\/g\' -e \'s/"/\\\\"/g\' -e \'s/\\t/\\\\t/g\' | awk \'{o=o (NR>1?"\\\\n":"") $0} END{printf "%s", o}\'; }');
    L.push('fill_template() {');
    L.push('  local tpl_b64="$1" status="$2" duration="$3"');
    L.push('  local s; s=$(echo "$tpl_b64" | base64 -d 2>/dev/null || echo "$tpl_b64")');
    L.push('  s=${s//\\{NAME\\}/$SCRIPT_NAME}');
    L.push('  s=${s//\\{STATUS\\}/$status}');
    L.push('  s=${s//\\{HOST\\}/$(hostname)}');
    L.push('  s=${s//\\{SOURCES\\}/$SOURCES_STR}');
    L.push('  s=${s//\\{DEST\\}/$REMOTE}');
    L.push('  s=${s//\\{DURATION\\}/$duration}');
    L.push('  s=${s//\\{DATE\\}/$(date)}');
    L.push('  printf \'%s\' "$s"');
    L.push('}');
    L.push('send_discord_notification() {');
    L.push('  local title="$1" description="$2" color="$3"');
    L.push('  local payload');
    L.push('  payload=$(printf \'{"username":"%s","embeds":[{"title":"%s","description":"%s","color":%s}]}\' \\');
    L.push('    "$DISCORD_USERNAME" \\');
    L.push('    "$(printf \'%s\' "$title" | esc_json)" \\');
    L.push('    "$(printf \'%s\' "$description" | esc_json)" \\');
    L.push('    "$color")');
    L.push('  curl -sf -X POST "$DISCORD_WEBHOOK_URL" -H "Content-Type: application/json" -d "$payload" >/dev/null || echo "[warn] discord notify failed"');
    L.push('}');
    L.push('send_discord_log() {');
    L.push('  [[ -f "$LOGFILE" ]] || return 0');
    L.push('  local attach="$LOGFILE"');
    L.push('  if [[ "$DISCORD_LOG_LINES" -gt 0 && -s "$LOGFILE" ]]; then');
    L.push('    local tmp; tmp=$(mktemp) || tmp="/tmp/rclone-dl-$$.log"');
    L.push('    tail -n "$DISCORD_LOG_LINES" "$LOGFILE" > "$tmp" 2>/dev/null && attach="$tmp"');
    L.push('  fi');
    L.push('  local payload; payload=$(printf \'{"username":"%s","content":"📎 Backup log for %s"}\' "$DISCORD_USERNAME" "$SCRIPT_NAME")');
    L.push('  curl -sf -X POST "$DISCORD_WEBHOOK_URL" -F "payload_json=$payload" -F "file=@$attach" >/dev/null || echo "[warn] discord log upload failed"');
    L.push('  [[ "$attach" != "$LOGFILE" ]] && rm -f "$attach"');
    L.push('}');
    L.push('send_final_notification() {');
    L.push('  local status="$1" duration="$2" color_var="$3"');
    L.push('  local color; if [[ "$status" == "SUCCESS" ]]; then color="$DISCORD_COLOR_OK"; else color="$DISCORD_COLOR_FAIL"; fi');
    L.push('  if [[ "$DISCORD_ONLY_ON_FAIL" == "1" && "$status" == "SUCCESS" ]]; then return 0; fi');
    L.push('  local title desc');
    L.push('  title=$(fill_template "$DISCORD_TITLE_B64" "$status" "$duration")');
    L.push('  desc=$(fill_template "$DISCORD_DESC_B64" "$status" "$duration")');
    L.push('  if [[ "$status" == "FAIL" && -f "$LOGFILE" && "$DISCORD_LOG_LINES" -gt 0 ]]; then');
    L.push('    local tail; tail=$(tail -n "$DISCORD_LOG_LINES" "$LOGFILE" 2>/dev/null | tail -c 1400)');
    L.push('    if [[ -n "$tail" ]]; then desc="$desc' + '\\n```' + '$tail' + '```' + '"; fi');
    L.push('  fi');
    L.push('  send_discord_notification "$title" "$desc" "$color"');
    L.push('}');
  } else {
    L.push('send_discord_notification() { :; }');
    L.push('send_discord_log() { :; }');
    L.push('send_final_notification() { :; }');
  }
  L.push('');

  L.push('# ---------- run backups ----------');
  L.push('SOURCES_STR=' + shq(cfg.sources.map((s) => s.path).join(', ')));
  L.push('DRYRUN_FLAG=""');
  L.push('if [[ "${DRY_RUN:-0}" == "1" ]]; then echo "[dry-run] DRY_RUN=1 set — no data will be changed"; DRYRUN_FLAG="--dry-run"; fi');

  // Use separate src/dst arrays so paths with spaces are handled correctly.
  L.push('sync_src=()');
  L.push('sync_dst=()');
  for (const s of cfg.sources) {
    const effDest = cleanDst(destForSource(s, cfg));
    L.push(`sync_src+=(${shq(s.path)})`);
    L.push(`sync_dst+=(${shq(effDest)})`);
  }
  const needsFilter = cfg.sources.some((s) => s.include || s.exclude) || Boolean(o.bandwidth && o.bandwidth.toLowerCase() !== 'off');
  if (needsFilter) {
    cfg.sources.forEach((s, i) => {
      const toks = filterExtraFor(s, o.bandwidth);
      const inner = toks.length ? toks.join(' ') : '';
      L.push(`sync_extra_${i}=(${inner})`);
    });
  }
  L.push('');

  // Start notification — respects onlyOnFail — real newline inside double quotes so esc_json correctly joins with \n
  if (webhookEnabled) {
    if (onlyOnFail) L.push('# Start notification skipped (onlyOnFail enabled)');
    else L.push(`send_discord_notification "🚀 Backup Started" "**Start Time:** $(date -u +"%a %b %d %H:%M:%S UTC %Y")
**Status:** Backup process initiated." 7506394`);
  }

  L.push('');
  L.push('for idx in "${!sync_src[@]}"; do');
  L.push('  src="${sync_src[$idx]}"');
  L.push('  dst="${sync_dst[$idx]}"');
  L.push('  sync_path="${sync_src[$idx]} ${sync_dst[$idx]}"');
  if (needsFilter) {
    L.push('  eval "set -- \\"\\${sync_extra_$idx[@]}\\""; ');
    L.push('  echo "Starting sync for: $sync_path"');
    if (webhookEnabled && !onlyOnFail) L.push(`  send_discord_notification "🔃 Sync Started" "**Path:** $sync_path
**Start Time:** $(date -u +"%a %b %d %H:%M:%S UTC %Y")
**Status:** Sync in progress." 15844367`);
    L.push(`  if rclone ${o.mode} "$src" "$dst" "$@" $RCLONE_OPTS $DRYRUN_FLAG; then`);
  } else {
    L.push('  echo "Starting sync for: $sync_path"');
    if (webhookEnabled && !onlyOnFail) L.push(`  send_discord_notification "🔃 Sync Started" "**Path:** $sync_path
**Start Time:** $(date -u +"%a %b %d %H:%M:%S UTC %Y")
**Status:** Sync in progress." 15844367`);
    L.push(`  if rclone ${o.mode} "$src" "$dst" $RCLONE_OPTS $DRYRUN_FLAG; then`);
  }
  L.push('    echo "Sync for $sync_path completed."');
  if (webhookEnabled && !onlyOnFail) L.push(`    send_discord_notification "✅ Sync Completed" "**Path:** $sync_path
**End Time:** $(date -u +"%a %b %d %H:%M:%S UTC %Y")
**Status:** Sync completed successfully." 3066993`);
  L.push('  else');
  L.push('    echo "Error: Sync failed for $src → $dst"');
  // Failure always notifies, even with onlyOnFail (that's the point)
  if (webhookEnabled) {
    L.push('    _dur=$(( $(date +%s) - START_TS ))');
    L.push('    send_final_notification "FAIL" "${_dur}s" "$DISCORD_COLOR_FAIL"');
    if (w.sendLogOnFail) L.push('    if [[ "$DISCORD_SENDLOG_FAIL" == "1" ]]; then send_discord_log; fi');
  }
  L.push('    exit 1');
  L.push('  fi');
  L.push('done');
  L.push('');

  if (Number(o.retentionDays) > 0) {
    L.push('# ---------- retention cleanup ----------');
    L.push(`echo "[retention] deleting remote files older than ${parseInt(String(o.retentionDays), 10)} days..."`);
    const retPath = (!t.remotePath || String(t.remotePath).trim() === '/' ? '/' : cleanPath(t.remotePath));
    L.push(`rclone delete --min-age ${parseInt(String(o.retentionDays), 10)}d "${t.remoteName}:${retPath}" --rmdirs || true`);
    L.push('');
  }

  L.push('DURATION=$(( $(date +%s) - START_TS ))');
  L.push('DUR_STR="${DURATION}s"');
  L.push('');

  if (webhookEnabled) {
    L.push('# ---------- final notification ----------');
    L.push(`send_discord_notification "🎉 Backup Completed" "**End Time:** $(date -u +"%a %b %d %H:%M:%S UTC %Y")
**Status:** All backup operations completed successfully.
**Logs:** See attached file." 8311585`);
    L.push('if [[ "$DISCORD_SENDLOG_SUCCESS" == "1" ]]; then send_discord_log; fi');
  }

  L.push('');
  L.push('exit 0');
  return L.join('\n') + '\n';
}
