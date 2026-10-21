import KnowledgeUpdateButton from './KnowledgeUpdateButton';
import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { SupplierRecord, SupplierSummary, SupplierUpdate } from '../shared/suppliers';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { assertLiveDataWritable, isCurrentWorkspace } from './lib/testWorkspaceGuard';
import { assertPreviewWritable } from './lib/previewGuard';
import { Modal } from './ui';
import { announceFeedbackUpdate } from './lib/adminApi';
import { announceSupplierUpdate, supplierApi } from './lib/supplierApi';
import { supplierShortName } from './lib/supplierPresentation';
import { isSelectableSupplierPic, supplierPicChoices } from './lib/supplierPicSelection';
import './supplier-pic-editor.css';

export default function SupplierPicEditor({ supplier, onEdit }: { supplier: SupplierSummary; onEdit: () => void }) {
  const { realUser, preview } = useAccess();
  const allowed = Boolean(realUser?.isActive && (realUser.isAdmin || realUser.isSpcTrader) && !preview && supplier.countryCode === 'SG');
  const name = supplierShortName(supplier);
  return <div className="supplier-pic-cell">
    {allowed ? <button type="button" className="supplier-pic-trigger" aria-label={`CHANGE SUPPLIER PIC FOR ${name}`} aria-haspopup="dialog"
      onClick={onEdit}>
      <span>{supplier.info.supplierTrader || '—'}</span><Pencil size={13} aria-hidden="true" />
    </button> : <span>{supplier.info.supplierTrader || '—'}</span>}
  </div>;
}

/** Mount at the workspace root so list refreshes cannot discard a draft or retry receipt. */
export function SupplierPicDialog({ supplier, options, optionsLoading = false, optionsError = '', onRetryOptions, onClose, onSaved }: {
  supplier: SupplierSummary;
  options: string[];
  optionsLoading?: boolean;
  optionsError?: string;
  onRetryOptions?: () => void;
  onClose: () => void;
  onSaved: (item: SupplierRecord) => void;
}) {
  const { realUser, preview } = useAccess();
  const allowed = Boolean(realUser?.isActive && (realUser.isAdmin || realUser.isSpcTrader) && !preview && supplier.countryCode === 'SG');
  const { namespace } = useTestWorkspace();
  if (!allowed) return null;
  return <PicDialog key={`${namespace}:${supplier.id}`} supplier={supplier} name={supplierShortName(supplier)} options={options}
    optionsLoading={optionsLoading} optionsError={optionsError} onRetryOptions={onRetryOptions} onClose={onClose} onSaved={onSaved} />;
}

function PicDialog({ supplier, name, options, optionsLoading, optionsError, onRetryOptions, onClose, onSaved }: {
  supplier: SupplierSummary; name: string; options: string[]; optionsLoading: boolean; optionsError: string;
  onRetryOptions?: () => void; onClose: () => void; onSaved: (item: SupplierRecord) => void;
}) {
  const { realUser, preview } = useAccess();
  const allowed = Boolean(realUser?.isActive && (realUser.isAdmin || realUser.isSpcTrader) && !preview);
  const { namespace } = useTestWorkspace();
  const authority = useRef({ ownerId: realUser?.id, namespace, allowed });
  authority.current = { ownerId: realUser?.id, namespace, allowed };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stillCurrent = (started: typeof authority.current) => alive.current && authority.current.ownerId === started.ownerId
    && authority.current.namespace === started.namespace && authority.current.allowed && isCurrentWorkspace(started.namespace);
  const [item, setItem] = useState<SupplierRecord | null>(null);
  const [value, setValue] = useState(supplier.info.supplierTrader.trim());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [generation, setGeneration] = useState(0);
  const attempt = useRef<SupplierUpdate | null>(null);
  useEffect(() => {
    const controller = new AbortController(), started = authority.current;
    setLoading(true); setError(''); setConflict(false); attempt.current = null;
    void (async () => {
      try {
        if (!stillCurrent(started)) return;
        assertPreviewWritable(); assertLiveDataWritable();
        const { item } = await supplierApi.detail(supplier.id, controller.signal);
        if (controller.signal.aborted || !stillCurrent(started)) return;
        assertPreviewWritable(); assertLiveDataWritable();
        if (item.countryCode !== 'SG') throw new Error('SINGAPORE SUPPLIER REQUIRED.');
        setItem(item); setValue(item.info.supplierTrader.trim()); setLoading(false);
      } catch (failure) {
        if (!controller.signal.aborted && stillCurrent(started)) { setError((failure as Error).message); setItem(null); setLoading(false); }
      }
    })();
    return () => controller.abort();
  }, [supplier.id, generation, namespace, realUser?.id, allowed]);
  const choices = supplierPicChoices(options, value);
  const changed = Boolean(item && value !== item.info.supplierTrader.trim());
  // A committed request may outlive a roster change. Its exact receipt can still
  // be retried; only a new assignment requires a currently selectable name.
  const selectionAllowed = Boolean(attempt.current) || !value || (!optionsLoading && !optionsError && isSelectableSupplierPic(value, options));
  const close = () => { if (!saving) onClose(); };
  async function save() {
    const started = authority.current;
    if (!stillCurrent(started) || !item || !changed || !selectionAllowed || loading || saving || conflict) return;
    setSaving(true); setError('');
    try {
      assertPreviewWritable(); assertLiveDataWritable();
      // A transport failure may have committed. Retrying this exact payload reuses
      // its request ID, so the server returns its receipt without another +1.
      attempt.current ??= { requestId: crypto.randomUUID(), id: item.id, revision: item.revision,
        info: { ...item.info, supplierTrader: value }, contacts: item.contacts, barges: item.barges };
      const result = await supplierApi.update(attempt.current);
      if (!stillCurrent(started)) return;
      announceSupplierUpdate(); announceFeedbackUpdate(); onSaved(result.item);
    } catch (failure) {
      if (stillCurrent(started)) {
        setError((failure as Error).message);
        if ((failure as { status?: number }).status === 409) setConflict(true);
        if ((failure as { status?: number }).status === 422) { attempt.current = null; onRetryOptions?.(); }
      }
    } finally { if (stillCurrent(started)) setSaving(false); }
  }
  return <Modal title="SUPPLIER PIC" onClose={close}>
    <form className="supplier-pic-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <strong className="supplier-pic-supplier">{name}</strong>
      {loading && <p role="status">LOADING…</p>}
      {error && <div className="supplier-pic-error" role="alert"><span>{error}</span>{(!item || conflict) && <button type="button" className="button secondary" disabled={saving} onClick={() => setGeneration(current => current + 1)}>RELOAD</button>}</div>}
      {optionsError && <div className="supplier-pic-error" role="alert"><span>{optionsError}</span>{onRetryOptions && <button type="button" className="button secondary" onClick={onRetryOptions}>RETRY</button>}</div>}
      <label>SUPPLIER PIC<select aria-label={`SUPPLIER PIC FOR ${name}`} value={value} disabled={loading || saving || !item || conflict}
        onChange={event => { setValue(event.target.value); attempt.current = null; setError(''); }}>
        {choices.map(option => <option value={option.value} key={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select></label>
      {optionsLoading && <p role="status">LOADING TRADERS…</p>}
      <footer><button type="button" className="button secondary" disabled={saving} onClick={close}>CANCEL</button>
        <KnowledgeUpdateButton type="submit" disabled={!allowed || !changed || !selectionAllowed || loading || saving || conflict}>{saving ? 'SAVING…' : 'SAVE'}</KnowledgeUpdateButton></footer>
    </form>
  </Modal>;
}
