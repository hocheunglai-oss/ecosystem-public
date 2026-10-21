import { useId, useState } from 'react';
import { useAccess } from './auth';
import { Modal } from './ui';

export function PasswordSettings({ onDone }: { onDone?: () => void }) {
  const access = useAccess();
  const requirementsId = useId();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  return <form className="password-settings" onSubmit={async event => {
    event.preventDefault();
    if (busy || access.preview) return;
    setError(''); setSuccess(false);
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await access.changePassword(current, password);
      setCurrent(''); setPassword(''); setConfirm(''); setSuccess(true); onDone?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Password could not be changed.'); }
    finally { setBusy(false); }
  }}>
    <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} required disabled={busy || Boolean(access.preview)} /></label>
    <label>New password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={8} pattern="(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{8,}" required disabled={busy || Boolean(access.preview)} aria-describedby={requirementsId} /></label>
    <p id={requirementsId}>At least 8 characters, including uppercase and lowercase letters and a number.</p>
    <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} required disabled={busy || Boolean(access.preview)} /></label>
    {error && <p role="alert">{error}</p>}
    {success && <p role="status">Password changed.</p>}
    <button className="lime-control ui-button ui-button--primary" disabled={busy || Boolean(access.preview)}>{busy ? 'Changing password…' : 'Change password'}</button>
  </form>;
}

export function PasswordSuggestion() {
  const access = useAccess();
  const [dismissed, setDismissed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!access.user?.passwordChangeSuggested || dismissed || access.preview) return null;
  return <>
    <aside className="password-suggestion" aria-label="Change password invitation">
      <strong>Change your password?</strong>
      <button className="lime-control" disabled={busy} onClick={() => setEditing(true)}>Change password</button>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await access.dismissPasswordPrompt(); setDismissed(true); }
        catch { setError('Could not save this preference. You can continue using ECO.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Skip'}</button>
      {error && <span role="status">{error}</span>}
    </aside>
    {editing && <Modal title="Change password" onClose={() => setEditing(false)}>
      <PasswordSettings onDone={() => { setEditing(false); setDismissed(true); }} />
    </Modal>}
  </>;
}
