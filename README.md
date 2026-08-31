# 📦 rcloneweb v2 — Node.js + React

Beautiful rclone backup panel — rebuilt from scratch in **Node.js 22 + Express 5 + React 19 + Vite**.

> **This is a complete rewrite** of the PHP version. All original features are preserved, every reported bug is fixed, and modern security defaults are applied. The PHP source is kept untouched in [`legacy/`](legacy/) for reference.

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.3-00E5CC?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Node-22-339933?style=for-the-badge&logo=node.js" />
  <img src="https://img.shields.io/badge/Express-5-000000?style=for-the-badge&logo=express" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react" />
</p>

## ✨ What it does

Build, store, schedule and run **rclone** backup scripts from a modern UI — with fleet management, live logs and Discord alerts.

| Area | What you get |
|---|---|
| **🛠 Builder** | Per-folder `source → remote` mapping, include/exclude, bandwidth, retention, `--dry-run` |
| **☁️ Fleet** | VPS fleet (SSH) + Destination fleet (SFTP/FTP/S3) — save once, pick from dropdown |
| **📂 Browse** | Browse local or remote storage over SSH/rclone, create folders inline |
| **🔔 Discord** | Webhook notifications with template support (`{NAME} {STATUS} {HOST} {SOURCES} {DEST} {DURATION} {DATE}`), per-stage control, log attachment |
| **▶ Run & Logs** | Live streaming output, compact view, real progress from rclone stats, stop, download, 25-run history |
| **⏰ Schedule** | In-panel cron builder (Every N min / hourly / daily / weekly / monthly / custom), timezone-aware, in-process scheduler + `cron` CLI |
| **🔐 Auth** | First-run setup, stateless HMAC session (30d, `HttpOnly` `SameSite=Lax`), `scrypt` hashing, rate-limited login, **account reset without data loss** |
| **🎨 Theme** | Dark / light, Material 3, responsive, accessible |

## 🚀 Quick start

### 🐳 Docker (recommended) — prebuilt GHCR, no local build

```bash
# 1. Clone (only for compose file) or download docker-compose.yml alone
git clone https://github.com/shaikhnedab/rcloneweb .
cd rcloneweb
# Timezone is Asia/Kolkata by default — change TZ in docker-compose.yml if needed

# 2. Run (pulls ghcr.io/shaikhnedab/rcloneweb:latest ~60MB Alpine, includes rclone + sshpass)
docker compose pull
docker compose up -d
# → http://127.0.0.1:8765
# First visit: create the admin account. Data lives in Docker volume rcloneweb-data.

# Logs
docker compose logs -f

# Stop (volume persists)
docker compose down

# Reset password (keeps data)
docker compose exec rcloneweb node server/cli.js reset-password

# Cron — not needed separately: the container's in-process scheduler ticks every 30s
# even when your browser is closed (as long as the container is up). For extra safety
# you can also add a host cron that triggers the container:
# * * * * * docker compose exec rcloneweb node server/cli.js cron >> /var/log/rcloneweb-cron.log 2>&1
```

**Local build (only if you fork):**

```bash
# Uncomment `build: .` in docker-compose.yml, then:
docker compose up -d --build
```

**GHCR prebuilt — manual pull/run without compose:**

```bash
# Pull the latest Alpine image from GHCR (built on every tag v* and main)
docker pull ghcr.io/your-org/rcloneweb:latest
# Use it in docker-compose.yml: image: ghcr.io/your-org/rcloneweb:latest (no build:)
# Or run directly:
docker run -d -p 8765:8765 -v rcloneweb-data:/app/data --name rcloneweb ghcr.io/your-org/rcloneweb:latest
```

**Data persistence:**
```bash
# Volume survives `docker compose down`
docker volume inspect rcloneweb-data
# Backup
docker run --rm -v rcloneweb-data:/data -v $(pwd):/backup alpine tar czf /backup/rcloneweb-data.tgz /data
# Update
git pull && docker compose up -d --build
# Or with GHCR: docker compose pull && docker compose up -d
```

### 📦 Bare metal (without Docker)

```bash
# 1. Clone
git clone https://github.com/your/rcloneweb .
# (legacy PHP kept in ./legacy/ — not used)

# 2. Node 22
node -v  # >=22

# 3. Install
npm install

# 4. Build frontend
npm run build

# 5. Run (fresh data/ is created on first boot)
npm start
# → http://127.0.0.1:8765
# First visit: create the admin account. Data lives in ./data/ (gitignored).

# Dev mode (Vite HMR on 5173, proxies /api to 8765)
# Terminal 1:
npm run dev:server   # or: node server/index.js
# Terminal 2:
npm run dev
```

### Environment

