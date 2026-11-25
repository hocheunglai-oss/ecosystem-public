import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  FixtureHistoryItem, FixtureRegisterChange, FixtureRegisterEditor, FixtureRegisterFields, FixtureRegisterLine,
} from '../shared/fixtureHistory';
import { fixtureGrades, type FixtureEtaKind } from '../shared/fixtureWorkflow';
import { parseProductQuantity } from '../shared/productQuantity';
import { fixtureApi } from './lib/commercialEnquiryApi';
import { fixtureCancellationDate, useSubmission } from './FixtureDialogs';
import { Field, Modal } from './ui';

type EditorLine = FixtureRegisterLine & { key: string };
type EditorAction = FixtureRegisterChange['action'];
const lineColumns = ['GRADE', 'QUANTITY (MT)', 'SUPPLIER', 'ACCOUNT', 'BUY PRICE', 'BARGING'] as const;
const newLine = (): EditorLine => ({ key: crypto.randomUUID(), grade: 'VLSFO',
  quantity: '', supplierId: '', accountId: '', price: '', barging: '', cancelled: false });

function FixtureEditorForm({ editor, onClose, onChanged }: {
  editor: FixtureRegisterEditor; onClose: () => void; onChanged: () => void;
}) {
  const { item } = editor;
  const [fields, setFields] = useState(() => editor.fields);
  const [lines, setLines] = useState<EditorLine[]>(() => editor.fields.lines.map(line => ({ ...line, key: crypto.randomUUID() })));
  const [action, setAction] = useState<EditorAction>('update');
  const [reason, setReason] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();
  const early = Boolean(fields.eta && fields.eta < fields.date);
  const invalidRange = Boolean(fields.etaEnd && (!fields.eta || fields.etaEnd <= fields.eta));
  const locked = Boolean(item.deleted);
  const status = locked ? 'DELETED' : item.cancelled ? 'CANCELLED' : item.status?.toUpperCase();
  const scheduleInvalid = invalidRange || (early && !fields.etaReviewed) || (fields.etaKind === 'range' && !fields.etaEnd);
  const publishing = editor.canConfirm || item.status === 'confirmed';
  const quantities = publishing ? lines.map(line => parseProductQuantity(line.quantity)) : [];
  const unusual = quantities.some((amount, index) => {
    const { min, max } = editor.quantityReview[lines[index].grade];
    return amount && amount.min === amount.max && (amount.min < min || amount.max > max);
  });
  const incomplete = !lines.length || lines.some((line, index) => {
    const quantity = quantities[index];
    const price = Number(line.price.replaceAll(',', ''));
    return !quantity || quantity.min !== quantity.max || quantity.max > 1_000_000 ||
      !line.supplierId || !line.accountId || !(price > 0 && price <= 1_000_000);
  });
  const publishingBlocked = incomplete || (unusual && !reviewed);
  const change = (patch: Partial<FixtureRegisterFields>) => setFields(current => ({ ...current, ...patch }));
  function updateLine(key: string, patch: Partial<FixtureRegisterLine>) {
    setReviewed(false);
    setLines(current => current.map(line => line.key === key ? { ...line, ...patch } : line));
  }
  function stage(next: EditorAction) { setAction(next); setError(''); }

  async function submit(operation: EditorAction) {
    if (busy || ((operation === 'update' || operation === 'complete') && (scheduleInvalid ||
      ((operation === 'complete' || item.status === 'confirmed') && publishingBlocked)))) return;
    if (operation === 'void' && !reason.trim()) return;
    setBusy(true); setError('');
    const base = { dataMode: 'live' as const, id: item.id, version: editor.version };
    const write: FixtureRegisterChange =
      operation === 'update' || operation === 'complete' ? { ...base, action: operation,
        fields: { ...fields, vessel: fields.vessel.trim(), lines: lines.map(({ key: _key, ...line }) => line) }, quantityReviewed: reviewed } :
        operation === 'void' ? { ...base, action: operation, reason: reason.trim() } : { ...base, action: operation };
    try {
      await fixtureApi.edit({ ...write, requestId: submission(write) });
      onChanged(); onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally { setBusy(false); }
  }

  const confirmation = action === 'delete' || action === 'void';
  return <Modal title="EDIT FIXTURE" onClose={() => { if (!busy) onClose(); }} wide>
    <form className="fixture-dialog fixture-editor" onSubmit={event => {
      event.preventDefault();
      const pressed = (event.nativeEvent as SubmitEvent).submitter;
      void submit(pressed instanceof HTMLButtonElement && pressed.value === 'complete' ? 'complete' : action);
    }}>
      <fieldset hidden={confirmation} disabled={busy || locked || confirmation}>
        <div className="fixture-editor__booking">
          <Field label="VESSEL"><input required maxLength={240} aria-label="VESSEL" value={fields.vessel} onChange={event => change({ vessel: event.target.value })} /></Field>
          <Field label="IMO"><input inputMode="numeric" maxLength={7} pattern="[0-9]{7}" aria-label="IMO" value={fields.imo} onChange={event => change({ imo: event.target.value })} /></Field>
          <Field label="DATE"><input required type="date" aria-label="DATE" value={fields.date} onChange={event => change({ date: event.target.value, etaReviewed: false })} /></Field>
          <Field label="ETA FROM"><input required={Boolean(item.status)} type="date" aria-label="ETA FROM" value={fields.eta ?? ''} onChange={event => change({ eta: event.target.value || null, etaReviewed: false })} /></Field>
          <Field label="ETA TO"><input type="date" aria-label="ETA TO" min={fields.eta ?? undefined} value={fields.etaEnd ?? ''} onChange={event => {
            const end = event.target.value || null;
            change({ etaEnd: end, etaKind: end ? 'range' : 'date' });
          }} /></Field>
          <Field label="ETA"><select aria-label="ETA" value={fields.etaKind} onChange={event => {
            const etaKind = event.target.value as FixtureEtaKind;
            change({ etaKind, etaEnd: etaKind === 'range' ? fields.etaEnd : null });
          }}><option value="date">DATE</option><option value="range">DATE RANGE</option><option value="earliest">EARLIEST ONLY</option></select></Field>
        </div>
        <dl className="fixture-editor__metadata">
          <div><dt>SUPPLIER TRADER</dt><dd>{item.supplierTrader} ({item.supplierOfficeCode ?? item.supplierOffice})</dd></div>
          <div><dt>BUYER TRADER</dt><dd>{item.buyerTrader} ({item.buyerOfficeCode ?? item.buyerOffice})</dd></div>
          {editor.reference && <div><dt>REFERENCE</dt><dd>{editor.reference}</dd></div>}
          {status && <div><dt>STATUS</dt><dd className={status === 'CANCELLED' ? 'fixture-cancelled' : undefined}>{status}</dd></div>}
          {item.cancellation && <>
            <div><dt>CANCELLED BY</dt><dd>{item.cancellation.by}</dd></div>
            <div><dt>CANCELLED AT</dt><dd>{fixtureCancellationDate(item.cancellation.at)}</dd></div>
            <div><dt>REASON</dt><dd>{item.cancellation.reason}</dd></div>
          </>}
        </dl>
        {early && <label className="fixture-dialog__check"><input type="checkbox" checked={fields.etaReviewed}
          onChange={event => change({ etaReviewed: event.target.checked })} /> CONFIRM ETA BEFORE FIXTURE DATE</label>}
        <table className="fixture-editor__lines" aria-label="SUPPLY LINES">
          <thead><tr>{lineColumns.map(label => <th key={label} scope="col">{label}</th>)}<th scope="col" aria-label="Remove line" /></tr></thead>
          <tbody>{lines.map((line, index) => {
            const num = index + 1;
            const legacyAccount = line.accountId.startsWith('@') ? line.accountId.slice(1) : '';
            return <tr key={line.key}>
              <td><Field label="GRADE"><select aria-label={`Grade ${num}`} value={line.grade} onChange={event => updateLine(line.key, { grade: event.target.value as FixtureRegisterLine['grade'] })}>
                {fixtureGrades.map(grade => <option key={grade}>{grade}</option>)}
              </select></Field>{line.cancelled && <small className="fixture-cancelled">CANCELLED</small>}</td>
              <td><Field label="QUANTITY (MT)"><input aria-label={`Quantity ${num}`} inputMode="decimal" maxLength={80} value={line.quantity}
                onChange={event => updateLine(line.key, { quantity: event.target.value })} /></Field></td>
              <td><Field label="SUPPLIER"><select aria-label={`Supplier ${num}`} value={line.supplierId} onChange={event => updateLine(line.key, { supplierId: event.target.value })}>
                <option value="">SELECT SUPPLIER</option>{editor.suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select></Field></td>
              <td><Field label="ACCOUNT"><select aria-label={`Account ${num}`} value={line.accountId} onChange={event => updateLine(line.key, { accountId: event.target.value })}>
                <option value="">SELECT ACCOUNT</option>{legacyAccount && <option value={line.accountId}>{legacyAccount}</option>}
                {editor.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select></Field></td>
              <td><Field label="BUY PRICE"><input aria-label={`Buy price ${num}`} inputMode="decimal" maxLength={120} value={line.price}
                onChange={event => updateLine(line.key, { price: event.target.value })} /></Field></td>
              <td><Field label="BARGING"><input aria-label={`Barging ${num}`} inputMode="decimal" maxLength={120} value={line.barging}
                onChange={event => updateLine(line.key, { barging: event.target.value })} /></Field></td>
              <td><button type="button" className="ui-button--icon ui-button--secondary" aria-label={`Remove line ${num}`} onClick={() => {
                setReviewed(false);
                setLines(current => current.filter(row => row.key !== line.key));
              }}><X size={16} aria-hidden="true" /></button></td>
            </tr>;
          })}</tbody>
        </table>
        <button type="button" className="ui-button ui-button--secondary" disabled={lines.length >= 30}
          onClick={() => setLines(current => [...current, newLine()])}>ADD LINE</button>
        {unusual && <label className="fixture-dialog__check"><input type="checkbox" checked={reviewed}
          onChange={event => setReviewed(event.target.checked)} /> CONFIRM UNUSUAL QUANTITIES</label>}
      </fieldset>
      {confirmation && <fieldset disabled={busy}>
        {action === 'delete' ? <p>DELETE {item.vessel}?</p> : <Field label="REASON"><textarea required aria-label="REASON" maxLength={500}
          rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field>}
      </fieldset>}
      {error && <p role="alert" className="record-sheet__error">{error}</p>}
      <footer className="modal-actions">
        {locked ? <button type="button" className="ui-button ui-button--primary" disabled={busy} onClick={() => void submit('restore')}>RESTORE</button> :
          confirmation ? <>
            <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => stage('update')}>BACK</button>
            <button className="ui-button ui-button--danger" disabled={busy || (action === 'void' && !reason.trim())}>
              {action === 'delete' ? 'CONFIRM DELETE' : 'CONFIRM CANCELLATION'}
            </button>
          </> : <>
            <button type="button" className="ui-button ui-button--danger" disabled={busy} onClick={() => stage('delete')}>DELETE</button>
            {editor.canCancel && <button type="button" className="ui-button ui-button--danger" disabled={busy} onClick={() => stage('void')}>FIXTURE CANCELLED</button>}
            <button className={`ui-button ui-button--${editor.canConfirm ? 'secondary' : 'primary'}`}
              disabled={busy || scheduleInvalid || (item.status === 'confirmed' && publishingBlocked)}>SAVE</button>
            {editor.canConfirm && <button value="complete" className="ui-button ui-button--primary"
              disabled={busy || scheduleInvalid || publishingBlocked}>CONFIRM</button>}
          </>}
      </footer>
    </form>
  </Modal>;
}

export default function FixtureEditor({ item, onClose, onChanged }: {
  item: FixtureHistoryItem; onClose: () => void; onChanged: () => void;
}) {
  const [editor, setEditor] = useState<FixtureRegisterEditor>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fixtureApi.editor(item.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setEditor(value);
    }).catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => controller.abort();
  }, [item.id, attempt]);
  if (editor) return <FixtureEditorForm editor={editor} onClose={onClose} onChanged={onChanged} />;
  return <Modal title="EDIT FIXTURE" onClose={onClose} wide><div className="fixture-dialog">
    {error ? <p role="alert">{error} <button type="button" className="ui-button ui-button--secondary" onClick={() => {
      setError(''); setAttempt(value => value + 1);
    }}>RETRY</button></p> : <p role="status">LOADING…</p>}
  </div></Modal>;
}
