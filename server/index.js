import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDataDirs, DATA_DIR } from './lib/paths.js';
import { migrateAndReap } from './lib/runs.js';
import { migrateRawTokens } from './lib/store.js';
import apiRouter from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

// App version for the startup banner (package.json is always present,
// including inside the Docker image; VERSION file is the fallback).
function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {}
  try {
    const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch {}
  return 'dev';
}
const APP_VERSION = appVersion();

ensureDataDirs();
// Fresh data: ensure .gitkeep files exist so data subdirs are kept in git if needed
for (const sub of ['scripts', 'runs', 'fleet', 'destinations', 'schedules']) {
  const dir = path.join(DATA_DIR, sub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

const app = express();
app.set('trust proxy', 1);

// Security headers (mirrors PHP version + HSTS when https)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // HSTS when behind https (direct or X-Forwarded-Proto)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-proto'] === 'https,http') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Block sensitive paths even before routing
app.use((req, res, next) => {
  if (/^\/(data|\.git|\.env)(\/|$)/.test(req.path)) return res.status(404).end();
  next();
});

// Mount API + raw routes (raw is inside apiRouter)
app.use(apiRouter);

// Serve built frontend when available. Hashed assets cache for a week, but
// index.html must always revalidate — a stale index referencing removed
// chunks breaks the UI until a hard refresh.
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    index: false,
    maxAge: '7d',
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // SPA fallback for non-file, non-api, non-raw routes
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/raw/') || req.path.startsWith('/i/')) {
      return res.status(404).json({ error: 'not found' });
    }
    const index = path.join(distDir, 'index.html');
    if (fs.existsSync(index)) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(index);
    }
    res.status(404).send('Not built yet — run npm run build');
  });
} else {
  // Dev fallback: if no dist, serve a hint (vite dev server proxies /api)
  app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/raw/') || req.path.startsWith('/i/')) {
      return res.status(404).json({ error: 'not found' });
    }
    res.type('html').send(`<!doctype html><title>rcloneweb dev</title><p>Frontend not built. Run <code>npm run dev</code> for Vite dev server (port 5173) or <code>npm run build</code> then restart.</p><p>API is running on this port.</p>`);
  });
}

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '127.0.0.1';

await migrateAndReap().catch((e) => console.error('[runs migrate/reap]', e.message));
await migrateRawTokens().catch((e) => console.error('[store migrate]', e.message));

// In-process scheduler tick every 5s — keeps schedule start times within
// seconds of the configured minute (the old 30s tick made runs start late).
const schedulerMod = await import('./lib/scheduler.js');
setInterval(() => {
  schedulerMod.triggerDueSchedules().then((t) => {
    if (t.length) console.log(`[scheduler] triggered ${t.length} job(s)`);
  }).catch((e) => console.error('[scheduler] tick failed:', e?.message || e));
}, 5_000).unref();

app.listen(PORT, HOST, () => {
  console.log(`rcloneweb v${APP_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
  if (!fs.existsSync(distDir)) console.log('hint: frontend not built — run `npm run build` or `npm run dev`');
});

export default app;