| Var | Default | Description |
|---|---|---|
| `PORT` | `8765` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` inside Docker) |
| `TZ` | `Asia/Kolkata` | Timezone for cron and logs (e.g. `UTC`, `Asia/Kolkata`, `America/New_York`) — set in `docker-compose.yml` or `ENV TZ=` |

### System cron — will it run if I close the browser?

**Yes, as long as the server/container is up.** The Node server has an in-process scheduler that ticks every **30s** (even with no browser open) and triggers due cron jobs. The browser also ticks every 30s while open, but it’s not required.

Host cron is **optional** — only needed if you stop the Node server/container when not using the panel. If you keep `docker compose up -d` or `npm start` running, schedules will fire on time.

```bash
# Bare metal — only if you stop the Node server:
* * * * * node /path/to/rcloneweb/server/cli.js cron >> /var/log/rcloneweb-cron.log 2>&1
# Docker — only if you stop the container:
* * * * * docker compose exec rcloneweb node server/cli.js cron >> /var/log/rcloneweb-cron.log 2>&1
```

## 🔐 Account management (no data loss)

**In-app (when logged in):** Sidebar → **account** → change username and/or password (current password required). Changing credentials bumps `pwVersion` and invalidates all old sessions.

**CLI (when locked out):**
```bash
node server/cli.js reset-password
# prompts for new username + password
# rewrites ONLY data/auth.json — data/.secret, fleet, destinations, scripts, runs, schedules are untouched
# works piped too: printf "newadmin\nnewpass123\n" | node server/cli.js reset-password
```

Fleet secrets stay decryptable because the encryption key (`data/.secret`) is never touched.

## 🌐 Nginx (production)

**Host Nginx (bare metal or Docker host):**
```nginx
server {
    listen 80;
    server_name panel.example.com;
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
        client_max_body_size 10M;
    }
}
```

For TLS use `certbot --nginx -d panel.example.com`. The app auto-detects `X-Forwarded-Proto: https` and sets `Secure` cookies + HSTS.

**SSL — complete example (HTTP → HTTPS redirect + 443):**
```nginx
# HTTP — redirect to HTTPS
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;

    # Auto HSTS — also sent by Node when X-Forwarded-Proto:https
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

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
        client_max_body_size 10M;
    }
}
```
Quick setup:
```bash
sudo apt update && sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d panel.example.com   # auto-creates 443 block + redirect
sudo certbot renew --dry-run  # test auto-renew
# Or manual: copy the 443 block above and run `sudo nginx -t && sudo systemctl reload nginx`
```

**Nginx inside Docker Compose (optional):** uncomment the `nginx` service in `docker-compose.yml`, put your `nginx/rcloneweb.conf` at `./nginx/rcloneweb.conf` on the host, and change `proxy_pass http://rcloneweb:8765;` (service name, not `127.0.0.1`). For SSL inside compose, mount `certs`:
```yaml
  nginx:
    image: nginx:alpine
    ports: ["80:80","443:443"]
    volumes:
      - ./nginx/rcloneweb.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
      - /var/lib/letsencrypt:/var/lib/letsencrypt:ro
```

## 🛠 Scripts

| Command | Description |
|---|---|
| `npm start` | Production server (serves `dist/`) |
| `npm run dev` | Vite dev server (5173) |
| `npm run dev:server` | Node server only |
| `npm run build` | Build frontend to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run reset-password` | CLI credential reset |
| `npm run cron` | One-shot scheduler tick |

## 🔒 Security fixes vs v1

- All shell execution via **arg arrays** (`execFile`/`spawn`) — no shell string concatenation
- SSH uses `StrictHostKeyChecking=accept-new` (not `no`)
- Secrets via **env vars** for rclone, obscure via stdin (never argv)
- Predictable `/tmp` paths replaced with randomized names
- Login **rate limiting** (10/5min per IP)
- CSRF: `SameSite=Lax` + `Origin` check on mutations
- `data/` blocked from web access, `auth.json` 0600
- Fleet/dest GETs strip ciphertext, XSS via `innerHTML` eliminated (React escapes)

## 🐛 Bugs fixed vs v1

- Webhook templates/colors/`onlyOnFail`/`logLines` now actually wired into the generated script (were preview-only)
- Run history prefix-glob collision (`test` vs `test-2`) fixed — exact shard names
- `pkill -f rclone` no longer kills all rclone on remote (per-run marker)
- Orphan schedules cleaned on script/VPS delete
- Username `.` / `>40 chars` lockout fixed (validated, `pwVersion` sessions)
- Read-modify-write races fixed via per-file promise-queue locks
- Stale runs reaped on boot (no more forever-409)
- Cron parser: ranges, steps, lists, Sunday 7→0, Vixie dom/dow OR semantics
- 200KB log keeps **tail** (live stats stay fresh)
- Paths with spaces handled via separate `sync_src`/`sync_dst` arrays
- Browse: `data/` blocked, `lsjson` stdout/stderr separated, `mkdir` for S3 uses `.keep`
- Touch-device action buttons always visible, `whoami` after reload, dialog Esc, fake 62% progress replaced with real stats, hardcoded cron path made dynamic

## 📁 Layout

```
server/          # Node backend (Express)
  index.js       # HTTP + static + scheduler
  cli.js         # reset-password + cron
  lib/           # auth, crypto, store, fleet, destinations, runs, ssh, rclone, browse, ...
  routes/api.js  # all endpoints
src/             # React frontend (Vite + TS)
  App.tsx        # auth, sidebar, all tabs
  lib/generator.ts  # bash generator (wired webhook templates)
  lib/cron.tsx   # cron builder component
  styles/style.css
dist/            # built frontend (gitignored, served by server)
data/            # runtime data (gitignored, fresh on first boot)
legacy/          # original PHP source (preserved)
```

## 📄 License

MIT — see `legacy/` for original PHP license. Fresh code is MIT, no warranty.

Built with Node 22 • Express 5 • React 19 • Vite • TypeScript
