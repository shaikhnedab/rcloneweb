/* rcloneweb — bash script generator + discord payload builder (client-side) */
'use strict';

const Generator = (() => {

  const shq = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

  function jsonEscape(s) {
    return String(s ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '')
      .replace(/\t/g, '\\t');
  }

  // ---------- config ----------
  function defaultConfig() {
    return {
      name: 'untitled',
      script: '',
      manualEdited: false,
      sources: [{ path: '/', dest: '/', include: '', exclude: '' }],
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
        extraFlags: '--transfers 16 --checkers 32 --fast-list --stats-one-line --stats 2s --log-level INFO --retries 5 --low-level-retries 10',
      },
      webhook: {
        enabled: true, onlyOnFail: false, url: '', username: 'Backup Bot', avatarUrl: '',
        title: 'Backup {STATUS}: {NAME}',
        description: 'Host: {HOST}\nSources: {SOURCES}\nDestination: {DEST}\nDuration: {DURATION}',
        colorOk: '#57f287', colorFail: '#ed4245', logLines: 10,
      },
    };
  }

  function normalize(cfg) {
    const d = defaultConfig();
    const out = { ...d, ...cfg };
    out.dest = { ...d.dest, ...(cfg.dest || {}) };
    out.secrets = { ...d.secrets, ...(cfg.secrets || {}) };
    out.options = { ...d.options, ...(cfg.options || {}) };
    out.webhook = { ...d.webhook, ...(cfg.webhook || {}) };
    if (!Array.isArray(out.sources) || !out.sources.length) out.sources = d.sources;
    // backfill per-row dest for legacy saves
    out.sources = out.sources.map((s) => ({ dest: '', include: '', exclude: '', ...s }));
    return out;
  }

  // ---------- helpers ----------
  const hexToDecimal = (hex) => {
    const n = parseInt(String(hex || '').replace('#', ''), 16);
    return Number.isFinite(n) ? n : 0x57f287;
  };

  const destString = (cfg) => {
    const t = cfg.dest;
    let remote = `${t.remoteName}:`;
    if (t.type === 's3') remote += t.s3Bucket ? `${t.s3Bucket}/` : '';
    const p = String(t.remotePath||'').trim();
    if (!p || p === '/') return remote + '/';
    return remote + p.replace(/^\/+/, '');
  };

  const srcBase = (p) => String(p).split('/').filter(Boolean).pop() || '.';
  const cleanPath = (p) => String(p).replace(/^\/+|\/+$/g, '');

  // Convert an explicit include/exclude entry into one or more rclone --filter
  // rules relative to the source directory, so patterns match regardless of the
  // source prefix and avoid rclone's implicit default-include mismatch.
  // Convention: absolute paths are made relative to the row's source path;
  // already-relative globs (no leading /) are kept as-is.
  const toFilterRules = (entry, srcPath, sign) => {
    const src = cleanPath(srcPath); // '/home/mysqldump' -> 'home/mysqldump'
    let rel = cleanPath(String(entry).trim());
    // If entry is absolute and under the source dir, strip the source prefix.
    if (entry.startsWith('/') && src) {
      if (rel === src) return [`${sign} *`]; // whole dir
      if (rel.startsWith(src + '/')) rel = rel.slice(src.length + 1);
      else rel = cleanPath(entry); // outside source: keep as provided-relative (best effort)
    }
    if (!rel) return [];
    // Treat an entry with no file-extension as a directory: match it and
    // everything beneath via `/**` (2-star recursion; rclone rejects 3-star).
    // A bare filename keeps a single rule.
    const hasExtension = /\.[A-Za-z0-9]{1,16}$/.test(rel);
    const rules = [`${sign} ${rel}`];
    if (!hasExtension) rules.push(`${sign} ${rel}/**`);
    return rules;
  };
  // Build the rclone filter + bwlimit token LIST for a given source row.
  // Returns an array of already-shell-quoted words (e.g. `--filter '+ x'`) that
  // the script stores as a bash array so word-splitting keeps each arg intact.
  const filterExtraFor = (s, bwRaw) => {
    const rules = [];
    const appendRel = (entry, sign) =>
      toFilterRules(entry, s.path, sign).forEach((r) => {
        if (!rules.includes(r)) rules.push(r);
      });
    if (s.include) s.include.split(/[,\s]+/).filter(Boolean).forEach((p) => appendRel(p, '+'));
    if (s.exclude) s.exclude.split(/[,\s]+/).filter(Boolean).forEach((p) => appendRel(p, '-'));
    // when whitelisting, default everything else to excluded
    if (s.include) rules.push('- *');
    const tokens = [];
    for (const r of rules) tokens.push('--filter ' + shq(r));
    if (bwRaw && bwRaw.toLowerCase() !== 'off') tokens.push('--bwlimit ' + shq(bwRaw));
    return tokens;
  };
  const destForSource = (s, cfg) => {
    const raw = String(s.dest || '').trim();
    if (raw) {
      if (raw.includes(':')) return raw;
      const cp = cleanPath(raw);
      return cp ? `${cfg.dest.remoteName}:${cp}` : `${cfg.dest.remoteName}:/`;
    }
    const t = cfg.dest;
    const base = cleanPath(t.remotePath);
    if (!base) return `${t.remoteName}:/${srcBase(s.path)}`;
    return `${t.remoteName}:${base}/${srcBase(s.path)}`;
  };

  // static vars baked into the script; dynamic ones become @VAR@ sed tokens
  function staticVars(cfg) {
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

  const fillTemplate = (tpl, vars) => {
    let s = String(tpl ?? '');
    for (const [k, v] of Object.entries(vars)) s = s.split(k).join(v);
    return s;
  };

  // ---------- discord payload (for live preview + test button) ----------
  function buildPayload(cfg, status, opts = {}) {
    const w = normalize(cfg).webhook;
    const ok = status === 'SUCCESS';
    const vars = { ...staticVars(normalize(cfg)) };
    vars['{STATUS}'] = status;
    vars['{HOST}'] = opts.host || 'myserver';
    vars['{DURATION}'] = opts.duration ?? '42s';
    vars['{DATE}'] = new Date().toLocaleString();
    const embed = {
      title: fillTemplate(w.title, vars),
      description: fillTemplate(w.description, vars),
      color: hexToDecimal(ok ? w.colorOk : w.colorFail),
      footer: { text: `rclone · ${cfg.name}` },
      timestamp: new Date().toISOString(),
    };
    if (!ok && opts.logTail) embed.description += '\n```' + String(opts.logTail).slice(-1400) + '```';
    const payload = { username: w.username || 'Backup Bot', embeds: [embed] };
    if (w.avatarUrl) payload.avatar_url = w.avatarUrl;
    return payload;
  }

  // ---------- bash generation ----------
  function buildConfigCreate(cfg) {
    const t = cfg.dest;
    const emb = cfg.secrets.embed;
    // (re)create is idempotent and overwrites any stale/wrong-cred remote, so a
    // previously-defined remote (e.g. from an earlier bad run) always gets the
    // credentials baked in this script instead of silently being reused.
    const setupHeader = (label) =>
      `echo "[setup] configuring rclone remote '${t.remoteName}' (${label})..." `;
    const L = [];

    if (t.type === 'sftp') {
      L.push(setupHeader('sftp'));
      L.push(`rclone config create ${shq(t.remoteName)} sftp \\`);
      L.push(`  host ${shq(t.host)} user ${shq(t.user)} \\`);
      if (t.port) L.push(`  port ${shq(t.port)} \\`);
      if (t.sftpAuth === 'key') {
        L.push(`  key_file ${shq(t.keyPath)}`);
      } else if (emb) {
        L.push(`  pass "$(_obscure ${shq(cfg.secrets.password)})"`);
      } else {
        L.push(`  pass "$(_obscure "$FTP_PASS")"`);
      }
    } else if (t.type === 'ftp') {
      L.push(setupHeader('ftp'));
      L.push(`rclone config create ${shq(t.remoteName)} ftp \\`);
      L.push(`  host ${shq(t.host)} user ${shq(t.user)} \\`);
      if (t.port) L.push(`  port ${shq(t.port)} \\`);
      if (emb) L.push(`  pass "$(_obscure ${shq(cfg.secrets.password)})"`);
      else L.push(`  pass "$(_obscure "$FTP_PASS")"`);
    } else { // s3
      L.push(setupHeader('s3'));
      L.push(`rclone config create ${shq(t.remoteName)} s3 \\`);
      L.push(`  provider ${shq(t.s3Provider)} region ${shq(t.s3Region)} \\`);
      if (t.s3Endpoint) L.push(`  endpoint ${shq(t.s3Endpoint)} \\`);
      if (emb) {
        // Pass the RAW secret: rclone config create obscures secret fields
        // internally. Pre-obscuring here would double-obscure and cause
        // SignatureDoesNotMatch on S3.
        L.push(`  access_key_id ${shq(cfg.secrets.s3AccessKey)} secret_access_key ${shq(cfg.secrets.s3SecretKey)} \\`);
      } else {
        L.push('  access_key_id "$AWS_ACCESS_KEY_ID" secret_access_key "$AWS_SECRET_ACCESS_KEY" \\');
      }
      L.push('  no_check_bucket true');
    }
    return L.join('\n');
  }

  function buildScript(rawCfg) {
    const cfg = normalize(rawCfg);
    const t = cfg.dest;
    const o = cfg.options;
    const w = cfg.webhook;
    const emb = cfg.secrets.embed;
    const L = [];

    L.push('#!/usr/bin/env bash');
    L.push('# =============================================================');
    L.push(`# ${cfg.name} — generated by rcloneweb on ${new Date().toISOString()}`);
    L.push(`# destination : ${destString(cfg)} (${t.type})`);
    L.push(`# sources     : ${cfg.sources.map((s) => `${s.path} → ${s.dest || destForSource(s,cfg)}`).join(', ')}`);
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
    L.push('# ---------- credentials ----------');
    if (emb) {
      L.push('# WARNING: credentials are embedded below. Keep this file root-owned: chmod 700.');
    } else if ((t.type === 'sftp' && t.sftpAuth === 'password') || t.type === 'ftp') {
      L.push('# Password comes from $FTP_PASS (env var) or an interactive prompt.');
    } else if (t.type === 's3') {
      L.push('# Keys come from $AWS_ACCESS_KEY_ID / $AWS_SECRET_ACCESS_KEY env vars.');
    } else {
      L.push('# Uses SSH key auth — no password needed.');
    }
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
    // `--progress` draws a TTY progress bar that never updates when piped (panel
    // runs scripts via ssh/pipes). Normalise it to periodic `--stats` log lines
    // so the live panel keeps streaming speed/ETA.
    const normalizedFlags = String(o.extraFlags || '')
      .split(/\s+/)
      .map(t => t === '--progress' ? '--stats 5s --stats-one-line' : t)
      .join(' ');
    L.push(`RCLONE_OPTS=${shq(normalizedFlags || '--transfers 16 --checkers 32 --fast-list --stats-one-line --stats 2s --log-level INFO --retries 5 --low-level-retries 10')}`);
    L.push('');

    L.push('# ---------- discord helpers ----------');
    if (w.enabled && w.url) {
      L.push(`DISCORD_WEBHOOK_URL=${shq(w.url)}`);
      L.push(`DISCORD_USERNAME=${shq(w.username || 'Backup Bot')}`);
      if (w.avatarUrl) L.push(`DISCORD_AVATAR_URL=${shq(w.avatarUrl)}`);
      L.push('esc_json() { sed -e \'s/\\\\/\\\\\\\\/g\' -e \'s/"/\\\\"/g\' -e \'s/\\t/\\\\t/g\' | awk \'{o=o (NR>1?"\\\\n":"") $0} END{printf "%s", o}\'; }');
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
      L.push('  local payload');
      L.push('  payload=$(printf \'{"username":"%s","content":"📎 Backup log for %s"}\' "$DISCORD_USERNAME" "$SCRIPT_NAME")');
      L.push('  curl -sf -X POST "$DISCORD_WEBHOOK_URL" -F "payload_json=$payload" -F "file=@$LOGFILE" >/dev/null || echo "[warn] discord log upload failed"');
      L.push('}');
    } else {
      L.push('send_discord_notification() { :; }');
      L.push('send_discord_log() { :; }');
    }
    L.push('');

    L.push('# ---------- run backups ----------');
    L.push('DRYRUN_FLAG=""');
    L.push('if [[ "${DRY_RUN:-0}" == "1" ]]; then echo "[dry-run] DRY_RUN=1 set — no data will be changed"; DRYRUN_FLAG="--dry-run"; fi');
    // build sync_paths array with per-row remote mapping
    L.push('sync_paths=(');
    for (const s of cfg.sources) {
      const effDest = destForSource(s, cfg);
      // build per-source extra flags for include/exclude/bandwidth/mode handling
      const escPath = String(s.path).replace(/"/g, '\\"');
      const escDest = String(effDest).replace(/"/g, '\\"');
      // We store as "source dest" string; extra per-source flags are baked into RCLONE_OPTS per iteration via arrays
      L.push(`  "${escPath} ${escDest}"`);
    }
    L.push(')');
    // per-source include/exclude/bandwidth: one quoted token array per source row
    // (sync_extra_0, sync_extra_1, ...) so each `--filter '+ x'` arg stays intact
    // when expanded with "${sync_extra_N[@]}".
    if (cfg.sources.some(s=> s.include || s.exclude) || (o.bandwidth && o.bandwidth.toLowerCase() !== 'off')) {
      cfg.sources.forEach((s, i) => {
        const toks = filterExtraFor(s, o.bandwidth);
        const inner = toks.length ? toks.join(' ') : '""';
        L.push(`sync_extra_${i}=(${inner})`);
      });
    }
    L.push('');
    L.push('# Send start notification');
    L.push('send_discord_notification "🚀 Backup Started" "**Start Time:** $(date)\n**Status:** Backup process initiated." 7506394');
    L.push('');
    L.push('# Run each command one after the other but with multi-threading enabled for each');
    L.push('for idx in "${!sync_paths[@]}"; do');
    L.push('    sync_path="${sync_paths[$idx]}"');
    // handle per-source extra if exists, otherwise just use RCLONE_OPTS
    if (cfg.sources.some(s=> s.include || s.exclude) || (o.bandwidth && o.bandwidth.toLowerCase() !== 'off')) {
      L.push('    eval "set -- \\"\\${sync_extra_$idx[@]}\\""; ');
      L.push(`    echo "Starting sync for: $sync_path"`);
    L.push('    send_discord_notification "🔃 Sync Started" "**Path:** \\`$sync_path\\`\n**Start Time:** $(date)\n**Status:** Sync in progress." 15844367');
    L.push('    # rclone mode from config: ' + (o.mode === 'copy' ? 'copy' : 'sync'));
    L.push(`    if rclone ${o.mode} $sync_path "$@" $RCLONE_OPTS $DRYRUN_FLAG; then`);
    } else {
      L.push(`    echo "Starting sync for: $sync_path"`);
      L.push('    send_discord_notification "🔃 Sync Started" "**Path:** \\`$sync_path\\`\n**Start Time:** $(date)\n**Status:** Sync in progress." 15844367');
      L.push(`    if rclone ${o.mode} $sync_path $RCLONE_OPTS $DRYRUN_FLAG; then`);
    }
    L.push('        echo "Sync for $sync_path completed."');
    L.push('        send_discord_notification "✅ Sync Completed" "**Path:** \\`$sync_path\\`\n**End Time:** $(date)\n**Status:** Sync completed successfully." 3066993');
    L.push('    else');
    L.push('        echo "Error: Sync failed for $sync_path"');
    L.push('        send_discord_notification "❌ Sync Failed" "**Path:** \\`$sync_path\\`\n**Time:** $(date)\n**Status:** Sync failed. Check logs for details." 15158332');
    L.push('        send_discord_log  # Send log immediately if any failure occurs');
    L.push('        exit 1');
    L.push('    fi');
    L.push('done');
    L.push('');

    if (Number(o.retentionDays) > 0) {
      L.push('# ---------- retention cleanup ----------');
      L.push(`echo "[retention] deleting remote files older than ${parseInt(o.retentionDays, 10)} days..."`);
      const retPath = (!t.remotePath || String(t.remotePath).trim() === '/' ? '/' : cleanPath(t.remotePath));
      L.push(`rclone delete --min-age ${parseInt(o.retentionDays, 10)}d "${t.remoteName}:${retPath}" --rmdirs || true`);
      L.push('');
    }

    L.push('DURATION=$(( $(date +%s) - START_TS ))');
    L.push('');
    L.push('# Send completion notification');
    L.push('send_discord_notification "🎉 Backup Completed" "**End Time:** $(date)\n**Status:** All backup operations completed successfully.\n**Logs:** See attached file." 8311585');
    L.push('');
    L.push('# Send the log file as an attachment');
    L.push('send_discord_log');
    L.push('');
    L.push('exit 0');

    return L.join('\n') + '\n';
  }

  return { buildScript, buildPayload, normalize, defaultConfig, destString };
})();
