import { LogOut } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { normalizeAccessPhone } from "../shared/access";
import { useAccess } from "./auth";
import { usePhoneChangeRequests } from "./PhoneChangeRequests";
import "./personal-details.css";

export type AccountPanel = {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  inline: boolean;
  target: HTMLElement | null;
};

export function ProfileMenu({ onSignOut }: { onSignOut: () => void }) {
  return <div className="hud-personal-menu">
    <button type="button" className="hud-profile-toggle ui-button--entry" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
      <LogOut size={18} />
    </button>
  </div>;
}

/** Account identity comes from the access service, never the browser-local demo profile. */
export function PersonalDetails() {
  const { realUser, preview } = useAccess();
  const { requests, loading, error: loadError, busy, submitRequest, refresh } = usePhoneChangeRequests();
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const ownRequests = requests.filter(request => request.userId === realUser?.id);
  const pending = ownRequests.find(request => request.status === 'pending');
  const latest = [...ownRequests].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (!realUser) return null;
  async function requestChange(event: FormEvent) {
    event.preventDefault();
    if (busy || preview || pending) return;
    const normalized = normalizeAccessPhone(phone);
    setPhone(normalized); setError(''); setNotice('');
    if (!/^\+[1-9][0-9]{6,14}$/.test(normalized)) { setError('Enter an international number, including + and the country code.'); return; }
    if (normalized === realUser?.phone) { setError('Enter a different phone number.'); return; }
    try {
      await submitRequest(requestId.current, normalized);
      setEditing(false); setPhone(''); requestId.current = crypto.randomUUID(); setNotice('Change requested. Awaiting admin approval.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Phone change could not be requested.'); }
  }
  return <section className="personal-details" aria-label="Personal details">
    <h2>Personal details</h2>
    <dl>
      <div><dt>Name</dt><dd>{realUser.displayName}</dd></div>
      <div><dt>Email</dt><dd data-email-value>{realUser.email}</dd></div>
      <div className="personal-phone"><dt>WhatsApp phone</dt><dd><div className="personal-phone-value"><span>{realUser.phone || "—"}</span>
        {!editing && !pending && <button type="button" className="ui-button" disabled={busy || loading || Boolean(preview) || Boolean(loadError)} onClick={() => {
          setEditing(true); setPhone(''); setError(''); setNotice(''); requestId.current = crypto.randomUUID();
        }}>Request change</button>}</div>
        {pending && <p className="personal-phone-status" role="status"><strong>Awaiting admin approval</strong><span>{pending.requestedPhone}</span></p>}
        {!pending && !editing && latest && <p className="personal-phone-status"><strong>{latest.status === 'approved' ? 'Approved' : latest.status === 'declined' ? 'Declined' : 'Request superseded'}</strong><span>{latest.requestedPhone}</span></p>}
        {editing && !pending && <form className="personal-phone-form" onSubmit={event => void requestChange(event)}>
          <label>New WhatsApp phone<input type="tel" autoComplete="tel" inputMode="tel" value={phone} required disabled={busy || Boolean(preview)}
            onChange={event => { setPhone(event.target.value); requestId.current = crypto.randomUUID(); }}
            onBlur={() => setPhone(value => normalizeAccessPhone(value))} /></label>
          <div className="personal-phone-actions"><button type="button" className="ui-button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
            <button type="submit" className="ui-button ui-button--primary" disabled={busy || Boolean(preview)}>{busy ? 'Submitting…' : 'Submit request'}</button></div>
        </form>}
        {(error || loadError) && <div className="personal-phone-error" role="alert"><p>{error || loadError}</p>{loadError && <button type="button" className="ui-button" disabled={busy} onClick={() => void refresh()}>Refresh</button>}</div>}
        {notice && <p className="personal-phone-status" role="status">{notice}</p>}
      </dd></div>
      <div><dt>Office</dt><dd>{realUser.officeName}</dd></div>
    </dl>
  </section>;
}
