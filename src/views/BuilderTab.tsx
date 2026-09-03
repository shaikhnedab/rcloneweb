import { useMemo, useState } from 'react';
import * as Gen from '../lib/generator';
import type { DestItem, FleetItem } from '../lib/types';
import { Field, Icon, Spinner, SwitchRow, toast } from '../lib/ui';
import { api } from '../api';

interface Props {
  cfg: Gen.AppConfig;
  update: (fn: (c: Gen.AppConfig) => Gen.AppConfig) => void;
  fleet: FleetItem[];
  dests: DestItem[];
  sourceVpsId: string;
  setSourceVpsId: (id: string) => void;
  destFleetId: string;
  setDestFleetId: (id: string) => void;
  openBrowse: (rowIdx: number, kind: 'src' | 'dest' | 'include' | 'exclude') => void;
  browseLoading: boolean;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <fieldset className="step">
      <legend><span className="step-num">{n}</span> {title}</legend>
      {children}
    </fieldset>
  );
}

export function BuilderTab(p: Props) {
  const { cfg, update } = p;
  const [testingSource, setTestingSource] = useState(false);
  const [testingDest, setTestingDest] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<'success' | 'fail'>('success');

  const liveScript = useMemo(() => {
    try { return Gen.buildScript(cfg); } catch (e) { return `# ${(e as Error).message}`; }
  }, [cfg]);
  const discordPreview = useMemo(() => {
    try {
      return Gen.buildPayload(cfg, previewStatus === 'fail' ? 'FAIL' : 'SUCCESS', {
        host: 'myserver', duration: '42s',
        logTail: previewStatus === 'fail' ? '[ERROR] rclone: failed to copy: dial tcp 10.0.0.5:22: connect refused' : null,
      });
    } catch { return null; }
  }, [cfg, previewStatus]);

  const manual = p.destFleetId === 'manual';
  const patchRow = (idx: number, patch: Partial<Gen.SourceRow>) =>
    update((c) => ({ ...c, sources: c.sources.map((x, i) => (i === idx ? { ...x, ...patch } : x)) }));

  const testSource = async () => {
    if (!p.sourceVpsId) { toast('Select a Source VPS first', true); return; }
    setTestingSource(true);
    try {
      const r = await api(`/api/fleet/${p.sourceVpsId}/test`, { method: 'POST' }) as { ok: boolean; msg: string };
      toast(r.msg, !r.ok);
    } catch (e) { toast((e as Error).message, true); }
    setTestingSource(false);
  };

  const testDest = async () => {
    setTestingDest(true);
    try {
      let r: { ok: boolean; msg: string };
      if (!manual) r = await api(`/api/destinations/${p.destFleetId}/test`, { method: 'POST' }) as never;
      else {
        r = await api('/api/test/connection', {
          method: 'POST',
          body: JSON.stringify({
            type: cfg.dest.type, host: cfg.dest.host, port: cfg.dest.port, user: cfg.dest.user,
            sftpAuth: cfg.dest.sftpAuth, keyPath: cfg.dest.keyPath, bucket: cfg.dest.s3Bucket,
            region: cfg.dest.s3Region, endpoint: cfg.dest.s3Endpoint, provider: cfg.dest.s3Provider,
            password: cfg.secrets.password, accessKey: cfg.secrets.s3AccessKey, secretKey: cfg.secrets.s3SecretKey,
          }),
        }) as never;
      }
      toast(r.msg, !r.ok);
    } catch (e) { toast((e as Error).message, true); }
    setTestingDest(false);
  };

  const needsPassword = cfg.dest.type === 'ftp' || (cfg.dest.type === 'sftp' && cfg.dest.sftpAuth === 'password');
  // Only manual destinations need a typed secret; presets are injected server-side.
  const embedNoSecret = manual && cfg.secrets.embed && ((needsPassword && !cfg.secrets.password) || (cfg.dest.type === 's3' && (!cfg.secrets.s3AccessKey || !cfg.secrets.s3SecretKey)));

  const dp = discordPreview as { username?: string; avatar_url?: string; embeds?: { title?: string; description?: string }[] } | null;
  const embed = dp?.embeds?.[0];

  return (
    <div className="builder-grid">
      <div className="builder-form">
        <div className="pipeline" aria-hidden="true">
          <span className="pipeline-node">Source</span>
          <span className="pipeline-line"><span className="pipeline-packet" /></span>
          <span className="pipeline-node accent">rclone</span>
          <span className="pipeline-line"><span className="pipeline-packet p2" /></span>
          <span className="pipeline-node">Destination</span>
        </div>

        <Step n={0} title="Source VPS">
          <div className="row">
            <Field label="Run on" grow>
              <select value={p.sourceVpsId} onChange={(e) => { p.setSourceVpsId(e.target.value); }}>
                <option value="">— Select VPS —</option>
                {p.fleet.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.host})</option>)}
              </select>
            </Field>
            <button className="btn tonal" disabled={testingSource} onClick={testSource}>{testingSource ? <Spinner size={13} /> : <Icon name="zap" size={13} />} Test</button>
          </div>
          <p className="hint">The backup runs on this machine over SSH.</p>
        </Step>

        <Step n={1} title="Source folders & files">
          <p className="hint">Each card maps one source → remote path. Browse the VPS or the remote storage to fill paths.</p>
          <div className="source-cards">
            {cfg.sources.map((s, idx) => (
              <div key={idx} className="source-card">
                <div className="source-head">
                  <span className="src-badge">#{idx + 1}</span>
                  <span className="src-path" title={s.path}>{s.path || '/'}</span>
                  <span className="src-arrow">→ {s.dest || (s.preserveParent && s.path !== '/' ? `…/${s.path.split('/').filter(Boolean).pop() || ''}` : 'contents')}</span>
                  <button className="icon-btn danger-text" aria-label={`Remove source ${idx + 1}`} title="Remove" onClick={() => update((c) => ({ ...c, sources: c.sources.filter((_, i) => i !== idx) }))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <div className="grid-2">
                  <Field label="Source folder">
                    <span className="input-btn">
                      <input placeholder="/" value={s.path} spellCheck={false} onChange={(e) => patchRow(idx, { path: e.target.value })} />
                      <button type="button" className="btn tonal small" disabled={p.browseLoading} aria-label="Browse VPS" onClick={() => p.openBrowse(idx, 'src')}><Icon name="folder" size={13} /></button>
                    </span>
                  </Field>
                  <Field label="Remote destination">
                    <span className="input-btn">
                      <input placeholder="remote:/ (empty = /)" value={s.dest} spellCheck={false} onChange={(e) => patchRow(idx, { dest: e.target.value })} />
                      <button type="button" className="btn tonal small" disabled={p.browseLoading} aria-label="Browse remote" onClick={() => p.openBrowse(idx, 'dest')}><Icon name="cloud" size={13} /></button>
                    </span>
                  </Field>
                  <Field label="Include">
                    <span className="input-btn">
                      <input placeholder="e.g. *.jpg" value={s.include} spellCheck={false} onChange={(e) => patchRow(idx, { include: e.target.value })} />
                      <button type="button" className="btn tonal small" disabled={p.browseLoading} aria-label="Browse for include filters" onClick={() => p.openBrowse(idx, 'include')}><Icon name="folder" size={13} /></button>
                    </span>
                  </Field>
                  <Field label="Exclude">
                    <span className="input-btn">
                      <input placeholder="e.g. *.tmp" value={s.exclude} spellCheck={false} onChange={(e) => patchRow(idx, { exclude: e.target.value })} />
                      <button type="button" className="btn tonal small" disabled={p.browseLoading} aria-label="Browse for exclude filters" onClick={() => p.openBrowse(idx, 'exclude')}><Icon name="folder" size={13} /></button>
                    </span>
                  </Field>
                </div>
                {(s.include || s.exclude) && (
                  <div className="filter-chips">
                    {(s.include || '').split(/[,\s]+/).filter(Boolean).map((pat, i) => (
                      <span key={`in-${i}-${pat}`} className="chip tiny ok">
                        {pat}
                        <button aria-label={`Remove include ${pat}`} onClick={() => patchRow(idx, { include: (s.include || '').split(/[,\s]+/).filter(Boolean).filter((x) => x !== pat).join(', ') })}><Icon name="x" size={10} /></button>
                      </span>
                    ))}
                    {(s.exclude || '').split(/[,\s]+/).filter(Boolean).map((pat, i) => (
                      <span key={`ex-${i}-${pat}`} className="chip tiny bad">
                        {pat}
                        <button aria-label={`Remove exclude ${pat}`} onClick={() => patchRow(idx, { exclude: (s.exclude || '').split(/[,\s]+/).filter(Boolean).filter((x) => x !== pat).join(', ') })}><Icon name="x" size={10} /></button>
                      </span>
                    ))}
                    <button className="btn ghost small" onClick={() => patchRow(idx, { include: '', exclude: '' })}>Clear filters</button>
                  </div>
                )}
                <SwitchRow
                  title={s.path === '/' ? 'Root folder — contents only' : 'When checked, the folder itself is created inside the destination'}
                  checked={s.preserveParent ?? s.path !== '/'}
                  onChange={(v) => patchRow(idx, { preserveParent: v })}
                  label={<b>Include folder itself</b>}
                  hint={<span className="hint-inline">{(s.preserveParent ?? s.path !== '/') && s.path !== '/' ? `→ …/${s.path.split('/').filter(Boolean).pop() || ''}/` : '→ contents only'}</span>}
                />
              </div>
            ))}
          </div>
          <button className="btn tonal small" onClick={() => update((c) => ({ ...c, sources: [...c.sources, { path: '/', dest: '', include: '', exclude: '', preserveParent: false }] }))}>
            <Icon name="plus" size={13} /> Add folder / file
          </button>
        </Step>

        <Step n={2} title="Destination">
          <div className="row">
            <Field label="Preset" grow>
              <select value={p.destFleetId} onChange={(e) => {
                const id = e.target.value;
                p.setDestFleetId(id);
                if (id !== 'manual') {
                  const d = p.dests.find((x) => x.id === id);
                  if (d) update((c) => ({ ...c, dest: { ...c.dest, type: d.type as Gen.DestType, remoteName: d.remoteName || 'my-backup-remote', remotePath: d.remotePath || '/', host: d.host || '', port: d.port || '', user: d.user || '', sftpAuth: (d.sftpAuth as 'password' | 'key') || 'password', s3Provider: d.s3Provider || 'AWS', s3Bucket: d.s3Bucket || '', s3Region: d.s3Region || '', s3Endpoint: d.s3Endpoint || '' } }));
                }
              }}>
                <option value="manual">Manual — custom</option>
                {p.dests.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.type.toUpperCase()} {d.host || d.s3Bucket}</option>)}
              </select>
            </Field>
          </div>
          <div className="row">
            <Field label="Type">
              <select value={cfg.dest.type} disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, type: e.target.value as Gen.DestType } }))}>
                <option value="sftp">SFTP</option><option value="ftp">FTP</option><option value="s3">S3</option>
              </select>
            </Field>
            <Field label="Remote name"><input value={cfg.dest.remoteName} disabled={!manual} spellCheck={false} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, remoteName: e.target.value } }))} /></Field>
            <Field label="Remote path" grow><input value={cfg.dest.remotePath} disabled={!manual} spellCheck={false} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, remotePath: e.target.value } }))} /></Field>
          </div>
          {(cfg.dest.type === 'sftp' || cfg.dest.type === 'ftp') && (
            <div className="row">
              <Field label="Host" grow><input value={cfg.dest.host} placeholder="host.example.com" disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, host: e.target.value } }))} /></Field>
              <Field label="Port"><input type="number" value={cfg.dest.port} placeholder="auto" disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, port: e.target.value } }))} /></Field>
              <Field label="User"><input value={cfg.dest.user} disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, user: e.target.value } }))} /></Field>
              <button className="btn tonal self-end" disabled={testingDest} onClick={testDest}>{testingDest ? <Spinner size={13} /> : <Icon name="zap" size={13} />} Test</button>
            </div>
          )}
          {cfg.dest.type === 'sftp' && (
            <div className="row">
              <Field label="Auth">
                <select value={cfg.dest.sftpAuth} disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, sftpAuth: e.target.value as 'password' | 'key' } }))}>
                  <option value="password">Password</option><option value="key">SSH key file</option>
                </select>
              </Field>
              {cfg.dest.sftpAuth === 'key' && <Field label="Key path" grow><input value={cfg.dest.keyPath} placeholder="~/.ssh/id_ed25519" disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, keyPath: e.target.value } }))} /></Field>}
            </div>
          )}
          {cfg.dest.type === 's3' && (
            <div className="row">
              <Field label="Provider">
                <select value={cfg.dest.s3Provider} disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, s3Provider: e.target.value } }))}>
                  <option>AWS</option><option>Ceph</option><option>Minio</option><option>Wasabi</option><option>Backblaze B2 (S3)</option><option>Other</option>
                </select>
              </Field>
              <Field label="Bucket"><input value={cfg.dest.s3Bucket} disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, s3Bucket: e.target.value } }))} /></Field>
              <Field label="Region"><input value={cfg.dest.s3Region} placeholder="us-east-1" disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, s3Region: e.target.value } }))} /></Field>
              <Field label="Endpoint" grow><input value={cfg.dest.s3Endpoint} placeholder="https://s3.us-west…" disabled={!manual} onChange={(e) => update((c) => ({ ...c, dest: { ...c.dest, s3Endpoint: e.target.value } }))} /></Field>
            </div>
          )}
          <div className="row">
            <SwitchRow label={<b>Embed secret in script</b>} checked={cfg.secrets.embed} onChange={(v) => update((c) => ({ ...c, secrets: { ...c.secrets, embed: v } }))} />
          </div>
          {cfg.secrets.embed && (
            <>
              {!manual && (needsPassword || cfg.dest.type === 's3') && <p className="hint"><Icon name="check" size={12} /> The saved destination's credentials are injected automatically when the script runs or is downloaded — nothing to type here.</p>}
              {embedNoSecret && <p className="warn-line"><Icon name="alert" size={13} /> Type the secret below so it can be embedded — manual destinations have no stored credentials.</p>}
              <p className="hint">Embedded secrets live inside the deployed copy — keep it <code>chmod 700</code>. Unchecked, the script reads them from env vars.</p>
            </>
          )}
          {(cfg.dest.type === 'ftp' || (cfg.dest.type === 'sftp' && cfg.dest.sftpAuth === 'password')) && (
            <Field label="Password"><input type="password" value={cfg.secrets.password} autoComplete="off" onChange={(e) => update((c) => ({ ...c, secrets: { ...c.secrets, password: e.target.value } }))} /></Field>
          )}
          {cfg.dest.type === 's3' && (
            <div className="row">
              <Field label="Access key ID" grow><input value={cfg.secrets.s3AccessKey} autoComplete="off" onChange={(e) => update((c) => ({ ...c, secrets: { ...c.secrets, s3AccessKey: e.target.value } }))} /></Field>
              <Field label="Secret access key" grow><input type="password" value={cfg.secrets.s3SecretKey} autoComplete="off" onChange={(e) => update((c) => ({ ...c, secrets: { ...c.secrets, s3SecretKey: e.target.value } }))} /></Field>
            </div>
          )}
        </Step>

        <Step n={3} title="Backup options">
          <div className="row">
            <Field label="Mode">
              <select value={cfg.options.mode} onChange={(e) => update((c) => ({ ...c, options: { ...c.options, mode: e.target.value as 'sync' | 'copy' } }))}>
                <option value="sync">sync (mirror)</option><option value="copy">copy (safe)</option>
              </select>
            </Field>
            <SwitchRow label="Default --dry-run" checked={cfg.options.dryRun} onChange={(v) => update((c) => ({ ...c, options: { ...c.options, dryRun: v } }))} />
            <Field label="Bandwidth limit"><input value={cfg.options.bandwidth} placeholder="e.g. 10M or off" onChange={(e) => update((c) => ({ ...c, options: { ...c.options, bandwidth: e.target.value } }))} /></Field>
            <Field label="Delete older than (days)"><input type="number" value={cfg.options.retentionDays || ''} placeholder="0 = off" onChange={(e) => update((c) => ({ ...c, options: { ...c.options, retentionDays: parseInt(e.target.value, 10) || 0 } }))} /></Field>
          </div>
          <div className="row">
            <Field label="Log file" grow><input value={cfg.options.logfile} placeholder="/var/log/rclone-backup.log" onChange={(e) => update((c) => ({ ...c, options: { ...c.options, logfile: e.target.value } }))} /></Field>
            <Field label="Extra rclone flags" grow><input value={cfg.options.extraFlags} onChange={(e) => update((c) => ({ ...c, options: { ...c.options, extraFlags: e.target.value } }))} /></Field>
          </div>
        </Step>

        <Step n={4} title="Discord notification">
          <div className="row wrap">
            <SwitchRow label="Enable webhook" checked={cfg.webhook.enabled} onChange={(v) => update((c) => ({ ...c, webhook: { ...c.webhook, enabled: v } }))} />
            <SwitchRow label="Only on failure" checked={cfg.webhook.onlyOnFail} onChange={(v) => update((c) => ({ ...c, webhook: { ...c.webhook, onlyOnFail: v } }))} />
            <SwitchRow label="Attach log on failure" checked={cfg.webhook.sendLogOnFail} onChange={(v) => update((c) => ({ ...c, webhook: { ...c.webhook, sendLogOnFail: v } }))} />
            <SwitchRow label="Attach log on success" checked={cfg.webhook.sendLogOnSuccess} onChange={(v) => update((c) => ({ ...c, webhook: { ...c.webhook, sendLogOnSuccess: v } }))} />
          </div>
          <Field label="Webhook URL"><input type="url" value={cfg.webhook.url} placeholder="https://discord.com/api/webhooks/…" onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, url: e.target.value } }))} /></Field>
          <div className="row">
            <Field label="Bot username"><input value={cfg.webhook.username} onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, username: e.target.value } }))} /></Field>
            <Field label="Avatar URL" grow><input value={cfg.webhook.avatarUrl} placeholder="(optional)" onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, avatarUrl: e.target.value } }))} /></Field>
            <Field label="Title template" grow><input value={cfg.webhook.title} onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, title: e.target.value } }))} /></Field>
          </div>
          <Field label="Description template"><textarea rows={4} value={cfg.webhook.description} onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, description: e.target.value } }))} /></Field>
          <div className="row">
            <Field label="Success color"><input type="color" value={cfg.webhook.colorOk} onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, colorOk: e.target.value } }))} /></Field>
            <Field label="Failure color"><input type="color" value={cfg.webhook.colorFail} onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, colorFail: e.target.value } }))} /></Field>
            <Field label="Log lines on failure"><input type="number" min={0} max={30} value={cfg.webhook.logLines} onChange={(e) => update((c) => ({ ...c, webhook: { ...c.webhook, logLines: parseInt(e.target.value, 10) || 0 } }))} /></Field>
          </div>
          <p className="hint">Variables: <code>{'{NAME} {STATUS} {HOST} {SOURCES} {DEST} {DURATION} {DATE}'}</code></p>
        </Step>
      </div>

      <div className="builder-preview">
        <div className="preview-sticky">
          <div className="card">
            <h3 className="card-title"><Icon name="bell" size={14} /> Discord preview <span className="live-dot" /></h3>
            <div className="discord-window">
              <div className="discord-msg">
                <img className="discord-avatar" src={dp?.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt="" />
                <div className="discord-content">
                  <div className="discord-header">
                    <span className="discord-botname">{dp?.username || 'Backup Bot'}</span>
                    <span className="discord-badge">APP</span>
                  </div>
                  <div className="discord-embed">
                    <span className="embed-color" style={{ background: previewStatus === 'success' ? cfg.webhook.colorOk : cfg.webhook.colorFail }} />
                    <div className="embed-body">
                      <div className="embed-title">{embed?.title || ''}</div>
                      <div className="embed-desc">{embed?.description || ''}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="preview-toggle" role="radiogroup" aria-label="Preview status">
              <label><input type="radio" name="pv" checked={previewStatus === 'success'} onChange={() => setPreviewStatus('success')} /> Success</label>
              <label><input type="radio" name="pv" checked={previewStatus === 'fail'} onChange={() => setPreviewStatus('fail')} /> Failure</label>
            </div>
          </div>
          <div className="card">
            <h3 className="card-title"><Icon name="code" size={14} /> Live script <span className="live-dot" /></h3>
            <pre className="script-preview">{liveScript}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
