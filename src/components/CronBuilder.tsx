import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../lib/ui';

const DAYS = [{ v: 0, n: 'Sun' }, { v: 1, n: 'Mon' }, { v: 2, n: 'Tue' }, { v: 3, n: 'Wed' }, { v: 4, n: 'Thu' }, { v: 5, n: 'Fri' }, { v: 6, n: 'Sat' }];
type Mode = 'everyN' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

/** Parse a cron expr into builder state; returns null when it doesn't fit a mode. */
function parseExpr(value: string): { mode: Mode; patch: Partial<ST> } | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, , dow] = parts;
  if (/^\*\/\d+$/.test(mi) && h === '*') return { mode: 'everyN', patch: { nMin: Math.min(59, Math.max(1, parseInt(mi.slice(2), 10) || 15)) } };
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) {
    // e.g. "30 */6 * * *" — run at minute 30 of every 6th hour
    return { mode: 'hourly', patch: { nHr: Math.min(23, Math.max(1, parseInt(h.slice(2), 10) || 6)), time: `00:${String(parseInt(mi, 10) % 60).padStart(2, '0')}` } };
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(h)) {
    const time = `${String(parseInt(h, 10)).padStart(2, '0')}:${String(parseInt(mi, 10)).padStart(2, '0')}`;
    if (dom === '*' && dow === '*') return { mode: 'daily', patch: { time } };
    if (dom === '*' && dow !== '*') {
      const days = dow.split(',').map((v) => parseInt(v, 10)).filter((n) => !Number.isNaN(n));
      if (days.length) return { mode: 'weekly', patch: { time, days } };
    }
    if (dom !== '*' && /^\d+$/.test(dom)) return { mode: 'monthly', patch: { time, dom: Math.min(28, Math.max(1, parseInt(dom, 10) || 1)) } };
  }
  return null;
}

interface ST { nMin: number; nHr: number; time: string; days: number[]; dom: number; custom: string }

export function CronBuilder({ value, onChange }: { value: string; onChange: (expr: string) => void }) {
  const [mode, setMode] = useState<Mode>('daily');
  const [state, setState] = useState<ST>({ nMin: 15, nHr: 6, time: '02:30', days: [1], dom: 1, custom: '*/15 * * * *' });

  const build = useCallback((m: Mode, s: ST): string => {
    const [hh, mm] = s.time.split(':').map(Number);
    const at = `${String(mm).padStart(2, '0')} ${String(hh).padStart(2, '0')}`;
    switch (m) {
      case 'everyN': return `*/${s.nMin} * * * *`;
      case 'hourly': return `${String(mm).padStart(2, '0')} */${s.nHr} * * *`;
      case 'daily': return `${at} * * *`;
      case 'weekly': return `${at} * * ${s.days.length ? [...s.days].sort((a, b) => a - b).join(',') : '*'}`;
      case 'monthly': return `${String(mm).padStart(2, '0')} ${String(hh).padStart(2, '0')} ${s.dom} * *`;
      case 'custom': return s.custom;
    }
  }, []);

  // external value -> internal state, only on genuinely external changes
  const prevExternal = useRef(value);
  const selfEmitted = useRef<string | null>(null);
  useEffect(() => {
    if (!value) return;
    if (value === selfEmitted.current) return;
    if (value === prevExternal.current) return;
    prevExternal.current = value;
    const parsed = parseExpr(value);
    if (parsed) {
      setMode(parsed.mode);
      setState((s) => ({ ...s, ...parsed.patch }));
    } else {
      setMode('custom');
      setState((s) => ({ ...s, custom: value }));
    }
  }, [value]);

  // internal state -> external value
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const v = build(mode, state);
    if (v === value) return;
    selfEmitted.current = v;
    prevExternal.current = v;
    onChange(v);
  }, [mode, state, build, value, onChange]);

  const set = (patch: Partial<ST>) => setState((s) => ({ ...s, ...patch }));
  const expr = build(mode, state);
  const summary = parseExpr(expr) ? friendly(expr) : expr;

  return (
    <div className="cron-builder">
      <div className="cron-chips" role="radiogroup" aria-label="Schedule pattern">
        {([['everyN', 'Every N min'], ['hourly', 'Every N hrs'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['custom', 'Advanced']] as const).map(([m, l]) => (
          <button key={m} type="button" role="radio" aria-checked={m === mode} className={`chip ${m === mode ? 'active' : ''}`} onClick={() => setMode(m)}>{l}</button>
        ))}
      </div>
      <div className="cron-body">
        {mode === 'everyN' && (
          <label className="inline-field">Run every
            <input type="number" min={1} max={59} value={state.nMin} onChange={(e) => set({ nMin: Math.max(1, Math.min(59, Number(e.target.value) || 1)) })} />
            <span className="unit">minutes</span>
          </label>
        )}
        {mode === 'hourly' && (
          <label className="inline-field">Run every
            <input type="number" min={1} max={23} value={state.nHr} onChange={(e) => set({ nHr: Math.max(1, Math.min(23, Number(e.target.value) || 1)) })} />
            <span className="unit">hours at minute</span>
            <input type="number" min={0} max={59} value={Number(state.time.split(':')[1])} onChange={(e) => {
              const mm = String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0');
              set({ time: `00:${mm}` });
            }} />
          </label>
        )}
        {mode === 'daily' && (
          <label className="inline-field">Time of day
            <input type="time" value={state.time} onChange={(e) => set({ time: e.target.value || '02:30' })} />
          </label>
        )}
        {mode === 'weekly' && (
          <div className="inline-field-wrap">
            <div className="day-chips">
              {DAYS.map((d) => (
                <button key={d.v} type="button" aria-pressed={state.days.includes(d.v)} className={`chip day ${state.days.includes(d.v) ? 'active' : ''}`}
                  onClick={() => set({ days: state.days.includes(d.v) ? state.days.filter((x) => x !== d.v) : [...state.days, d.v] })}>{d.n}</button>
              ))}
            </div>
            <label className="inline-field">Time
              <input type="time" value={state.time} onChange={(e) => set({ time: e.target.value || '02:30' })} />
            </label>
          </div>
        )}
        {mode === 'monthly' && (
          <div className="inline-field-wrap">
            <label className="inline-field">Day of month
              <input type="number" min={1} max={28} value={state.dom} onChange={(e) => set({ dom: Math.max(1, Math.min(28, Number(e.target.value) || 1)) })} />
            </label>
            <label className="inline-field">Time
              <input type="time" value={state.time} onChange={(e) => set({ time: e.target.value || '02:30' })} />
            </label>
          </div>
        )}
        {mode === 'custom' && (
          <label className="inline-field grow">Cron expression
            <input value={state.custom} spellCheck={false} onChange={(e) => set({ custom: e.target.value })} />
          </label>
        )}
      </div>
      <div className="cron-out">
        <div className="cron-summary"><Icon name="clock" size={13} /> {summary}</div>
        <code className="cron-expr">{expr}</code>
      </div>
    </div>
  );
}

function friendly(expr: string): string {
  const [mi, h, dom, , dow] = expr.split(' ');
  if (/^\*\/\d+$/.test(mi) && h === '*') return `Every ${mi.slice(2)} minutes`;
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) return `Every ${h.slice(2)} hours, at :${mi.padStart(2, '0')}`;
  const hm = `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return `Every day at ${hm}`;
  if (dow !== '*') return `${dow.split(',').map((d) => DAYS[Number(d)]?.n ?? d).join(', ')} at ${hm}`;
  if (dom !== '*') return `Day ${dom} of month at ${hm}`;
  return expr;
}
