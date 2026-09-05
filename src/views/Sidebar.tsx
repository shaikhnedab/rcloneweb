import { useState } from 'react';
import type { DestItem, FleetItem, ScriptSummary } from '../lib/types';
import { FluidTooltipGroup, Icon, Tip } from '../lib/ui';
import { timeAgo } from '../lib/format';

interface Props {
  scripts: ScriptSummary[];
  selectedId: string | null;
  fleet: FleetItem[];
  dests: DestItem[];
  username: string;
  onNewScript: () => void;
  onOpenScript: (id: string) => void;
  onDeleteScript: (s: ScriptSummary) => void;
  onDuplicateScript: (s: ScriptSummary) => void;
  onAddVps: () => void;
  onEditVps: (v: FleetItem) => Promise<void>;
  onDeleteVps: (v: FleetItem) => void;
  onAddDest: () => void;
  onEditDest: (d: DestItem) => Promise<void>;
  onDeleteDest: (d: DestItem) => void;
  onPickDest: (d: DestItem) => void;
  pickedDestId: string | null;
  onAccount: () => void;
  onLogout: () => void;
  onHome: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function Sidebar(p: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q ? p.scripts.filter((s) => s.name.toLowerCase().includes(q)) : p.scripts;

  return (
    <FluidTooltipGroup orientation="vertical">
    <aside className="sidebar">
      <div className="brand">
      <Tip id="tip-home" label="Go to dashboard" side="right">
        <button className="brand-home" aria-label="Go to dashboard" onClick={p.onHome}>
          <span className="brand-logo"><Icon name="box" size={18} /></span>
          <span className="brand-name">rcloneweb</span>
        </button>
      </Tip>
      <div className="brand-actions">
        <Tip id="tip-account" label={p.username ? `Signed in as ${p.username}` : 'Account settings'} side="right">
          <button className="icon-btn" title={p.username ? `Signed in as ${p.username}` : 'Account'} aria-label="Account settings" onClick={p.onAccount}>
            <Icon name="settings" size={15} />
          </button>
        </Tip>
        <Tip id="tip-logout" label="Sign out" side="right">
          <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={p.onLogout}>
            <Icon name="logout" size={15} />
          </button>
        </Tip>
      </div>
      </div>

      <button className="btn filled block" onClick={p.onNewScript}><Icon name="plus" size={14} /> New script</button>

      <div className="side-section">
        <div className="side-head"><Icon name="server" size={13} /> Fleet
          <Tip id="tip-add-vps" label="Add VPS" side="right">
            <button className="side-add" aria-label="Add VPS" onClick={p.onAddVps}><Icon name="plus" size={12} /></button>
          </Tip>
        </div>
        {p.fleet.length === 0
          ? <p className="side-empty">No VPS yet — add one to run backups over SSH.</p>
          : p.fleet.map((v) => (
            <div key={v.id} className="side-item">
              <span className={`dot ${v.lastSeen ? 'dot-ok' : 'dot-off'}`} title={v.lastSeen ? `Last seen ${timeAgo(v.lastSeen)}` : 'Never connected'} />
              <button className="side-name" title={v.host} onClick={() => p.onEditVps(v)}>{v.name}</button>
              <span className="side-actions">
                <Tip id={`tip-vps-edit-${v.id}`} label={`Edit ${v.name}`} side="right">
                  <button className="icon-btn subtle" aria-label={`Edit ${v.name}`} onClick={() => p.onEditVps(v)}><Icon name="edit" size={13} /></button>
                </Tip>
                <Tip id={`tip-vps-del-${v.id}`} label={`Delete ${v.name}`} side="right">
                  <button className="icon-btn subtle danger-text" aria-label={`Delete ${v.name}`} onClick={() => p.onDeleteVps(v)}><Icon name="trash" size={13} /></button>
                </Tip>
              </span>
            </div>
          ))}
      </div>

      <div className="side-section">
        <div className="side-head"><Icon name="cloud" size={13} /> Destinations
          <Tip id="tip-add-dest" label="Add destination" side="right">
            <button className="side-add" aria-label="Add destination" onClick={p.onAddDest}><Icon name="plus" size={12} /></button>
          </Tip>
        </div>
        {p.dests.length === 0
          ? <p className="side-empty">No destinations yet. SFTP, FTP or S3.</p>
          : p.dests.map((d) => (
            <div key={d.id} className={`side-item ${p.pickedDestId === d.id ? 'picked' : ''}`}>
              <span className={`dot ${d.lastSeen ? 'dot-ok' : 'dot-off'}`} title={d.lastSeen ? `Last seen ${timeAgo(d.lastSeen)}` : 'Never tested'} />
              <button className="side-name" title={d.type === 's3' ? d.s3Bucket : d.host} onClick={() => p.onEditDest(d)}>
                <span className="side-type">{d.type}</span> {d.name}
              </button>
              <span className="side-actions">
                <Tip id={`tip-dest-edit-${d.id}`} label={`Edit ${d.name}`} side="right">
                  <button className="icon-btn subtle" aria-label={`Edit ${d.name}`} onClick={() => p.onEditDest(d)}><Icon name="edit" size={13} /></button>
                </Tip>
                <Tip id={`tip-dest-del-${d.id}`} label={`Delete ${d.name}`} side="right">
                  <button className="icon-btn subtle danger-text" aria-label={`Delete ${d.name}`} onClick={() => p.onDeleteDest(d)}><Icon name="trash" size={13} /></button>
                </Tip>
              </span>
            </div>
          ))}
      </div>

      <div className="side-section side-scripts">
        <div className="side-head"><Icon name="code" size={13} /> Scripts</div>
        {p.scripts.length > 5 && (
          <div className="side-search">
            <Icon name="search" size={12} />
            <input placeholder="Filter scripts…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter scripts" />
          </div>
        )}
        <nav className="side-list" aria-label="Scripts">
          {filtered.length === 0
            ? <p className="side-empty">{p.scripts.length ? 'No matches.' : 'Nothing here yet — create your first script.'}</p>
            : filtered.map((s) => (
              <div key={s.id} className={`side-item ${s.id === p.selectedId ? 'picked' : ''}`}>
                <button className="side-name" onClick={() => p.onOpenScript(s.id)}>{s.name}</button>
                <span className="side-actions">
                  <Tip id={`tip-script-dup-${s.id}`} label={`Duplicate ${s.name}`} side="right">
                    <button className="icon-btn subtle" aria-label={`Duplicate ${s.name}`} title="Duplicate" onClick={() => p.onDuplicateScript(s)}><Icon name="copy" size={13} /></button>
                  </Tip>
                  <Tip id={`tip-script-del-${s.id}`} label={`Delete ${s.name}`} side="right">
                    <button className="icon-btn subtle danger-text" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => p.onDeleteScript(s)}><Icon name="trash" size={13} /></button>
                  </Tip>
                </span>
              </div>
            ))}
        </nav>
      </div>

      <div className="side-foot">
        <span>{p.username}</span>
        <Tip id="tip-theme" label="Toggle theme" side="right">
          <button className="icon-btn subtle" title="Toggle theme" aria-label="Toggle theme" onClick={p.onToggleTheme}>
            <Icon name={p.theme === 'dark' ? 'sun' : 'moon'} size={14} />
          </button>
        </Tip>
      </div>
    </aside>
    </FluidTooltipGroup>
  );
}
