# 📦 rcloneweb — Beautiful rclone backup panel

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.13-00E5CC?style=for-the-badge&logo=github" />
  <img src="https://img.shields.io/badge/PHP-8.5-777BB4?style=for-the-badge&logo=php&logoColor=white" />
  <img src="https://img.shields.io/badge/rclone-v1.75-3A9BDC?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Nginx-Apache-269539?style=for-the-badge&logo=nginx" />
  <img src="https://img.shields.io/badge/license-MIT-6b8afd?style=for-the-badge" />
</p>

<p align="center"><b>Build, store, and run rclone backup scripts from a modern Material UI — with fleet management, live logs, and one-click Discord alerts.</b></p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-nginx-guide">Nginx</a> •
  <a href="#-apache-guide">Apache</a> •
  <a href="#-cron--scheduler">Cron</a>
</p>

---

### ✨ Features

| Area | What you get |
|---|---|
| **🛠 Builder** | Per-folder `source → remote` mapping (e.g. `/home/dockge → hostbrr:backups/hostdzire/home/dockge`), include/exclude, bandwidth, retention, `--dry-run` |
| **☁️ Fleet** | **VPS Fleet** (SSH) + **Destination Fleet** (SFTP/FTP/S3) — save once, pick from dropdown with `Manual` fallback |
| **📂 Browse** | Click `📂/☁️` to browse VPS + remote storage, create folders inline (`📁 New Folder`) |
| **🔔 Discord** | Per-stage notifications (`🚀 Started → 🔃 Sync → ✅/❌ → 🎉 Completed`) + log file attachment via `send_discord_log` |
| **▶ Run & Logs** | Beautiful live card (progress, steps, spinner) + compact live terminal (last 12 lines) + full log, `DRY_RUN=1`, `Stop`, `Clear`, `Download` — **runs asynchronously** so the panel never hangs |
| **⏰ Schedule** | In-panel cron builder (Every N min / hourly / daily / weekly / monthly / custom), timezone-aware (`Asia/Kolkata` etc.), panel runs it + `cron.php` fallback, edit/toggle/delete |
| **🔐 Auth** | First-run setup, `HttpOnly` `rw_session` (30d HMAC), `sodium` encrypted fleet secrets |
| **🎨 Theme** | Material 3 — dark / light toggle, fully responsive (880px/520px), Inter + JetBrains Mono |

---

### 🚀 Quick Start (VPS — any deps allowed)

```bash
# 1. Clone
git clone https://github.com/your/rcloneweb /var/www/rcloneweb
cd /var/www/rcloneweb

# 2. PHP 8.1+ + extensions
sudo apt update && sudo apt install -y php8.5 php8.5-fpm php8.5-curl php-ssh php-cli unzip curl

# 3. Permissions
sudo chown -R www-data:www-data data/
sudo chmod 750 data/ data/scripts data/runs data/fleet data/destinations data/schedules
# (data/.secret & data/auth.json will be created on first run)

# 4. rclone + sshpass (for fleet tests / remote runs)
curl https://rclone.org/install.sh | sudo bash
sudo apt install -y sshpass
rclone version  # → v1.75+

# 5. Run — built-in PHP (dev)
php -S 127.0.0.1:8765 -t /var/www/rcloneweb /var/www/rcloneweb/router.php &
# → http://YOUR_VPS_IP:8765
# Login: admin / hunter2hunter (first run will ask to create it, then delete data/auth.json to reset)

# 6. Default folders are `/` — add VPS in Fleet, Destination in Destinations, pick them in Builder, Save, Run.

# RCLONE defaults (compact, single-line stats)
# --transfers 16 --checkers 32 --fast-list --stats-one-line --stats 2s --log-level INFO --retries 5 --low-level-retries 10
```

