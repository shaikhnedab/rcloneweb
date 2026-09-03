import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DATA_DIR = path.join(root, 'data');
export const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const LOGS_DIR = path.join(RUNS_DIR, 'logs');
export const FLEET_DIR = path.join(DATA_DIR, 'fleet');
export const DESTINATIONS_DIR = path.join(DATA_DIR, 'destinations');
export const SCHEDULES_DIR = path.join(DATA_DIR, 'schedules');
export const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
export const SECRET_FILE = path.join(DATA_DIR, '.secret');
export const PUBLIC_DIR = path.join(root, 'dist');

const DIR_MODE = 0o750;

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, SCRIPTS_DIR, RUNS_DIR, LOGS_DIR, FLEET_DIR, DESTINATIONS_DIR, SCHEDULES_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/** Resolve a user-supplied id to a path inside `dir`, rejecting traversal. */
export function safeJoin(dir, name) {
  const resolved = path.resolve(dir, name);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    return null;
  }
  return resolved;
}

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const isSafeId = (id) => typeof id === 'string' && ID_RE.test(id);
