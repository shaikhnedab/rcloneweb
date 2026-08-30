import React, { useEffect, useState, useRef, useCallback } from 'react';
import * as Gen from './lib/generator';
import { api } from './api';

// ---------- types ----------
type Tab = 'builder' | 'script' | 'run' | 'schedule' | 'install' | 'webhook';
type ScriptDoc = { id: string; name: string; createdAt?: string; updatedAt?: string | null; rawToken?: string; cronExpr?: string; sourceVpsId?: string | null; destFleetId?: string | null; manualEdited?: boolean; script?: string; config?: Gen.AppConfig };
type FleetItem = { id: string; name: string; host: string; port: number; user: string; auth: string; hasPassword: boolean; lastSeen: string | null };
type DestItem = { id: string; name: string; type: string; host: string; port: string; user: string; remoteName: string; remotePath: string; sftpAuth: string; hasPassword: boolean; hasSecret: boolean; s3Provider: string; s3Bucket: string; s3Region: string; s3Endpoint: string; lastSeen: string | null };
type RunRec = { id: string; scriptId: string; vpsId: string; vpsName: string; name: string; dryRun: boolean; startedAt: string; finishedAt: string | null; exitCode: number | null; output: string };
type ScheduleDoc = { id: string; scriptId: string; vpsId: string; cronExpr: string; timezone: string; enabled: boolean; createdAt: string; lastRun: string | null };

// ---------- helpers ----------
function Toast({ msg, err, onDone }: { msg: string; err: boolean; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2600); return () => clearTimeout(t); }, [onDone]);
  return <div id="toast" className={err ? 'err show' : 'success show'} role="status">{msg}</div>;
}

// Generic dialog hook
function useDialog() {
  const [open, setOpen] = useState<null | { title: string; message: string; danger?: boolean; okText?: string; input?: string; placeholder?: string; resolve: (v: unknown) => void }>(null);
  const confirm = useCallback((title: string, message = '', okText = 'OK', danger = false) => new Promise<boolean>((res) => setOpen({ title, message, okText, danger, resolve: res as never })), []);
  const prompt = useCallback((title: string, message = '', def = '', placeholder = '') => new Promise<string | null>((res) => setOpen({ title, message, okText: 'Save', input: def, placeholder, resolve: res as never })), []);
  const alert = useCallback((title: string, message = '', icon = 'ℹ️') => new Promise<void>((res) => setOpen({ title: `${icon} ${title}`, message, okText: 'Close', resolve: () => res() })), []);
  const dlg = open ? (
    <div className="dlg-overlay open dialog-generic" onClick={(e) => { if (e.target === e.currentTarget) { open.resolve(open.input !== undefined ? null : false); setOpen(null); }}}>
      <div className="dlg-card" role="dialog" aria-modal="true">
        <h3 className="dlg-title">{open.title}</h3>
        {open.message && <p className="dlg-message" style={{ whiteSpace: 'pre-wrap' }}>{open.message}</p>}
        {open.input !== undefined && <input id="dlg-input" className="dlg-input" defaultValue={open.input} placeholder={open.placeholder} autoFocus />}
        <div className="dlg-actions">
          <button className="btn ghost" onClick={() => { open.resolve(open.input !== undefined ? null : false); setOpen(null); }}>Cancel</button>
          <button className={`btn filled ${open.danger ? 'danger' : ''}`} onClick={() => {
            const el = document.getElementById('dlg-input') as HTMLInputElement | null;
            open.resolve(open.input !== undefined ? (el?.value ?? '') : true); setOpen(null);
          }}>{open.okText || 'OK'}</button>
        </div>
      </div>
    </div>
  ) : null;
  return { dlg, confirm, prompt, alert };
}

// Cron builder
function CronBuilder({ value, onChange }: { value: string; onChange: (expr: string) => void }) {
  const [mode, setMode] = useState<'everyN' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'>('daily');
  const [state, setState] = useState({ nMin: 15, nHr: 6, time: '02:30', days: [1], dom: 1, custom: '*/15 * * * *' });
  const build = useCallback(() => {
    const [hh, mm] = state.time.split(':').map(Number);
    switch (mode) {
      case 'everyN': return `*/${state.nMin} * * * *`;
      case 'hourly': return `${String(mm).padStart(2,'0')} */${state.nHr} * * *`;
      case 'daily': return `${String(mm).padStart(2,'0')} ${String(hh).padStart(2,'0')} * * *`;
      case 'weekly': return `${String(mm).padStart(2,'0')} ${String(hh).padStart(2,'0')} * * ${state.days.length ? [...state.days].sort((a,b)=>a-b).join(',') : '*'}`;
      case 'monthly': return `${String(mm).padStart(2,'0')} ${String(hh).padStart(2,'0')} ${state.dom} * *`;
      case 'custom': return state.custom;
    }
  }, [mode, state]);
  const prevValueRef = useRef(value);
  const isFirstMount = useRef(true);
  // sync external value -> internal, only when value was changed externally (not from our own onChange)
  useEffect(() => {
    if (!value) return;
    if (value === build()) return;
    if (value === prevValueRef.current) return;
    prevValueRef.current = value;
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 5) { setMode('custom'); setState(s => ({ ...s, custom: value })); return; }
    const [mi, h, dom, , dow] = parts;
    if (/^\*\/\d+$/.test(mi) && h === '*') { setMode('everyN'); setState(s=>({ ...s, nMin: parseInt(mi.slice(2),10)||15 })); return; }
    if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) { setMode('hourly'); setState(s=>({ ...s, nHr: parseInt(h.slice(2),10)||6, time: `00:${String(parseInt(mi,10)).padStart(2,'0')}`})); return; }
    if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom==='*' && dow==='*') { setMode('daily'); setState(s=>({ ...s, time: `${String(parseInt(h,10)).padStart(2,'0')}:${String(parseInt(mi,10)).padStart(2,'0')}` })); return; }
    if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom==='*' && dow!=='*') { setMode('weekly'); setState(s=>({ ...s, time: `${String(parseInt(h,10)).padStart(2,'0')}:${String(parseInt(mi,10)).padStart(2,'0')}`, days: dow.split(',').map(v=>parseInt(v,10)).filter(n=>!isNaN(n)) })); return; }
    if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom!=='*') { setMode('monthly'); setState(s=>({ ...s, time: `${String(parseInt(h,10)).padStart(2,'0')}:${String(parseInt(mi,10)).padStart(2,'0')}`, dom: parseInt(dom,10)||1 })); return; }
    setMode('custom'); setState(s=>({ ...s, custom: value }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    const v = build();
    if (v === value) return;
    if (v === prevValueRef.current) return;
    prevValueRef.current = v;
    onChange(v);
  }, [build, onChange, value]);
  const DAYS = [{v:0,n:'Sun'},{v:1,n:'Mon'},{v:2,n:'Tue'},{v:3,n:'Wed'},{v:4,n:'Thu'},{v:5,n:'Fri'},{v:6,n:'Sat'}];
  const describeCron = (expr: string) => {
    const [mi,h,dom,,dow] = expr.split(' ');
    if (/^\*\/\d+$/.test(mi) && h==='*') return `Every ${mi.slice(2)} minutes`;
    if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) return `Every ${h.slice(2)} hours`;
    const hm = `${h.padStart(2,'0')}:${mi.padStart(2,'0')}`;
    if (dom==='*' && dow==='*') return `Every day at ${hm}`;
    if (dow!=='*') return `${dow.split(',').map(d=>DAYS[+d]?.n ?? d).join(', ')} at ${hm}`;
    if (dom!=='*') return `Day ${dom} of month at ${hm}`;
    return expr;
  };
  const describe = describeCron;
  const expr = build();
  return (
    <div className="cron-builder">
      <div className="cron-chips">
        {([['everyN','⏱ Every N min'],['hourly','🕒 Every N hrs'],['daily','📅 Daily'],['weekly','📆 Weekly'],['monthly','🗓 Monthly'],['custom','⚙ Advanced']] as const).map(([m,l]) => (
          <button key={m} type="button" className={`chip ${m===mode?'active':''}`} onClick={()=>setMode(m as never)}>{l}</button>
        ))}
      </div>
      <div className="cron-body">
        {mode==='everyN' && <><label className="field">Run every <input type="number" min={1} max={59} value={state.nMin} onChange={e=>setState(s=>({...s,nMin:Math.max(1,Math.min(59,Number(e.target.value)||1))}))} /></label><span className="unit">minutes</span></>}
        {mode==='hourly' && <><label className="field">Run every <input type="number" min={1} max={23} value={state.nHr} onChange={e=>setState(s=>({...s,nHr:Math.max(1,Math.min(23,Number(e.target.value)||1))}))} /></label><span className="unit">hours</span><label className="field">at minute <input type="number" min={0} max={59} value={Number(state.time.split(':')[1])} onChange={e=>{const [hh]=state.time.split(':'); const mm=String(Math.min(59,Math.max(0,Number(e.target.value)||0))).padStart(2,'0'); setState(s=>({...s,time:`${hh}:${mm}`}));}} /></label></>}
        {mode==='daily' && <label className="field">Time of day <input type="time" value={state.time} onChange={e=>setState(s=>({...s,time:e.target.value||'02:30'}))} /></label>}
        {mode==='weekly' && <><div className="day-chips">{DAYS.map(d=><button key={d.v} type="button" className={`chip day ${state.days.includes(d.v)?'active':''}`} onClick={()=>setState(s=>{const a=s.days.includes(d.v)?s.days.filter(x=>x!==d.v):[...s.days,d.v]; return {...s,days:a};})}>{d.n}</button>)}</div><label className="field">Time <input type="time" value={state.time} onChange={e=>setState(s=>({...s,time:e.target.value||'02:30'}))} /></label></>}
        {mode==='monthly' && <><label className="field">Day of month <input type="number" min={1} max={28} value={state.dom} onChange={e=>setState(s=>({...s,dom:Math.max(1,Math.min(28,Number(e.target.value)||1))}))} /></label><label className="field">Time <input type="time" value={state.time} onChange={e=>setState(s=>({...s,time:e.target.value||'02:30'}))} /></label></>}
        {mode==='custom' && <label className="field grow">Cron expression <input value={state.custom} spellCheck={false} onChange={e=>setState(s=>({...s,custom:e.target.value}))} /></label>}
      </div>
      <div className="cron-out"><div className="cron-summary">📅 {describe(expr)}</div><code className="cron-expr">{expr}</code></div>
    </div>
  );
}

const FRIENDLY_DAYS = [{v:0,n:'Sun'},{v:1,n:'Mon'},{v:2,n:'Tue'},{v:3,n:'Wed'},{v:4,n:'Thu'},{v:5,n:'Fri'},{v:6,n:'Sat'}];
function friendlyCron(expr: string): string {
  const [mi,h,dom,,dow] = expr.split(' ');
  if (/^\*\/\d+$/.test(mi) && h==='*') return `Every ${mi.slice(2)} minutes`;
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) return `Every ${h.slice(2)} hours`;
  const hm = `${h.padStart(2,'0')}:${mi.padStart(2,'0')}`;
  if (dom==='*' && dow==='*') return `Every day at ${hm}`;
  if (dow!=='*') return `${dow.split(',').map(d=>FRIENDLY_DAYS[+d]?.n ?? d).join(', ')} at ${hm}`;
  if (dom!=='*') return `Day ${dom} of month at ${hm}`;
  return expr;
}

