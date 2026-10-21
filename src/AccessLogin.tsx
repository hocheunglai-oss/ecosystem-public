import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useAccess } from './auth';

export function AccessLogin() {
  const access = useAccess();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activation] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const tokenHash = params.get('token_hash'), type = params.get('type');
    if (!tokenHash || (type !== 'invite' && type !== 'recovery')) return null;
    return { tokenHash, type };
  });
  useEffect(() => {
    if (activation) history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [activation]);
  return <form className="entry-pass access-login" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    if (activation && password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      if (activation) await access.activate(activation.tokenHash, password, activation.type as 'invite' | 'recovery');
      else await access.signIn(email, password);
      setPassword(''); setConfirm('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }}>
    {!activation && <label>Email<input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required disabled={busy} /></label>}
    <label>{activation ? 'New password' : 'Password'}<input type="password" autoComplete={activation ? 'new-password' : 'current-password'}
      value={password} onChange={event => setPassword(event.target.value)} minLength={activation ? 8 : 1}
      pattern={activation ? '(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{8,}' : undefined} required disabled={busy} /></label>
    {activation && <p>At least 8 characters, including uppercase and lowercase letters and a number.</p>}
    {activation && <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} required disabled={busy} /></label>}
    {(error || access.error) && <p role="alert">{error || access.error}</p>}
    <button className="lime-control entry-submit" type="submit" disabled={busy || access.loading}>
      <span>{busy ? 'Signing in…' : access.loading ? 'Checking session…' : activation ? 'Set password' : 'Sign in'}</span><ArrowUpRight size={23} />
    </button>
  </form>;
}
