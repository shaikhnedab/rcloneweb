import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DestItem, FleetItem, RunRec, ScheduleDoc, ScriptSummary } from '../lib/types';
import { friendlyCron, timeAgo } from '../lib/format';
import { Icon } from '../lib/ui';

interface Props {
  scripts: ScriptSummary[];
  fleet: FleetItem[];
  dests: DestItem[];
  onOpenScript: (id: string, tab?: 'builder' | 'run' | 'schedule') => void;
  onRunScript: (s: ScriptSummary) => void;
}

interface ScriptRow { last: RunRec | null; running: boolean; schedules: ScheduleDoc[] }

/** Overview of every script: last run, next schedule, fleet + destinations health. */
export function DashboardTab(p: Props) {
  const [rows, setRows] = useState<Record<string, ScriptRow>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let schedules: ScheduleDoc[] = [];
      try { schedules = await api('/api/schedules') as ScheduleDoc[]; } catch { /* non-fatal */ }
      const next: Record<string, ScriptRow> = {};
      await Promise.all(p.scripts.map(async (s) => {
        try {
          const runs = await api(`/api/scripts/${s.id}/runs`) as RunRec[];
          const scheds = schedules.filter((x) => x.scriptId === s.id && x.enabled);
          next[s.id] = {
            last: runs[0] ?? null,
            running: runs.some((r) => !r.finishedAt),
            schedules: scheds,
          };
        } catch {
          next[s.id] = { last: null, running: false, schedules: schedules.filter((x) => x.scriptId === s.id && x.enabled) };
        }
      }));
      if (!cancelled) { setRows(next); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [p.scripts]);

  const online = p.fleet.filter((v) => v.lastSeen).length;
  const okRuns = Object.values(rows).filter((r) => r.last?.finishedAt && r.last.exitCode === 0).length;
  const activeSchedules = Object.values(rows).reduce((n, r) => n + r.schedules.length, 0);

  return (
    <div className="dash">
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{p.scripts.length}</span>
          <span className="stat-label"><Icon name="code" size={13} /> Backup scripts</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{online}<span className="stat-dim">/{p.fleet.length}</span></span>
          <span className="stat-label"><Icon name="server" size={13} /> VPS online</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{okRuns}</span>
          <span className="stat-label"><Icon name="check" size={13} /> Last runs OK</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{activeSchedules}</span>
          <span className="stat-label"><Icon name="clock" size={13} /> Active schedules</span>
        </div>
      </div>

      <div className="section-head"><h3>Scripts</h3></div>
      {p.scripts.length === 0 && loaded && (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="box" size={30} /></div>
          <h2>No backup scripts yet</h2>
          <p>Create your first script to sync folders from a VPS to SFTP, FTP or S3 storage.</p>
        </div>
      )}
      {p.scripts.length > 0 && (
        <div className="dash-list">
          {p.scripts.map((s) => {
            const row = rows[s.id];
            const last = row?.last;
            const status = row?.running ? 'running' : last ? (last.finishedAt ? (last.exitCode === 0 ? 'ok' : 'bad') : 'running') : 'none';
            return (
              <div key={s.id} className="dash-row">
                <span className={`dot ${status === 'ok' ? 'dot-ok' : status === 'bad' ? 'dot-bad' : status === 'running' ? 'dot-run' : 'dot-off'}`} />
                <button className="dash-name" onClick={() => p.onOpenScript(s.id)}>{s.name}</button>
                <span className="dash-meta">
                  {last
                    ? <>last {last.dryRun ? 'dry ' : ''}run {status === 'running' ? 'running…' : `${timeAgo(last.startedAt)} · exit ${last.exitCode ?? '?'}`}</>
                    : 'never run'}
                </span>
                <span className="dash-cron">
                  {row?.schedules.length
                    ? row.schedules.map((sc) => <span key={sc.id} className="chip tiny accent" title={sc.cronExpr}>{friendlyCron(sc.cronExpr)}</span>)
                    : <span className="hint-inline">no schedule</span>}
                </span>
                <span className="dash-actions">
                  <button className="btn tonal small" onClick={() => p.onOpenScript(s.id, 'builder')}>Open</button>
                  <button className="btn ghost small" aria-label={`Run ${s.name} now`} title="Run now" onClick={() => p.onRunScript(s)}><Icon name="play" size={13} /></button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="dash-cols">
        <div>
          <div className="section-head"><h3>Fleet</h3></div>
          {p.fleet.length === 0
            ? <p className="side-empty">No VPS yet — add one in the sidebar.</p>
            : p.fleet.map((v) => (
              <div key={v.id} className="dash-mini">
                <span className={`dot ${v.lastSeen ? 'dot-ok' : 'dot-off'}`} />
                <b>{v.name}</b>
                <span className="dash-meta">{v.host}</span>
                <span className="hint-inline">seen {timeAgo(v.lastSeen)}</span>
              </div>
            ))}
        </div>
        <div>
          <div className="section-head"><h3>Destinations</h3></div>
          {p.dests.length === 0
            ? <p className="side-empty">No destinations yet — add SFTP, FTP or S3.</p>
            : p.dests.map((d) => (
              <div key={d.id} className="dash-mini">
                <span className={`dot ${d.lastSeen ? 'dot-ok' : 'dot-off'}`} />
                <b>{d.name}</b>
                <span className="chip tiny">{d.type}</span>
                <span className="hint-inline">tested {timeAgo(d.lastSeen)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
