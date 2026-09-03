import { useEffect, useState } from 'react';
import { api } from '../api';
import * as Gen from '../lib/generator';
import { CodeEditor } from '../components/CodeEditor';
import { Icon, Spinner, SwitchRow, toast } from '../lib/ui';
import { Button } from '../components/ui/button';
import { downloadText } from '../lib/format';

// ---------- Script editor (CodeMirror) ----------
export function ScriptTab({ script, cfg, onChange, onRegenerate, dialog }: {
  script: string;
  cfg: Gen.AppConfig;
  onChange: (v: string) => void;
  onRegenerate: () => void;
  dialog: { confirm: (t: string, m?: string, ok?: string, danger?: boolean) => Promise<boolean> };
}) {
  return (
    <div className="scripttab">
      <div className="term-bar">
        <button className="btn tonal small" onClick={async () => {
          const ok = await dialog.confirm('Regenerate script?', 'Regenerating replaces your manual edits with the builder output.', 'Regenerate', true);
          if (!ok) return;
          onRegenerate();
        }}><Icon name="refresh" size={13} /> Regenerate from builder</button>
        <button className="btn ghost small" onClick={() => { try { navigator.clipboard.writeText(script); toast('Script copied'); } catch { toast('Copy failed', true); } }}><Icon name="copy" size={13} /> Copy</button>
        <button className="btn ghost small" onClick={() => downloadText(`${cfg.name || 'backup'}.sh`, script)}><Icon name="download" size={13} /> Download</button>
        <span className="hint-inline">Manual edits are kept on save.</span>
      </div>
      <CodeEditor value={script} onChange={onChange} />
    </div>
  );
}

// ---------- Install ----------
export function InstallTab({ scriptId, rawToken }: { scriptId: string | null; rawToken?: string }) {
  const ready = Boolean(scriptId && rawToken);
  const baseUrl = window.location.origin;
  const rawUrl = ready ? `${baseUrl}/raw/${scriptId}.sh?token=${encodeURIComponent(rawToken!)}` : '';
  const install = ready ? `curl -fsSL '${rawUrl}' -o backup.sh && chmod 700 backup.sh` : '';
  return (
    <div>
      {!ready && <p className="warn-line"><Icon name="alert" size={13} /> Save the script first — the install link is generated with the saved copy.</p>}
      <div className="section-head"><h3>Raw link</h3></div>
      <div className="cmd-box"><code>{rawUrl || '—'}</code>{ready && <button className="btn tonal small" onClick={() => { navigator.clipboard.writeText(rawUrl).then(() => toast('Copied'), () => toast('Copy failed', true)); }}>Copy</button>}</div>
      <div className="section-head"><h3>One-line install</h3></div>
      <div className="cmd-box"><code>{install || '—'}</code>{ready && <button className="btn tonal small" onClick={() => { navigator.clipboard.writeText(install).then(() => toast('Copied'), () => toast('Copy failed', true)); }}>Copy</button>}</div>
      <div className="section-head"><h3>On the target machine</h3></div>
      <table className="perm-table"><tbody>
        <tr><td><code>chmod 700 backup.sh</code></td><td>Recommended — owner only; required if secrets are embedded.</td></tr>
        <tr><td><code>rclone</code></td><td>Install: <code>curl https://rclone.org/install.sh | sudo bash</code></td></tr>
      </tbody></table>
    </div>
  );
}

// ---------- Webhook test ----------
export function WebhookTab({ cfg }: { cfg: Gen.AppConfig }) {
  const [sending, setSending] = useState<'ok' | 'fail' | null>(null);
  const send = async (kind: 'ok' | 'fail') => {
    if (!cfg.webhook.url) { toast('Enter a webhook URL in the Builder first', true); return; }
    setSending(kind);
    const payload = kind === 'ok'
      ? Gen.buildPayload(cfg, 'SUCCESS', { host: 'test-server', duration: '13' })
      : Gen.buildPayload(cfg, 'FAIL', { host: 'test-server', duration: '13', logTail: '[ERROR] rclone: directory not found /home/user/data' });
    try {
      await api('/api/test-webhook', { method: 'POST', body: JSON.stringify({ url: cfg.webhook.url, payload }) });
      toast('Test sent — check your Discord channel');
    } catch (e) { toast((e as Error).message, true); }
    setSending(null);
  };
  return (
    <div>
      <div className="section-head"><h3>Send test notification</h3></div>
      <p className="hint">Sends sample embeds using the exact payload format of the generated script.</p>
      <div className="row">
          <Button className="btn filled" disabled={sending !== null} onClick={() => send('ok')}>{sending === 'ok' ? <Spinner size={14} /> : <Icon name="check" size={14} />} Send success test</Button>
        <button className="btn danger" disabled={sending !== null} onClick={() => send('fail')}>{sending === 'fail' ? <Spinner size={14} /> : <Icon name="alert" size={14} />} Send failure test</button>
      </div>
    </div>
  );
}

