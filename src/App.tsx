import { useCallback, useEffect, useRef, useState } from 'react';
import * as Gen from './lib/generator';
import { api } from './api';
import type * as T from './lib/types';
import { Icon, ToastHost, toast, useDialog } from './lib/ui';
import FluidTabs from './components/ui/fluid-tabs/fluid-tabs';
import { Button } from './components/ui/button';
import HoldToDeleteButton from './components/ui/hold-to-delete-button/hold-to-delete-button';
import { AuthView } from './views/AuthView';
import { Sidebar } from './views/Sidebar';
import { BuilderTab } from './views/BuilderTab';
import { RunTab } from './views/RunTab';
import { ScheduleTab } from './views/ScheduleTab';
import { DashboardTab } from './views/DashboardTab';
import { InstallTab, ScriptTab, SettingsTab, WebhookTab } from './views/MiscTabs';
import { BrowseDialog, DestDialog, VpsDialog } from './views/dialogs';

const TABS: { id: T.Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'builder', label: 'Builder', icon: 'wrench' },
  { id: 'script', label: 'Script editor', icon: 'code' },
  { id: 'run', label: 'Run & logs', icon: 'terminal' },
  { id: 'schedule', label: 'Schedule', icon: 'clock' },
  { id: 'install', label: 'Install', icon: 'link' },
  { id: 'webhook', label: 'Webhook test', icon: 'bell' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

type AuthStatus = { setupNeeded: boolean; authenticated: boolean; username: string | null };

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('rcloneweb_theme') as 'dark' | 'light') || 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('rcloneweb_theme', theme);
  }, [theme]);

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const refreshAuth = useCallback(async () => {
    try {
      const s = await api('/api/auth/status') as AuthStatus;
      setAuth(s);
    } catch {
      setAuth({ setupNeeded: false, authenticated: false, username: null });
    }
  }, []);
  useEffect(() => { refreshAuth(); }, [refreshAuth]);

  const dialog = useDialog();

  // ---- data ----
  const [scripts, setScripts] = useState<T.ScriptSummary[]>([]);
  const [fleet, setFleet] = useState<T.FleetItem[]>([]);
  const [dests, setDests] = useState<T.DestItem[]>([]);
  const [loadError, setLoadError] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [s, f, d] = await Promise.all([
        api('/api/scripts') as Promise<T.ScriptSummary[]>,
        api('/api/fleet') as Promise<T.FleetItem[]>,
        api('/api/destinations') as Promise<T.DestItem[]>,
      ]);
      setScripts(s); setFleet(f); setDests(d);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { if (auth?.authenticated) loadAll(); }, [auth?.authenticated, loadAll]);

  // ---- current doc ----
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<T.ScriptDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<T.Tab>('dashboard');

  const [cfg, setCfg] = useState<Gen.AppConfig>(() => Gen.defaultConfig());
  const [cronExpr, setCronExpr] = useState('0 2 * * *');
  const [sourceVpsId, setSourceVpsId] = useState('');
  const [destFleetId, setDestFleetId] = useState('manual');
  const [editorText, setEditorText] = useState('');
  const [manualEdited, setManualEdited] = useState(false);

  const applyDoc = useCallback((d: T.ScriptDoc | null) => {
    setDoc(d);
    setSelectedId(d && d.id !== '__new__' ? d.id : null);
    if (d?.config) {
      setCfg(Gen.normalize(d.config));
      setCronExpr(d.cronExpr || '0 2 * * *');
      setSourceVpsId(d.sourceVpsId || '');
      setDestFleetId(d.destFleetId || 'manual');
      setEditorText(d.script ?? '');
      setManualEdited(Boolean(d.manualEdited));
    } else if (!d) {
      setCfg(Gen.defaultConfig());
      setCronExpr('0 2 * * *');
      setSourceVpsId('');
      setDestFleetId('manual');
      setEditorText('');
      setManualEdited(false);
    }
  }, []);

  const updateCfg = useCallback((fn: (c: Gen.AppConfig) => Gen.AppConfig) => {
    setCfg((c) => fn(c));
    setDirty(true);
  }, []);

  const openSeq = useRef(0);
  const openDoc = useCallback(async (id: string, targetTab?: T.Tab) => {
    if (dirty) {
      const ok = await dialog.confirm('Unsaved changes', 'Discard your current edits?', 'Discard', true);
      if (!ok) return;
    }
    const seq = ++openSeq.current;
    try {
      const d = await api(`/api/scripts/${id}`) as T.ScriptDoc;
      if (seq !== openSeq.current) return; // a newer selection already landed
      applyDoc(d);
      setDirty(false);
      setTab(targetTab ?? 'builder');
    } catch (e) { toast((e as Error).message, true); }
  }, [dirty, dialog, applyDoc]);

  const newDoc = useCallback(async () => {
    if (dirty) {
      const ok = await dialog.confirm('Unsaved changes', 'Discard?', 'Discard', true);
      if (!ok) return;
    }
    // A draft doc (id '__new__') keeps the editor open — a null doc would
    // bounce the user back to the dashboard.
    const draftCfg = Gen.defaultConfig();
    applyDoc({
      id: '__new__',
      name: draftCfg.name,
      config: draftCfg,
      cronExpr: '0 2 * * *',
      sourceVpsId: null,
      destFleetId: null,
      script: '',
      manualEdited: false,
    });
    setDirty(true);
    setTab('builder');
  }, [dirty, dialog, applyDoc]);

  const saveDoc = useCallback(async (): Promise<string | null> => {
    if (!sourceVpsId) { toast('Select a Source VPS in the Builder first', true); setTab('builder'); return null; }
    let generated: string;
    try { generated = Gen.buildScript(cfg); } catch (e) { toast((e as Error).message, true); return null; }
    const body: Record<string, unknown> = {
      ...(doc || {}),
      name: cfg.name || 'untitled',
      config: cfg,
      cronExpr,
      sourceVpsId: sourceVpsId || null,
      destFleetId: destFleetId === 'manual' ? null : destFleetId,
      script: manualEdited ? editorText : generated,
      manualEdited,
    };
    try {
      const saved = await api(selectedId ? `/api/scripts/${selectedId}` : '/api/scripts', { method: selectedId ? 'PUT' : 'POST', body: JSON.stringify(body) }) as T.ScriptDoc;
      setSelectedId(saved.id);
      setDoc(saved);
      setDirty(false);
      setManualEdited(Boolean(saved.manualEdited));
      setScripts((prev) => {
        const rest = prev.filter((s) => s.id !== saved.id);
        return [{ id: saved.id, name: saved.name, updatedAt: saved.updatedAt ?? new Date().toISOString() }, ...rest];
      });
      toast(selectedId ? 'Saved' : 'Script created');
      return saved.id;
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, true);
      return null;
    }
  }, [cfg, cronExpr, destFleetId, doc, editorText, manualEdited, selectedId, sourceVpsId]);

  const deleteDoc = useCallback(async (id: string, name: string, confirmed = false) => {
    // Deletion is deliberate by construction at the call site (hold-to-delete
    // in the topbar); the sidebar still passes through a confirm dialog.
    if (!confirmed) {
      const ok = await dialog.confirm('Delete script?', `Delete "${name}"? Runs and schedules for it are removed too. This cannot be undone.`, 'Delete', true);
      if (!ok) return;
    }
    try {
      await api(`/api/scripts/${id}`, { method: 'DELETE' });
      if (id === selectedId) applyDoc(null);
      setScripts((prev) => prev.filter((s) => s.id !== id));
      setTab('dashboard');
      toast('Script deleted');
    } catch (e) { toast((e as Error).message, true); }
  }, [dialog, selectedId, applyDoc]);

  const duplicateDoc = useCallback(async (s: T.ScriptSummary) => {
    try {
      const src = await api(`/api/scripts/${s.id}`) as T.ScriptDoc;
      const copy: Record<string, unknown> = { ...src, id: undefined, createdAt: undefined, updatedAt: undefined, rawToken: undefined, name: `${src.name} copy` };
      delete (copy as Record<string, unknown>).id;
      const saved = await api('/api/scripts', { method: 'POST', body: JSON.stringify(copy) }) as T.ScriptDoc;
      await loadAll();
      toast(`Duplicated as "${saved.name}"`);
    } catch (e) { toast((e as Error).message, true); }
  }, [loadAll]);

  const runScript = useCallback(async (scriptId: string, vpsId: string, dryRun: boolean): Promise<boolean> => {
    try {
      await api(`/api/scripts/${scriptId}/run`, { method: 'POST', body: JSON.stringify({ vpsId, dryRun }) });
      toast(dryRun ? 'Dry run started' : 'Backup started');
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  }, []);

  // Run from the Run tab: save first when dirty, then start.
  const runFromTab = useCallback(async (vpsId: string, dryRun: boolean): Promise<boolean> => {
    let id = selectedId;
    if (dirty || !id) {
      id = await saveDoc();
      if (!id) return false;
    }
    return runScript(id, vpsId, dryRun);
  }, [selectedId, dirty, saveDoc, runScript]);

  // Run from the dashboard: scripts there are saved by definition.
  const runFromDashboard = useCallback(async (s: T.ScriptSummary) => {
    const vpsId = doc?.id === s.id ? sourceVpsId : '';
    if (!vpsId) { await openDoc(s.id, 'run'); return; }
    if (await runScript(s.id, vpsId, false)) await openDoc(s.id, 'run');
  }, [doc, sourceVpsId, runScript, openDoc]);

  // ---- fleet / destination dialogs ----
  const [vpsDlg, setVpsDlg] = useState<T.FleetItem | null | 'new'>(null);
  const [destDlg, setDestDlg] = useState<T.DestItem | null | 'new'>(null);

  const editVps = useCallback(async (v: T.FleetItem) => {
    try {
      const full = await api(`/api/fleet/${v.id}`) as T.FleetItem;
      setVpsDlg(full);
    } catch { setVpsDlg(v); }
  }, []);
  const editDest = useCallback(async (d: T.DestItem) => {
    try {
      const full = await api(`/api/destinations/${d.id}`) as T.DestItem;
      setDestDlg(full);
    } catch { setDestDlg(d); }
  }, []);
  const deleteVps = useCallback(async (v: T.FleetItem) => {
    const ok = await dialog.confirm('Delete VPS?', `Delete "${v.name}"? Its schedules and run logs are removed too.`, 'Delete', true);
    if (!ok) return;
    try { await api(`/api/fleet/${v.id}`, { method: 'DELETE' }); await loadAll(); toast('VPS deleted'); } catch (e) { toast((e as Error).message, true); }
  }, [dialog, loadAll]);
  const deleteDest = useCallback(async (d: T.DestItem) => {
    const ok = await dialog.confirm('Delete destination?', `Delete "${d.name}"?`, 'Delete', true);
    if (!ok) return;
    try { await api(`/api/destinations/${d.id}`, { method: 'DELETE' }); await loadAll(); toast('Destination deleted'); } catch (e) { toast((e as Error).message, true); }
  }, [dialog, loadAll]);

  // ---- browse dialog ----
  const [browse, setBrowse] = useState<T.BrowseState | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);

  const runBrowse = useCallback(async (state: T.BrowseState, path: string) => {
    setBrowseLoading(true);
    try {
      let res: { ok: boolean; path: string; entries: T.BrowseEntry[]; msg?: string };
      if (state.mode === 'vps' && state.vpsId) res = await api(`/api/fleet/${state.vpsId}/browse`, { method: 'POST', body: JSON.stringify({ path }) }) as never;
      else if (state.mode === 'remoteFleet' && state.destId) res = await api(`/api/destinations/${state.destId}/browse`, { method: 'POST', body: JSON.stringify({ path }) }) as never;
      else res = await api('/api/browse/remote', { method: 'POST', body: JSON.stringify({ ...(state.remoteCfg || {}), path }) }) as never;
      if (!res.ok) { toast(res.msg || 'Browse failed', true); setBrowseLoading(false); return; }
      // Only apply when this dialog is still the one on screen (sequence guard).
      setBrowse((prev) => (prev && prev.kind === state.kind && prev.rowIdx === state.rowIdx
        ? { ...prev, path: res.path, entries: res.entries, hint: `${res.entries.length} items` }
        : prev));
    } catch (e) {
      const msg = (e as { data?: { msg?: string } })?.data?.msg || (e as Error).message;
      toast(String(msg), true);
    }
    setBrowseLoading(false);
  }, []);

  const openBrowse = useCallback(async (rowIdx: number, kind: 'src' | 'dest' | 'include' | 'exclude') => {
    const row = cfg.sources[rowIdx];
    if (!row) return;
    let state: T.BrowseState;
    if (kind === 'src' || kind === 'include' || kind === 'exclude') {
      if (!sourceVpsId) { toast('Select a Source VPS first', true); return; }
      state = { kind, rowIdx, mode: 'vps', vpsId: sourceVpsId, path: kind === 'src' ? (row.path || '/') : '/', entries: [], hint: 'Loading…', selected: [] };
    } else if (destFleetId !== 'manual') {
      const cur = row.dest || '';
      const path = cur.includes(':') ? cur.split(':').slice(1).join(':') : (cur || '/');
      state = { kind, rowIdx, mode: 'remoteFleet', destId: destFleetId, path, entries: [], hint: 'Loading…', selected: [] };
    } else {
      const cur = row.dest || '';
      const path = cur.includes(':') ? cur.split(':').slice(1).join(':') : '';
      state = {
        kind, rowIdx, mode: 'remote', path,
        remoteCfg: {
          type: cfg.dest.type, host: cfg.dest.host, port: cfg.dest.port, user: cfg.dest.user,
          sftpAuth: cfg.dest.sftpAuth, keyPath: cfg.dest.keyPath, bucket: cfg.dest.s3Bucket,
          region: cfg.dest.s3Region, endpoint: cfg.dest.s3Endpoint, provider: cfg.dest.s3Provider,
          password: cfg.secrets.password, accessKey: cfg.secrets.s3AccessKey, secretKey: cfg.secrets.s3SecretKey,
        },
        entries: [], hint: 'Loading…', selected: [],
      };
    }
    setBrowse(state);
    await runBrowse(state, state.path);
  }, [cfg, sourceVpsId, destFleetId, runBrowse]);

  const navigateTo = useCallback((path: string) => {
    setBrowse((b) => {
      if (b) runBrowse(b, path);
      return b ? { ...b, path, hint: 'Loading…' } : b;
    });
  }, [runBrowse]);

  const applyBrowseSingle = useCallback((sel: string) => {
    setBrowse((b) => {
      if (!b) return null;
      const row = cfg.sources[b.rowIdx];
      if (!row) return null;
      let value = sel.trim();
      if (b.kind === 'dest') {
        const existing = row.dest;
        if (existing.includes(':')) value = existing.split(':')[0] + ':' + value.replace(/^\/+/, '');
        else {
          const rn = cfg.dest.remoteName || 'my-backup-remote';
          if (cfg.dest.type === 's3' && cfg.dest.s3Bucket && !value.startsWith(cfg.dest.s3Bucket)) value = cfg.dest.s3Bucket + '/' + value.replace(/^\/+/, '');
          value = rn + ':' + value.replace(/^\/+/, '');
        }
      }
      const key = b.kind === 'src' ? 'path' : b.kind === 'dest' ? 'dest' : b.kind;
      updateCfg((c) => ({ ...c, sources: c.sources.map((x, i) => (i === b.rowIdx ? { ...x, [key]: value } : x)) }));
      return null;
    });
  }, [cfg, updateCfg]);

  const applyBrowseMulti = useCallback((paths: string[]) => {
    setBrowse((b) => {
      if (!b) return null;
      const row = cfg.sources[b.rowIdx];
      if (!row) return null;
      const key = b.kind === 'include' ? 'include' : 'exclude';
      const use = paths.length ? paths : [b.path];
      const existing = (row[key] || '').split(/[,\s]+/).filter(Boolean);
      const next = [...existing];
      for (const raw of use) {
        const p = raw.startsWith('/') ? raw : '/' + raw;
        if (!next.includes(p)) next.push(p);
      }
      updateCfg((c) => ({ ...c, sources: c.sources.map((x, i) => (i === b.rowIdx ? { ...x, [key]: next.join(', ') } : x)) }));
      return null;
    });
  }, [cfg, updateCfg]);

  const mkdirBrowse = useCallback(async () => {
    if (!browse) return;
    const name = await dialog.prompt('New folder', 'Enter a folder name', '', 'my-folder');
    if (!name) return;
    const clean = name.trim().replace(/[/\\]/g, '').replace(/\s+/g, '-');
    if (!clean) return;
    const newPath = (browse.path.replace(/\/+$/, '') || '') + '/' + clean;
    try {
      let res: { ok: boolean; msg?: string };
      if (browse.mode === 'vps' && browse.vpsId) res = await api(`/api/fleet/${browse.vpsId}/mkdir`, { method: 'POST', body: JSON.stringify({ path: newPath }) }) as never;
      else if (browse.mode === 'remoteFleet' && browse.destId) res = await api(`/api/destinations/${browse.destId}/mkdir`, { method: 'POST', body: JSON.stringify({ path: newPath }) }) as never;
      else if (browse.mode === 'vps') res = await api('/api/browse/mkdir-local', { method: 'POST', body: JSON.stringify({ path: newPath }) }) as never;
      else res = await api('/api/browse/mkdir-remote', { method: 'POST', body: JSON.stringify({ ...(browse.remoteCfg || {}), path: newPath }) }) as never;
      if (!res.ok) { toast(res.msg || 'mkdir failed', true); return; }
      toast(`Created ${clean}`);
      navigateTo(browse.path);
    } catch (e) { toast((e as Error).message, true); }
  }, [browse, dialog, navigateTo]);

  // ---- render ----
  if (!auth) {
    return <div className="boot-screen"><span className="spinner" /></div>;
  }
  if (!auth.authenticated) {
    return (
      <>
        <AuthView setupNeeded={auth.setupNeeded} onAuthed={refreshAuth} />
        <ToastHost />
      </>
    );
  }

  const activeTabId = !selectedId && !doc && !['dashboard', 'settings'].includes(tab) ? 'dashboard' : tab;
  const dirtyLabel = dirty ? 'Unsaved changes' : selectedId ? 'Saved' : '';

  const openCreateVps = () => setVpsDlg('new');
  const openCreateDest = () => setDestDlg('new');

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <Sidebar
        scripts={scripts}
        selectedId={selectedId}
        fleet={fleet}
        dests={dests}
        username={auth.username ?? ''}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onNewScript={newDoc}
        onOpenScript={(id) => openDoc(id)}
        onDeleteScript={(s) => deleteDoc(s.id, s.name)}
        onDuplicateScript={duplicateDoc}
        onAddVps={openCreateVps}
        onEditVps={editVps}
        onDeleteVps={deleteVps}
        onAddDest={openCreateDest}
        onEditDest={editDest}
        onDeleteDest={deleteDest}
        onPickDest={(d) => { setDestFleetId(d.id); if (doc) setDirty(true); toast(`Destination preset: ${d.name}`); }}
        pickedDestId={destFleetId}
        onAccount={() => setTab('settings')}
        onLogout={async () => { await api('/api/auth/logout', { method: 'POST' }); applyDoc(null); await refreshAuth(); }}
      />

      <main className="main" id="main">
        {!selectedId && !doc && activeTabId !== 'settings' ? (
          <DashboardTab
            scripts={scripts}
            fleet={fleet}
            dests={dests}
            onOpenScript={(id, t) => openDoc(id, t)}
            onRunScript={runFromDashboard}
          />
        ) : (
          <>
            <header className="topbar">
              <input
                className="name-input"
                placeholder="Script name"
                value={cfg.name}
                aria-label="Script name"
                spellCheck={false}
                onChange={(e) => { updateCfg((c) => ({ ...c, name: e.target.value })); }}
              />
              <span className={`save-status ${dirty ? 'is-dirty' : ''}`}>{dirtyLabel}</span>
              <span className="topbar-actions">
                <Button className="btn filled" onClick={saveDoc}><Icon name="save" size={14} /> Save</Button>
                {selectedId && (
                  <HoldToDeleteButton
                    label="Hold to delete"
                    holdDuration={1200}
                    className="hold-topbar"
                    onDelete={() => selectedId && deleteDoc(selectedId, cfg.name, true)}
                  />
                )}
              </span>
            </header>

            <FluidTabs
              variant="underline"
              ariaLabel="Script views"
              value={activeTabId}
              onValueChange={(v) => setTab(v as T.Tab)}
              className="sona-tabs"
              activeIndicatorClassName="sona-tab-indicator"
              tabs={TABS.map((t) => ({
                value: t.id,
                title: (<span className="tab-title"><Icon name={t.icon} size={13} /> {t.label}</span>),
              }))}
            />

            <section className="tab-body" role="tabpanel" key={activeTabId}>
              {activeTabId === 'dashboard' && (
                <DashboardTab
                  scripts={scripts}
                  fleet={fleet}
                  dests={dests}
                  onOpenScript={(id, t) => openDoc(id, t)}
                  onRunScript={runFromDashboard}
                />
              )}
              {activeTabId === 'builder' && (
                <BuilderTab
                  cfg={cfg} update={updateCfg}
                  fleet={fleet} dests={dests}
                  sourceVpsId={sourceVpsId} setSourceVpsId={(id) => { setSourceVpsId(id); setDirty(true); }}
                  destFleetId={destFleetId} setDestFleetId={(id) => { setDestFleetId(id); setDirty(true); }}
                  openBrowse={openBrowse} browseLoading={browseLoading}
                />
              )}
              {activeTabId === 'script' && (
                <ScriptTab
                  script={editorText}
                  cfg={cfg}
                  onChange={(v) => { setEditorText(v); setManualEdited(true); setDirty(true); }}
                  onRegenerate={() => { try { setEditorText(Gen.buildScript(cfg)); setManualEdited(false); setDirty(true); } catch (e) { toast((e as Error).message, true); } }}
                  dialog={dialog}
                />
              )}
              {activeTabId === 'run' && (
                <RunTab
                  scriptId={selectedId}
                  docName={cfg.name}
                  fleet={fleet}
                  sourceVpsId={sourceVpsId}
                  onRun={runFromTab}
                  dialog={dialog}
                />
              )}
              {activeTabId === 'schedule' && (
                <ScheduleTab
                  scriptId={selectedId}
                  cronExpr={cronExpr} setCronExpr={(v) => { setCronExpr(v); setDirty(true); }}
                  fleet={fleet} sourceVpsId={sourceVpsId}
                  dialog={dialog}
                />
              )}
              {activeTabId === 'install' && <InstallTab scriptId={selectedId} rawToken={doc?.rawToken} />}
              {activeTabId === 'webhook' && <WebhookTab cfg={cfg} />}
              {activeTabId === 'settings' && (
                <SettingsTab
                  username={auth.username ?? ''}
                  theme={theme}
                  onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                  onImported={loadAll}
                  dialog={dialog}
                />
              )}
            </section>
          </>
        )}

        {loadError && (
          <div className="load-error">
            Couldn't reach the API. <button className="btn tonal small" onClick={loadAll}>Retry</button>
          </div>
        )}
      </main>

      {vpsDlg && (
        <VpsDialog
          draft={vpsDlg === 'new' ? {} : { ...vpsDlg, password: '' }}
          onClose={() => setVpsDlg(null)}
          onSaved={loadAll}
        />
      )}
      {destDlg && (
        <DestDialog
          draft={destDlg === 'new' ? { type: 'sftp' } : { ...destDlg, password: '', s3AccessKey: '', s3SecretKey: '' }}
          onClose={() => setDestDlg(null)}
          onSaved={loadAll}
        />
      )}
      {browse && (
        <BrowseDialog
          state={browse}
          loading={browseLoading}
          onClose={() => setBrowse(null)}
          onNavigate={navigateTo}
          onPreselect={(path) => setBrowse((b) => (b ? { ...b, path } : b))}
          onClearSelected={() => setBrowse((b) => (b ? { ...b, selected: [] } : b))}
          onToggle={(path) => setBrowse((b) => {
            if (!b) return b;
            const has = b.selected.includes(path);
            return { ...b, selected: has ? b.selected.filter((x) => x !== path) : [...b.selected, path] };
          })}
          onMkdir={mkdirBrowse}
          onApplyMulti={applyBrowseMulti}
          onApplySingle={applyBrowseSingle}
        />
      )}
      {dialog.dlg}
      <ToastHost />
    </div>
  );
}