> **Live log is compact** (speed / transferred / ETA on a single updating line) — **full log stays full** for `View`/`Download`. If a run looks hanged (no output 90s) you get a toast and can `Stop`. `--progress` in "Extra flags" is auto-normalized to periodic `--stats 5s --stats-one-line` when a script is generated, so the panel streams live speed/ETA over SSH/pipes (a TTY progress bar can't update when piped).

---

### 🌐 Nginx Guide (deploy at `/`)

**Option A — php-fpm direct (recommended for production)**

```nginx
# /etc/nginx/sites-available/rcloneweb
server {
    listen 80;
    server_name panel.example.com;
    root /var/www/rcloneweb;
    index index.php;

    # Security: block sensitive paths
    location ~ ^/(data|\.git|\.env) { deny all; return 404; }
    location ~ /\. { deny all; access_log off; log_not_found off; }

    # Static assets: /css/* -> public/css/*, /js/* -> public/js/*
    # Use ^~ so these prefix locations take precedence over regex
    location ^~ /css/ { alias /var/www/rcloneweb/public/css/; expires 7d; access_log off; add_header Cache-Control "public"; }
    location ^~ /js/  { alias /var/www/rcloneweb/public/js/;  expires 7d; access_log off; add_header Cache-Control "public"; }

    # PHP MUST be defined BEFORE the /api location below. The API block's
    # try_files fallback points at /api/index.php; if the api regex matched first,
    # nginx would serve that .php as STATIC source instead of executing it (you'd
    # see raw `<?php` for /api/auth/status). Order fixes it.
    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.5-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param SCRIPT_NAME $fastcgi_script_name;
        fastcgi_read_timeout 600;
        fastcgi_buffers 8 16k;
        fastcgi_buffer_size 32k;
        client_max_body_size 10M;
    }

    # Front-controller for SPA + API/raw
    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    # API/raw routing — defined AFTER \.php$ so the /api/index.php fallback executes.
    location ~ ^/(api|raw|i)(/|$) {
        try_files $uri /api/index.php?$args;
    }

    location ~ ^/data/.*\.php$ { deny all; return 404; }
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
# optional TLS
sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d panel.example.com
```

**Why CSS was 404 before:** the old guide had `location ~* \.(css|js)$ { try_files $uri @fallback; }` — that block matched `/css/style.css` first (regex order) and tried `$uri` at `/var/www/rcloneweb/css/style.css` which doesn't exist (real file is in `public/css/`), then fell to undefined `@fallback`. It also conflicted with the separate `alias` location. The `^~ /css/` + `^~ /js/` fix above makes Nginx map directly to `public/`.

**Option B — Nginx reverse proxy to `php -S` (simple, no php-fpm needed)**

If you run `php -S 127.0.0.1:8765 -t /var/www/rcloneweb /var/www/rcloneweb/router.php`:

```nginx
server {
    listen 80;
    server_name panel.example.com;

    # still block direct access to sensitive paths
    location ~ ^/(data|\.git|\.env) { deny all; return 404; }

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_max_body_size 10M;
    }
}
```

> **Do not mix** `root` + `try_files` with `proxy_pass` in the same `location /`. Pick **one** of the two options. If `css/style.css` still 404 behind a proxy, check `nginx -T` that you don't have both.

#### 🔒 SSL / HTTPS — Nginx + app (auto Secure cookies + HSTS)

The app auto-detects HTTPS via `HTTPS` or `X-Forwarded-Proto: https` (set by Nginx below) and then:
- adds `Secure` to `rw_session` cookies,
- sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` + `X-Frame-Options: SAMEORIGIN`.

**With `certbot` (easiest, either option):**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d panel.example.com   # auto-creates 443 + redirect, test with --dry-run first
sudo certbot renew --dry-run
```

**Manual 443 example — Option A (php-fpm):**
```nginx
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    root /var/www/rcloneweb;
    index index.php;

    ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    location ~ ^/(data|\.git|\.env) { deny all; return 404; }
    location ~ /\. { deny all; access_log off; log_not_found off; }
    location ^~ /css/ { alias /var/www/rcloneweb/public/css/; expires 7d; access_log off; }
    location ^~ /js/  { alias /var/www/rcloneweb/public/js/;  expires 7d; access_log off; }

    # PHP MUST come before the /api block (same reason as the HTTP guide): the
    # API try_files fallback points at /api/index.php; if the api regex matched
    # first, nginx would serve that .php as static source instead of executing it.
    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.5-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param HTTPS on;   # ensures app issues Secure cookies + HSTS
        fastcgi_read_timeout 600;
        client_max_body_size 10M;
    }

    location / { try_files $uri $uri/ /index.php?$args; }
    location ~ ^/(api|raw|i)(/|$) { try_files $uri /api/index.php?$args; }
}
```

**Manual 443 — Option B (reverse proxy to `php -S`):**
```nginx
server { listen 80; server_name panel.example.com; return 301 https://$host$request_uri; }
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    location ~ ^/(data|\.git|\.env) { deny all; return 404; }
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;  # lets app set Secure cookies + HSTS
        proxy_http_version 1.1;
        proxy_read_timeout 600s;
        client_max_body_size 10M;
    }
}
```

> No extra app config needed — just ensure Nginx sends `X-Forwarded-Proto` (above). Test: `curl -I https://panel.example.com/api/auth/status` should show `strict-transport-security` and `set-cookie: ...; Secure`.

**`.htaccess` is already included** for Apache — just set `DocumentRoot /var/www/rcloneweb` and `AllowOverride All`. For Apache SSL use `a2enmod ssl` + certbot `--apache`.

---

### 🟦 Apache Guide

```apache
# /etc/apache2/sites-available/rcloneweb.conf
<VirtualHost *:80>
    ServerName panel.example.com
    DocumentRoot /var/www/rcloneweb
    <Directory /var/www/rcloneweb>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```
```bash
sudo a2enmod rewrite headers proxy_fcgi setenvif
sudo a2ensite rcloneweb && sudo systemctl reload apache2
# PHP-FPM
# <FilesMatch \.php$> SetHandler "proxy:unix:/run/php/php8.5-fpm.sock|fcgi://localhost" </FilesMatch>
```

`.htaccess` at root already handles:
```
RewriteRule ^(api|raw|i)/ api/index.php [L,QSA]
RewriteRule ^(css|js)/ public/$1/$2 [L]
RewriteRule ^ index.php [L]
```

---

### ⏰ Cron / Scheduler

The panel has **two** schedulers (either is enough):

**A) Panel-run (no system cron needed)** — while the panel is open it polls every 60s and auto-triggers due jobs via `POST /api/schedules/trigger`. Good for testing.

