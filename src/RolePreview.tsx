import { useEffect, useId, useRef, useState } from 'react';
import type { PreviewRole } from '../shared/access';
import type { PreviewPerson } from '../shared/personPreview';
import { useAccess } from './auth';
import './role-preview.css';

const labels: Record<PreviewRole, string> = {
  admin: 'Admin', trader: 'Normal trader', 'spc-trader': 'SPC Trader', manager: 'Manager', credit: 'Credit',
};

export function RolePreview({ pending = false }: { pending?: boolean }) {
  const access = useAccess();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [people, setPeople] = useState<PreviewPerson[] | null>(null);
  const [selected, setSelected] = useState('');
  const container = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!expanded) return;
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setExpanded(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  if (!access.realUser?.isAdmin) return null;
  const roles: PreviewRole[] = ['trader', 'spc-trader', 'manager', 'credit'];
  return <section ref={container} className="role-preview-controls" aria-label="View as"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.current?.focus(); } }}>
    <button ref={toggle} className="ui-button ui-button--secondary" type="button" aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined} disabled={busy || pending}
      onClick={() => { setError(''); setPeople(null); setExpanded(value => !value); }}>View as</button>
    {expanded && <div id={panelId} className="role-preview-options" aria-label="Preview roles">
      {people ? <form className="role-preview-form" onSubmit={async event => {
        event.preventDefault();
        if (busy || pending) return;
        setBusy(true); setError('');
        try { await access.startPersonPreview(selected); setExpanded(false); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Preview could not start.'); }
        finally { setBusy(false); }
      }}>
        <label>USER<select aria-label="Preview user" value={selected} disabled={busy || pending}
          onChange={event => setSelected(event.target.value)}>
          {people.map(person => <option key={person.id} value={person.id}>{person.name}{person.fictional ? ' (FICTIONAL)' : ''}</option>)}
        </select></label>
        <button type="submit" className="ui-button ui-button--secondary" disabled={busy || pending || !selected}>VIEW AS USER</button>
        <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => setPeople(null)}>BACK</button>
      </form> : <>
      <button type="button" className="ui-button ui-button--secondary" disabled={busy || pending} onClick={async () => {
        setBusy(true); setError('');
        try { const options = await access.loadPreviewPeople(); setPeople(options); setSelected(options[0]?.id ?? ''); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Users could not be loaded.'); }
        finally { setBusy(false); }
      }}>USER</button>
      {roles.map(role => <button type="button" className="ui-button ui-button--secondary" key={role}
        disabled={busy || pending} aria-pressed={access.preview?.role === role}
        onClick={async () => {
          if (busy || pending) return;
          setBusy(true); setError('');
          try {
            await access.startPreview({ role, officeId: role === 'credit' ? 'CREDIT' : access.realUser!.officeId });
            setExpanded(false);
          } catch (failure) { setError(failure instanceof Error ? failure.message : 'Preview could not start.'); }
          finally { setBusy(false); }
        }}>{labels[role]}</button>)}</>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </section>;
}

export function RolePreviewBanner() {
  const access = useAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!access.preview || !access.realUser) return null;
  return <aside className="role-preview-banner" role="status" aria-label="Role preview">
    <div><strong>Preview · Read only</strong><span>{access.previewPerson ? `${access.previewPerson.name}${access.previewPerson.fictional ? ' (FICTIONAL)' : ''} · ` : ''}{labels[access.preview.role]} · {access.preview.officeName}</span></div>
    <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setError('');
      try { await access.endPreview(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Preview could not end.'); }
      finally { setBusy(false); }
    }}>{busy ? 'Returning…' : `Back to ${access.realUser.displayName}`}</button>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
