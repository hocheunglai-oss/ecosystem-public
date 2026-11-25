import { useEffect, useRef, useState } from 'react';
import type { CommercialEnquirySummary } from '../shared/commercialEnquiries';
import type { FixtureHistoryItem } from '../shared/fixtureHistory';
import {
  fixtureGrades, isFixtureDate, type FixtureAssignment, type FixtureBooking, type FixtureEtaKind,
  type FixtureOptions,
} from '../shared/fixtureWorkflow';
import { fixtureApi } from './lib/commercialEnquiryApi';
import { Field, Modal } from './ui';
import type { OpenWorkspace } from './workspaceNavigation';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dateFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const hongKongDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
const hongKongTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', dateStyle: 'medium', timeStyle: 'short' });
export const fixtureCancellationDate = (value: string) => `${hongKongTime.format(new Date(value))} HKT`;
const amount = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 9 });
const asDate = (value: string | null) => value ? dateFormatter.format(new Date(`${value}T00:00:00Z`)) : '—';
export function fixtureEta(eta: string | null, kind?: FixtureEtaKind, end?: string | null) {
  if (!eta) return '—';
  const start = asDate(eta);
  if (kind === 'range' && end) return `${start} – ${asDate(end)}`;
  return start;
}
function knownEnquiryEta(value: string) {
  const written = value.trim().toUpperCase();
  if (isFixtureDate(value)) return value;
  const known = /^(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) ((?:19|20)\d{2})$/.exec(written);
  if (!known) return '';
  const date = `${known[3]}-${String(months.indexOf(known[2]) + 1).padStart(2, '0')}-${known[1].padStart(2, '0')}`;
  return isFixtureDate(date) ? date : '';
}
function useFixtureOptions(enabled: boolean) {
  const [options, setOptions] = useState<FixtureOptions>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    setError('');
    void fixtureApi.options(abort.signal).then(result => { if (!abort.signal.aborted) setOptions(result); }).catch(failure => {
      if (!abort.signal.aborted) setError((failure as Error).message);
    });
    return () => abort.abort();
  }, [attempt, enabled]);
  return { options, error, retry: () => setAttempt(value => value + 1) };
}
export function useSubmission() {
  const request = useRef<{ body: string; id: string } | undefined>(undefined);
  return (input: object) => {
    const body = JSON.stringify(input);
    if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
    return request.current.id;
  };
}

