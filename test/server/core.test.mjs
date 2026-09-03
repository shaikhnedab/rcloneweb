import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeJoin, isSafeId, DATA_DIR } from '../../server/lib/paths.js';
import { cronMatches, cronError } from '../../server/lib/cron.js';
import * as auth from '../../server/lib/auth.js';
import * as jsonfile from '../../server/lib/jsonfile.js';
import * as webhook from '../../server/lib/webhook.js';
import * as browse from '../../server/lib/browse.js';

// ---- paths ----
test('safeJoin rejects traversal', () => {
  assert.equal(safeJoin(DATA_DIR, '../../etc/passwd'), null);
  assert.equal(safeJoin(DATA_DIR, 'a/../../b'), null);
  assert.ok(safeJoin(DATA_DIR, 'scripts/ok.json'));
});

test('isSafeId accepts only sane ids', () => {
  assert.ok(isSafeId('abc-123_X'));
  assert.ok(isSafeId('local'));
  assert.equal(isSafeId('../etc'), false);
  assert.equal(isSafeId('a/b'), false);
  assert.equal(isSafeId(''), false);
  assert.equal(isSafeId(42), false);
});

// ---- cron ----
test('cronMatches handles common expressions', () => {
  const d = (min, hour, day, month) => new Date(2026, month - 1, day, hour, min, 30);
  const dow = (day, month) => new Date(2026, month - 1, day).getDay();
  assert.ok(cronMatches('*/15 * * * *', d(0, 5, 1, 9)));
  assert.ok(!cronMatches('*/15 * * * *', d(7, 5, 1, 9)));
  assert.ok(cronMatches('30 2 * * *', d(30, 2, 15, 9)));
  assert.ok(!cronMatches('30 2 * * *', d(31, 2, 15, 9)));
  const monday = [7, 8, 9, 10, 11, 12, 13].find((day) => dow(day, 9) === 1);
  const sunday = [7, 8, 9, 10, 11, 12, 13].find((day) => dow(day, 9) === 0);
  assert.ok(cronMatches('0 3 * * 1', d(0, 3, monday, 9))); // Monday
  assert.ok(!cronMatches('0 3 * * 1', d(0, 3, monday + 1, 9)));
  // vixie-cron OR semantics: dom OR dow when both are restricted
  assert.ok(cronMatches('0 3 1 * 0', d(0, 3, sunday, 9))); // Sunday (dow matches)
  assert.ok(cronMatches('0 3 1 * 0', d(0, 3, 1, 9))); // 1st (dom matches)
  assert.ok(!cronMatches('0 3 1 * 0', d(0, 3, 2, 9))); // neither
});

test('cronError rejects garbage', () => {
  assert.equal(cronError('*/15 * * * *'), null);
  assert.ok(cronError('not a cron'));
  assert.ok(cronError('*/0 * * * *'));
  assert.ok(cronError('61 * * * *'));
});

// ---- auth rate limiter ----
test('rate limiter blocks after MAX_ATTEMPTS and clears', () => {
  const ip = `10.0.0.${Math.floor(Math.random() * 200) + 5}`;
  for (let i = 0; i < 10; i++) {
    assert.ok(auth.rateLimitCheck(ip));
    auth.rateLimitRecord(ip);
  }
  assert.ok(!auth.rateLimitCheck(ip));
  auth.rateLimitClear(ip);
  assert.ok(auth.rateLimitCheck(ip));
});

// ---- webhook validation (no network) ----
test('webhook rejects non-Discord URLs', async () => {
  const out = await webhook.testWebhook({ url: 'https://evil.example.com/api/webhooks/x', payload: {} });
  assert.equal(out.code, 400);
  const out2 = await webhook.testWebhook({ url: 'javascript:alert(1)', payload: {} });
  assert.equal(out2.code, 400);
});

// ---- jsonfile helpers ----
test('atomicWrite + withLock serialize access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  const file = path.join(dir, 'x.json');
  let counter = 0;
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    jsonfile.withLock(file, async () => {
      const cur = jsonfile.readJson(file) ?? { n: 0 };
      counter = cur.n;
      await new Promise((r) => setTimeout(r, 1));
      jsonfile.atomicWrite(file, JSON.stringify({ n: counter + 1 }));
    }),
  ));
  assert.equal(jsonfile.readJson(file).n, 20);
  assert.equal(jsonfile.slugify('My Cool Script!!', 'x'), 'my-cool-script');
});

// ---- browse data-dir guard (incl. symlink bypass) ----
test('browseLocal blocks the data dir directly and via symlink', () => {
  assert.equal(browse.browseLocal(DATA_DIR).ok, false);
  assert.equal(browse.browseLocal(path.join(DATA_DIR, 'scripts')).ok, false);
  const link = path.join(os.tmpdir(), `rw-link-${process.pid}`);
  try {
    fs.symlinkSync(DATA_DIR, link);
    const viaLink = browse.browseLocal(link);
    assert.equal(viaLink.ok, false, 'symlink into data dir must be blocked');
  } finally {
    fs.rmSync(link, { force: true });
  }
  assert.equal(browse.browseLocal(os.tmpdir()).ok, true);
});