**B) System cron (24/7, recommended):**
```bash
# run every minute, log to /var/log/rcloneweb-cron.log
* * * * * php /var/www/rcloneweb/cron.php >> /var/log/rcloneweb-cron.log 2>&1
sudo touch /var/log/rcloneweb-cron.log && sudo chmod 666 /var/log/rcloneweb-cron.log
sudo crontab -e  # paste above
sudo crontab -l  # verify
```
Schedules are timezone-aware (`Asia/Kolkata`, `UTC`, etc.) — the builder saves `Intl.DateTimeFormat().resolvedOptions().timeZone` with each `cronExpr`.

Create / edit in **⏰ Schedule** tab: pick **VPS + cron preset → + Add Schedule**, toggle enable, **✎ Edit** / **🗑 Delete**, **▶ Run due now** for immediate test. Friendly text like `Daily at 12:06` is shown alongside `6 12 * * *`.

---

### 📂 Browse & Create

- **VPS file browser:** `📂` on any source row → lists via `ssh ls -1 -p` (supports `sshpass` or key), `Go` / `⬆ Up` / `📁 New Folder` (calls `POST /api/fleet/:id/mkdir`).
- **Remote browser:** `☁️` on destination → ephemeral `rclone lsjson remote:path` (or fleet's stored creds via `POST /api/destinations/:id/browse`), same `New Folder` for sftp/ftp via `rclone mkdir`. On **S3**, folders are virtual, so `New Folder` uploads a zero-byte `.keep` marker object to make the prefix visible.
- **Multi-select include/exclude:** `📂` on an include/exclude field opens a folder picker where you can click several files/folders to toggle selection (chips appear below), then `Add selected (+N)` appends them as comma-separated patterns. Double-click a folder (or `⬆ Up`) to navigate.

If `rclone` is missing on a source VPS, the **Test** button will warn: `SSH OK, but rclone not found — install on source`.

---

### 🔒 Security Notes

- `data/` is denied via `.htaccess` / nginx `deny all` (contains `auth.json`, `.secret`, fleet secrets encrypted with `sodium_crypto_secretbox`).
- `rawToken` per script (`?token=...`) protects `curl` installs — token is 24 hex chars, never logged.
- Fleet passwords never leave the server in list responses (`hasPassword` only); full decrypt only for testing/browsing/running.

---

### 🛠 Troubleshooting

| Symptom | Fix |
|---|---|
| `rclone not found on panel server` | `curl https://rclone.org/install.sh | sudo bash` |
| `Permission denied (publickey,password)` for VPS | In `Fleet → Add VPS` re-enter password (blank keeps old), or switch to **SSH key** (`~/.ssh/id_ed25519`), and on the VPS set `PasswordAuthentication yes` + `PermitRootLogin yes` → `systemctl restart sshd` |
| `/: Is a directory` in logs | Was unescaped Markdown backticks — fixed in current `generator.js` (now `\`$sync_path\``). Click **↻ Regenerate** on old scripts and Save. |
| `530 Login incorrect` (FTP) | Re-test destination with `🔍 Test`, ensure `FTP_PASS` or embedded password matches `rclone@storage...` |
| Duplicate runs | Panel now blocks concurrent `POST /api/scripts/:id/run` with `409` and disables **▶ Run** while `running` |
| `css/style.css` 404 / no styles behind Nginx | Old guide used `try_files $uri @fallback` with undefined fallback and `location ~* \.(css\|js)$` that shadowed the `alias`. Use the fixed `^~ /css/` + `^~ /js/` alias in **Option A**, or if you proxy (`proxy_pass http://127.0.0.1:8765`) do **not** also set `root` + `try_files` in the same `location /` — pick one option. Check `nginx -T` for duplicate `location /`. |
| Can't log in / first-run account not created | On first run `data/auth.json` doesn't exist → `GET /api/auth/status` returns `setupNeeded:true`. The panel shows **Create the first admin account**. If you see the login form but setup fails with `409 Setup already completed`, someone already created it — delete `data/auth.json` + `data/.secret` on the server and refresh ( `rm data/auth.json data/.secret` ). Ensure `data/` is writable by php-fpm/www-data (`chown www-data:www-data data && chmod 750 data`). |
| `Setup already completed` but forgot password | `rm data/auth.json data/.secret` then refresh to re-create admin (fleet secrets will be re-encrypted with new key — re-save fleet entries). |
| Forgot admin password — **keep all data** | `rm /var/www/rcloneweb/data/auth.json` (leave `data/.secret`). Refresh → **Create the first admin account**. Your scripts, fleet VPS list, destinations, schedules, and run logs are untouched, and fleet passwords stay decryptable because `data/.secret` is unchanged. Only add `data/.secret` to the `rm` if you also want to rotate the session-signing key (then re-enter fleet passwords once). |

---

### 📄 License

MIT — do what you want, no warranty. PRs welcome.

<p align="center"><i>Built with PHP 8.5 • vanilla JS • CodeMirror • Material 3</i></p>