// ---------- Settings ----------
interface SettingsProps {
  username: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onImported: () => void;
  dialog: { confirm: (t: string, m?: string, ok?: string, danger?: boolean) => Promise<boolean> };
}

export function SettingsTab(p: SettingsProps) {
  const [passphrase, setPassphrase] = useState('');
  const [importPass, setImportPass] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [sched, setSched] = useState<{ total: number; enabled: number } | null>(null);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newUser, setNewUser] = useState('');

  useEffect(() => { api('/api/scheduler/status').then((s) => setSched(s as never)).catch(() => {}); }, []);

  const doExport = async () => {
    setBusy('export');
    try {
      const bundle = await api('/api/export', { method: 'POST', body: JSON.stringify({ passphrase }) }) as Record<string, unknown>;
      downloadText(`rcloneweb-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
      toast('Config exported');
    } catch (e) { toast((e as Error).message, true); }
    setBusy('');
  };

  const doImport = async () => {
    if (!file) { toast('Choose a bundle file first', true); return; }
    setBusy('import');
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const r = await api('/api/import', { method: 'POST', body: JSON.stringify({ bundle, passphrase: importPass }) }) as { counts: Record<string, number> };
      toast(`Imported: ${Object.entries(r.counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}`);
      p.onImported();
    } catch (e) { toast((e as Error).message, true); }
    setBusy('');
  };

  const revoke = async () => {
    const ok = await p.dialog.confirm('Sign out all sessions?', 'Every signed-in browser (including this one) will need to sign in again.', 'Sign out all', true);
    if (!ok) return;
    setBusy('revoke');
    try {
      await api('/api/auth/revoke-sessions', { method: 'POST' });
      toast('All sessions signed out');
    } catch (e) { toast((e as Error).message, true); }
    setBusy('');
  };

  const changeAccount = async () => {
    const body: Record<string, string> = { currentPassword: currentPass };
    if (newUser.trim()) body.username = newUser.trim();
    if (newPass) body.password = newPass;
    if (!body.username && !body.password) { toast('Enter a new username or password', true); return; }
    setBusy('account');
    try {
      await api('/api/account', { method: 'POST', body: JSON.stringify(body) });
      toast('Account updated');
      setCurrentPass(''); setNewPass(''); setNewUser('');
    } catch (e) { toast((e as Error).message, true); }
    setBusy('');
  };

  return (
    <div className="settings">
      <div className="card">
        <h3 className="card-title"><Icon name="settings" size={14} /> Account</h3>
        <p className="hint">Change username or password. Current password required.</p>
        <div className="row">
          <label className="field"><span className="field-label">Current password</span><input type="password" value={currentPass} onChange={(e) => setCurrentPass(e.target.value)} autoComplete="current-password" /></label>
          <label className="field"><span className="field-label">New username (optional)</span><input value={newUser} onChange={(e) => setNewUser(e.target.value)} placeholder={p.username} /></label>
          <label className="field"><span className="field-label">New password (optional)</span><input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} autoComplete="new-password" /></label>
        </div>
        <div className="row">
          <Button className="btn filled" disabled={busy === 'account'} onClick={changeAccount}>Save account</Button>
          <button className="btn tonal" disabled={busy === 'revoke'} onClick={revoke}><Icon name="logout" size={13} /> Sign out all sessions</button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="clock" size={14} /> Scheduler</h3>
        {sched
          ? <p className="hint">{sched.enabled} active schedule(s) of {sched.total}. The in-process scheduler checks every 5 seconds.</p>
          : <p className="hint">Scheduler status unavailable.</p>}
        <SwitchRow label="Light theme" checked={p.theme === 'light'} onChange={p.onToggleTheme} />
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="download" size={14} /> Export config</h3>
        <p className="hint">Downloads scripts, schedules, fleet and destinations as one JSON file. Secrets are encrypted with your passphrase — the panel's own credentials are never included.</p>
        <div className="row">
          <label className="field grow"><span className="field-label">Export passphrase (min 8 chars)</span><input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" /></label>
          <Button className="btn filled self-end" disabled={busy === 'export' || passphrase.length < 8} onClick={doExport}><Icon name="download" size={13} /> Export</Button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="up" size={14} /> Import config</h3>
        <p className="hint">Existing entries with the same ids are replaced. Scripts keep their content; secrets are decrypted with the export passphrase.</p>
        <div className="row">
          <label className="field grow"><span className="field-label">Bundle file</span><input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <label className="field grow"><span className="field-label">Export passphrase</span><input type="password" value={importPass} onChange={(e) => setImportPass(e.target.value)} autoComplete="off" /></label>
          <Button className="btn filled self-end" disabled={busy === 'import' || !file} onClick={doImport}><Icon name="up" size={13} /> Import</Button>
        </div>
      </div>
    </div>
  );
}
