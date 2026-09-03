import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../lib/ui';

export function AuthView({ setupNeeded, onAuthed }: { setupNeeded: boolean; onAuthed: () => void }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user.trim() || pass.length < 6) {
      setErr('Username required, password must be at least 6 characters');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api(setupNeeded ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: user.trim(), password: pass }) });
      onAuthed();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-view">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo"><Icon name="box" size={26} /></span>
          <span className="auth-name">rcloneweb</span>
        </div>
        <p className="auth-sub">{setupNeeded ? 'Create the first admin account to get started' : 'Sign in to your backup panel'}</p>
        <form onSubmit={submit}>
          <label className="field">
            <span className="field-label">Username</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} required autoFocus />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete={setupNeeded ? 'new-password' : 'current-password'} required />
          </label>
          <button type="submit" className="btn filled block" disabled={busy}>
            {busy ? 'Working…' : setupNeeded ? 'Create account' : 'Sign in'}
          </button>
        </form>
        {err && <p className="auth-error" role="alert">{err}</p>}
      </div>
      <p className="auth-foot">rclone sync scripts · fleet of VPSes · scheduled runs · Discord notifications</p>
    </div>
  );
}
