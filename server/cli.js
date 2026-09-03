import * as auth from './lib/auth.js';
import { ensureDataDirs } from './lib/paths.js';
import { triggerDueSchedules } from './lib/scheduler.js';

const cmd = process.argv[2];

async function resetPassword() {
  ensureDataDirs();
  const isTTY = process.stdin.isTTY;
  let username = '';
  let password = '';
  if (isTTY) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const q = (msg) => new Promise((res) => rl.question(msg, (ans) => res(ans)));
    username = (await q('New username: ')).trim();
    password = await q('New password (min 6 chars): ');
    rl.close();
  } else {
    // Piped input: two lines (username, password)
    const fs = await import('node:fs');
    const data = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    username = (data[0] || '').trim();
    password = (data[1] || '').trim();
    // If password still empty and data has more lines, join remaining as password (allows spaces)
    if (!password && data.length > 2) password = data.slice(1).join('\n').trim();
  }
  try {
    auth.resetCredentials(username, password);
    console.log(`\n✓ Credentials updated for "${username}". Fleet secrets preserved (data/.secret untouched).`);
    console.log('  Restart the server if it is running, then log in with the new credentials.');
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}

if (cmd === 'reset-password') {
  await resetPassword();
} else if (cmd === 'cron') {
  ensureDataDirs();
  const triggered = await triggerDueSchedules();
  if (triggered.length) console.log(`Triggered ${triggered.length} schedule(s): ${triggered.map((r) => r.id).join(', ')}`);
  else console.log('No schedules due.');
} else {
  console.log('Usage:');
  console.log('  node server/cli.js reset-password   # reset admin username/password (keeps all data)');
  console.log('  node server/cli.js cron             # one-shot scheduler tick (for system crontab)');
}
