import { describe, it, expect } from 'vitest';
import { friendlyCron, parseRunStats, elapsedSince, fmtBytes, compactView } from './format';
import { buildScript, defaultConfig } from './generator';

describe('friendlyCron', () => {
  it('summarizes common patterns', () => {
    expect(friendlyCron('*/15 * * * *')).toBe('Every 15 min');
    expect(friendlyCron('30 */6 * * *')).toBe('Every 6 h');
    expect(friendlyCron('30 2 * * *')).toBe('Daily at 02:30');
    expect(friendlyCron('0 3 * * 1,5')).toBe('Mon, Fri at 03:00');
  });
  it('never crashes on malformed input', () => {
    expect(friendlyCron('garbage')).toBe('garbage');
    expect(friendlyCron('')).toBe('—');
    expect(friendlyCron(undefined)).toBe('—');
  });
});

describe('parseRunStats', () => {
  it('extracts the newest rclone stats', () => {
    const log = [
      '2026/09/01 10:00:00 INFO  : Starting sync for: /srv/data remote:backup',
      'Transferred:    1.5 MiB / 10 MiB, 15%, 2 MiB/s, ETA 5s',
      'Checks:              10 / 40, 25%',
      'Transferred:    4.0 MiB / 10 MiB, 40%, 3 MiB/s, ETA 2s',
      'Checks:              30 / 40, 75%',
    ].join('\n');
    const s = parseRunStats(log);
    expect(s.pct).toBe(40);
    expect(s.transferred).toBe('4.0 MiB / 10 MiB');
    expect(s.speed).toBe('3 MiB/s');
    expect(s.eta).toBe('2s');
    expect(s.checks).toBe('30 / 40');
  });
  it('returns nulls for empty logs', () => {
    expect(parseRunStats('').pct).toBeNull();
  });
});

describe('buildScript', () => {
  it('generates a runnable bash header and rejects shell metachars in flags', () => {
    const cfg = defaultConfig();
    cfg.options.extraFlags = '--transfers 8';
    const script = buildScript(cfg);
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    cfg.options.extraFlags = '--flag; rm -rf /';
    expect(() => buildScript(cfg)).toThrow();
  });
});

describe('elapsed / bytes', () => {
  it('formats durations and byte sizes', () => {
    const start = new Date(Date.now() - 65000).toISOString();
    expect(elapsedSince(start)).toBe('1m 5s');
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(2048)).toBe('2 KiB');
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3 MiB');
  });
  it('compactView keeps 4 lines', () => {
    const out = compactView('Starting sync for: /a remote:b\nTransferred: 1 MiB / 2 MiB, 50%, ETA 1s', new Date().toISOString());
    expect(out.split('\n').length).toBe(4);
  });
});
