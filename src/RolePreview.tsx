import { useEffect, useId, useRef, useState } from 'react';
import type { PreviewRole } from '../shared/access';
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
      onClick={() => { setError(''); setExpanded(value => !value); }}>View as</button>
    {expanded && <div id={panelId} className="role-preview-options" aria-label="Preview roles">
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
        }}>{labels[role]}</button>)}
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
    <div><strong>Preview · Read only</strong><span>{labels[access.preview.role]} · {access.preview.officeName}</span></div>
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