function NowBar() {
  const [now, setNow] = useState(new Date());
  useEffect(()=>{ const id=setInterval(()=>setNow(new Date()), 1000); return()=>clearInterval(id); },[]);
  return (
    <div className="hint" style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'center', marginBottom:8, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 12px' }}>
      <span>🕐 Now: <b>{now.toLocaleString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</b> <span style={{ opacity:0.7 }}>({Intl.DateTimeFormat().resolvedOptions().timeZone})</span> <span style={{ fontVariantNumeric:'tabular-nums', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:6, padding:'2px 6px', marginLeft:6 }}>{now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</span></span>
      <span>•</span>
      <span>Next check: {new Date(Math.ceil(Date.now()/30000)*30000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</span>
      <span style={{ opacity:0.7 }}>— live</span>
    </div>
  );
}

function LiveStats({ run }: { run: RunRec | null }) {
  if (!run) return null;
  const out = run.output || '';
  // Parse last Transferred line: "Transferred: 10 MiB / 100 MiB, 10%, 5 MiB/s, ETA 18s"
  const lines = out.split('\n');
  let transferred = '—', speed = '—', eta = '—', checks = '';
  for (const line of lines) {
    const hasTrans = /Transferred\s*:/i.test(line) || /\d+(?:\.\d+)?\s*[KMGT]?i?B\s*\/\s*\d/.test(line);
    if (!hasTrans) continue;
    const mTrans = line.match(/([0-9.]+\s*[KMGT]?i?B\s*\/\s*[0-9.]+\s*[KMGT]?i?B)/i);
    if (mTrans) transferred = mTrans[1].trim();
    const mSpeed = line.match(/(\d+(?:\.\d+)?\s*[KMGT]?i?B\/s)/i);
    if (mSpeed) speed = mSpeed[0];
    const mEta = line.match(/ETA\s+([^\n,)]+)/i);
    if (mEta) eta = mEta[1].trim();
  }
  const mChecks = out.match(/Checks:\s*([^\n]+)/i);
  if (mChecks) checks = mChecks[1].trim();
  const start = new Date(run.startedAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.floor((end - start)/1000));
  const elapsed = `${Math.floor(elapsedSec/60)}m ${elapsedSec%60}s`;
  return (
    <div className="preview-card" style={{ margin:'12px 0', padding:'10px 14px', display:'flex', gap:14, flexWrap:'wrap', fontSize:12, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12 }}>
      <span><b>⏱ Elapsed:</b> {elapsed}</span>
      <span><b>📦 Transferred:</b> {transferred}</span>
      {speed!=='—' && <span><b>⚡ Speed:</b> {speed}</span>}
      {eta!=='—' && eta!=='-' && <span><b>⏳ ETA:</b> {eta}</span>}
      {checks && <span><b>✔ Checks:</b> {checks}</span>}
      <span style={{ marginLeft:'auto' }}><b>Status:</b> {run.finishedAt ? (run.exitCode===0?'✅ OK':'❌ Failed') : '⏳ Running'}</span>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<'dark'|'light'>(() => (localStorage.getItem('rcloneweb_theme') as 'dark'|'light') || 'dark');
  useEffect(()=>{ document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('rcloneweb_theme', theme); }, [theme]);

  const [auth, setAuth] = useState<null | { setupNeeded: boolean; authenticated: boolean; username: string | null }>(null);
  const [authForm, setAuthForm] = useState({ user: '', pass: '' });
  const [authErr, setAuthErr] = useState('');
  const refreshAuth = useCallback(async () => {
    try { const s = await api('/api/auth/status') as { setupNeeded: boolean; authenticated: boolean; username: string | null }; setAuth(s); if (s.authenticated) setAuthErr(''); } catch { setAuth({ setupNeeded: false, authenticated: false, username: null }); }
  }, []);
  useEffect(()=>{ refreshAuth(); }, [refreshAuth]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = authForm.user.trim(); const p = authForm.pass;
    if (!u || p.length < 6) { setAuthErr('Username required, password must be at least 6 characters'); return; }
    const url = auth?.setupNeeded ? '/api/auth/setup' : '/api/auth/login';
    try { await api(url, { method: 'POST', body: JSON.stringify({ username: u, password: p }) }); setAuthForm({ user:'', pass:'' }); setAuthErr(''); await refreshAuth(); }
    catch (err: unknown) { setAuthErr((err as Error).message); }
  };
  const doLogout = async () => { await api('/api/auth/logout', { method: 'POST' }); await refreshAuth(); };

  // app state
  const [scripts, setScripts] = useState<{id:string;name:string;updatedAt:string}[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<ScriptDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>('builder');
  const [cronExpr, setCronExpr] = useState('0 2 * * *');
  const [toast, setToast] = useState<{msg:string;err:boolean}|null>(null);
  const showToast = useCallback((msg:string, err=false) => setToast({msg,err}), []);
  const dialog = useDialog();

  // fleet & dest
  const [fleet, setFleet] = useState<FleetItem[]>([]);
  const [dests, setDests] = useState<DestItem[]>([]);
  const loadFleet = useCallback(async ()=>{ try { setFleet(await api('/api/fleet') as FleetItem[]);} catch {} }, []);
  const loadDests = useCallback(async ()=>{ try { setDests(await api('/api/destinations') as DestItem[]);} catch {} }, []);
  const loadScripts = useCallback(async (active?: string | null) => {
    try { const list = await api('/api/scripts') as {id:string;name:string;updatedAt:string}[]; setScripts(list); if (active) setSelectedId(active); } catch {}
  }, []);
  useEffect(()=>{ if (auth?.authenticated) { loadScripts(); loadFleet(); loadDests(); } }, [auth?.authenticated, loadScripts, loadFleet, loadDests]);

  // builder config derived from doc + editable local state
  const [cfg, setCfg] = useState<Gen.AppConfig>(() => Gen.defaultConfig());
  // sync cfg when doc changes
  useEffect(()=>{ if (doc?.config) { setCfg(Gen.normalize(doc.config)); setCronExpr(doc.cronExpr || '0 2 * * *'); } else if (!selectedId) { setCfg(Gen.defaultConfig()); } }, [doc, selectedId]);
  // keep sourceVps/destFleet ids separate
  const [sourceVpsId, setSourceVpsId] = useState<string>('');
  const [destFleetId, setDestFleetId] = useState<string>('manual');
  useEffect(()=>{ if (doc) { setSourceVpsId(doc.sourceVpsId || ''); setDestFleetId(doc.destFleetId || 'manual'); } }, [doc]);

  const scriptText = doc?.script ?? '';
  const [editorText, setEditorText] = useState('');
  useEffect(()=>{ setEditorText(scriptText); }, [scriptText]);
  const [manualEdited, setManualEdited] = useState(false);
  useEffect(()=>{ setManualEdited(Boolean(doc?.manualEdited)); }, [doc]);
  const [previewStatus, setPreviewStatus] = useState<'success'|'fail'>('success');

  // generate live script for preview
  const liveScript = (()=>{ try { return Gen.buildScript(cfg); } catch (e) { return `// ${(e as Error).message}`; } })();
  const discordPreview = (()=>{ try { return Gen.buildPayload(cfg, previewStatus === 'fail' ? 'FAIL' : 'SUCCESS', { host: 'myserver', duration: '42s', logTail: previewStatus==='fail' ? '[ERROR] rclone: failed to copy: dial tcp 10.0.0.5:22: connect refused' : null }); } catch { return null; } })();

  // fleet/dest dialogs state
  const [vpsDlg, setVpsDlg] = useState<null | Partial<FleetItem & { password?: string; keyPath?: string }>>(null);
  const [destDlg, setDestDlg] = useState<null | Partial<DestItem & { password?: string; s3AccessKey?: string; s3SecretKey?: string; keyPath?: string }>>(null);
  const [vpsTestResult, setVpsTestResult] = useState('');
  const [vpsTesting, setVpsTesting] = useState(false);
  const [destTestResult, setDestTestResult] = useState('');
  const [destTesting, setDestTesting] = useState(false);
  const [browse, setBrowse] = useState<null | { kind: 'src'|'dest'|'include'|'exclude'; rowIdx: number; mode: 'vps'|'remote'|'remoteFleet'; vpsId?: string; destId?: string; remoteCfg?: Record<string,string>; path: string; entries: { name: string; path: string; isDir: boolean; isParent?: boolean }[]; hint: string; selected: string[] }>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  // runs
  const [runs, setRuns] = useState<RunRec[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runVps, setRunVps] = useState<string>('');
  const pollRef = useRef<number | null>(null);
  const loadRuns = useCallback(async () => {
    if (!selectedId) return;
    try {
      const list = await api(`/api/scripts/${selectedId}/runs`) as RunRec[];
      setRuns(list);
      // auto-select latest
      if (list.length && !activeRunId) setActiveRunId(list[0].id);
    } catch {}
  }, [selectedId, activeRunId]);
  useEffect(()=>{ if (selectedId && tab==='run') loadRuns(); }, [selectedId, tab, loadRuns]);
  // polling when running
  useEffect(()=>{
    const anyRunning = runs.some(r=>!r.finishedAt);
    if (!anyRunning) { if (pollRef.current) window.clearTimeout(pollRef.current); return; }
    pollRef.current = window.setTimeout(loadRuns, 900);
    return () => { if (pollRef.current) window.clearTimeout(pollRef.current); };
  }, [runs, loadRuns]);
  // also poll every 30s for scheduler trigger (more responsive than 60s)
  useEffect(()=>{
    const id = window.setInterval(async()=>{ try{ const r = await api('/api/schedules/trigger', { method: 'POST' }) as {count:number}; if (r.count) { showToast(`Auto-ran ${r.count} schedule(s)`); loadRuns(); } } catch {} }, 30000);
    return ()=> window.clearInterval(id);
  }, [loadRuns, showToast]);

  // schedules
  const [schedules, setSchedules] = useState<ScheduleDoc[]>([]);
  const loadSchedules = useCallback(async()=>{ if(!selectedId) return; try{ setSchedules(await api(`/api/schedules?scriptId=${selectedId}`) as ScheduleDoc[]);} catch {} }, [selectedId]);
  useEffect(()=>{ if (tab==='schedule' && selectedId) loadSchedules(); }, [tab, selectedId, loadSchedules]);
  const [editingSched, setEditingSched] = useState<string | null>(null);
  const [schedVps, setSchedVps] = useState('');
  const [schedEnabled, setSchedEnabled] = useState(true);
  // auto-select VPS for schedule form from builder's source or first fleet — no loop
  useEffect(()=>{ if (schedVps || !fleet.length) return; setSchedVps(sourceVpsId || fleet[0].id); }, [fleet, sourceVpsId]);
  useEffect(()=>{ if (tab!=='schedule' || schedVps || !fleet.length) return; setSchedVps(sourceVpsId || fleet[0].id); }, [tab]);

  // account dialog
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountForm, setAccountForm] = useState({ currentPass:'', newUser:'', newPass:'' });

  const markDirty = useCallback(()=> setDirty(true), []);

  const openDoc = async (id: string) => {
    if (dirty) {
      const ok = await dialog.confirm('Unsaved changes', 'Discard your current edits?', 'Discard', true);
      if (!ok) return;
    }
    try {
      const d = await api(`/api/scripts/${id}`) as ScriptDoc;
      setSelectedId(d.id); setDoc(d); setDirty(false); setTab('builder');
    } catch (e) { showToast((e as Error).message, true); }
  };
  const newDoc = async () => {
    if (dirty) {
      const ok = await dialog.confirm('Unsaved changes', 'Discard?', 'Discard', true);
      if (!ok) return;
    }
    const draftCfg = Gen.defaultConfig();
    const draft: ScriptDoc = {
      id: '__new__',
      name: '',
      config: draftCfg,
      cronExpr: '0 2 * * *',
      sourceVpsId: null,
      destFleetId: null,
      script: Gen.buildScript(draftCfg),
      manualEdited: false,
    };
    setSelectedId(null); setDoc(draft); setCfg(draftCfg); setCronExpr('0 2 * * *'); setSourceVpsId(''); setDestFleetId('manual'); setEditorText(Gen.buildScript(draftCfg)); setManualEdited(false); setDirty(true); setTab('builder');
    setTimeout(()=> (document.getElementById('f-name') as HTMLInputElement | null)?.focus(), 50);
  };
  const saveDoc = async () => {
    const name = (document.getElementById('f-name') as HTMLInputElement)?.value?.trim() || cfg.name || 'untitled';
    if (/[;|&$`<>]/.test(cfg.options.extraFlags) || /\$\(/.test(cfg.options.extraFlags)) { showToast('Extra flags contains invalid shell characters', true); return; }
    if (!sourceVpsId) { showToast('Select a Source VPS first', true); return; }
    let generated: string;
    try { generated = Gen.buildScript(cfg); } catch (e) { showToast((e as Error).message, true); return; }
    const scriptToSave = manualEdited ? editorText : generated;
    const body: Record<string, unknown> = {
      ...(doc || {}),
      name,
      config: cfg,
      cronExpr,
      sourceVpsId: sourceVpsId || null,
      destFleetId: destFleetId === 'manual' ? null : destFleetId,
      script: scriptToSave,
      manualEdited,
    };
    try {
      const saved = await api(selectedId ? `/api/scripts/${selectedId}` : '/api/scripts', { method: selectedId ? 'PUT' : 'POST', body: JSON.stringify(body) }) as ScriptDoc;
      setSelectedId(saved.id); setDoc(saved); setDirty(false); setManualEdited(Boolean(saved.manualEdited));
      await loadScripts(saved.id);
      showToast(selectedId ? 'Saved' : 'Script created');
    } catch (e) { showToast(`Save failed: ${(e as Error).message}`, true); }
  };
  const deleteDoc = async () => {
    if (!selectedId || !doc) return;
    const ok = await dialog.confirm('Delete script?', `Delete "${doc.name}"? This cannot be undone.`, 'Delete', true);
    if (!ok) return;
    await api(`/api/scripts/${selectedId}`, { method: 'DELETE' });
    setSelectedId(null); setDoc(null); setDirty(false); await loadScripts(); showToast('Deleted');
  };

  // copy helper
  const copyText = async (text: string) => { try { await navigator.clipboard.writeText(text); showToast('Copied'); } catch { showToast('Copy failed', true); } };

  // browse helpers
  const openBrowseForRow = async (rowIdx: number, kind: 'src'|'dest'|'include'|'exclude') => {
    const row = cfg.sources[rowIdx];
    setBrowseLoading(true);
    // show dialog immediately with loading state so user sees feedback
    const existingSel = kind!=='src' && (kind==='include' || kind==='exclude') ? (kind==='include' ? row.include : row.exclude).split(/[,\s]+/).filter(Boolean) : [];
    // set a temporary browse to show dialog
    if (kind==='src' || kind==='include' || kind==='exclude') {
      if (!sourceVpsId) { showToast('Select a Source VPS first', true); setBrowseLoading(false); return; }
      setBrowse({ kind, rowIdx, mode: 'vps', vpsId: sourceVpsId, path: kind==='src' ? (row.path || '/') : '/', entries: [], hint: 'Loading…', selected: existingSel });
    } else if (destFleetId !== 'manual') {
      const cur = row.dest || '';
      const p = cur.includes(':') ? cur.split(':').slice(1).join(':') : (cur || '/');
      setBrowse({ kind, rowIdx, mode: 'remoteFleet', destId: destFleetId, path: p || '/', entries: [], hint: 'Loading…', selected: [] });
    } else {
      const cur = row.dest || '';
      const p = cur.includes(':') ? cur.split(':').slice(1).join(':') : '';
      const payload: Record<string,string> = {
        type: cfg.dest.type, host: cfg.dest.host, port: cfg.dest.port, user: cfg.dest.user, sftpAuth: cfg.dest.sftpAuth, keyPath: cfg.dest.keyPath,
        bucket: cfg.dest.s3Bucket, region: cfg.dest.s3Region, endpoint: cfg.dest.s3Endpoint, provider: cfg.dest.s3Provider,
        password: cfg.secrets.password, accessKey: cfg.secrets.s3AccessKey, secretKey: cfg.secrets.s3SecretKey, path: p,
      };
      setBrowse({ kind, rowIdx, mode: 'remote', remoteCfg: payload, path: p, entries: [], hint: 'Loading…', selected: [] });
    }
    try {
      if (kind==='src' || kind==='include' || kind==='exclude') {
        const path = kind==='src' ? (row.path || '/') : '/';
        const res = await api(`/api/fleet/${sourceVpsId}/browse`, { method: 'POST', body: JSON.stringify({ path }) }) as { ok: boolean; path: string; entries: { name: string; path: string; isDir: boolean; isParent?: boolean }[]; msg?: string };
        if (!res.ok) { showToast(res.msg || 'Failed', true); setBrowse(null); return; }
        const existing = kind!=='src' ? (kind==='include' ? row.include : row.exclude).split(/[,\s]+/).filter(Boolean) : [];
        setBrowse({ kind, rowIdx, mode: 'vps', vpsId: sourceVpsId, path: res.path, entries: res.entries, hint: `${res.entries.length} items`, selected: existing });
        return;
      }
      if (destFleetId !== 'manual') {
        const cur = row.dest || '';
        const p = cur.includes(':') ? cur.split(':').slice(1).join(':') : (cur || '/');
        const res = await api(`/api/destinations/${destFleetId}/browse`, { method: 'POST', body: JSON.stringify({ path: p || '/' }) }) as { ok: boolean; path: string; entries: { name: string; path: string; isDir: boolean }[]; msg?: string };
        if (!res.ok) { showToast(res.msg || 'Failed', true); setBrowse(null); return; }
        setBrowse({ kind, rowIdx, mode: 'remoteFleet', destId: destFleetId, path: res.path, entries: res.entries as never, hint: `${res.entries.length} items`, selected: [] });
      } else {
        const cur = row.dest || '';
        const p = cur.includes(':') ? cur.split(':').slice(1).join(':') : '';
        const payload: Record<string,string> = {
          type: cfg.dest.type, host: cfg.dest.host, port: cfg.dest.port, user: cfg.dest.user, sftpAuth: cfg.dest.sftpAuth, keyPath: cfg.dest.keyPath,
          bucket: cfg.dest.s3Bucket, region: cfg.dest.s3Region, endpoint: cfg.dest.s3Endpoint, provider: cfg.dest.s3Provider,
          password: cfg.secrets.password, accessKey: cfg.secrets.s3AccessKey, secretKey: cfg.secrets.s3SecretKey, path: p,
        };
        const res = await api('/api/browse/remote', { method: 'POST', body: JSON.stringify(payload) }) as { ok: boolean; path: string; entries: { name: string; path: string; isDir: boolean }[]; msg?: string };
        if (!res.ok) { showToast(res.msg || 'Failed', true); setBrowse(null); return; }
        setBrowse({ kind, rowIdx, mode: 'remote', remoteCfg: payload, path: res.path, entries: res.entries as never, hint: `${res.entries.length} items`, selected: [] });
      }
    } catch (e) {
      const msg = (e as unknown as { data?: { msg?: string } })?.data?.msg || (e as Error).message;
      showToast(String(msg), true);
      setBrowse(null);
    } finally { setBrowseLoading(false); }
  };
  const loadBrowsePath = async (path: string) => {
    if (!browse) return;
    setBrowseLoading(true);
    setBrowse(b=> b ? { ...b, hint: 'Loading…' } : b);
    try {
      let res: { ok: boolean; path: string; entries: { name: string; path: string; isDir: boolean; isParent?: boolean }[]; msg?: string };
      if (browse.mode === 'vps' && browse.vpsId) res = await api(`/api/fleet/${browse.vpsId}/browse`, { method: 'POST', body: JSON.stringify({ path }) }) as never;
      else if (browse.mode === 'remoteFleet' && browse.destId) res = await api(`/api/destinations/${browse.destId}/browse`, { method: 'POST', body: JSON.stringify({ path }) }) as never;
      else res = await api('/api/browse/remote', { method: 'POST', body: JSON.stringify({ ...(browse.remoteCfg||{}), path }) }) as never;
      if (!res.ok) { showToast(res.msg || 'Failed', true); return; }
      setBrowse(b=> b ? { ...b, path: res.path, entries: res.entries, hint: `${res.entries.length} items` } : null);
    } catch (e) {
      const msg = (e as unknown as { data?: { msg?: string } })?.data?.msg || (e as Error).message;
      showToast(String(msg), true);
    } finally { setBrowseLoading(false); }
  };

  if (!auth) return <div style={{ display:'grid', placeItems:'center', minHeight:'100vh' }}>Loading…</div>;
  if (!auth.authenticated) {
    return (
      <div id="auth-view" className="auth-view">
        <div className="auth-card">
          <div className="brand center"><span className="logo">📦</span> rcloneweb</div>
          <p className="hint center">{auth.setupNeeded ? 'Create the first admin account' : 'Sign in to continue'}</p>
          <form onSubmit={handleAuth}>
            <label className="field">Username <input value={authForm.user} onChange={e=>setAuthForm(s=>({...s,user:e.target.value}))} autoComplete="username" spellCheck={false} required /></label>
            <label className="field">Password <input type="password" value={authForm.pass} onChange={e=>setAuthForm(s=>({...s,pass:e.target.value}))} autoComplete="current-password" required /></label>
            <button type="submit" className="btn filled block">{auth.setupNeeded ? 'Create account' : 'Sign in'}</button>
          </form>
          {authErr && <p className="auth-error">{authErr}</p>}
        </div>
        {dialog.dlg}
      </div>
    );
  }

  const rawToken = doc?.rawToken || '';
  const baseUrl = window.location.origin;
  const rawUrl = selectedId ? `${baseUrl}/raw/${selectedId}.sh?token=${encodeURIComponent(rawToken)}` : '';
  const needsFleet = fleet.length === 0;

  return (
    <div id="app" style={{ display:'flex', height:'100vh' }}>
      <aside id="sidebar">
        <div className="brand"><span className="logo">📦</span> rcloneweb <span className="sub">backup script builder</span></div>
        <button className="btn filled tonal block" onClick={newDoc}>+ New Script</button>
        <div className="fleet-block">
          <div className="fleet-head"><span>🖥 Fleet</span><button className="btn tonal small" onClick={()=>{ setVpsDlg({}); setVpsTestResult(''); }}>+ Add VPS</button></div>
          <nav id="fleet-list">
            {fleet.length===0 ? <p className="hint" style={{padding:'4px 8px'}}>no VPS yet</p> : fleet.map(v=>(
              <div key={v.id} className="fleet-item">
                <span className={`fleet-dot ${v.lastSeen?'online':''}`} />
                <span className="nm" title={v.host}>{v.name}</span>
                <span className="fleet-actions">
                  <button className="fleet-btn edit" onClick={async()=>{
                    const full = await api(`/api/fleet/${v.id}`) as FleetItem & {keyPath:string};
                    setVpsDlg({ ...full, password: '' }); setVpsTestResult('');
                  }}>✎</button>
                  <button className="fleet-btn danger" onClick={async()=>{
                    const ok = await dialog.confirm('Delete VPS?', `Delete "${v.name}"?`, 'Delete', true);
                    if (!ok) return;
                    await api(`/api/fleet/${v.id}`, { method:'DELETE' }); await loadFleet(); showToast('VPS deleted');
                  }}>✕</button>
                </span>
              </div>
            ))}
          </nav>
        </div>
        <div className="fleet-block">
          <div className="fleet-head"><span>☁️ Destinations</span><button className="btn tonal small" onClick={()=>{ setDestDlg({type:'sftp'}); setDestTestResult(''); }}>+ Add</button></div>
          <nav id="dest-list">
            {dests.length===0 ? <p className="hint" style={{padding:'4px 8px'}}>no destinations yet</p> : dests.map(d=>(
              <div key={d.id} className="fleet-item" onClick={()=>{ setDestFleetId(d.id); setDirty(true); showToast(`Selected ${d.name}`); }}>
                <span className={`fleet-dot ${d.lastSeen?'online':''}`} />
                <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(d.type==='s3'?'🪣':d.type==='ftp'?'📂':'🔐')} {d.name}</span>
                <span className="fleet-actions">
                  <button className="fleet-btn edit" onClick={async(e)=>{ e.stopPropagation(); const full = await api(`/api/destinations/${d.id}`) as DestItem & {keyPath:string}; setDestDlg({ ...full, password:'', s3AccessKey:'', s3SecretKey:'' }); setDestTestResult(''); }}>✎</button>
                  <button className="fleet-btn danger" onClick={async(e)=>{ e.stopPropagation(); const ok=await dialog.confirm('Delete destination?', `Delete "${d.name}"?`, 'Delete', true); if(!ok) return; await api(`/api/destinations/${d.id}`,{method:'DELETE'}); await loadDests(); showToast('Destination deleted'); }}>✕</button>
                </span>
              </div>
            ))}
          </nav>
        </div>
        <div className="sidebar-sep" />
        <div className="sidebar-label">📜 Scripts</div>
        <nav id="script-list" style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:2 }}>
          {scripts.map(s=>(
            <div key={s.id} className={`script-item ${s.id===selectedId?'active':''}`} onClick={()=>openDoc(s.id)}>
              <span className="nm">{s.name}</span>
              <button className="del" onClick={async(e)=>{ e.stopPropagation(); const ok=await dialog.confirm('Delete script?', `Delete "${s.name}"?`, 'Delete', true); if(!ok) return; await api(`/api/scripts/${s.id}`,{method:'DELETE'}); if(s.id===selectedId){ setSelectedId(null); setDoc(null);} await loadScripts(); showToast('Deleted'); }}>🗑</button>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          logged in as <b>{auth.username}</b> · <a href="#" onClick={(e)=>{e.preventDefault(); setAccountOpen(true);}}>account</a> · <a href="#" onClick={(e)=>{e.preventDefault(); doLogout();}}>sign out</a>
        </div>
      </aside>

      <main id="main" style={{ flex:1, overflowY:'auto', padding:'20px 28px 70px' }}>
        {!selectedId && !doc ? (
          <section className="empty-state">
            <div className="empty-icon">📦</div>
            <h1>No script selected</h1>
            <p>Create a new backup script or pick one from the sidebar.</p>
            <p>Build rclone sync scripts for <b>SFTP / FTP / S3</b> destinations with live Discord webhook previews, a full bash editor, one-click runs, and curl-able install links.</p>
            {needsFleet && <p className="hint" style={{marginTop:12, color:'var(--danger)'}}>Add a VPS in Fleet first — the panel runs backups over SSH.</p>}
          </section>
        ) : (
          <section>
            <header id="topbar" style={{ display:'flex', alignItems:'center', gap:14, marginBottom:14, flexWrap:'wrap' }}>
              <input id="f-name" className="name-input" placeholder="script name" value={cfg.name} onChange={e=>{ setCfg(c=>({...c,name:e.target.value})); markDirty(); }} spellCheck={false} style={{ flex:'0 1 420px', background:'transparent', border:'1.5px solid transparent', fontSize:21, fontWeight:700, padding:'6px 10px', borderRadius:10 }} />
              <div className="topbar-actions" style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
                <span id="save-status" style={{ color:'var(--text-muted)', fontSize:12 }}>{dirty ? 'unsaved changes' : ''}</span>
                <button className="btn filled" onClick={saveDoc}>💾 Save</button>
                <button className="btn icon-btn danger-text" title="Delete" onClick={deleteDoc}>🗑</button>
                <button className="btn icon-btn" title="Toggle theme" onClick={()=>setTheme(t=>t==='dark'?'light':'dark')}>{theme==='dark'?'☀️':'🌙'}</button>
              </div>
            </header>

            <div className="tabs" role="tablist">
              {(['builder','script','run','schedule','install','webhook'] as Tab[]).map(t=>(
                <button key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)}>
                  {t==='builder'?'🛠 Builder':t==='script'?'📜 Script Editor':t==='run'?'▶ Run & Logs':t==='schedule'?'⏰ Schedule':t==='install'?'🔗 Install':'🔔 Webhook Test'}
                </button>
              ))}
            </div>

            {tab==='builder' && (
              <div className="builder-grid" style={{ display:'grid', gridTemplateColumns:'minmax(430px,1fr) minmax(430px,1fr)', gap:24 }}>
                <div className="col-form">
                  <div className="pipeline" style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:12, fontFamily:'JetBrains Mono, monospace', fontSize:11 }}>
                    <span className="pipeline__node" style={{ padding:'4px 8px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:999, fontWeight:600 }}>Source</span>
                    <span style={{ flex:1, height:2, background:'var(--border)', borderRadius:999 }} />
                    <span className="pipeline__node" style={{ padding:'4px 8px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:999, fontWeight:600 }}>rclone</span>
                    <span style={{ flex:1, height:2, background:'var(--border)', borderRadius:999 }} />
                    <span className="pipeline__node" style={{ padding:'4px 8px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:999, fontWeight:600 }}>Destination</span>
                  </div>

                  <fieldset style={{ border:'1px solid var(--border)', borderRadius:16, padding:'16px 18px', marginTop:18, background:'var(--surface)' }}>
                    <legend><span className="step-num" style={{ display:'inline-grid', placeItems:'center', width:22, height:22, borderRadius:'50%', background:'var(--primary)', color:'var(--on-primary)', fontSize:12, fontWeight:800 }}>0</span> Source VPS</legend>
                    <div className="row" style={{ display:'flex', gap:14, alignItems:'end', flexWrap:'wrap' }}>
                      <label className="field grow">Run on <select value={sourceVpsId} onChange={e=>{ setSourceVpsId(e.target.value); setRunVps(e.target.value); markDirty();}}><option value="">— Select VPS —</option>{fleet.map(v=><option key={v.id} value={v.id}>{v.name} ({v.host})</option>)}</select></label>
                      <button className="btn tonal small" onClick={async()=>{
                        if(!sourceVpsId) return showToast('Select a Source VPS first', true);
                        const btn = document.getElementById('btn-test-source'); if(btn) btn.textContent='…';
                        try { const r = await api(`/api/fleet/${sourceVpsId}/test`, { method:'POST' }) as { ok:boolean; msg:string }; showToast(r.msg, !r.ok); } catch(e){ showToast((e as Error).message, true);} finally { if(btn) btn.textContent='🔍 Test'; }
                      }} id="btn-test-source">🔍 Test</button>
                    </div>
                    <p className="hint">Select a fleet VPS to execute the backup via SSH.</p>
                  </fieldset>

                  <fieldset style={{ border:'1px solid var(--border)', borderRadius:16, padding:'16px 18px', background:'var(--surface)', marginTop:12 }}>
                    <legend><span className="step-num" style={{ display:'inline-grid', placeItems:'center', width:22, height:22, borderRadius:'50%', background:'var(--primary)', color:'var(--on-primary)', fontSize:12, fontWeight:800 }}>1</span> Source folders &amp; files</legend>
                    <p className="hint">Each card is <code>source → remote</code>. Use 📂 to browse source VPS and ☁️ to browse remote. Check <b>Folder</b> to create the folder itself inside the destination.</p>
                    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                    {cfg.sources.map((s, idx)=>(
                      <div key={idx} className="source-card" style={{ background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:12, padding:14, display:'flex', flexDirection:'column', gap:10 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <span style={{ display:'inline-grid', placeItems:'center', width:26, height:26, borderRadius:'50%', background:'var(--primary)', color:'var(--on-primary)', fontSize:12, fontWeight:800, flexShrink:0 }}>#{idx+1}</span>
                          <span style={{ flex:1, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={s.path}>{s.path || '/'}</span>
                          <span className="hint" style={{ fontSize:12, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.dest ? `→ ${s.dest}` : `→ ${s.path !== '/' && (s.preserveParent ?? s.path !== '/') ? '…/' + (s.path.split('/').pop()||'') : 'contents'}`}</span>
                          <button type="button" onClick={()=>{ setCfg(c=>({...c, sources:c.sources.filter((_,i)=>i!==idx)})); markDirty(); }} title="Remove source" style={{ background:'none', border:'none', color:'var(--danger)', cursor:'pointer', fontSize:16, padding:'4px 8px' }}>✕</button>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                          <label className="field">Source folder <div style={{ display:'flex', gap:6 }}><input placeholder="/" value={s.path} onChange={e=>{ const v=e.target.value; setCfg(c=>{ const n={...c, sources:c.sources.map((x,i)=> i===idx?{...x,path:v}:x)}; return n;}); markDirty(); }} spellCheck={false} style={{ flex:1 }} /><button type="button" className="btn tonal small" disabled={browseLoading} onClick={()=>openBrowseForRow(idx,'src')}>{browseLoading ? '…' : '📂'}</button></div></label>
                          <label className="field">Remote destination <div style={{ display:'flex', gap:6 }}><input placeholder="remote:/  (empty = /)" value={s.dest} onChange={e=>{ const v=e.target.value; setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,dest:v}:x)})); markDirty(); }} spellCheck={false} style={{ flex:1 }} /><button type="button" className="btn tonal small" disabled={browseLoading} onClick={()=>openBrowseForRow(idx,'dest')}>{browseLoading ? '…' : '☁️'}</button></div></label>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                          <label className="field">Include <div style={{ display:'flex', gap:6 }}><input placeholder="e.g. *.jpg" value={s.include} onChange={e=>{ const v=e.target.value; setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,include:v}:x)})); markDirty(); }} spellCheck={false} style={{ flex:1 }} /><button type="button" className="btn tonal small" disabled={browseLoading} onClick={()=>openBrowseForRow(idx,'include')}>{browseLoading ? '…' : '📂'}</button></div></label>
                          <label className="field">Exclude <div style={{ display:'flex', gap:6 }}><input placeholder="e.g. *.tmp" value={s.exclude} onChange={e=>{ const v=e.target.value; setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,exclude:v}:x)})); markDirty(); }} spellCheck={false} style={{ flex:1 }} /><button type="button" className="btn tonal small" disabled={browseLoading} onClick={()=>openBrowseForRow(idx,'exclude')}>{browseLoading ? '…' : '📂'}</button></div></label>
                        </div>
                        {(s.include||s.exclude) && (
                          <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center', background:'var(--surface)', border:'1px dashed var(--border)', borderRadius:8, padding:'8px 10px' }}>
                            {s.include && s.include.split(/[,\s]+/).filter(Boolean).map(p=> <span key={p} style={{ background:'color-mix(in srgb, var(--green) 14%, var(--surface))', border:'1px solid var(--green)', borderRadius:999, padding:'3px 8px', fontSize:11, display:'inline-flex', gap:4, alignItems:'center' }}>{p} <button onClick={()=>{ const next=s.include.split(/[,\s]+/).filter(Boolean).filter(x=>x!==p).join(', '); setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,include:next}:x)})); markDirty(); }} style={{ background:'none', border:'none', cursor:'pointer', padding:0, fontSize:12 }}>✕</button></span>)}
                            {s.exclude && s.exclude.split(/[,\s]+/).filter(Boolean).map(p=> <span key={p} style={{ background:'color-mix(in srgb, var(--danger) 12%, var(--surface))', border:'1px solid var(--danger)', borderRadius:999, padding:'3px 8px', fontSize:11, display:'inline-flex', gap:4, alignItems:'center' }}>{p} <button onClick={()=>{ const next=s.exclude.split(/[,\s]+/).filter(Boolean).filter(x=>x!==p).join(', '); setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,exclude:next}:x)})); markDirty(); }} style={{ background:'none', border:'none', cursor:'pointer', padding:0, fontSize:12 }}>✕</button></span>)}
                            <button className="btn ghost small" style={{ marginLeft:'auto', fontSize:11 }} onClick={()=>{ setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,include:'',exclude:''}:x)})); markDirty(); }}>Clear filters</button>
                          </div>
                        )}
                        <label className="checkbox" title={s.path==='/'?'Root folder — contents only':'When checked, the folder itself is created inside the destination (e.g. /home → …/Test/home)'} style={{ display:'flex', gap:8, alignItems:'center', fontSize:13, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}><input type="checkbox" checked={s.preserveParent ?? s.path !== '/'} onChange={e=>{ const v=e.target.checked; setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===idx?{...x,preserveParent:v}:x)})); markDirty(); }} /> <span><b>Include folder itself</b> <span className="hint" style={{ fontSize:11, marginLeft:6 }}>{s.preserveParent ?? s.path !== '/' ? `→ ${s.path.split('/').filter(Boolean).pop() || ''}/` : '→ contents only'}</span></span></label>
                      </div>
                    ))}
                    </div>
                    <button className="btn tonal small" style={{ marginTop:12 }} onClick={()=>{ setCfg(c=>({...c, sources:[...c.sources, { path:'/', dest:'', include:'', exclude:'', preserveParent: false }]})); markDirty(); }}>+ Add folder / file</button>
                  </fieldset>

                  <fieldset style={{ border:'1px solid var(--border)', borderRadius:16, padding:'16px 18px', background:'var(--surface)', marginTop:12 }}>
                    <legend><span className="step-num" style={{ display:'inline-grid', placeItems:'center', width:22, height:22, borderRadius:'50%', background:'var(--primary)', color:'var(--on-primary)', fontSize:12, fontWeight:800 }}>2</span> Destination</legend>
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="field grow">Preset <select value={destFleetId} onChange={e=>{
                        const id=e.target.value; setDestFleetId(id);
                        if (id!=='manual') {
                          const d = dests.find(x=>x.id===id);
                          if (d) setCfg(c=>({...c, dest:{...c.dest, type:d.type as Gen.DestType, remoteName:d.remoteName||'my-backup-remote', remotePath:d.remotePath||'/', host:d.host||'', port:d.port||'', user:d.user||'', sftpAuth:(d.sftpAuth as 'password'|'key')||'password', s3Provider:d.s3Provider||'AWS', s3Bucket:d.s3Bucket||'', s3Region:d.s3Region||'', s3Endpoint:d.s3Endpoint||''}}));
                        }
                        markDirty();
                      }}><option value="manual">Manual — custom</option>{dests.map(d=><option key={d.id} value={d.id}>{d.name} — {d.type.toUpperCase()} {d.host||d.s3Bucket}</option>)}</select></label>
                    </div>
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="field">Type <select value={cfg.dest.type} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,type:e.target.value as Gen.DestType}})); markDirty(); }} disabled={destFleetId!=='manual'}><option value="sftp">SFTP</option><option value="ftp">FTP</option><option value="s3">S3</option></select></label>
                      <label className="field">Remote name <input value={cfg.dest.remoteName} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,remoteName:e.target.value}})); markDirty(); }} spellCheck={false} disabled={destFleetId!=='manual'} /></label>
                      <label className="field grow">Remote path <input value={cfg.dest.remotePath} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,remotePath:e.target.value}})); markDirty(); }} spellCheck={false} disabled={destFleetId!=='manual'} /></label>
                    </div>
                    {(cfg.dest.type==='sftp' || cfg.dest.type==='ftp') && (
                      <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                        <label className="field grow">Host <input value={cfg.dest.host} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,host:e.target.value}})); markDirty(); }} placeholder="host.example.com" disabled={destFleetId!=='manual'} /></label>
                        <label className="field">Port <input type="number" value={cfg.dest.port} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,port:e.target.value}})); markDirty(); }} placeholder="auto" disabled={destFleetId!=='manual'} /></label>
                        <label className="field">User <input value={cfg.dest.user} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,user:e.target.value}})); markDirty(); }} disabled={destFleetId!=='manual'} /></label>
                        <button className="btn tonal small" onClick={async()=>{
                          try {
                            let r: { ok:boolean; msg:string };
                            if (destFleetId!=='manual') r = await api(`/api/destinations/${destFleetId}/test`, { method:'POST' }) as never;
                            else r = await api('/api/test/connection', { method:'POST', body: JSON.stringify({ type: cfg.dest.type, host: cfg.dest.host, port: cfg.dest.port, user: cfg.dest.user, sftpAuth: cfg.dest.sftpAuth, keyPath: cfg.dest.keyPath, bucket: cfg.dest.s3Bucket, region: cfg.dest.s3Region, endpoint: cfg.dest.s3Endpoint, provider: cfg.dest.s3Provider, password: cfg.secrets.password, accessKey: cfg.secrets.s3AccessKey, secretKey: cfg.secrets.s3SecretKey }) }) as never;
                            showToast(r.msg, !r.ok);
                          } catch(e){ showToast((e as Error).message, true); }
                        }}>🔍 Test</button>
                      </div>
                    )}
                    {cfg.dest.type==='sftp' && <div className="row" style={{ display:'flex', gap:14 }}><label className="field">Auth <select value={cfg.dest.sftpAuth} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,sftpAuth:e.target.value as 'password'|'key'}})); markDirty(); }} disabled={destFleetId!=='manual'}><option value="password">Password</option><option value="key">SSH key file</option></select></label>{cfg.dest.sftpAuth==='key' && <label className="field grow">Key path <input value={cfg.dest.keyPath} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,keyPath:e.target.value}})); markDirty(); }} placeholder="~/.ssh/id_ed25519" disabled={destFleetId!=='manual'} /></label>}</div>}
                    {cfg.dest.type==='s3' && <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}><label className="field">Provider <select value={cfg.dest.s3Provider} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,s3Provider:e.target.value}})); markDirty(); }} disabled={destFleetId!=='manual'}><option>AWS</option><option>Ceph</option><option>Minio</option><option>Wasabi</option><option>Backblaze B2 (S3)</option><option>Other</option></select></label><label className="field">Bucket <input value={cfg.dest.s3Bucket} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,s3Bucket:e.target.value}})); markDirty(); }} disabled={destFleetId!=='manual'} /></label><label className="field">Region <input value={cfg.dest.s3Region} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,s3Region:e.target.value}})); markDirty(); }} placeholder="us-east-1" disabled={destFleetId!=='manual'} /></label><label className="field grow">Endpoint <input value={cfg.dest.s3Endpoint} onChange={e=>{ setCfg(c=>({...c,dest:{...c.dest,s3Endpoint:e.target.value}})); markDirty(); }} placeholder="https://s3.us-west..." disabled={destFleetId!=='manual'} /></label></div>}
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={cfg.secrets.embed} onChange={e=>{ setCfg(c=>({...c,secrets:{...c.secrets,embed:e.target.checked}})); markDirty(); }} /> Embed secret in script</label>
                      {cfg.secrets.embed && <span className="hint" style={{ color:'var(--danger)' }}>⚠ embedded secrets live inside the script — keep it <code>chmod 700</code></span>}
                    </div>
                    {(cfg.dest.type==='ftp' || (cfg.dest.type==='sftp' && cfg.dest.sftpAuth==='password')) && <div className="row"><label className="field grow">Password <input type="password" value={cfg.secrets.password} onChange={e=>{ setCfg(c=>({...c,secrets:{...c.secrets,password:e.target.value}})); markDirty(); }} autoComplete="off" /></label></div>}
                    {cfg.dest.type==='s3' && <div className="row" style={{ display:'flex', gap:14 }}><label className="field grow">Access key ID <input value={cfg.secrets.s3AccessKey} onChange={e=>{ setCfg(c=>({...c,secrets:{...c.secrets,s3AccessKey:e.target.value}})); markDirty(); }} autoComplete="off" /></label><label className="field grow">Secret access key <input type="password" value={cfg.secrets.s3SecretKey} onChange={e=>{ setCfg(c=>({...c,secrets:{...c.secrets,s3SecretKey:e.target.value}})); markDirty(); }} autoComplete="off" /></label></div>}
                    <p className="hint">🔒 Unchecked secrets are never stored — the script reads them from env vars.</p>
                  </fieldset>

                  <fieldset style={{ border:'1px solid var(--border)', borderRadius:16, padding:'16px 18px', background:'var(--surface)', marginTop:12 }}>
                    <legend><span className="step-num" style={{ display:'inline-grid', placeItems:'center', width:22, height:22, borderRadius:'50%', background:'var(--primary)', color:'var(--on-primary)', fontSize:12, fontWeight:800 }}>3</span> Backup options</legend>
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="field">Mode <select value={cfg.options.mode} onChange={e=>{ setCfg(c=>({...c,options:{...c.options,mode:e.target.value as 'sync'|'copy'}})); markDirty(); }}><option value="sync">sync (mirror)</option><option value="copy">copy (safe)</option></select></label>
                      <label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={cfg.options.dryRun} onChange={e=>{ setCfg(c=>({...c,options:{...c.options,dryRun:e.target.checked}})); markDirty(); }} /> default --dry-run</label>
                      <label className="field">Bandwidth limit <input value={cfg.options.bandwidth} onChange={e=>{ setCfg(c=>({...c,options:{...c.options,bandwidth:e.target.value}})); markDirty(); }} placeholder="e.g. 10M or off" /></label>
                      <label className="field">Delete older than (days) <input type="number" value={cfg.options.retentionDays||''} onChange={e=>{ setCfg(c=>({...c,options:{...c.options,retentionDays:parseInt(e.target.value,10)||0}})); markDirty(); }} placeholder="0 = off" /></label>
                      <label className="field grow">Log file <input value={cfg.options.logfile} onChange={e=>{ setCfg(c=>({...c,options:{...c.options,logfile:e.target.value}})); markDirty(); }} placeholder="/var/log/rclone-backup.log" /></label>
                      <label className="field grow">Extra rclone flags <input value={cfg.options.extraFlags} onChange={e=>{ setCfg(c=>({...c,options:{...c.options,extraFlags:e.target.value}})); markDirty(); }} placeholder="--transfers 16 ..." /></label>
                    </div>
                  </fieldset>

                  <fieldset style={{ border:'1px solid var(--border)', borderRadius:16, padding:'16px 18px', background:'var(--surface)', marginTop:12 }}>
                    <legend><span className="step-num" style={{ display:'inline-grid', placeItems:'center', width:22, height:22, borderRadius:'50%', background:'var(--primary)', color:'var(--on-primary)', fontSize:12, fontWeight:800 }}>4</span> Discord notification</legend>
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={cfg.webhook.enabled} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,enabled:e.target.checked}})); markDirty(); }} /> Enable webhook</label>
                      <label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={cfg.webhook.onlyOnFail} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,onlyOnFail:e.target.checked}})); markDirty(); }} /> Only notify on failure</label>
                      <label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={cfg.webhook.sendLogOnFail} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,sendLogOnFail:e.target.checked}})); markDirty(); }} /> Attach log on failure</label>
                      <label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={cfg.webhook.sendLogOnSuccess} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,sendLogOnSuccess:e.target.checked}})); markDirty(); }} /> Attach log on success</label>
                    </div>
                    <div className="row" style={{ display:'flex', gap:14 }}>
                      <label className="field grow">Webhook URL <input type="url" value={cfg.webhook.url} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,url:e.target.value}})); markDirty(); }} placeholder="https://discord.com/api/webhooks/..." /></label>
                    </div>
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="field">Bot username <input value={cfg.webhook.username} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,username:e.target.value}})); markDirty(); }} /></label>
                      <label className="field grow">Avatar URL <input value={cfg.webhook.avatarUrl} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,avatarUrl:e.target.value}})); markDirty(); }} placeholder="(optional)" /></label>
                      <label className="field grow">Title template <input value={cfg.webhook.title} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,title:e.target.value}})); markDirty(); }} /></label>
                    </div>
                    <label className="field">Description template <textarea rows={4} value={cfg.webhook.description} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,description:e.target.value}})); markDirty(); }} /></label>
                    <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                      <label className="field">Success color <input type="color" value={cfg.webhook.colorOk} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,colorOk:e.target.value}})); markDirty(); }} /></label>
                      <label className="field">Failure color <input type="color" value={cfg.webhook.colorFail} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,colorFail:e.target.value}})); markDirty(); }} /></label>
                      <label className="field">Log lines on failure <input type="number" value={cfg.webhook.logLines} onChange={e=>{ setCfg(c=>({...c,webhook:{...c.webhook,logLines:parseInt(e.target.value,10)||0}})); markDirty(); }} min={0} max={30} /></label>
                    </div>
                    <p className="hint">Variables: <code>{'{NAME} {STATUS} {HOST} {SOURCES} {DEST} {DURATION} {DATE}'}</code></p>
                  </fieldset>
                </div>

                <div className="col-preview">
                  <div className="preview-sticky" style={{ position:'sticky', top:12, display:'flex', flexDirection:'column', gap:18 }}>
                    <div className="preview-card" style={{ background:'var(--surface)', borderRadius:16, padding:'16px 18px', border:'1px solid var(--border)' }}>
                      <h3>🔔 Discord preview <span className="live-dot" style={{ display:'inline-block', width:7, height:7, background:'var(--green)', borderRadius:'50%', marginLeft:4 }} /></h3>
                      <div className="discord-window" style={{ background:'#313338', borderRadius:10, padding:'13px 15px' }}>
                        <div className="discord-msg" style={{ display:'flex', gap:12 }}>
                          <img className="discord-avatar" src={discordPreview && (discordPreview as {avatar_url?:string}).avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt="" style={{ width:40, height:40, borderRadius:'50%' }} />
                          <div className="discord-content" style={{ flex:1 }}>
                            <div className="discord-header" style={{ display:'flex', gap:8, alignItems:'center', marginBottom:4 }}>
                              <span className="discord-botname" style={{ color:'#fff', fontWeight:600 }}>{(discordPreview as {username?:string})?.username || 'Backup Bot'}</span> <span className="discord-badge" style={{ background:'#5865f2', color:'#fff', fontSize:9, borderRadius:4, padding:'1px 5px' }}>APP</span>
                            </div>
                            <div className="discord-embed" style={{ display:'flex', background:'#2b2d31', borderRadius:6, overflow:'hidden', border:'1px solid #232428' }}>
                              <div className="embed-color" style={{ width:4, background: previewStatus==='success' ? cfg.webhook.colorOk : cfg.webhook.colorFail }} />
                              <div className="embed-body" style={{ padding:'10px 14px' }}>
                                <div className="embed-title" style={{ color:'#00a8fc', fontWeight:700, fontSize:14 }}>{(discordPreview?.embeds as {title:string}[] )?.[0]?.title || ''}</div>
                                <div className="embed-desc" style={{ color:'#dbdee1', fontSize:13, whiteSpace:'pre-wrap' }}>{(discordPreview?.embeds as {description:string}[] )?.[0]?.description || ''}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="preview-toggle" style={{ marginTop:12, display:'flex', gap:16, fontSize:12 }}>
                        <label><input type="radio" checked={previewStatus==='success'} onChange={()=>setPreviewStatus('success')} /> Success</label>
                        <label><input type="radio" checked={previewStatus==='fail'} onChange={()=>setPreviewStatus('fail')} /> Failure</label>
                      </div>
                    </div>
                    <div className="preview-card" style={{ background:'var(--surface)', borderRadius:16, padding:'16px 18px', border:'1px solid var(--border)' }}>
                      <h3>📜 Live script <span className="live-dot" style={{ display:'inline-block', width:7, height:7, background:'var(--green)', borderRadius:'50%', marginLeft:4 }} /></h3>
                      <pre id="script-preview" style={{ background:'#16171b', color:'#c7e3b8', borderRadius:10, padding:14, fontSize:12, maxHeight:'46vh', overflowY:'auto', whiteSpace:'pre', overflowX:'auto' }}>{liveScript}</pre>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab==='script' && (
              <div>
                <div className="editor-toolbar" style={{ display:'flex', gap:12, marginBottom:10, flexWrap:'wrap', alignItems:'center' }}>
                  <button className="btn tonal small" onClick={async()=>{
                    if (manualEdited) { const ok=await dialog.confirm('Overwrite manual edits?','Regenerating will discard edits in the Script Editor.','Regenerate',true); if(!ok) return; }
                    setEditorText(Gen.buildScript(cfg)); setManualEdited(false); markDirty();
                  }}>↻ Regenerate from builder</button>
                  <span className="hint">Everything below is fully editable. Manual edits are kept on save.</span>
                </div>
                <textarea value={editorText} onChange={e=>{ setEditorText(e.target.value); setManualEdited(true); markDirty(); }} spellCheck={false} style={{ width:'100%', height:'62vh', background:'#16171b', color:'#c7e3b8', fontFamily:'JetBrains Mono, monospace', fontSize:13, borderRadius:12, padding:14, border:'1px solid var(--border)' }} />
              </div>
            )}

            {tab==='run' && (
              <div>
                <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap', alignItems:'center' }}>
                  <label className="field">Run on <select value={runVps || sourceVpsId} onChange={e=>setRunVps(e.target.value)}><option value="">— Select VPS —</option>{fleet.map(v=><option key={v.id} value={v.id}>{v.name} ({v.host})</option>)}</select></label>
                  <button className="btn filled" disabled={runs.some(r=>!r.finishedAt)} onClick={async()=>{
                    const vpsId = runVps || sourceVpsId;
                    if (!vpsId) { showToast('Select a VPS first', true); return; }
                    if (dirty) await saveDoc();
                    try { await api(`/api/scripts/${selectedId}/run`, { method:'POST', body: JSON.stringify({ vpsId, dryRun: false }) }); showToast('Backup started'); setTab('run'); loadRuns(); } catch(e){ showToast((e as Error).message, true); }
                  }}>▶ Run now</button>
                  <button className="btn tonal" disabled={runs.some(r=>!r.finishedAt)} onClick={async()=>{
                    const vpsId = runVps || sourceVpsId;
                    if (!vpsId) { showToast('Select a VPS first', true); return; }
                    try { await api(`/api/scripts/${selectedId}/run`, { method:'POST', body: JSON.stringify({ vpsId, dryRun: true }) }); showToast('Dry run started'); loadRuns(); } catch(e){ showToast((e as Error).message, true); }
                  }}>🧪 Dry run</button>
                  {runs.some(r=>!r.finishedAt) && <button className="btn danger" onClick={async()=>{
                    const active = runs.find(r=>!r.finishedAt);
                    if (!active) return;
                    await api(`/api/runs/${active.id}/stop`, { method:'POST' }); showToast('Stop signal sent'); loadRuns();
                  }}>🛑 Stop</button>}
                </div>
                {/* beautiful card */}
                {(() => {
                  const r = runs.find(x=>!x.finishedAt) || runs[0];
                  if (!r) return null;
                  const running = !r.finishedAt;
                  const ok = r.exitCode===0;
                  return (
                    <div className="preview-card" style={{ margin:'16px 0', background:'var(--surface)', borderRadius:16, padding:'16px 18px', border:'1px solid var(--border)' }}>
                      <div style={{ display:'flex', gap:14, alignItems:'center' }}>
                        <div style={{ width:42, height:42, borderRadius:'50%', display:'grid', placeItems:'center', fontSize:20, background: running ? 'var(--surface-2)' : ok ? 'color-mix(in srgb, var(--green) 18%, var(--surface-2))' : 'color-mix(in srgb, var(--danger) 14%, var(--surface-2))' }}>{running?'⏳': ok?'✅':'❌'}</div>
                        <div style={{ flex:1 }}><div style={{ fontWeight:700 }}>{running ? `Running on ${r.vpsName}…` : ok ? `Completed on ${r.vpsName}` : `Failed on ${r.vpsName}`}</div><div className="hint">{new Date(r.startedAt).toLocaleString()}{r.finishedAt? ` → ${new Date(r.finishedAt).toLocaleString()}`: ' · running'}</div></div>
                        {running && <div style={{ width:22, height:22, border:'2px solid var(--border)', borderTopColor:'var(--primary)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />}
                      </div>
                      <div style={{ height:6, background:'var(--surface-2)', borderRadius:999, overflow:'hidden', margin:'14px 0 10px' }}>
                        <div style={{ height:'100%', width: running?'62%':'100%', background: running?'var(--primary)': ok?'var(--green)':'var(--danger)', borderRadius:999, transition:'width 0.6s ease' }} />
                      </div>
                    </div>
                  );
                })()}
                <LiveStats run={runs.find(x=>!x.finishedAt) || runs[0] || null} />
                <pre
                  className="run-terminal"
                  ref={(el) => {
                    if (el) {
                      const r = runs.find(x=>x.id===activeRunId) || runs[0];
                      if (r && !r.finishedAt) {
                        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                        if (nearBottom || el.scrollTop === 0) requestAnimationFrame(()=> { el.scrollTop = el.scrollHeight; });
                      }
                    }
                  }}
                  style={{ background:'#16171b', color:'#c7e3b8', borderRadius:10, padding:14, fontSize:12, height:420, overflowY:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all', lineHeight:'1.5' }}
                >{(() => {
                  const r = runs.find(x=>x.id===activeRunId) || runs[0];
                  if (!r) return '// no runs yet — hit "Run now" or "Dry run"';
                  if (!r.finishedAt) {
                    const raw = (r.output || '').replace(/\r/g, '\n');
                    const lines = raw.split('\n');
                    let starting = '', transferred = '', checks = '', elapsed = '';
                    for (const l of lines) {
                      const t = l.trim();
                      if (!t || /^\[setup\]|^\[warn\]|^---/.test(t)) continue;
                      if (/Starting sync for:/.test(t)) starting = t;
                      else if (/Transferred:/i.test(t) || (/\d+(?:\.\d+)?\s*[KMGT]?i?B\s*\/\s*\d/.test(t) && /B\/s|ETA/i.test(t))) {
                        const clean = t.replace(/^.*\b(?:INFO|NOTICE)\s*:\s*/i, '').trim();
                        transferred = /Transferred:/i.test(t) ? t : `Transferred: ${clean}`;
                      }
                      else if (/Checks:/i.test(t)) checks = t;
                      else if (/Elapsed time:/i.test(t)) elapsed = t;
                    }
                    if (starting || transferred || checks || elapsed) {
                      const elapsedComputed = (() => {
                        const start = new Date(r.startedAt).getTime();
                        const secs = Math.max(0, Math.floor((Date.now() - start)/1000));
                        return `Elapsed time: ${Math.floor(secs/60)}m ${secs%60}s`;
                      })();
                      return [
                        starting || 'Starting sync for: ...',
                        transferred || 'Transferred: waiting for first stats…',
                        checks || 'Checks: —',
                        elapsed || elapsedComputed,
                      ].join('\n');
                    }
                    return lines.slice(-24).join('\n').trim() || '(no output yet — waiting for rclone --progress)';
                  }
                  return r.output || '(no output)';
                })()}</pre>
                <div style={{ display:'flex', justifyContent:'space-between', marginTop:20 }}>
                  <h3 style={{ margin:0 }}>Run history</h3>
                  <div style={{ display:'flex', gap:6 }}>
                    <button className="btn tonal small" onClick={async()=>{
                      const ok=await dialog.confirm('Clear all logs?','This cannot be undone.','Clear',true);
                      if(!ok) return;
                      const res = await api(`/api/scripts/${selectedId}/runs`, { method:'DELETE' }) as {ok?:boolean};
                      if(res) { showToast('Logs cleared'); loadRuns(); }
                    }}>🗑 Clear logs</button>
                    <button className="btn tonal small" onClick={()=>{
                      if(!runs.length) return showToast('No logs', true);
                      const all = runs.map(r=>`===== ${r.name} | ${r.vpsName} | ${r.startedAt} → ${r.finishedAt||'running'} | exit ${r.exitCode??''} =====\n${r.output||''}\n`).join('\n');
                      const blob=new Blob([all],{type:'text/plain'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`all-logs-${selectedId}.log`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000);
                    }}>⬇ Download all</button>
                  </div>
                </div>
                <div id="run-history" style={{ marginTop:10 }}>
                  {runs.length===0 ? <p className="hint">no runs recorded yet</p> : runs.map(r=>(
                    <div key={r.id} className={`run-item ${r.id===activeRunId?'active':''}`} onClick={()=>setActiveRunId(r.id)} style={{ display:'flex', gap:12, padding:'10px 14px', borderRadius:12, background:'var(--surface)', cursor:'pointer', marginBottom:6, border: r.id===activeRunId ? '1px solid var(--primary)' : '1px solid transparent', alignItems:'center' }}>
                      <span className={`st ${r.finishedAt ? (r.exitCode===0?'ok':'bad'):'running'}`} style={{ width:10, height:10, borderRadius:'50%', background: r.finishedAt ? (r.exitCode===0?'var(--green)':'var(--danger)'):'var(--yellow)', display:'inline-block', flexShrink:0 }} />
                      <b style={{ flexShrink:0 }}>{r.dryRun && <span className="badge-dry" style={{ background:'var(--surface-3)', color:'var(--yellow)', fontSize:10, padding:'2px 7px', borderRadius:5, marginRight:4 }}>DRY</span>}{r.name || doc?.name || '—'}</b>
                      <span className="when" style={{ color:'var(--text-muted)', fontSize:12, marginLeft:8, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{new Date(r.startedAt).toLocaleString()}{r.finishedAt? ` · ${r.exitCode} · ${Math.round((new Date(r.finishedAt).getTime()-new Date(r.startedAt).getTime())/1000)}s` : ' · running…'}</span>
                      <button className="btn tonal small" title="View log" onClick={(e)=>{ e.stopPropagation(); setActiveRunId(r.id); setTimeout(()=> document.querySelector('.run-terminal')?.scrollIntoView({behavior:'smooth', block:'center'}), 50); }}>👁 View</button>
                      <button className="btn tonal small" title="Copy log" onClick={async(e)=>{ e.stopPropagation(); const t=r.output||''; if(!t) { showToast('No log to copy', true); return; } try{ await navigator.clipboard.writeText(t); showToast('Log copied'); } catch{ showToast('Copy failed', true); } }}>📋 Copy</button>
                      <button className="btn tonal small" title="Download log" onClick={async(e)=>{ e.stopPropagation(); const t = r.output || ''; const blob=new Blob([t],{type:'text/plain'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`run-${r.id}.log`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000);}}>⬇ Download</button>
                      <button className="btn tonal small danger" title="Delete log" onClick={async(e)=>{
                        e.stopPropagation();
                        if (!r.finishedAt) { showToast('Stop running job first', true); return; }
                        const ok=await dialog.confirm('Delete log?', `Delete log ${new Date(r.startedAt).toLocaleString()}?`, 'Delete', true);
                        if(!ok) return;
                        try { await api(`/api/scripts/${selectedId}/runs/${r.id}`, { method:'DELETE' }); showToast('Log deleted'); if(activeRunId===r.id) setActiveRunId(null); loadRuns(); } catch(err){ showToast((err as Error).message, true); }
                      }}>🗑 Delete</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab==='schedule' && (
              <div>
                <div className="preview-card" style={{ background:'var(--surface)', borderRadius:16, padding:'16px 18px', border:'1px solid var(--border)', marginBottom:18 }}>
                  <h3 style={{ marginTop:0 }}>⏰ {editingSched ? 'Edit Schedule' : 'New Schedule'}</h3>
                  <NowBar />
                  <div className="row" style={{ display:'flex', gap:14 }}><label className="field grow">Run on VPS <select value={schedVps} onChange={e=>setSchedVps(e.target.value)}>{fleet.length ? fleet.map(v=><option key={v.id} value={v.id}>{v.name} ({v.host})</option>) : <option value="">No VPS — add one in Fleet</option>}</select></label><label className="checkbox" style={{ display:'flex', gap:7, alignItems:'center' }}><input type="checkbox" checked={schedEnabled} onChange={e=>setSchedEnabled(e.target.checked)} /> Enabled</label></div>
                  <CronBuilder value={cronExpr} onChange={setCronExpr} />
                  <div style={{ display:'flex', gap:8, marginTop:12 }}>
                    <button className="btn filled" onClick={async()=>{
                      if(!selectedId) { showToast('Save the script first', true); return; }
                      if(!schedVps) { showToast('Select a VPS', true); return; }
                      try {
                        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                        if (editingSched) {
                          await api(`/api/schedules/${editingSched}`, { method:'PUT', body: JSON.stringify({ vpsId: schedVps, cronExpr, enabled: schedEnabled, timezone: tz }) });
                          showToast('Schedule updated'); setEditingSched(null);
                        } else {
                          await api('/api/schedules', { method:'POST', body: JSON.stringify({ scriptId: selectedId, vpsId: schedVps, cronExpr, enabled: schedEnabled, timezone: tz }) });
                          showToast('Schedule added');
                        }
                        setSchedVps(fleet[0]?.id || ''); setSchedEnabled(true); loadSchedules();
                      } catch(e){ showToast((e as Error).message, true); }
                    }}>{editingSched ? '✓ Update Schedule' : '+ Add Schedule'}</button>
                    {editingSched && <button className="btn tonal small" onClick={()=>{ setEditingSched(null); setSchedVps(fleet[0]?.id||''); }}>Cancel</button>}
                    <button className="btn tonal small" style={{ marginLeft:'auto' }} onClick={async()=>{ try{ const r=await api('/api/schedules/trigger', { method:'POST' }) as {count:number}; showToast(r.count?`Triggered ${r.count} schedule(s)`:'No schedules due right now'); if(r.count) loadRuns(); } catch(e){ showToast((e as Error).message, true); } }}>▶ Run due now</button>
                  </div>
                </div>
                <h3>Active Schedules for this script</h3>
                <div id="schedule-list">
                  {schedules.length===0 ? <p className="hint">No schedules yet — add one above.</p> : schedules.map(s=>{
                    const vpsName = fleet.find(v=>v.id===s.vpsId)?.name || s.vpsId;
                    return (
                      <div key={s.id} className="schedule-item" style={{ display:'flex', gap:12, padding:'12px 14px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, marginBottom:8, alignItems:'center' }}>
                        <div style={{ flex:1 }}><b>{vpsName}</b> <span style={{ fontSize:12, fontWeight:600, color:'var(--primary)', background:'color-mix(in srgb, var(--primary) 12%, var(--surface))', border:'1px solid var(--primary)', borderRadius:6, padding:'3px 8px', marginRight:6 }}>{friendlyCron(s.cronExpr)}</span> <span className="sched-expr" style={{ fontFamily:'JetBrains Mono, monospace', fontSize:11, background:'var(--surface-2)', padding:'3px 8px', borderRadius:6, opacity:0.8 }}>{s.cronExpr}</span> <span className="hint" style={{ fontSize:11, marginLeft:6 }}>({s.timezone})</span><div className="hint" style={{ margin:'4px 0 0' }}>Created {new Date(s.createdAt).toLocaleString()} {s.lastRun?`· last ${new Date(s.lastRun).toLocaleString()}`:''}</div></div>
                        <div className={`schedule-toggle ${s.enabled?'on':''}`} onClick={async()=>{ await api(`/api/schedules/${s.id}`, { method:'PUT', body: JSON.stringify({ enabled: !s.enabled }) }); loadSchedules(); }} style={{ width:44, height:26, background: s.enabled?'var(--green)':'var(--surface-3)', borderRadius:999, position:'relative', cursor:'pointer', border:'1px solid var(--border)' }} />
                        <button className="btn tonal small" onClick={()=>{ setEditingSched(s.id); setSchedVps(s.vpsId); setSchedEnabled(s.enabled); setCronExpr(s.cronExpr); }}>✎ Edit</button>
                        <button className="btn tonal small" onClick={async()=>{ const ok=await dialog.confirm('Delete schedule?','','Delete',true); if(!ok) return; await api(`/api/schedules/${s.id}`,{method:'DELETE'}); if(editingSched===s.id) setEditingSched(null); loadSchedules(); }}>🗑 Delete</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab==='install' && (
              <div>
                <h3>Curl-able link</h3>
                <div className="cmd-box" style={{ display:'flex', gap:12, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'11px 15px', alignItems:'center' }}><code style={{ flex:1, fontSize:13, whiteSpace:'pre', overflowX:'auto' }}>{rawUrl}</code><button className="btn tonal small" onClick={()=>copyText(rawUrl)}>Copy</button></div>
                <h3>One-line install</h3>
                <div className="cmd-box" style={{ display:'flex', gap:12, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'11px 15px' }}><code style={{ flex:1, fontSize:13, whiteSpace:'pre' }}>{`curl -fsSL '${rawUrl}' -o backup.sh && chmod 700 backup.sh`}</code><button className="btn tonal small" onClick={()=>copyText(`curl -fsSL '${rawUrl}' -o backup.sh && chmod 700 backup.sh`)}>Copy</button></div>
                <h3>Required permissions</h3>
                <table className="perm-table" style={{ borderCollapse:'collapse', width:'100%', maxWidth:760 }}><tbody>
                  <tr><td style={{ border:'1px solid var(--border)', padding:'9px 13px', background:'var(--surface-2)', fontFamily:'monospace' }}><code>chmod 700 backup.sh</code></td><td style={{ border:'1px solid var(--border)', padding:'9px 13px', color:'var(--text-muted)' }}>Recommended — owner only; safe if secrets are embedded.</td></tr>
                  <tr><td style={{ border:'1px solid var(--border)', padding:'9px 13px', background:'var(--surface-2)', fontFamily:'monospace' }}><code>rclone</code></td><td style={{ border:'1px solid var(--border)', padding:'9px 13px' }}>Install: <code>curl https://rclone.org/install.sh | sudo bash</code></td></tr>
                </tbody></table>
              </div>
            )}

            {tab==='webhook' && (
              <div>
                <h3>Send test notification</h3>
                <p className="hint">Sends sample embeds using the exact payload format of the generated script.</p>
                <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
                  <button className="btn filled" onClick={async()=>{
                    if (!cfg.webhook.url) { showToast('Enter a webhook URL first', true); return; }
                    const payload = Gen.buildPayload(cfg, 'SUCCESS', { host: 'test-server', duration: '13' });
                    try { await api('/api/test-webhook', { method:'POST', body: JSON.stringify({ url: cfg.webhook.url, payload }) }); showToast('Test sent — check your Discord channel'); } catch(e){ showToast((e as Error).message, true); }
                  }}>Send success test</button>
                  <button className="btn danger" onClick={async()=>{
                    if (!cfg.webhook.url) { showToast('Enter a webhook URL first', true); return; }
                    const payload = Gen.buildPayload(cfg, 'FAIL', { host: 'test-server', duration: '13', logTail: '[ERROR] rclone: directory not found /home/user/data' });
                    try { await api('/api/test-webhook', { method:'POST', body: JSON.stringify({ url: cfg.webhook.url, payload }) }); showToast('Test sent — check your Discord channel'); } catch(e){ showToast((e as Error).message, true); }
                  }}>Send failure test</button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* VPS dialog */}
      {vpsDlg && (
        <div className="dlg-overlay open" onClick={(e)=>{ if(e.target===e.currentTarget) setVpsDlg(null); }}>
          <div className="dlg-card" style={{ width:520 }}>
            <h3 className="dlg-title">{(vpsDlg as {id?:string}).id ? 'Edit VPS' : 'Add VPS'}</h3>
            <label className="field">Name <input value={vpsDlg.name||''} onChange={e=>setVpsDlg(s=>({...s!,name:e.target.value}))} placeholder="my-vps-1" /></label>
            <div className="row" style={{ display:'flex', gap:14 }}><label className="field grow">Host <input value={vpsDlg.host||''} onChange={e=>setVpsDlg(s=>({...s!,host:e.target.value}))} placeholder="1.2.3.4" /></label><label className="field">Port <input type="number" value={vpsDlg.port||22} onChange={e=>setVpsDlg(s=>({...s!,port:Number(e.target.value)}))} /></label></div>
            <div className="row" style={{ display:'flex', gap:14 }}><label className="field">User <input value={vpsDlg.user||'root'} onChange={e=>setVpsDlg(s=>({...s!,user:e.target.value}))} /></label><label className="field">Auth <select value={(vpsDlg as {auth?:string}).auth||'password'} onChange={e=>setVpsDlg(s=>({...s!,auth:e.target.value}))}><option value="password">Password</option><option value="key">SSH key</option></select></label></div>
            {(vpsDlg as {auth?:string}).auth !== 'key' ? <label className="field">Password <input type="password" value={vpsDlg.password||''} onChange={e=>setVpsDlg(s=>({...s!,password:e.target.value}))} autoComplete="new-password" placeholder="leave blank to keep" /></label> : <label className="field">Key path <input value={(vpsDlg as {keyPath?:string}).keyPath||''} onChange={e=>setVpsDlg(s=>({...s!,keyPath:e.target.value}))} placeholder="~/.ssh/id_ed25519" /></label>}
            <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:8 }}>
              <button className="btn tonal small" disabled={vpsTesting} onClick={async()=>{
                const host = String(vpsDlg.host||'').trim();
                if (!host) { showToast('Host required', true); return; }
                setVpsTesting(true); setVpsTestResult('Testing…');
                try {
                  const id = (vpsDlg as {id?:string}).id;
                  let r: { ok:boolean; msg:string };
                  if (id && !vpsDlg.password) {
                    r = await api(`/api/fleet/${id}/test`, { method:'POST' }) as never;
                  } else {
                    r = await api('/api/test/connection', { method:'POST', body: JSON.stringify({ type:'sftp', host, port: String(vpsDlg.port||'22'), user: String(vpsDlg.user||'root'), password: String(vpsDlg.password||''), sftpAuth: String((vpsDlg as {auth?:string}).auth||'password'), keyPath: String((vpsDlg as {keyPath?:string}).keyPath||'') }) }) as never;
                  }
                  setVpsTestResult(r.msg || (r.ok?'SSH OK':'Failed'));
                  showToast(r.msg || (r.ok?'OK':'Failed'), !r.ok);
                } catch(e){ const m=(e as Error).message; setVpsTestResult(m); showToast(m, true); }
                setVpsTesting(false);
              }}>{vpsTesting ? '…' : '🔍 Test connection'}</button>
              <span className="hint" style={{ flex:1, whiteSpace:'pre-wrap' }}>{vpsTestResult}</span>
            </div>
            <div className="dlg-actions" style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
              <button className="btn ghost" onClick={()=>setVpsDlg(null)}>Cancel</button>
              <button className="btn filled" onClick={async()=>{
                const body: Record<string,unknown> = { name: vpsDlg.name, host: vpsDlg.host, port: vpsDlg.port||22, user: vpsDlg.user||'root', auth: (vpsDlg as {auth?:string}).auth||'password', keyPath: (vpsDlg as {keyPath?:string}).keyPath||'' };
                if (vpsDlg.password) body.password = vpsDlg.password;
                const id = (vpsDlg as {id?:string}).id;
                try {
                  if (id) await api(`/api/fleet/${id}`, { method:'PUT', body: JSON.stringify(body) });
                  else await api('/api/fleet', { method:'POST', body: JSON.stringify(body) });
                  setVpsDlg(null); await loadFleet(); showToast(id?'VPS updated':'VPS added');
                } catch(e){ showToast((e as Error).message, true); }
              }}>Save VPS</button>
            </div>
          </div>
        </div>
      )}

      {/* Dest dialog */}
      {destDlg && (
        <div className="dlg-overlay open" onClick={(e)=>{ if(e.target===e.currentTarget) setDestDlg(null); }}>
          <div className="dlg-card" style={{ width:560, maxHeight:'85vh', overflowY:'auto' }}>
            <h3 className="dlg-title">{(destDlg as {id?:string}).id ? 'Edit Destination' : 'Add Destination'}</h3>
            <label className="field">Name <input value={destDlg.name||''} onChange={e=>setDestDlg(s=>({...s!,name:e.target.value}))} placeholder="my-sftp-1" /></label>
            <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
              <label className="field">Type <select value={(destDlg as {type?:string}).type||'sftp'} onChange={e=>setDestDlg(s=>({...s!,type:e.target.value}))}><option value="sftp">SFTP</option><option value="ftp">FTP</option><option value="s3">S3</option></select></label>
              <label className="field">Remote name <input value={(destDlg as {remoteName?:string}).remoteName||'my-backup-remote'} onChange={e=>setDestDlg(s=>({...s!,remoteName:e.target.value}))} /></label>
              <label className="field grow">Remote path <input value={(destDlg as {remotePath?:string}).remotePath||'/'} onChange={e=>setDestDlg(s=>({...s!,remotePath:e.target.value}))} /></label>
            </div>
            {(destDlg as {type?:string}).type !== 's3' && (
              <div className="row" style={{ display:'flex', gap:14 }}><label className="field grow">Host <input value={(destDlg as {host?:string}).host||''} onChange={e=>setDestDlg(s=>({...s!,host:e.target.value}))} placeholder="host.example.com" /></label><label className="field">Port <input type="number" value={(destDlg as {port?:string|number}).port||''} onChange={e=>setDestDlg(s=>({...s!,port:e.target.value}))} placeholder="auto" /></label><label className="field">User <input value={(destDlg as {user?:string}).user||''} onChange={e=>setDestDlg(s=>({...s!,user:e.target.value}))} /></label></div>
            )}
            {(destDlg as {type?:string}).type === 'sftp' && <div className="row"><label className="field">Auth <select value={(destDlg as {sftpAuth?:string}).sftpAuth||'password'} onChange={e=>setDestDlg(s=>({...s!,sftpAuth:e.target.value}))}><option value="password">Password</option><option value="key">SSH key</option></select></label><label className="field grow">Key path <input value={(destDlg as {keyPath?:string}).keyPath||''} onChange={e=>setDestDlg(s=>({...s!,keyPath:e.target.value}))} placeholder="~/.ssh/id_ed25519" /></label></div>}
            {(destDlg as {type?:string}).type === 's3' && <div className="row" style={{ display:'flex', gap:14, flexWrap:'wrap' }}><label className="field">Provider <select value={(destDlg as {s3Provider?:string}).s3Provider||'AWS'} onChange={e=>setDestDlg(s=>({...s!,s3Provider:e.target.value}))}><option>AWS</option><option>Ceph</option><option>Minio</option><option>Wasabi</option><option>Other</option></select></label><label className="field">Bucket <input value={(destDlg as {s3Bucket?:string}).s3Bucket||''} onChange={e=>setDestDlg(s=>({...s!,s3Bucket:e.target.value}))} /></label><label className="field">Region <input value={(destDlg as {s3Region?:string}).s3Region||''} onChange={e=>setDestDlg(s=>({...s!,s3Region:e.target.value}))} placeholder="us-east-1" /></label><label className="field grow">Endpoint <input value={(destDlg as {s3Endpoint?:string}).s3Endpoint||''} onChange={e=>setDestDlg(s=>({...s!,s3Endpoint:e.target.value}))} placeholder="https://s3.example.com" /></label></div>}
            {(destDlg as {type?:string}).type !== 's3' ? <div className="row"><label className="field grow">Password <input type="password" value={(destDlg as {password?:string}).password||''} onChange={e=>setDestDlg(s=>({...s!,password:e.target.value}))} autoComplete="new-password" placeholder="leave blank to keep" /></label></div> : <div className="row" style={{ display:'flex', gap:14 }}><label className="field">Access key <input value={(destDlg as {s3AccessKey?:string}).s3AccessKey||''} onChange={e=>setDestDlg(s=>({...s!,s3AccessKey:e.target.value}))} /></label><label className="field grow">Secret key <input type="password" value={(destDlg as {s3SecretKey?:string}).s3SecretKey||''} onChange={e=>setDestDlg(s=>({...s!,s3SecretKey:e.target.value}))} /></label></div>}
            <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:8 }}>
              <button className="btn tonal small" disabled={destTesting} onClick={async()=>{
                const type = String((destDlg as {type?:string}).type||'sftp');
                setDestTesting(true); setDestTestResult('Testing…');
                try {
                  const id = (destDlg as {id?:string}).id;
                  let r: { ok:boolean; msg:string };
                  const hasNewSecret = Boolean((destDlg as {password?:string}).password || (destDlg as {s3AccessKey?:string}).s3AccessKey || (destDlg as {s3SecretKey?:string}).s3SecretKey);
                  if (id && !hasNewSecret) {
                    r = await api(`/api/destinations/${id}/test`, { method:'POST' }) as never;
                  } else {
                    const payload: Record<string,string> = {
                      type,
                      host: String((destDlg as {host?:string}).host||''),
                      port: String((destDlg as {port?:string}).port||''),
                      user: String((destDlg as {user?:string}).user||''),
                      password: String((destDlg as {password?:string}).password||''),
                      sftpAuth: String((destDlg as {sftpAuth?:string}).sftpAuth||'password'),
                      keyPath: String((destDlg as {keyPath?:string}).keyPath||''),
                      bucket: String((destDlg as {s3Bucket?:string}).s3Bucket||''),
                      region: String((destDlg as {s3Region?:string}).s3Region||''),
                      endpoint: String((destDlg as {s3Endpoint?:string}).s3Endpoint||''),
                      provider: String((destDlg as {s3Provider?:string}).s3Provider||'AWS'),
                      accessKey: String((destDlg as {s3AccessKey?:string}).s3AccessKey||''),
                      secretKey: String((destDlg as {s3SecretKey?:string}).s3SecretKey||''),
                    };
                    r = await api('/api/test/connection', { method:'POST', body: JSON.stringify(payload) }) as never;
                  }
                  setDestTestResult(r.msg || (r.ok?'Connection OK':'Failed'));
                  showToast(r.msg || (r.ok?'OK':'Failed'), !r.ok);
                } catch(e){ const m=(e as Error).message; setDestTestResult(m); showToast(m, true); }
                setDestTesting(false);
              }}>{destTesting ? '…' : '🔍 Test connection'}</button>
              <span className="hint" style={{ flex:1, whiteSpace:'pre-wrap' }}>{destTestResult}</span>
            </div>
            <div className="dlg-actions" style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
              <button className="btn ghost" onClick={()=>setDestDlg(null)}>Cancel</button>
              <button className="btn filled" onClick={async()=>{
                const body: Record<string,unknown> = {
                  name: destDlg.name, type: (destDlg as {type?:string}).type||'sftp', host: (destDlg as {host?:string}).host||'', port: (destDlg as {port?:string}).port||'', user: (destDlg as {user?:string}).user||'',
                  remoteName: (destDlg as {remoteName?:string}).remoteName||'my-backup-remote', remotePath: (destDlg as {remotePath?:string}).remotePath||'/', sftpAuth: (destDlg as {sftpAuth?:string}).sftpAuth||'password', keyPath: (destDlg as {keyPath?:string}).keyPath||'',
                  s3Provider: (destDlg as {s3Provider?:string}).s3Provider||'AWS', s3Bucket: (destDlg as {s3Bucket?:string}).s3Bucket||'', s3Region: (destDlg as {s3Region?:string}).s3Region||'', s3Endpoint: (destDlg as {s3Endpoint?:string}).s3Endpoint||'',
                };
                if ((destDlg as {password?:string}).password) body.password = (destDlg as {password?:string}).password;
                if ((destDlg as {s3AccessKey?:string}).s3AccessKey) body.s3AccessKey = (destDlg as {s3AccessKey?:string}).s3AccessKey;
                if ((destDlg as {s3SecretKey?:string}).s3SecretKey) body.s3SecretKey = (destDlg as {s3SecretKey?:string}).s3SecretKey;
                const id=(destDlg as {id?:string}).id;
                try {
                  if (id) await api(`/api/destinations/${id}`, { method:'PUT', body: JSON.stringify(body) });
                  else await api('/api/destinations', { method:'POST', body: JSON.stringify(body) });
                  setDestDlg(null); await loadDests(); showToast(id?'Destination updated':'Destination added');
                } catch(e){ showToast((e as Error).message, true); }
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Browse dialog */}
      {browse && (
        <div className="dlg-overlay open" style={{ zIndex:101 }} onClick={(e)=>{ if(e.target===e.currentTarget) setBrowse(null); }}>
          <div className="dlg-card" style={{ width:560, maxHeight:'80vh', display:'flex', flexDirection:'column' }}>
            <h3 className="dlg-title">Browse</h3>
            <div className="row" style={{ display:'flex', gap:8, marginBottom:8 }}>
              <label className="field grow">Path <input value={browse.path} onChange={e=>setBrowse(b=> b?{...b,path:e.target.value}:null)} spellCheck={false} onKeyDown={e=>{ if(e.key==='Enter') loadBrowsePath((e.target as HTMLInputElement).value); }} disabled={browseLoading} /></label>
              <button className="btn tonal small" disabled={browseLoading} onClick={()=>loadBrowsePath(browse.path)}>{browseLoading ? '…' : 'Go'}</button>
              <button className="btn ghost small" disabled={browseLoading} onClick={()=>{
                const cur=browse.path||'/';
                const up = cur==='/'?'/':cur.replace(/\/[^\/]*\/?$/,'')||'/';
                loadBrowsePath(up);
              }}>⬆ Up</button>
            </div>
            <div id="browse-list" style={{ overflowY:'auto', maxHeight:'32vh', border:'1px solid var(--border)', borderRadius:10, padding:4 }}>
              {browseLoading ? <p className="hint" style={{ padding:12 }}>Loading…</p> : browse.entries.length===0 ? <p className="hint" style={{ padding:12 }}>Empty folder</p> : browse.entries.map(en=>(
                <div key={en.path} className={`browse-item ${browse.selected.includes(en.path)?'selected':''} ${browse.kind==='include'||browse.kind==='exclude'?'multi':''}`} onClick={()=>{
                  if (browseLoading) return;
                  if (browse.kind==='include'||browse.kind==='exclude') {
                    setBrowse(b=>{ if(!b) return b; const has=b.selected.includes(en.path); return {...b, selected: has? b.selected.filter(x=>x!==en.path):[...b.selected,en.path]}; });
                  } else if (en.isDir) {
                    loadBrowsePath(en.path);
                  } else {
                    setBrowse(b=> b?{...b,path:en.path}:null);
                  }
                }} onDoubleClick={()=>{ if(en.isDir && !browseLoading) loadBrowsePath(en.path); }} style={{ display:'flex', gap:8, padding:'8px 10px', borderRadius:8, cursor: browseLoading ? 'wait' : 'pointer', opacity: browseLoading ? 0.6 : 1, alignItems:'center' }}>
                  <span>{en.isDir?'📁':'📄'}</span><span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{en.name}</span><span className="hint">{en.isDir?'dir':'file'}</span>
                </div>
              ))}
            </div>
            {(browse.kind==='include'||browse.kind==='exclude') && browse.selected.length>0 && (
              <div className="browse-selected" style={{ marginTop:8, display:'flex', gap:6, flexWrap:'wrap', border:'1px dashed var(--border)', borderRadius:10, padding:8 }}>
                {browse.selected.map(p=>(
                  <span key={p} className="browse-chip" onClick={()=>setBrowse(b=> b?{...b,selected:b.selected.filter(x=>x!==p)}:null)} style={{ display:'inline-flex', gap:6, background:'color-mix(in srgb, var(--primary) 14%, var(--surface-2))', border:'1px solid var(--primary)', borderRadius:999, padding:'3px 10px', fontFamily:'JetBrains Mono, monospace', fontSize:11, cursor:'pointer' }}>{p} ✕</span>
                ))}
              </div>
            )}
            <p className="hint" style={{ marginTop:8 }}>{browse.hint}</p>
            <div className="row" style={{ marginTop:4, display:'flex', gap:8 }}>
              <button className="btn tonal small" onClick={async()=>{
                const name = await dialog.prompt('New Folder','Enter folder name','','my-folder');
                if(!name) return;
                const clean=name.trim().replace(/[\/\\]/g,'').replace(/\s+/g,'-');
                if(!clean) return;
                const newPath=(browse.path.replace(/\/+$/,'')||'')+'/'+clean;
                try {
                  let res: {ok:boolean;msg?:string};
                  if (browse.mode==='vps' && browse.vpsId) res = await api(`/api/fleet/${browse.vpsId}/mkdir`, { method:'POST', body: JSON.stringify({ path:newPath }) }) as never;
                  else if (browse.mode==='remoteFleet' && browse.destId) res = await api(`/api/destinations/${browse.destId}/mkdir`, { method:'POST', body: JSON.stringify({ path:newPath }) }) as never;
                  else if (browse.mode==='vps') res = await api('/api/browse/mkdir-local', { method:'POST', body: JSON.stringify({ path:newPath }) }) as never;
                  else res = await api('/api/browse/mkdir-remote', { method:'POST', body: JSON.stringify({ ...(browse.remoteCfg||{}), path:newPath }) }) as never;
                  if(!res.ok) { showToast(res.msg||'mkdir failed', true); return; }
                  showToast('Created '+clean); loadBrowsePath(browse.path);
                } catch(e){ showToast((e as Error).message, true); }
              }}>📁 New Folder</button>
              <span className="hint">Create directory in current path</span>
            </div>
            <div className="dlg-actions" style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
              <button className="btn ghost" onClick={()=>setBrowse(null)}>Cancel</button>
              {(browse.kind==='include'||browse.kind==='exclude') && <button className="btn tonal" onClick={()=>{
                const paths = browse.selected.length ? browse.selected : [browse.path].filter(Boolean);
                if(!paths.length) return;
                const row = cfg.sources[browse.rowIdx];
                const key = browse.kind==='include'?'include':'exclude';
                const existing = (row[key]||'').split(/[,\s]+/).filter(Boolean);
                const next = [...existing];
                for(const p of paths){ const raw=p.startsWith('/')?p:'/'+p; if(!next.includes(raw)) next.push(raw); }
                setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===browse.rowIdx?{...x,[key]:next.join(', ')}:x)})); markDirty(); setBrowse(null);
              }}>Add selected (+{browse.selected.length})</button>}
              <button className="btn filled" onClick={()=>{
                let sel = browse.path.trim();
                if (!sel) return;
                const row = cfg.sources[browse.rowIdx];
                if (browse.kind==='dest') {
                  const existing = row.dest;
                  if (existing.includes(':')) sel = existing.split(':')[0]+':'+sel.replace(/^\/+/,'');
                  else {
                    const rn = cfg.dest.remoteName || 'my-backup-remote';
                    if (cfg.dest.type==='s3' && cfg.dest.s3Bucket && !sel.startsWith(cfg.dest.s3Bucket)) sel = cfg.dest.s3Bucket+'/'+sel.replace(/^\/+/,'');
                    sel = rn+':'+sel.replace(/^\/+/,'');
                    if (!sel.includes(':')) sel = rn+':'+sel;
                  }
                }
                const key = browse.kind==='src'?'path': browse.kind==='dest'?'dest': browse.kind;
                setCfg(c=>({...c, sources:c.sources.map((x,i)=> i===browse.rowIdx?{...x,[key]:sel}:x)})); markDirty(); setBrowse(null);
              }}>Select</button>
            </div>
          </div>
        </div>
      )}

      {/* Account dialog */}
      {accountOpen && (
        <div className="dlg-overlay open" onClick={(e)=>{ if(e.target===e.currentTarget) setAccountOpen(false); }}>
          <div className="dlg-card" style={{ width:420 }}>
            <h3 className="dlg-title">Account settings</h3>
            <p className="hint">Change username or password without losing any data. Current password required.</p>
            <label className="field">Current password <input type="password" value={accountForm.currentPass} onChange={e=>setAccountForm(s=>({...s,currentPass:e.target.value}))} /></label>
            <label className="field">New username (optional) <input value={accountForm.newUser} onChange={e=>setAccountForm(s=>({...s,newUser:e.target.value}))} placeholder={auth.username||''} /></label>
            <label className="field">New password (optional) <input type="password" value={accountForm.newPass} onChange={e=>setAccountForm(s=>({...s,newPass:e.target.value}))} placeholder="leave blank to keep" /></label>
            <div className="dlg-actions" style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
              <button className="btn ghost" onClick={()=>setAccountOpen(false)}>Cancel</button>
              <button className="btn filled" onClick={async()=>{
                const body: Record<string,string> = { currentPassword: accountForm.currentPass };
                if (accountForm.newUser.trim()) body.username = accountForm.newUser.trim();
                if (accountForm.newPass) body.password = accountForm.newPass;
                if (!body.username && !body.password) { showToast('Nothing to change', true); return; }
                try { await api('/api/account', { method:'POST', body: JSON.stringify(body) }); showToast('Account updated'); setAccountOpen(false); setAccountForm({ currentPass:'', newUser:'', newPass:'' }); await refreshAuth(); } catch(e){ showToast((e as Error).message, true); }
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {dialog.dlg}
      {toast && <Toast msg={toast.msg} err={toast.err} onDone={()=>setToast(null)} />}
    </div>
  );
}
