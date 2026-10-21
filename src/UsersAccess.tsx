import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { normalizeAccessPhone, type AccessOffice, type AccessUser, type PhoneChangeRequest } from '../shared/access';
import { accessRequest, useAccess } from './auth';
import { PhoneChangeRequestQueue, usePhoneChangeRequests } from './PhoneChangeRequests';

type UserDraft = Pick<AccessUser, 'displayName' | 'email' | 'officeId' | 'isAdmin' | 'isSpcTrader' | 'isManager' | 'isActive'> & { phone: string };
type PendingOperation = { kind: 'create'; requestId: string; payload: UserDraft }
  | { kind: 'reset'; requestId: string; payload: { id: string; expectedRevision: number; newPassword: string } }
  | { kind: 'delete'; requestId: string; payload: { id: string; expectedRevision: number } };
const accessLabels = { isSpcTrader: 'SPC Trader', isManager: 'Manager', isAdmin: 'Admin', isActive: 'Active' } as const;
const newDraft = (officeId: string): UserDraft => ({ displayName: '', email: '', phone: '', officeId, isAdmin: false, isSpcTrader: false, isManager: false, isActive: true });
const userDraft = (user: AccessUser): UserDraft => ({ displayName: user.displayName, email: user.email, phone: user.phone ?? '', officeId: user.officeId, isAdmin: user.isAdmin, isSpcTrader: user.isSpcTrader, isManager: user.isManager, isActive: user.isActive });
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : 'Changes could not be saved.';

