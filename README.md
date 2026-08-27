# 📦 rcloneweb — Beautiful rclone backup panel

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.1-00E5CC?style=for-the-badge&logo=github" />
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
php -S 1.0.1.0:8765 -t /var/www/rcloneweb /var/www/rcloneweb/router.php &
# → http://YOUR_VPS_IP:8765
# Login: admin / hunter2hunter (first run will ask to create it, then delete data/auth.json to reset)

# 6. Default folders are `/` — add VPS in Fleet, Destination in Destinations, pick them in Builder, Save, Run.

# RCLONE defaults (compact, single-line stats)
# --transfers 16 --checkers 32 --fast-list --stats-one-line --stats 2s --log-level INFO --retries 5 --low-level-retries 10
```

> **Live log is compact** (speed / transferred / current file on one updating line) — **full log stays full** for `View`/`Download`. If a run looks hanged (no output 90s) you get a toast and can `Stop`.

---

### 🌐 Nginx Guide (deploy at `/`)

```nginx
# /etc/nginx/sites-available/rcloneweb
server {
    listen 80;
    server_name panel.example.com;
    root /var/www/rcloneweb;
    index index.php;

    # Protect data
    location ~ ^/(data|\.git)/ { deny all; return 404; }

    # Public assets
    location ~* \.(css|js|png|jpg|svg|woff2)$ {
        try_files $uri $uri/ @fallback;
        expires 7d;
    }
    location ~ ^/(css|js)/ { alias /var/www/rcloneweb/public/$1/; }

    # PHP
    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.5-fpm.sock;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }

    # Front controller + API/raw
    location / {
        try_files $uri $uri/ /index.php?$args;
    }
    location ~ ^/(api|raw|i)/ {
        try_files $uri /api/index.php?$args;
    }
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
# optional TLS
sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d panel.example.com
```

**`.htaccess` is already included** for Apache — just set `DocumentRoot /var/www/rcloneweb` and `AllowOverride All`.

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
- **Remote browser:** `☁️` on destination → ephemeral `rclone lsjson remote:path` (or fleet's stored creds via `POST /api/destinations/:id/browse`), same `New Folder` via `rclone mkdir`.

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

---

### 📄 License

MIT — do what you want, no warranty. PRs welcome.

<p align="center"><i>Built with PHP 8.5 • vanilla JS • CodeMirror • Material 3</i></p>
