# Changelog

All notable changes to rcloneweb are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.7] - 2026-08-27

### Added
- **Full SSL Nginx config** — new `nginx/rcloneweb.ssl.conf` with a complete `listen 443 ssl http2` server block + `80 → 443` redirect (certbot cert paths), correct location ordering (PHP before API), `fastcgi_param HTTPS on`, and HSTS/`X-Frame-Options` headers. Ready to paste for raw-nginx deployments.
- **Reset-admin docs** — README Troubleshooting now documents the data-preserving password reset: `rm data/auth.json` (keeping `data/.secret`) preserves all scripts, fleet, destinations, schedules, and run logs while letting you recreate the admin.

### Fixed
- **SSL "Option A" 443 example ordering** — `README.md` manual 443 block had the `^/(api|raw|i)` location before `\.php$`, so the `/api/index.php` fallback was served as static PHP source. Reordered so PHP executes first (matches the 1.0.6 HTTP fix).

## [1.0.6] - 2026-08-27

### Fixed
- **Nginx served `api/index.php` as raw PHP source (auth API broken)** — in the Nginx guide the `location ~ ^/(api|raw|i)` block was defined *before* `location ~ \.php$`. Its `try_files ... /api/index.php` fallback re-matched the same api regex, so nginx returned `api/index.php` as a static file (`content-type: application/octet-stream`, body starting with `<?php`) instead of executing it via php-fpm. `GET /api/auth/status` therefore returned PHP source, not JSON, so the SPA could never authenticate. The `\.php$` block is now defined **before** the API block so the fallback executes. Same reorder applied to `nginx/rcloneweb.conf` (new standalone config for easy paste into a Nginx UI).

## [1.0.5] - 2026-08-27

### Fixed
- **Critical auth bypass in SPA boot (fail-open)** — `boot()` in `public/js/app.js` caught *any* error from `GET /api/auth/status` with an empty `catch {}` and then unconditionally called `showApp()`, revealing the full app (with the static `admin` label) without a valid session. When `/api/*` was misrouted by Nginx (e.g. served as the SPA HTML shell instead of JSON, or a network/JSON error), `r.json()` threw and the app appeared "logged in as admin", and logout + refresh kept re-showing the app. `boot()` now **fails closed**: on any non-OK response or parse error it shows the login view and surfaces an actionable message (`Check server logs / nginx routing for /api/`), never the app.

### Security
- Authentication state can no longer be bypassed by an unreachable or misconfigured API. Access is granted only when `/api/auth/status` returns `authenticated:true`.

## [1.0.4] - 2026-08-27

### Fixed
- **Auth bypass: fresh setup auto-login & logout not clearing session** — `Auth::validSession()` only checked HMAC/expiry, so a stale `rw_session` cookie (e.g. after `rm data/auth.json` while keeping `data/.secret`) stayed valid and `GET /api/auth/status` returned `authenticated:true` even though no admin existed, and `POST /api/auth/logout` cleared the cookie without `Secure`/`SameSite` so a Secure cookie persisted. Now `validSession()` returns `false` when `data/auth.json` is missing and verifies the cookie's username matches the stored admin, and logout clears with `SameSite=Lax; Secure` when the request is HTTPS (`X-Forwarded-Proto: https`).

## [1.0.3] - 2026-08-27

### Added
- **SSL / HTTPS support — Nginx + app** — the panel now auto-detects HTTPS via `HTTPS` / `X-Forwarded-Proto: https` / `SERVER_PORT 443` and sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` + `X-Frame-Options: SAMEORIGIN` + `Referrer-Policy`. `rw_session` cookies get `Secure` when the request is HTTPS (required behind an SSL-terminating Nginx). `router.php` and `index.php` also send HSTS so the SPA shell is covered.

### Changed
- **README — Nginx SSL** — added HTTP→HTTPS redirect, full 443 examples for both **Option A (php-fpm)** and **Option B (reverse proxy to `php -S`)** with `ssl_certificate`, `options-ssl-nginx.conf`, `ssl_dhparam`, and `X-Forwarded-Proto` so the app sets `Secure` cookies. Added `certbot --nginx` one-liner and a note to test with `curl -I https://panel.example.com/api/auth/status`.

### Fixed
- **Dev-server data leak** — `router.php` / `index.php` now return 404 for `/data/`, `/.git/`, `/.env` even on `php -S` (mirrors the Nginx `deny all`), so `data/auth.json` can't be fetched directly in dev.

## [1.0.2] - 2026-08-27

### Fixed
- **Live speed / ETA freeze** — scripts using `--progress` never streamed updates over SSH/pipes (TTY-only). `--progress` is now auto-normalized to periodic `--stats 5s --stats-one-line` at generation time, and the live parser takes the latest stats line (both `Transferred:` and `INFO :` formats), so speed/ETA/percent update continuously.
- **Live log not auto-switching** — when a run was in progress but the user had previously selected an old finished run, the terminal kept showing the old log. The running run now auto-switches into view.
- **Include/exclude browse error** — the include/exclude folder picker derived its start folder by splitting the whole comma-separated value, producing a broken path. It now always opens at the source VPS root `/`.
- **S3 "New Folder" did nothing** — `rclone mkdir` creates no empty dir on S3/MinIO. `New Folder` on an S3 destination now uploads a zero-byte `.keep` marker object so the folder actually appears in the browser.
- **Nginx CSS 404 behind reverse proxy / php-fpm** — the old guide's `try_files $uri @fallback` and overlapping `~* \.(css|js)$` regex caused `/css/style.css` to 404 (file lives in `public/css/`). Replaced with `^~ /css/` + `^~ /js/` alias and added a dedicated reverse-proxy example (`proxy_pass http://127.0.0.1:8765`).

### Changed
- **Include/exclude dialog UX** — click toggles selection (no accidental folder navigation), a chips bar lists all selected paths with per-chip remove, and existing values are pre-seeded as chips.
- **README — Nginx** — split into **Option A (php-fpm direct)** and **Option B (reverse proxy to `php -S`)** with correct `alias`, `try_files`, and `proxy_set_header` blocks; added `client_max_body_size` and `fastcgi_read_timeout`.
- **First-run auth verified** — re-tested `POST /api/auth/status` → `setupNeeded:true`, `POST /api/auth/setup` → 200, duplicate setup → 409, and `Auth::secret()` now ensures `data/` exists before writing `.secret` so a fresh `git clone` without `data/` doesn't break.

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

## [1.0.8] - 2026-08-27

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

[1.0.7]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.7
[1.0.6]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.6
[1.0.5]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.5
[1.0.4]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.4
[1.0.3]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.3
[1.0.2]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.2
[1.0.1]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.1
[1.0.0]: https://github.com/shaikhnedab/rcloneweb/releases/tag/v1.0.0