export default function UsersAccess({ onPendingChange }: { onPendingChange?: (reference: string | null) => void }) {
  const access = useAccess();
  const { refresh: refreshPhoneRequests } = usePhoneChangeRequests();
  const passwordRulesId = useId();
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [offices, setOffices] = useState<AccessOffice[]>([]);
  const [officeId, setOfficeId] = useState('');
  const [selected, setSelected] = useState<AccessUser | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<UserDraft>(() => newDraft(''));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [administratorPassword, setAdministratorPassword] = useState('');
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [copiedReference, setCopiedReference] = useState(false);
  const pendingNoticeRef = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!access.user?.isAdmin) return;
    const controller = new AbortController();
    void accessRequest<{ users: AccessUser[]; offices: AccessOffice[] }>('users', undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setUsers(result.users); setOffices(result.offices); setOfficeId(result.offices[0]?.id ?? ''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failureMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [access.user?.id, access.user?.isAdmin]);

  const operationReference = pending?.requestId ?? activeRequestId;
  const locked = busy || Boolean(pending);
  const mutationLocked = locked || Boolean(access.preview);
  useEffect(() => { onPendingChange?.(operationReference); }, [onPendingChange, operationReference]);
  useEffect(() => () => onPendingChange?.(null), [onPendingChange]);
  useEffect(() => {
    if (pending && !busy) { pendingNoticeRef.current?.scrollIntoView({ block: 'nearest' }); pendingNoticeRef.current?.focus({ preventScroll: true }); }
  }, [pending, busy]);
  useEffect(() => {
    if (!pending) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [pending]);

  if (!access.user?.isAdmin) return null;

  function clearCredentials() {
    setPassword(''); setConfirm(''); setAdministratorPassword(''); setPending(null); setCopiedReference(false); requestId.current = crypto.randomUUID();
  }
  function closeEditor() {
    if (locked) return;
    setSelected(null); setCreating(false); setResetting(false); setDeleting(false); setConflict(false); setError(''); clearCredentials();
  }
  function openUser(user: AccessUser) {
    if (locked) return;
    setSelected(user); setDraft(userDraft(user)); setCreating(false); setResetting(false); setDeleting(false);
    setConflict(false); setError(''); setNotice(''); clearCredentials();
  }
  function editDraft<K extends keyof UserDraft>(key: K, value: UserDraft[K]) {
    if (mutationLocked) return;
    setDraft(previous => ({ ...previous, [key]: value })); requestId.current = crypto.randomUUID();
  }
  function editPassword(value: string) {
    if (mutationLocked) return;
    setPassword(value); requestId.current = crypto.randomUUID();
  }
  function validPassword() {
    if (password !== confirm) { setError('Passwords do not match.'); return false; }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      setError('Use at least 8 characters, including uppercase and lowercase letters and a number.'); return false;
    }
    if (new TextEncoder().encode(password).length > 72) { setError('Password is too long. Use no more than 72 bytes.'); return false; }
    return true;
  }
  function acceptUser(user: AccessUser) {
    setUsers(previous => previous.some(item => item.id === user.id) ? previous.map(item => item.id === user.id ? user : item) : [...previous, user]);
    setSelected(user); setDraft(userDraft(user)); setOfficeId(user.officeId); setConflict(false);
  }
  function operationFailed(failure: unknown, operation: PendingOperation) {
    setError(failureMessage(failure));
    const detail = failure as { status?: number; operationState?: 'failed' | 'pending' };
    // Only an explicit ledger failure proves an earlier uncertain operation is finished.
    // A reauthentication error must keep the original payload and request reference.
    if (detail.operationState === 'failed') {
      setPending(null); requestId.current = crypto.randomUUID(); return;
    }
    const definiteInitialRejection = !pending && detail.operationState !== 'pending' && detail.status !== undefined && detail.status >= 400 && detail.status < 500 && detail.status !== 408;
    if (!definiteInitialRejection) setPending(operation);
    else if (operation.kind !== 'create' && detail.status === 409) setConflict(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (access.preview || inFlight.current || resetting || deleting || conflict || (pending && pending.kind !== 'create')) return;
    const normalizedDraft = { ...draft, phone: normalizeAccessPhone(draft.phone) };
    setDraft(normalizedDraft);
    const operation: PendingOperation | null = creating ? (pending?.kind === 'create' ? pending : { kind: 'create', requestId: requestId.current, payload: normalizedDraft }) : null;
    inFlight.current = true; setBusy(true); setError(''); setNotice(''); setActiveRequestId(operation?.requestId ?? null);
    try {
      const result = operation?.kind === 'create'
        ? await accessRequest<{ user: AccessUser }>('users/create', { ...operation.payload, administratorPassword, requestId: operation.requestId })
        : await accessRequest<{ user: AccessUser }>('users', { id: selected!.id, expectedRevision: selected!.revision, ...normalizedDraft });
      acceptUser(result.user); setCreating(false); clearCredentials(); setNotice(creating ? 'User added.' : 'Changes saved.');
      void refreshPhoneRequests();
      if (result.user.id === access.user?.id) await access.refresh();
    } catch (failure) {
      if (operation) operationFailed(failure, operation);
      else { setError(failureMessage(failure)); if ((failure as { status?: number }).status === 409) setConflict(true); }
    } finally { inFlight.current = false; setBusy(false); setActiveRequestId(null); }
  }
  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (access.preview || inFlight.current || conflict || !selected || (pending && pending.kind !== 'reset') || !validPassword()) return;
    const operation: PendingOperation = pending?.kind === 'reset' ? pending : {
      kind: 'reset', requestId: requestId.current, payload: { id: selected.id, expectedRevision: selected.revision, newPassword: password },
    };
    inFlight.current = true; setBusy(true); setError(''); setNotice(''); setActiveRequestId(operation.requestId);
    try {
      const result = await accessRequest<{ user: AccessUser }>('users/reset-password', { ...operation.payload, administratorPassword, requestId: operation.requestId });
      setUsers(previous => previous.map(user => user.id === result.user.id ? result.user : user));
      setSelected(result.user); clearCredentials(); setResetting(false); setNotice('Password reset.');
      if (result.user.id === access.user?.id) await access.refresh();
    } catch (failure) { operationFailed(failure, operation); }
    finally { inFlight.current = false; setBusy(false); setActiveRequestId(null); }
  }
  async function deleteUser(event: FormEvent) {
    event.preventDefault();
    if (access.preview || inFlight.current || conflict || !selected || selected.id === access.user?.id || (pending && pending.kind !== 'delete')) return;
    const operation: PendingOperation = pending?.kind === 'delete' ? pending : {
      kind: 'delete', requestId: requestId.current, payload: { id: selected.id, expectedRevision: selected.revision },
    };
    inFlight.current = true; setBusy(true); setError(''); setNotice(''); setActiveRequestId(operation.requestId);
    try {
      const result = await accessRequest<{ deletedUserId: string }>('users/delete', { ...operation.payload, administratorPassword, requestId: operation.requestId });
      setUsers(previous => previous.filter(user => user.id !== result.deletedUserId));
      setSelected(null); setDeleting(false); setConflict(false); clearCredentials(); setNotice('User deleted.');
    } catch (failure) { operationFailed(failure, operation); }
    finally { inFlight.current = false; setBusy(false); setActiveRequestId(null); }
  }
  async function reloadUser() {
    if (inFlight.current || pending) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const result = await accessRequest<{ users: AccessUser[]; offices: AccessOffice[] }>('users');
      setUsers(result.users); setOffices(result.offices);
      const latest = result.users.find(user => user.id === selected?.id);
      if (latest) { acceptUser(latest); clearCredentials(); setResetting(false); setDeleting(false); setNotice('Latest details loaded. Review before saving.'); }
      else { closeEditor(); setNotice('This user is no longer available.'); }
    } catch (failure) { setError(failureMessage(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function phoneRequestReviewed(request: PhoneChangeRequest) {
    if (request.status === 'declined') return;
    // Refresh directory data, while retaining any unsaved editor draft for explicit review.
    if (selectedRef.current?.id === request.userId) { setConflict(true); setError('Phone details changed. Reload this user before saving.'); }
    void accessRequest<{ users: AccessUser[]; offices: AccessOffice[] }>('users').then(result => {
      setUsers(result.users); setOffices(result.offices);
    }).catch(failure => setError(failureMessage(failure)));
  }
  const query = search.trim().toLowerCase();
  const filtered = users.filter(user => query
    ? `${user.displayName} ${user.email} ${user.phone ?? ''} ${user.officeName}`.toLowerCase().includes(query)
    : user.officeId === officeId);
  const administratorPasswordField = <label>Your administrator password<input type="password" autoComplete="current-password" value={administratorPassword}
    onChange={event => setAdministratorPassword(event.target.value)} required disabled={busy || Boolean(access.preview)} /></label>;
  const passwordFields = <>
    <label>New password<input type="password" autoComplete="new-password" value={password} onChange={event => editPassword(event.target.value)}
      required minLength={8} pattern="(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{8,}" disabled={mutationLocked} aria-describedby={passwordRulesId} /></label>
    <p className="users-access-hint" id={passwordRulesId}>At least 8 characters, including uppercase and lowercase letters and a number.</p>
    <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} required disabled={busy || Boolean(access.preview)} /></label>
    {administratorPasswordField}
  </>;

  const pendingNotice = pending ? <aside ref={pendingNoticeRef} tabIndex={-1} className="users-access-message users-access-pending" aria-label="Pending account request" aria-live="polite">
      <strong>Request not confirmed</strong>
      <p>Retry this request before making other changes. Keep this reference if you refresh or sign out.</p>
      <span className="users-access-reference">Request reference: <code>{pending.requestId}</code></span>
      <div className="users-access-actions">
        <button type="button" className="button" onClick={async () => {
          try { await navigator.clipboard.writeText(pending.requestId); setCopiedReference(true); }
          catch { setError('Copy the request reference shown above.'); }
        }}>{copiedReference ? 'Reference copied' : 'Copy reference'}</button>
        <button type="button" className="button" onClick={async () => { try { await access.signOut(); } catch (failure) { setError(failureMessage(failure)); } }}>Sign out</button>
      </div>
    </aside> : null;

  return <section className="users-access" aria-label="Users & Access" aria-busy={busy || loading}>
    <PhoneChangeRequestQueue disabled={mutationLocked || loading} onReviewed={phoneRequestReviewed} />
    <div className="users-access-toolbar">
      <label className="sr-only" htmlFor="access-user-search">Search users</label>
      <input id="access-user-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search users" disabled={locked} />
      <button type="button" className="button secondary" disabled={locked || !search} onClick={() => setSearch('')}>Clear</button>
      <button className="lime-control" disabled={mutationLocked || loading || !offices.length} onClick={() => {
        setCreating(true); setSelected(null); setDraft(newDraft(officeId)); setResetting(false); setDeleting(false); setConflict(false); setError(''); setNotice(''); clearCredentials();
      }}>Add user</button>
    </div>
    {error && <div role="alert" className="users-access-message error"><p>{error}</p>
      {conflict && <button type="button" className="button" onClick={() => void reloadUser()} disabled={busy}>Reload user</button>}
    </div>}
    {notice && <p role="status" className="users-access-message">{notice}</p>}
    <div className={`users-access-layout${selected || creating ? ' has-editor' : ''}`}>
      <nav aria-label="Offices" className="users-access-offices">{offices.map(office => <button key={office.id} className={!query && officeId === office.id ? 'active' : ''}
        aria-pressed={!query && officeId === office.id} onClick={() => { setOfficeId(office.id); setSearch(''); closeEditor(); setNotice(''); }} disabled={locked}>
        <span>{office.name}</span><span>{users.filter(user => user.officeId === office.id).length}</span></button>)}</nav>
      <div className="users-access-directory">
        {loading ? <p className="users-access-empty" role="status">Loading users…</p> : !filtered.length && <p className="users-access-empty">No users found.</p>}
        <div className="users-access-list">{filtered.map(user => <button key={user.id} className={selected?.id === user.id ? 'active' : ''}
          aria-pressed={selected?.id === user.id} onClick={() => openUser(user)} disabled={locked}>
          <span className="users-access-identity"><strong>{user.displayName}</strong><small data-email-value>{user.email}</small></span>
          <span className="users-access-badges">{query && <em>{user.officeName}</em>}{user.isAdmin && <em>Admin</em>}{user.isSpcTrader && <em>SPC Trader</em>}{user.isManager && <em>Manager</em>}
            {!user.isActive && <em className="is-inactive">Inactive</em>}{!user.activated && <em>Pending activation</em>}</span>
        </button>)}</div>
      </div>
      {(selected || creating) && <aside className="users-access-editor" aria-label={creating ? 'Add user' : 'Edit user'}>
        <div className="users-access-editor-title"><h3>{creating ? 'Add user' : 'Edit user'}</h3><button type="button" className="button secondary" onClick={closeEditor} disabled={locked}>Close</button></div>
        <form onSubmit={save}>
          <label>Name<input value={draft.displayName} onChange={event => editDraft('displayName', event.target.value)} maxLength={120} required disabled={mutationLocked || resetting || deleting} /></label>
          <label>Email<input type="email" value={draft.email} onChange={event => editDraft('email', event.target.value)} readOnly={!creating} required disabled={mutationLocked || resetting || deleting} autoComplete="off" /></label>
          <label>WhatsApp phone<input type="tel" value={draft.phone} onChange={event => editDraft('phone', event.target.value)}
            onBlur={() => { const phone = normalizeAccessPhone(draft.phone); if (phone !== draft.phone) editDraft('phone', phone); }}
            maxLength={64} title="International phone number beginning with +" disabled={mutationLocked || resetting || deleting} autoComplete="off" /></label>
          <label>Office<span className="users-access-select"><select aria-label="Office" value={draft.officeId} onChange={event => editDraft('officeId', event.target.value)} disabled={mutationLocked || resetting || deleting} required>
            {offices.map(office => <option value={office.id} key={office.id}>{office.name}</option>)}</select></span></label>
          <div className="users-access-permissions">{(Object.keys(accessLabels) as (keyof typeof accessLabels)[]).map(key => <label className="access-checkbox" key={key}>
            <input type="checkbox" checked={draft[key]} onChange={event => editDraft(key, event.target.checked)}
              disabled={mutationLocked || resetting || deleting || (selected?.id === access.user?.id && (key === 'isAdmin' || key === 'isActive'))} />{accessLabels[key]}</label>)}</div>
          {creating && administratorPasswordField}
          {creating && pendingNotice}
          {!resetting && !deleting && <div className="users-access-actions"><button className="lime-control" type="submit" disabled={busy || conflict || Boolean(access.preview)}>{busy ? 'Saving…' : pending ? 'Retry request' : creating ? 'Add user' : 'Save changes'}</button>
            {!creating && selected?.id !== access.user?.id && <><button type="button" className="button" disabled={busy || conflict || Boolean(access.preview)} onClick={() => { setResetting(true); setError(''); setNotice(''); clearCredentials(); }}>Reset password</button>
              <button type="button" className="button danger" disabled={busy || conflict || Boolean(access.preview)} onClick={() => { setDeleting(true); setError(''); setNotice(''); clearCredentials(); }}>Delete user</button></>}
          </div>}
        </form>
        {resetting && <form className="users-access-password-reset" aria-label="Reset password" onSubmit={resetPassword}>
          <h3>Reset password</h3>{passwordFields}{pendingNotice}
          <div className="users-access-actions"><button className="lime-control" type="submit" disabled={busy || conflict || Boolean(access.preview)}>{busy ? 'Resetting…' : pending ? 'Retry request' : 'Reset password'}</button>
            <button type="button" className="button" disabled={locked} onClick={() => { setResetting(false); setError(''); clearCredentials(); }}>Cancel</button></div>
        </form>}
        {deleting && selected && <form className="users-access-password-reset users-access-delete" aria-label="Delete user" onSubmit={deleteUser}>
          <h3>Delete {selected.displayName}?</h3>
          {administratorPasswordField}{pendingNotice}
          <div className="users-access-actions"><button className="button danger" type="submit" disabled={busy || conflict || Boolean(access.preview)}>{busy ? 'Deleting…' : pending ? 'Retry request' : 'Delete user'}</button>
            <button type="button" className="button secondary" disabled={locked} onClick={() => { setDeleting(false); setError(''); clearCredentials(); }}>Cancel</button></div>
        </form>}
      </aside>}
    </div>
  </section>;
}
