# Changelog

All notable changes to rcloneweb are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-08-26

### Changed
- Patch release via auto-release workflow.

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

[1.0.0]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.0

