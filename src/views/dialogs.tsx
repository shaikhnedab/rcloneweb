import { useEffect, useState } from 'react';
import { api } from '../api';
import type * as T from '../lib/types';
import { Field, Icon, Modal, Spinner, toast } from '../lib/ui';
import { Button } from '../components/ui/button';

// ---------- VPS (fleet) dialog ----------
export type VpsDraft = Partial<T.FleetItem & { password?: string; keyPath?: string }>;

export function VpsDialog({ draft, onClose, onSaved }: { draft: VpsDraft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<VpsDraft>(draft);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState('');
  const set = (patch: VpsDraft) => setD((s) => ({ ...s, ...patch }));

  const test = async () => {
    const host = String(d.host || '').trim();
    if (!host) { toast('Host required', true); return; }
    setTesting(true); setResult('Testing…');
    try {
      let r: { ok: boolean; msg: string };
      if (d.id && !d.password) r = await api(`/api/fleet/${d.id}/test`, { method: 'POST' }) as never;
      else {
        r = await api('/api/test/connection', {
          method: 'POST',
          body: JSON.stringify({ type: 'sftp', host, port: String(d.port || '22'), user: String(d.user || 'root'), password: String(d.password || ''), sftpAuth: String(d.auth || 'password'), keyPath: String(d.keyPath || '') }),
        }) as never;
      }
      setResult(r.msg || (r.ok ? 'SSH OK' : 'Failed'));
      toast(r.msg || (r.ok ? 'Connected' : 'Failed'), !r.ok);
    } catch (e) { setResult((e as Error).message); toast((e as Error).message, true); }
    setTesting(false);
  };

  const save = async () => {
    const body: Record<string, unknown> = { name: d.name, host: d.host, port: d.port || 22, user: d.user || 'root', auth: d.auth || 'password', keyPath: d.keyPath || '' };
    if (d.password) body.password = d.password;
    try {
      if (d.id) await api(`/api/fleet/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/fleet', { method: 'POST', body: JSON.stringify(body) });
      toast(d.id ? 'VPS updated' : 'VPS added');
      onSaved(); onClose();
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <Modal title={d.id ? 'Edit VPS' : 'Add VPS'} onClose={onClose}>
      <h3 className="dlg-title">{d.id ? 'Edit VPS' : 'Add VPS'}</h3>
      <Field label="Name"><input value={d.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="my-vps-1" /></Field>
      <div className="row">
        <Field label="Host" grow><input value={d.host || ''} onChange={(e) => set({ host: e.target.value })} placeholder="1.2.3.4" /></Field>
        <Field label="Port"><input type="number" value={d.port ?? 22} onChange={(e) => set({ port: Number(e.target.value) })} /></Field>
      </div>
      <div className="row">
        <Field label="User"><input value={d.user || 'root'} onChange={(e) => set({ user: e.target.value })} /></Field>
        <Field label="Auth">
          <select value={d.auth || 'password'} onChange={(e) => set({ auth: e.target.value })}>
            <option value="password">Password</option>
            <option value="key">SSH key</option>
          </select>
        </Field>
      </div>
      {d.auth !== 'key'
        ? <Field label="Password" hint="Leave blank to keep the saved password."><input type="password" value={d.password || ''} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" /></Field>
        : <Field label="Key path"><input value={d.keyPath || ''} onChange={(e) => set({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" /></Field>}
      <div className="dlg-test">
        <Button className="btn tonal small" disabled={testing} onClick={test}>{testing ? <Spinner size={13} /> : <Icon name="zap" size={13} />} Test connection</Button>
        {result && <span className="dlg-test-result">{result}</span>}
      </div>
      <div className="dlg-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Button className="btn filled" onClick={save}>Save VPS</Button>
      </div>
    </Modal>
  );
}

// ---------- Destination dialog ----------
export type DestDraft = Partial<T.DestItem & { password?: string; s3AccessKey?: string; s3SecretKey?: string }>;

export function DestDialog({ draft, onClose, onSaved }: { draft: DestDraft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<DestDraft>(draft);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState('');
  const set = (patch: DestDraft) => setD((s) => ({ ...s, ...patch }));
  const type = d.type || 'sftp';

  const test = async () => {
    setTesting(true); setResult('Testing…');
    try {
      let r: { ok: boolean; msg: string };
      const hasNewSecret = Boolean(d.password || d.s3AccessKey || d.s3SecretKey);
      if (d.id && !hasNewSecret) r = await api(`/api/destinations/${d.id}/test`, { method: 'POST' }) as never;
      else {
        r = await api('/api/test/connection', {
          method: 'POST',
          body: JSON.stringify({
            type, host: String(d.host || ''), port: String(d.port || ''), user: String(d.user || ''),
            password: String(d.password || ''), sftpAuth: String(d.sftpAuth || 'password'), keyPath: String(d.keyPath || ''),
            bucket: String(d.s3Bucket || ''), region: String(d.s3Region || ''), endpoint: String(d.s3Endpoint || ''),
            provider: String(d.s3Provider || 'AWS'), accessKey: String(d.s3AccessKey || ''), secretKey: String(d.s3SecretKey || ''),
          }),
        }) as never;
      }
      setResult(r.msg || (r.ok ? 'Connection OK' : 'Failed'));
      toast(r.msg || (r.ok ? 'Connected' : 'Failed'), !r.ok);
    } catch (e) { setResult((e as Error).message); toast((e as Error).message, true); }
    setTesting(false);
  };

  const save = async () => {
    const body: Record<string, unknown> = {
      name: d.name, type, host: d.host || '', port: d.port || '', user: d.user || '',
      remoteName: d.remoteName || 'my-backup-remote', remotePath: d.remotePath || '/', sftpAuth: d.sftpAuth || 'password', keyPath: d.keyPath || '',
      s3Provider: d.s3Provider || 'AWS', s3Bucket: d.s3Bucket || '', s3Region: d.s3Region || '', s3Endpoint: d.s3Endpoint || '',
    };
    if (d.password) body.password = d.password;
    if (d.s3AccessKey) body.s3AccessKey = d.s3AccessKey;
    if (d.s3SecretKey) body.s3SecretKey = d.s3SecretKey;
    try {
      if (d.id) await api(`/api/destinations/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/destinations', { method: 'POST', body: JSON.stringify(body) });
      toast(d.id ? 'Destination updated' : 'Destination added');
      onSaved(); onClose();
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <Modal title={d.id ? 'Edit destination' : 'Add destination'} onClose={onClose} width={560}>
      <h3 className="dlg-title">{d.id ? 'Edit destination' : 'Add destination'}</h3>
      <div className="dlg-scroll">
        <Field label="Name"><input value={d.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="my-sftp-1" /></Field>
        <div className="row">
          <Field label="Type">
            <select value={type} onChange={(e) => set({ type: e.target.value })}>
              <option value="sftp">SFTP</option><option value="ftp">FTP</option><option value="s3">S3</option>
            </select>
          </Field>
          <Field label="Remote name"><input value={d.remoteName || 'my-backup-remote'} onChange={(e) => set({ remoteName: e.target.value })} /></Field>
          <Field label="Remote path" grow><input value={d.remotePath || '/'} onChange={(e) => set({ remotePath: e.target.value })} /></Field>
        </div>
        {type !== 's3' && (
          <div className="row">
            <Field label="Host" grow><input value={d.host || ''} onChange={(e) => set({ host: e.target.value })} placeholder="host.example.com" /></Field>
            <Field label="Port"><input type="number" value={d.port ?? ''} onChange={(e) => set({ port: e.target.value })} placeholder="auto" /></Field>
            <Field label="User"><input value={d.user || ''} onChange={(e) => set({ user: e.target.value })} /></Field>
          </div>
        )}
        {type === 'sftp' && (
          <div className="row">
            <Field label="Auth">
              <select value={d.sftpAuth || 'password'} onChange={(e) => set({ sftpAuth: e.target.value })}>
                <option value="password">Password</option><option value="key">SSH key</option>
              </select>
            </Field>
            <Field label="Key path" grow><input value={d.keyPath || ''} onChange={(e) => set({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" /></Field>
          </div>
        )}
        {type === 's3' && (
          <div className="row">
            <Field label="Provider">
              <select value={d.s3Provider || 'AWS'} onChange={(e) => set({ s3Provider: e.target.value })}>
                <option>AWS</option><option>Ceph</option><option>Minio</option><option>Wasabi</option><option>Backblaze B2 (S3)</option><option>Other</option>
              </select>
            </Field>
            <Field label="Bucket"><input value={d.s3Bucket || ''} onChange={(e) => set({ s3Bucket: e.target.value })} /></Field>
            <Field label="Region"><input value={d.s3Region || ''} onChange={(e) => set({ s3Region: e.target.value })} placeholder="us-east-1" /></Field>
            <Field label="Endpoint" grow><input value={d.s3Endpoint || ''} onChange={(e) => set({ s3Endpoint: e.target.value })} placeholder="https://s3.example.com" /></Field>
          </div>
        )}
        {type !== 's3'
          ? <Field label="Password" hint="Leave blank to keep the saved password."><input type="password" value={d.password || ''} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" /></Field>
          : (
            <div className="row">
              <Field label="Access key"><input value={d.s3AccessKey || ''} onChange={(e) => set({ s3AccessKey: e.target.value })} autoComplete="off" /></Field>
              <Field label="Secret key" grow><input type="password" value={d.s3SecretKey || ''} onChange={(e) => set({ s3SecretKey: e.target.value })} autoComplete="new-password" /></Field>
            </div>
          )}
      </div>
      <div className="dlg-test">
        <Button className="btn tonal small" disabled={testing} onClick={test}>{testing ? <Spinner size={13} /> : <Icon name="zap" size={13} />} Test connection</Button>
        {result && <span className="dlg-test-result">{result}</span>}
      </div>
      <div className="dlg-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Button className="btn filled" onClick={save}>Save</Button>
      </div>
    </Modal>
  );
}

// ---------- Browse dialog ----------
interface BrowseProps {
  state: T.BrowseState;
  loading: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onPreselect: (path: string) => void;
  onToggle: (path: string) => void;
  onClearSelected: () => void;
  onMkdir: () => void;
  onApplyMulti: (paths: string[]) => void;
  onApplySingle: (path: string) => void;
}

export function BrowseDialog(p: BrowseProps) {
  const { state: b } = p;
  const [pathText, setPathText] = useState(b.path);
  useEffect(() => setPathText(b.path), [b.path]);
  const multi = b.kind === 'include' || b.kind === 'exclude';
  const goUp = () => {
    const cur = b.path || '/';
    const up = cur === '/' ? '/' : cur.replace(/\/[^/]*\/?$/, '') || '/';
    p.onNavigate(up);
  };
  return (
    <Modal title="Browse" onClose={p.onClose} width={580}>
      <h3 className="dlg-title">{multi ? (b.kind === 'include' ? 'Pick files to include' : 'Pick files to exclude') : 'Browse'}</h3>
      <div className="row">
        <Field label="Path" grow>
          <input
            value={pathText} spellCheck={false} disabled={p.loading}
            onChange={(e) => setPathText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); p.onNavigate(pathText); } }}
          />
        </Field>
        <button className="btn tonal" disabled={p.loading} onClick={() => p.onNavigate(pathText)}>Go</button>
        <button className="btn ghost" disabled={p.loading} onClick={goUp} aria-label="Go up"><Icon name="up" size={14} /></button>
      </div>
      <div className="browse-list" role="listbox" aria-label="Directory contents">
        {p.loading
          ? <div className="browse-empty"><Spinner /> Loading…</div>
          : b.entries.length === 0
            ? <div className="browse-empty">Empty folder</div>
            : b.entries.map((en) => (
              <button
                key={en.path}
                className={`browse-item ${multi && b.selected.includes(en.path) ? 'selected' : ''}`}
                title={multi && en.isDir ? 'Click to select · double-click to open' : en.isDir ? undefined : 'Click to use this path'}
                onClick={() => {
                  if (multi) p.onToggle(en.path);
                  else if (en.isDir) p.onNavigate(en.path);
                  else p.onPreselect(en.path);
                }}
                onDoubleClick={() => { if (en.isDir && !p.loading) p.onNavigate(en.path); }}
              >
                <Icon name={en.isParent ? 'up' : en.isDir ? 'folder' : 'code'} size={14} />
                <span className="browse-name">{en.name}</span>
                <span className="browse-kind">{en.isParent ? 'parent' : en.isDir ? 'dir' : 'file'}</span>
              </button>
            ))}
      </div>
      {multi && (
        <div className="browse-selected">
          {b.selected.length ? (
            <>
              {b.selected.map((s) => (
                <button key={s} className="chip small removable" title="Remove from selection" onClick={() => p.onToggle(s)}>
                  {s} <Icon name="x" size={10} />
                </button>
              ))}
              <button className="btn ghost small clear-sel" onClick={p.onClearSelected}>Clear all</button>
            </>
          ) : (
            <span className="hint-inline">Click items to add them · double-click a folder to open it</span>
          )}
        </div>
      )}
      <p className="hint">{b.hint}</p>
      <div className="dlg-actions spread">
        <button className="btn tonal small" disabled={p.loading} onClick={p.onMkdir}><Icon name="folder" size={13} /> New folder</button>
        <span className="dlg-actions-group">
          <button className="btn ghost" onClick={p.onClose}>Cancel</button>
          {multi && <button className="btn tonal" onClick={() => p.onApplyMulti(b.selected)}>Add selected ({b.selected.length})</button>}
          {!multi && <button className="btn filled" onClick={() => p.onApplySingle(b.path)}>Select this folder</button>}
        </span>
      </div>
    </Modal>
  );
}
