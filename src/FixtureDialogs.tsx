import { useEffect, useRef, useState } from 'react';
import type { CommercialEnquirySummary } from '../shared/commercialEnquiries';
import type { FixtureHistoryItem } from '../shared/fixtureHistory';
import {
  fixtureGrades, isFixtureDate, type FixtureAssignment, type FixtureBooking, type FixtureEtaKind,
  type FixtureGrade, type FixtureOptions, type FixtureSupplyLine,
} from '../shared/fixtureWorkflow';
import { parseProductQuantity } from '../shared/productQuantity';
import { fixtureApi } from './lib/commercialEnquiryApi';
import { useSupplierCatalog } from './lib/supplierApi';
import { supplierName } from './lib/supplierPresentation';
import SearchableSelect from './SearchableSelect';
import { Field, Modal } from './ui';
import type { OpenWorkspace } from './workspaceNavigation';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dateFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const hongKongDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
const amount = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 9 });
const asDate = (value: string | null) => value ? dateFormatter.format(new Date(`${value}T00:00:00Z`)) : '—';
export function fixtureEta(eta: string | null, kind?: FixtureEtaKind, end?: string | null) {
  if (!eta) return '—';
  const start = asDate(eta);
  if (kind === 'range' && end) return `${start} – ${asDate(end)}`;
  return kind === 'date' ? start : `FROM ${start}`;
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
function useSubmission() {
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

type DraftLine = { key: string; grade: FixtureGrade; quantity: string; supplierId: string; accountId: string; price: string; requested?: string };
const blankSupplyLine = (grade: FixtureGrade, accountId: string): DraftLine => ({
  key: crypto.randomUUID(), grade, accountId, quantity: '', supplierId: '', price: '',
});
function exactQuantity(raw: string) {
  const parsed = parseProductQuantity(raw);
  return parsed && parsed.min === parsed.max && parsed.max <= 1_000_000 ? parsed.min : null;
}

function FixtureSupplyForm({ booking, onConfirmed }: { booking: FixtureBooking; onConfirmed: (booking: FixtureBooking) => void }) {
  const settings = useFixtureOptions(true);
  const catalog = useSupplierCatalog(true);
  const suppliers = (catalog.data?.items ?? []).filter(supplier => supplier.countryCode === 'SG' && !supplier.isClosed);
  const supplierOptions = suppliers.map(supplier => ({ value: supplier.id, label: supplierName(supplier),
    keywords: [supplier.shortName, ...supplier.aliases].join(' ') }));
  const [account, setAccount] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() => booking.requested.length ? booking.requested.map(product => ({
    ...blankSupplyLine(product.grade, ''), quantity: exactQuantity(product.quantityText)?.toString() ?? '', requested: product.quantityText,
  })) : [blankSupplyLine('VLSFO', '')]);
  const [quantityReviewed, setQuantityReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();
  const confirmed: FixtureSupplyLine[] = lines.flatMap(line => {
    const quantity = exactQuantity(line.quantity);
    const buyPrice = Number(line.price);
    return quantity && line.supplierId && settings.options?.accounts.some(item => item.id === line.accountId) && buyPrice > 0 && buyPrice <= 1_000_000
      ? [{ grade: line.grade, quantity, supplierId: line.supplierId, accountId: line.accountId, buyPrice }] : [];
  });
  const bands = settings.options?.quantityReview;
  const unusual = bands && lines.some(line => {
    const quantity = exactQuantity(line.quantity);
    const band = bands[line.grade];
    return quantity !== null && (quantity < band.min || quantity > band.max);
  });
  const duplicate = new Set(confirmed.map(line => JSON.stringify(line))).size !== confirmed.length;

  function edit(index: number, patch: Partial<DraftLine>) {
    setQuantityReviewed(false);
    setLines(current => current.map((line, row) => row === index ? { ...line, ...patch } : line));
  }
  async function save() {
    if (busy || confirmed.length !== lines.length || !settings.options || duplicate || (unusual && !quantityReviewed)) return;
    setBusy(true); setError('');
    const input = { action: 'confirm' as const, dataMode: 'live' as const, id: booking.id,
      expectedRevision: booking.revision, lines: confirmed, quantityReviewed: Boolean(unusual && quantityReviewed) };
    try { onConfirmed(await fixtureApi.confirm({ ...input, requestId: submission(input) })); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="outcome-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy}>
      {(settings.error || catalog.error) && <p role="alert">{settings.error || catalog.error}
        <button type="button" className="ui-button ui-button--secondary" onClick={() => { settings.retry(); catalog.refresh(); }}>RETRY</button></p>}
      {error && <p className="record-sheet__error" role="alert">{error}</p>}
      <Field label="ACCOUNT"><select aria-label="ACCOUNT" value={account} disabled={!settings.options} onChange={event => {
        const initial = account; const next = event.target.value;
        setAccount(next); setLines(current => current.map(line => !line.accountId || line.accountId === initial ? { ...line, accountId: next } : line));
      }}><option value="">SELECT ACCOUNT</option>{settings.options?.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      {lines.map((line, index) => <section key={line.key} className="fixture-product">
        <div className="form-grid">
          <Field label="GRADE"><select aria-label={`Grade ${index + 1}`} value={line.grade}
            onChange={event => edit(index, { grade: event.target.value as FixtureGrade, requested: undefined })}>
            {fixtureGrades.map(grade => <option key={grade}>{grade}</option>)}
          </select></Field>
          <Field label="QUANTITY (MT)" hint={line.requested && !exactQuantity(line.requested) ? line.requested : undefined}>
            <input required value={line.quantity} aria-label={`Quantity ${index + 1}`} inputMode="decimal"
              onChange={event => edit(index, { quantity: event.target.value })} />
          </Field>
          <Field label="SUPPLIER"><SearchableSelect label={`Supplier ${index + 1}`} options={supplierOptions}
            disabled={catalog.loading || Boolean(catalog.error)} value={line.supplierId} onChange={supplierId => edit(index, { supplierId })} /></Field>
          <Field label="ACCOUNT"><select required value={line.accountId} aria-label={`Account ${index + 1}`}
            onChange={event => edit(index, { accountId: event.target.value })}>
            <option value="">SELECT ACCOUNT</option>{settings.options?.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></Field>
          <Field label="BUY PRICE (USD/MT)"><input required type="number" step="any" min="0.000001" value={line.price}
            aria-label={`Buy price ${index + 1}`} onChange={event => edit(index, { price: event.target.value })} /></Field>
        </div>
        {lines.length > 1 && <button type="button" className="ui-button ui-button--secondary" onClick={() => {
          setQuantityReviewed(false); setLines(current => current.filter(item => item.key !== line.key));
        }}>REMOVE LINE</button>}
      </section>)}
      {duplicate && <p className="record-sheet__error" role="alert">REVIEW DUPLICATE SUPPLY LINES.</p>}
      {unusual && <label className="fixture-dialog__check"><input type="checkbox" checked={quantityReviewed}
        onChange={event => setQuantityReviewed(event.target.checked)} /> CONFIRM UNUSUAL QUANTITIES</label>}
      <footer className="modal-actions">
        <button type="button" className="ui-button ui-button--secondary" disabled={lines.length >= 30}
          onClick={() => { setQuantityReviewed(false); setLines(current => [...current, blankSupplyLine('VLSFO', account)]); }}>ADD LINE</button>
        <button className="ui-button ui-button--primary" disabled={confirmed.length !== lines.length || !settings.options || duplicate || Boolean(unusual && !quantityReviewed)}>
          {busy ? 'SAVING…' : 'CONFIRM'}
        </button>
      </footer>
    </fieldset>
  </form>;
}

function SupplyDetails({ grade, quantity, supplier, account, price, onSupplier }: {
  grade: string; quantity: string; supplier: string; account: string | null; price: string | null; onSupplier?: () => void;
}) {
  return <dl className="form-grid fixture-dialog__record">
    <div><dt>GRADE</dt><dd>{grade}</dd></div><div><dt>QUANTITY (MT)</dt><dd>{quantity}</dd></div>
    <div><dt>SUPPLIER</dt><dd>{onSupplier ? <button type="button" className="text-button" onClick={onSupplier}>{supplier}</button> : supplier || '—'}</dd></div>
    <div><dt>ACCOUNT</dt><dd>{account ?? '—'}</dd></div><div><dt>BUY PRICE</dt><dd>{price ?? '—'}</dd></div>
  </dl>;
}
export function FixtureDetails({ item, onOpen, onClose, onConfirmed }: {
  item: FixtureHistoryItem; onOpen: OpenWorkspace; onClose: () => void; onConfirmed: () => void;
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
  return <Modal title={item.vessel} onClose={onClose} wide={item.status === 'pending'}>
    <div className="fixture-dialog">
      <dl className="form-grid fixture-dialog__record">
        <div><dt>DATE</dt><dd>{asDate(item.date)}</dd></div>
        <div><dt>ETA</dt><dd>{fixtureEta(item.eta, item.etaKind, item.etaEnd)}</dd></div>
        {item.imo && <div><dt>IMO</dt><dd>{item.imo}</dd></div>}
        {!item.status && item.barging !== null && <div><dt>BARGING</dt><dd>{item.barging}</dd></div>}
        {booking && <div><dt>STATUS</dt><dd>{booking.status}</dd></div>}
      </dl>
      {error && <p role="alert">{error} <button type="button" className="ui-button ui-button--secondary" onClick={() => setAttempt(value => value + 1)}>RETRY</button></p>}
      {item.status && !booking && !error && <p role="status">LOADING…</p>}
      {booking?.canConfirm && <FixtureSupplyForm key={booking.revision} booking={booking} onConfirmed={confirmed => { setBooking(confirmed); onConfirmed(); }} />}
      {booking?.lines.map((line, index) => <SupplyDetails key={index} grade={line.grade} quantity={amount.format(line.quantity)} supplier={line.supplier}
        account={line.account} price={`USD ${amount.format(line.buyPrice)}/MT`}
        onSupplier={line.supplierAvailable ? () => openSupplier(line.supplierId) : undefined} />)}
      {!item.status && fixtureGrades.map(grade => {
        const quantity = item[grade.toLowerCase() as 'hsfo' | 'vlsfo' | 'lsmgo'];
        return quantity !== null && <SupplyDetails key={grade} grade={grade} quantity={quantity} supplier={item.supplier}
          account={item.account} price={item.price} onSupplier={item.supplierAvailable ? () => openSupplier(item.supplierId) : undefined} />;
      })}
    </div>
  </Modal>;
}
