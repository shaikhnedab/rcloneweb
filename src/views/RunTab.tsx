import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FleetItem, RunRec } from '../lib/types';
import { compactView, downloadText, elapsedSince, fmtBytes, parseRunStats } from '../lib/format';
import { Icon, Spinner, toast } from '../lib/ui';
import { Button } from '../components/ui/button';

interface Props {
  scriptId: string | null;
  docName: string;
  fleet: FleetItem[];
  sourceVpsId: string;
  onRun: (vpsId: string, dryRun: boolean) => Promise<boolean>;
  dialog: { confirm: (t: string, m?: string, ok?: string, danger?: boolean) => Promise<boolean> };
}

const LOG_CAP = 160 * 1024;

export function RunTab(p: Props) {
  const [runs, setRuns] = useState<RunRec[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [runVps, setRunVps] = useState('');
  const [liveMode, setLiveMode] = useState<'compact' | 'full'>(() => (localStorage.getItem('rcloneweb_liveMode') as 'compact' | 'full') || 'compact');
  const [starting, setStarting] = useState(false);
  const userPicked = useRef(false);
  const scriptRef = useRef<string | null>(null);
  const termRef = useRef<HTMLPreElement>(null);

  useEffect(() => { localStorage.setItem('rcloneweb_liveMode', liveMode); }, [liveMode]);

  // Reset view when switching scripts.
  useEffect(() => {
    if (scriptRef.current === p.scriptId) return;
    scriptRef.current = p.scriptId;
    userPicked.current = false;
    setActiveRunId(null);
    setRuns([]);
    setLog('');
    setRunVps('');
  }, [p.scriptId]);

  const selectedId = p.scriptId;
  const activeRunIdRef = useRef<string | null>(null);
  activeRunIdRef.current = activeRunId;

  const loadRuns = useCallback(async (select: 'none' | 'latest' = 'none') => {
    if (!selectedId) return;
    try {
      const list = await api(`/api/scripts/${selectedId}/runs`) as RunRec[];
      setRuns(list);
      // Auto-follow: jump to a newly started run (e.g. fired by the scheduler)
      // unless the user deliberately picked one. Picking releases once that
      // run finishes (the SSE 'end' handler clears userPicked).
      const newest = list[0];
      if (select === 'latest' && newest && !userPicked.current) setActiveRunId(newest.id);
      const runningRun = list.find((r) => !r.finishedAt);
      if (runningRun && !userPicked.current && runningRun.id !== activeRunIdRef.current) {
        setActiveRunId(runningRun.id);
      }
    } catch { /* transient — next poll retries */ }
  }, [selectedId]);

  useEffect(() => { if (selectedId) loadRuns('latest'); }, [selectedId, loadRuns]);

  // Poll the (metadata-only) run index so scheduler-started runs show up live.
  const anyRunning = runs.some((r) => !r.finishedAt);
  useEffect(() => {
    if (!selectedId) return;
    const id = window.setInterval(() => loadRuns(), anyRunning ? 2500 : 5000);
    return () => window.clearInterval(id);
  }, [selectedId, anyRunning, loadRuns]);

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  const running = Boolean(activeRun && !activeRun.finishedAt);

  // Live log over SSE (also delivers finished logs once, then closes).
  useEffect(() => {
    if (!selectedId || !activeRun) { setLog(''); return; }
    let es: EventSource | null = null;
    let got = false;
    let cancelled = false;
    setLog('');
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`/api/scripts/${selectedId}/runs/${activeRun.id}/events`);
      es.addEventListener('log', (e) => {
        got = true;
        const text = JSON.parse((e as MessageEvent).data).text as string;
        setLog((prev) => (prev.length > LOG_CAP ? prev.slice(-LOG_CAP / 2) : prev) + text);
      });
      es.addEventListener('end', () => {
        es?.close();
        // Picking released once the viewed run is over, so a newly started
        // (e.g. scheduler-fired) run can auto-follow again.
        userPicked.current = false;
        loadRuns();
      });
      es.onerror = () => {
        es?.close();
        if (!got && !cancelled) {
          // Fallback for proxies that break SSE: fetch the log once.
          fetch(`/api/scripts/${selectedId}/runs/${activeRun.id}/log`, { credentials: 'include' })
            .then((r) => (r.ok ? r.text() : ''))
            .then((t) => { if (!cancelled) setLog(t); })
            .catch(() => {});
        }
      };
    }
    return () => { cancelled = true; es?.close(); };
  }, [selectedId, activeRun?.id, loadRuns]);

  // Auto-scroll the terminal while output grows.
  useEffect(() => {
    const el = termRef.current;
    if (!el || !running) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || el.scrollTop === 0) {
      const raf = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      return () => cancelAnimationFrame(raf);
    }
  }, [log, running]);

  const stop = async () => {
    if (!activeRun) return;
    try {
      await api(`/api/runs/${activeRun.id}/stop`, { method: 'POST' });
      toast('Stop signal sent');
      loadRuns();
    } catch (e) { toast((e as Error).message, true); }
  };

  const start = async (dryRun: boolean) => {
    const vpsId = runVps || p.sourceVpsId;
    if (!vpsId) { toast('Select a VPS first', true); return; }
    setStarting(true);
    const ok = await p.onRun(vpsId, dryRun);
    setStarting(false);
    if (ok) loadRuns('latest');
  };

  const viewLog = (r: RunRec) => {
    userPicked.current = true;
    setActiveRunId(r.id);
  };

  const fetchLog = async (r: RunRec): Promise<string> => {
    if (!selectedId) return '';
    try {
      return await fetch(`/api/scripts/${selectedId}/runs/${r.id}/log`, { credentials: 'include' }).then((x) => x.text());
    } catch { return ''; }
  };

  const copyLog = async (r: RunRec) => {
    const t = await fetchLog(r);
    if (!t) { toast('No log to copy', true); return; }
    try { await navigator.clipboard.writeText(t); toast('Log copied'); } catch { toast('Copy failed', true); }
  };

  const downloadLog = async (r: RunRec) => {
    const t = await fetchLog(r);
    downloadText(`run-${r.id}.log`, t);
  };

  const deleteLog = async (r: RunRec) => {
    if (!r.finishedAt) { toast('Stop the run first — only finished logs can be deleted', true); return; }
    const ok = await p.dialog.confirm('Delete run log?', `Delete the ${r.dryRun ? 'dry ' : ''}run from ${new Date(r.startedAt).toLocaleString()}?`, 'Delete', true);
    if (!ok) return;
    try {
      await api(`/api/scripts/${selectedId}/runs/${r.id}`, { method: 'DELETE' });
      toast('Run deleted');
      if (activeRun?.id === r.id) { setActiveRunId(null); setLog(''); }
      loadRuns();
    } catch (e) { toast((e as Error).message, true); }
  };

  if (!selectedId) return <p className="hint">Save the script first.</p>;

  const stats = parseRunStats(log);
  const progressPct = running ? stats.pct : 100;

  return (
    <div className="runtab">
      <div className="run-controls">
        <label className="field">
          <span className="field-label">Run on</span>
          <select value={runVps || p.sourceVpsId} onChange={(e) => setRunVps(e.target.value)}>
            <option value="">— Select VPS —</option>
            {p.fleet.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.host})</option>)}
          </select>
        </label>
        <Button className="btn filled" disabled={anyRunning || starting} onClick={() => start(false)}>{starting ? <Spinner size={14} /> : <Icon name="play" size={14} />} Run now</Button>
        <Button className="btn tonal" disabled={anyRunning || starting} onClick={() => start(true)}><Icon name="eye" size={14} /> Dry run</Button>
        {anyRunning && <button className="btn danger" onClick={stop}><Icon name="stop" size={14} /> Stop</button>}
      </div>

      {activeRun && (
        <div className="card run-card">
          <div className="run-card-head">
            <span className={`run-glyph ${running ? 'is-running' : activeRun.exitCode === 0 ? 'is-ok' : 'is-bad'}`}>
              {running ? <Spinner size={16} /> : <Icon name={activeRun.exitCode === 0 ? 'check' : 'x'} size={16} />}
            </span>
            <div className="run-card-title">
              <b>{running ? `Running on ${activeRun.vpsName}…` : activeRun.exitCode === 0 ? `Completed on ${activeRun.vpsName}` : `Failed on ${activeRun.vpsName}`}</b>
              <span className="hint-inline">{new Date(activeRun.startedAt).toLocaleString()} · {elapsedSince(activeRun.startedAt, activeRun.finishedAt)}{activeRun.dryRun ? ' · dry run' : ''}</span>
            </div>
            {running && <span className="badge-live">LIVE</span>}
          </div>
          <div className={`progress ${running ? 'indeterminate' : activeRun.exitCode === 0 ? 'is-ok' : 'is-bad'}`} role="progressbar" aria-valuenow={progressPct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${progressPct ?? 8}%` }} />
          </div>
          <div className="stat-strip">
            <span><b>Elapsed</b> {elapsedSince(activeRun.startedAt, activeRun.finishedAt)}</span>
            <span><b>Transferred</b> {stats.transferred || '—'}{stats.pct !== null ? ` (${stats.pct}%)` : ''}</span>
            {stats.speed && <span><b>Speed</b> {stats.speed}</span>}
            {stats.eta && <span><b>ETA</b> {stats.eta}</span>}
            {stats.checks && <span><b>Checks</b> {stats.checks}</span>}
            {!running && typeof activeRun.bytes === 'number' && <span className="stat-right"><b>Log</b> {fmtBytes(activeRun.bytes)}</span>}
          </div>
        </div>
      )}

      <div className="term-bar">
        <span className="hint-inline">Live view</span>
        <div className="seg" role="radiogroup" aria-label="Terminal view">
          <button role="radio" aria-checked={liveMode === 'compact'} className={liveMode === 'compact' ? 'active' : ''} onClick={() => setLiveMode('compact')}>Compact</button>
          <button role="radio" aria-checked={liveMode === 'full'} className={liveMode === 'full' ? 'active' : ''} onClick={() => setLiveMode('full')}>Full</button>
        </div>
        <span className="hint-inline term-mode">{liveMode === 'compact' ? '4-line stats summary' : 'full log, auto-scroll'}</span>
      </div>

      <pre className={`terminal ${liveMode === 'compact' && running ? 'term-compact' : ''}`} ref={termRef}>
        {log
          ? (running && liveMode === 'compact' ? compactView(log, activeRun?.startedAt ?? new Date().toISOString()) : log)
          : '// no run selected — hit “Run now” or pick a run below'}
      </pre>

      <div className="section-head">
        <h3>Run history</h3>
        <span className="section-actions">
          <button className="btn tonal small" onClick={async () => {
            const ok = await p.dialog.confirm('Clear run history?', `All ${runs.length} run(s) and their logs for this script will be deleted.`, 'Clear', true);
            if (!ok) return;
            const res = await api(`/api/scripts/${selectedId}/runs`, { method: 'DELETE' }) as { ok?: boolean };
            if (res) { toast('Run history cleared'); setActiveRunId(null); setLog(''); loadRuns(); }
          }}><Icon name="trash" size={13} /> Clear</button>
          <button className="btn tonal small" onClick={async () => {
            if (!runs.length) { toast('No runs to download', true); return; }
            for (const r of runs.slice(0, 10)) {
              try {
                const t = await fetch(`/api/scripts/${selectedId}/runs/${r.id}/log`, { credentials: 'include' }).then((x) => x.text());
                downloadText(`run-${r.id}.log`, `===== ${r.name} | ${r.vpsName} | ${r.startedAt} | exit ${r.exitCode ?? '?'} =====\n${t}\n`);
              } catch { toast('Download failed', true); }
            }
          }}><Icon name="download" size={13} /> Download all</button>
        </span>
      </div>

      <div className="run-list">
        {runs.length === 0
          ? <p className="side-empty">No runs recorded yet.</p>
          : runs.map((r) => (
            <div key={r.id} className={`run-item ${r.id === (activeRun?.id) ? 'active' : ''}`}>
              <button className="run-item-main" onClick={() => viewLog(r)}>
                <span className={`dot ${r.finishedAt ? (r.exitCode === 0 ? 'dot-ok' : 'dot-bad') : 'dot-run'}`} />
                <b>{r.dryRun && <span className="badge-dry">DRY</span>}{r.name || p.docName || '—'}</b>
                <span className="run-when">{r.vpsName} · {new Date(r.startedAt).toLocaleString()}{r.finishedAt ? ` · ${r.exitCode} · ${elapsedSince(r.startedAt, r.finishedAt)}` : ' · running…'}</span>
              </button>
              <span className="run-item-actions">
                <button className="btn ghost small" onClick={() => viewLog(r)}><Icon name="eye" size={13} /> View</button>
                <button className="btn ghost small" onClick={() => copyLog(r)}><Icon name="copy" size={13} /> Copy</button>
                <button className="btn ghost small" onClick={() => downloadLog(r)}><Icon name="download" size={13} /> Download</button>
                <button
                  className="btn ghost small danger-text" disabled={!r.finishedAt}
                  title={r.finishedAt ? 'Delete run' : 'Stop the run first — only finished logs can be deleted'}
                  onClick={() => deleteLog(r)}
                ><Icon name="trash" size={13} /> Delete</button>
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
