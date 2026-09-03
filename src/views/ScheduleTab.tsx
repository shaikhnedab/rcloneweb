import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { FleetItem, ScheduleDoc } from '../lib/types';
import { friendlyCron } from '../lib/format';
import { CronBuilder } from '../components/CronBuilder';
import { Field, Icon, toast } from '../lib/ui';

function NowBar() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="nowbar">
      <Icon name="clock" size={13} />
      <span>Local time <b>{now.toLocaleTimeString()}</b> · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      <span className="hint-inline">scheduler checks every 5s</span>
    </div>
  );
}

interface Props {
  scriptId: string | null;
  cronExpr: string;
  setCronExpr: (v: string) => void;
  fleet: FleetItem[];
  sourceVpsId: string;
  dialog: { confirm: (t: string, m?: string, ok?: string, danger?: boolean) => Promise<boolean> };
}

export function ScheduleTab(p: Props) {
  const [schedules, setSchedules] = useState<ScheduleDoc[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [schedVps, setSchedVps] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!p.scriptId) return;
    try {
      setSchedules(await api(`/api/schedules?scriptId=${p.scriptId}`) as ScheduleDoc[]);
      setLoadError(false);
    } catch { setLoadError(true); }
  }, [p.scriptId]);

  useEffect(() => { load(); }, [load]);

  // Default the form's VPS to the builder's source VPS, else the first fleet entry.
  useEffect(() => {
    if (schedVps || !p.fleet.length) return;
    setSchedVps(p.sourceVpsId || p.fleet[0].id);
  }, [p.fleet, p.sourceVpsId, schedVps]);

  const save = async () => {
    if (!p.scriptId) { toast('Save the script first', true); return; }
    if (!schedVps) { toast('Select a VPS', true); return; }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      if (editing) {
        await api(`/api/schedules/${editing}`, { method: 'PUT', body: JSON.stringify({ vpsId: schedVps, cronExpr: p.cronExpr, enabled, timezone: tz }) });
        toast('Schedule updated');
        setEditing(null);
      } else {
        await api('/api/schedules', { method: 'POST', body: JSON.stringify({ scriptId: p.scriptId, vpsId: schedVps, cronExpr: p.cronExpr, enabled, timezone: tz }) });
        toast('Schedule added');
      }
      setSchedVps(p.fleet[0]?.id || '');
      setEnabled(true);
      load();
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div>
      <div className="card sched-card">
        <h3 className="card-title"><Icon name="clock" size={14} /> {editing ? 'Edit schedule' : 'New schedule'}</h3>
        <NowBar />
        <div className="row">
          <Field label="Run on VPS" grow>
            <select value={schedVps} onChange={(e) => setSchedVps(e.target.value)}>
              {p.fleet.length
                ? p.fleet.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.host})</option>)
                : <option value="">No VPS — add one in Fleet</option>}
            </select>
          </Field>
          <label className="check-row self-end"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <span>Enabled</span></label>
        </div>
        <CronBuilder value={p.cronExpr} onChange={p.setCronExpr} />
        <div className="row spread">
          <span>
            <button className="btn filled" onClick={save}>{editing ? 'Update schedule' : 'Add schedule'}</button>
            {editing && <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>}
          </span>
          <button className="btn tonal small" onClick={async () => {
            try {
              const r = await api('/api/schedules/trigger', { method: 'POST' }) as { count: number };
              toast(r.count ? `Triggered ${r.count} schedule(s)` : 'No schedules due right now');
            } catch (e) { toast((e as Error).message, true); }
          }}><Icon name="play" size={13} /> Run due now</button>
        </div>
      </div>

      <div className="section-head"><h3>Schedules for this script</h3></div>
      {loadError && <p className="empty-error">Couldn't load schedules. <button className="btn ghost small" onClick={load}>Retry</button></p>}
      {schedules.length === 0 && !loadError && <p className="side-empty">No schedules yet — add one above.</p>}
      {schedules.map((s) => {
        const vpsName = p.fleet.find((v) => v.id === s.vpsId)?.name || s.vpsId;
        return (
          <div key={s.id} className="sched-item">
            <div className="sched-info">
              <b>{vpsName}</b>
              <span className="chip small accent">{friendlyCron(s.cronExpr)}</span>
              <code className="mono-chip">{s.cronExpr}</code>
              <span className="hint-inline">{s.timezone}</span>
              <div className="hint-inline">Created {new Date(s.createdAt).toLocaleString()}{s.lastRun ? ` · last run ${new Date(s.lastRun).toLocaleString()}` : ''}</div>
            </div>
            <label className="switch" title={s.enabled ? 'Disable' : 'Enable'}>
              <input type="checkbox" checked={s.enabled} onChange={async () => {
                await api(`/api/schedules/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) });
                load();
              }} />
              <span className="switch-track" aria-hidden="true" />
              <span className="visually-hidden">Enabled</span>
            </label>
            <button className="btn ghost small" aria-label="Edit schedule" onClick={() => { setEditing(s.id); setSchedVps(s.vpsId); setEnabled(s.enabled); p.setCronExpr(s.cronExpr); }}><Icon name="edit" size={13} /></button>
            <button className="btn ghost small danger-text" aria-label="Delete schedule" onClick={async () => {
              const ok = await p.dialog.confirm('Delete schedule?', `The ${friendlyCron(s.cronExpr)} schedule on ${vpsName} will stop running.`, 'Delete', true);
              if (!ok) return;
              await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
              if (editing === s.id) setEditing(null);
              load();
            }}><Icon name="trash" size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}