export function FixtureHandoff({ enquiry, onClose, onSaved }: {
  enquiry: CommercialEnquirySummary;
  onClose: () => void;
  onSaved: (assignment: FixtureAssignment) => void;
}) {
  const selection = useFixtureOptions(true);
  const prior = enquiry.fixture;
  const [supplierTraderId, setSupplierTraderId] = useState(prior?.supplierTraderId ?? '');
  const [date, setDate] = useState(() => prior?.date ?? hongKongDate.format(new Date()));
  const [eta, setEta] = useState(() => prior?.eta ?? knownEnquiryEta(enquiry.eta));
  const [etaEnd, setEtaEnd] = useState(prior?.etaEnd ?? '');
  const [etaKind, setEtaKind] = useState<FixtureEtaKind>(prior?.etaKind ?? 'date');
  const [etaReviewed, setEtaReviewed] = useState(prior?.etaReviewed ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();
  const early = Boolean(eta && eta < date);
  const valid = isFixtureDate(date) && isFixtureDate(eta) && (!early || etaReviewed)
    && (etaKind !== 'range' || (isFixtureDate(etaEnd) && etaEnd > eta))
    && selection.options?.traders.some(trader => trader.id === supplierTraderId);

  async function save() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    const input = { action: 'assign' as const, dataMode: 'live' as const, enquiryId: enquiry.id,
      expectedRevision: prior?.revision ?? 0, supplierTraderId, date, eta,
      etaEnd: etaKind === 'range' ? etaEnd : null, etaKind, etaReviewed: early && etaReviewed };
    try { onSaved(await fixtureApi.assign({ ...input, requestId: submission(input) })); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <Modal title="STEM" onClose={() => { if (!busy) onClose(); }}>
    <form className="fixture-dialog" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>{enquiry.vessel}</h3>
      {selection.error && <p role="alert">{selection.error} <button type="button" className="ui-button ui-button--secondary" onClick={selection.retry}>RETRY</button></p>}
      {error && <p className="record-sheet__error" role="alert">{error}</p>}
      <Field label="SUPPLIER TRADER"><select aria-label="SUPPLIER TRADER" required value={supplierTraderId} disabled={busy || !selection.options}
        onChange={event => setSupplierTraderId(event.target.value)}>
        <option value="">SELECT SUPPLIER TRADER</option>
        {selection.options?.traders.map(trader => <option key={trader.id} value={trader.id}>{trader.name} · {trader.office}</option>)}
      </select></Field>
      <div className="form-grid">
        <Field label="DATE"><input aria-label="DATE" required type="date" value={date} disabled={busy} onChange={event => { setDate(event.target.value); setEtaReviewed(false); }} /></Field>
        <Field label="ETA"><select aria-label="ETA" value={etaKind} disabled={busy} onChange={event => { setEtaKind(event.target.value as FixtureEtaKind); setEtaReviewed(false); }}>
          <option value="date">DATE</option><option value="range">DATE RANGE</option><option value="earliest">EARLIEST ONLY</option>
        </select></Field>
        <Field label={etaKind === 'date' ? 'ETA DATE' : 'EARLIEST ETA'} hint={enquiry.eta}><input aria-label={etaKind === 'date' ? 'ETA DATE' : 'EARLIEST ETA'} required type="date" value={eta} disabled={busy}
          onChange={event => { setEta(event.target.value); setEtaReviewed(false); }} /></Field>
        {etaKind === 'range' && <Field label="LATEST ETA"><input aria-label="LATEST ETA" required type="date" min={eta} value={etaEnd} disabled={busy}
          onChange={event => { setEtaEnd(event.target.value); setEtaReviewed(false); }} /></Field>}
      </div>
      {early && <label className="fixture-dialog__check"><input type="checkbox" checked={etaReviewed} disabled={busy}
        onChange={event => setEtaReviewed(event.target.checked)} /> CONFIRM ETA BEFORE FIXTURE DATE</label>}
      <footer className="modal-actions"><button className="ui-button ui-button--primary" disabled={!valid || busy}>{busy ? 'SAVING…' : 'SAVE'}</button></footer>
    </form>
  </Modal>;
}

function FixtureCancellation({ booking, onCancelled }: { booking: FixtureBooking; onCancelled: (booking: FixtureBooking) => void }) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();

  async function save() {
    if (busy || !reason.trim()) return;
    setBusy(true); setError('');
    const input = { action: 'cancel' as const, dataMode: 'live' as const, id: booking.id,
      expectedRevision: booking.revision, reason: reason.trim() };
    try { onCancelled(await fixtureApi.cancel({ ...input, requestId: submission(input) })); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  if (!editing) return <footer className="modal-actions"><button type="button" className="ui-button ui-button--danger"
    onClick={() => setEditing(true)}>CANCEL STEM</button></footer>;
  return <form onSubmit={event => { event.preventDefault(); void save(); }}>
    <Field label="REASON"><textarea aria-label="REASON" required maxLength={500} rows={3} value={reason} disabled={busy}
      onChange={event => setReason(event.target.value)} /></Field>
    {error && <p className="record-sheet__error" role="alert">{error}</p>}
    <footer className="modal-actions">
      <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>BACK</button>
      <button className="ui-button ui-button--danger" disabled={busy || !reason.trim()}>{busy ? 'SAVING…' : 'CONFIRM CANCELLATION'}</button>
    </footer>
  </form>;
}

function SupplyDetails({ grade, quantity, supplier, account, price, barging, cancelled, onSupplier }: {
  grade: string; quantity: string; supplier: string; account: string | null; price: string | null;
  barging?: string | null; cancelled?: boolean; onSupplier?: () => void;
}) {
  return <dl className="form-grid fixture-dialog__record">
    {cancelled && <div><dt>STATUS</dt><dd>CANCELLED</dd></div>}
    <div><dt>GRADE</dt><dd>{grade}</dd></div><div><dt>QUANTITY (MT)</dt><dd>{quantity}</dd></div>
    <div><dt>SUPPLIER</dt><dd>{onSupplier ? <button type="button" className="text-button" onClick={onSupplier}>{supplier}</button> : supplier || '—'}</dd></div>
    <div><dt>ACCOUNT</dt><dd>{account ?? '—'}</dd></div><div><dt>BUY PRICE</dt><dd>{price ?? '—'}</dd></div>
    {barging && <div><dt>BARGING</dt><dd>{barging}</dd></div>}
  </dl>;
}
export function FixtureDetails({ item, onOpen, onClose, onChanged, onEdit }: {
  item: FixtureHistoryItem; onOpen: OpenWorkspace; onClose: () => void; onChanged: () => void; onEdit?: () => void;
}) {
  const [booking, setBooking] = useState<FixtureBooking>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!item.status) return;
    const abort = new AbortController();
    setError('');
    void fixtureApi.detail(item.id, abort.signal).then(result => { if (!abort.signal.aborted) setBooking(result); }).catch(failure => {
      if (!abort.signal.aborted) setError((failure as Error).message);
    });
    return () => abort.abort();
  }, [attempt, item.id, item.status]);
  const openSupplier = (supplierId: string) => { onClose(); onOpen('suppliers', { supplierId }); };
  const saveBooking = (value: FixtureBooking) => { setBooking(value); onChanged(); };
  const cancellation = booking?.cancellation ?? item.cancellation;
  return <Modal title={item.imo ? `${item.vessel} (${item.imo})` : item.vessel} onClose={onClose}>
    <div className="fixture-dialog">
      <dl className="form-grid fixture-dialog__record">
        <div><dt>DATE</dt><dd>{asDate(item.date)}</dd></div>
        <div><dt>ETA</dt><dd>{fixtureEta(item.eta, item.etaKind, item.etaEnd)}</dd></div>
        {item.imo && <div><dt>IMO</dt><dd>{item.imo}</dd></div>}
        {!item.status && item.barging !== null && <div><dt>BARGING</dt><dd>{item.barging}</dd></div>}
        <div><dt>SUPPLIER TRADER</dt><dd>{item.supplierTrader} ({item.supplierOfficeCode ?? item.supplierOffice})</dd></div>
        <div><dt>BUYER TRADER</dt><dd>{item.buyerTrader} ({item.buyerOfficeCode ?? item.buyerOffice})</dd></div>
        {booking?.reference && <div><dt>REFERENCE</dt><dd>{booking.reference}</dd></div>}
        {(item.cancelled || booking) && <div><dt>STATUS</dt><dd>{item.cancelled ? 'CANCELLED' : booking?.status.toUpperCase()}</dd></div>}
        {cancellation && <>
          <div><dt>CANCELLED BY</dt><dd>{cancellation.by}</dd></div>
          <div><dt>CANCELLED AT</dt><dd>{fixtureCancellationDate(cancellation.at)}</dd></div>
          <div><dt>REASON</dt><dd>{cancellation.reason}</dd></div>
        </>}
      </dl>
      {error && <p role="alert">{error} <button type="button" className="ui-button ui-button--secondary" onClick={() => setAttempt(value => value + 1)}>RETRY</button></p>}
      {item.status && !booking && !error && <p role="status">LOADING…</p>}
      {booking && !booking.lines.length && booking.requested.map((line, index) =>
        <dl className="form-grid fixture-dialog__record" key={index}>
          <div><dt>GRADE</dt><dd>{line.grade}</dd></div><div><dt>QUANTITY (MT)</dt><dd>{line.quantityText}</dd></div>
        </dl>)}
      {booking?.lines.map((line, index) => <SupplyDetails key={index} grade={line.grade} quantity={amount.format(line.quantity)} supplier={line.supplier}
        account={line.account} price={`USD ${amount.format(line.buyPrice)}/MT`} barging={line.barging}
        onSupplier={line.supplierAvailable ? () => openSupplier(line.supplierId) : undefined} />)}
      {!item.status && (item.supplyRows ?? [item]).map((row, index) => fixtureGrades.map(grade => {
        const quantity = row[grade.toLowerCase() as 'hsfo' | 'vlsfo' | 'lsmgo'];
        return quantity !== null && <SupplyDetails key={`${index}-${grade}`} grade={grade} quantity={quantity} supplier={row.supplier}
          account={row.account} price={row.price} barging={item.supplyRows ? row.barging : undefined} cancelled={!item.cancelled && row.cancelled}
          onSupplier={row.supplierAvailable ? () => openSupplier(row.supplierId) : undefined} />;
      }))}
      {onEdit && <footer className="modal-actions"><button type="button" className="ui-button ui-button--primary" onClick={onEdit}>EDIT</button></footer>}
      {booking?.canCancel && !onEdit && <FixtureCancellation key={booking.revision} booking={booking} onCancelled={saveBooking} />}
    </div>
  </Modal>;
}
