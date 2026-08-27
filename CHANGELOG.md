# Changelog

All notable changes to rcloneweb are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-08-27

### Added
- **Asynchronous runs** — `POST /api/scripts/:id/run` now returns immediately (≈ms) and streams output via a background monitor (`api/lib/monitor.php`); the panel no longer blocks while a backup runs.
- **Multi-select include/exclude** — the folder browser now supports selecting several files/folders at once and appending them as comma-separated patterns to a source row.
- **Signal-search include/exclude** — include/exclude rewritten as rclone `--filter` rules computed relative to each source folder (with a trailing `- *` whitelist), eliminating the `Using --filter is recommended` warning and the "nothing to transfer" misses.

### Fixed
- **Panel hang on run** — runs were blocking the HTTP request (600s) because the monitor wasn't wired; now fully async.
- **S3 `SignatureDoesNotMatch`** — embedded S3 scripts passed a pre-obscured secret to `rclone config create`, double-obscuring it. S3 secrets are now passed raw; the remote is (re)created idempotently so stale/wrong-cred remotes are refreshed every run.
- **S3 browse/mkdir via saved destination** — used the stored access key correctly (`s3AccessEnc`) and verified bucket access before treating a folder as created.
- **Stale per-row destination** — switching the Destination fleet now clears per-row remote destinations so the generator re-derives them from the newly selected fleet (e.g. `Hostbrr:` → `s3nginx:`).
- **Accessibility** — strong `:focus-visible` for inputs, keyboard access + `aria-label` on browser items/buttons, removed `transition: all`, `overscroll-behavior: contain` on dialogs, touch-friendly defaults.

## [1.0.0] - 2026-08-26

### Added
- **Fleet management** — VPS fleet (SSH) + Destination fleet (SFTP/FTP/S3) with encrypted `sodium_crypto_secretbox` secrets, dropdown selectors with `Manual` fallback, browse + mkdir for both.
- **Builder** — per-folder `source → remote` mapping, include/exclude, bandwidth, retention, `--dry-run`, multi-transfers.
- **Live previews** — sticky Discord embed preview + live bash script preview regenerating on every keystroke.
- **Script Editor** — CodeMirror 5 `shell` with `material-darker`, manual-edit tracking.
- **Run & Logs** — beautiful live card (progress, steps, spinner) + compact live terminal (last 12 lines) + full log, `DRY_RUN=1`, `Stop` (process-group kill), `Clear` / `Download` per-run and bulk.
- **Discord** — per-stage `🚀 Started → 🔃 Sync → ✅/❌ → 🎉 Completed` with `send_discord_log` attachment, test buttons.
- **Schedule** — user-friendly cron builder (Every N min / hourly / daily / weekly / monthly / custom), timezone-aware, panel-run (`POST /api/schedules/trigger` every 60s) + `cron.php` system fallback, edit/toggle/delete, `Run due now`.
- **Install** — token-protected `curl -fsSL /raw/:id.sh?token=...`, `chmod 700` guidance, `cron` line generation.
- **Auth** — first-run setup, `HttpOnly` `rw_session` (30d HMAC), `sodium` for fleet secrets.
- **Theme** — Material 3, Ink/Cyan pipeline signature (Space Grotesk + Inter + JetBrains Mono), dark/light toggle, responsive 880px/520px, `color-scheme`.
- **Server** — zero-dep PHP 8.5 (`api/index.php` front-controller), `router.php` for `php -S`, `.htaccess` for Apache, Nginx guide, `data/` protection.

### Security
- `data/` denied via `.htaccess` / Nginx `deny all`.
- `rawToken` (24 hex) per script for `curl` installs.
- Fleet list never leaks secrets (`hasPassword` only).

### Fixed
- `/: Is a directory` — escaped Markdown backticks in Discord messages (`\`$sync_path\``).
- `630 Login incorrect` handling for FTP/SFTP with empty `FTP_PASS`.

[1.0.1]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.1
[1.0.0]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.0

