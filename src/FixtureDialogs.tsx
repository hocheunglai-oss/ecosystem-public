import { useEffect, useRef, useState } from 'react';
import type { CommercialEnquirySummary } from '../shared/commercialEnquiries';
import {
  fixtureEtaRange, fixtureEtaTo, isFixtureDate, type FixtureAssignment, type FixtureOptions,
} from '../shared/fixtureWorkflow';
import { fixtureApi } from './lib/commercialEnquiryApi';
import { Field, Modal } from './ui';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const hongKongDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
function knownEnquiryEta(value: string) {
  const written = value.trim().toUpperCase();
  if (isFixtureDate(value)) return value;
  const known = /^(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) ((?:19|20)\d{2})$/.exec(written);
  if (!known) return '';
  const date = `${known[3]}-${String(months.indexOf(known[2]) + 1).padStart(2, '0')}-${known[1].padStart(2, '0')}`;
  return isFixtureDate(date) ? date : '';
}
function useFixtureOptions() {
  const [options, setOptions] = useState<FixtureOptions>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void fixtureApi.options(abort.signal).then(result => { if (!abort.signal.aborted) setOptions(result); }).catch(failure => {
      if (!abort.signal.aborted) setError((failure as Error).message);
    });
    return () => abort.abort();
  }, [attempt]);
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
  const selection = useFixtureOptions();
  const prior = enquiry.fixture;
  const [supplierTraderId, setSupplierTraderId] = useState(prior?.supplierTraderId ?? '');
  const [date, setDate] = useState(() => prior?.date ?? hongKongDate.format(new Date()));
  const [eta, setEta] = useState(() => prior?.eta ?? knownEnquiryEta(enquiry.eta));
  const [etaTo, setEtaTo] = useState(() => prior ? fixtureEtaTo(prior) : knownEnquiryEta(enquiry.eta));
  const [etaReviewed, setEtaReviewed] = useState(prior?.etaReviewed ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();
  const early = Boolean(eta && eta < date);
  const range = fixtureEtaRange(eta || null, etaTo);
  const valid = isFixtureDate(date) && isFixtureDate(eta) && (!early || etaReviewed) && Boolean(range)
    && selection.options?.traders.some(trader => trader.id === supplierTraderId);

  async function save() {
    if (!valid || busy || !range) return;
    setBusy(true); setError('');
    const input = { action: 'assign' as const, dataMode: 'live' as const, enquiryId: enquiry.id,
      expectedRevision: prior?.revision ?? 0, supplierTraderId, date, eta,
      ...range, etaReviewed: early && etaReviewed };
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
        <Field label="ETA FROM" hint={enquiry.eta}><input aria-label="ETA FROM" required type="date" value={eta} disabled={busy}
          onChange={event => {
            if (eta && etaTo === eta) setEtaTo(event.target.value);
            setEta(event.target.value); setEtaReviewed(false);
          }} /></Field>
        <Field label="ETA TO"><input aria-label="ETA TO" type="date" min={eta || undefined} value={etaTo} disabled={busy}
          onChange={event => setEtaTo(event.target.value)} /></Field>
      </div>
      {early && <label className="fixture-dialog__check"><input type="checkbox" checked={etaReviewed} disabled={busy}
        onChange={event => setEtaReviewed(event.target.checked)} /> CONFIRM ETA BEFORE FIXTURE DATE</label>}
      <footer className="modal-actions"><button className="ui-button ui-button--primary" disabled={!valid || busy}>{busy ? 'SAVING…' : 'SAVE'}</button></footer>
    </form>
  </Modal>;
}


export function PendingFixtureCancellation({ fixture, vessel, onClose, onSaved }: {
  fixture: FixtureAssignment; vessel: string; onClose: () => void; onSaved: (assignment: FixtureAssignment) => void;
}) {
  const reinstating = fixture.status === 'cancelled';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();
  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    const input = { dataMode: 'live' as const, id: fixture.id, expectedRevision: fixture.revision,
      action: reinstating ? 'reinstate' as const : 'cancel' as const };
    try {
      const result = await fixtureApi.changeCancellation({ ...input, requestId: submission(input) });
      if (result) onSaved(result);
    } catch (failure) {
      setError((failure as Error).message);
    } finally { setBusy(false); }
  }
  return <Modal title={reinstating ? 'REINSTATE' : 'CANCEL STEM'} onClose={() => { if (!busy) onClose(); }}>
    <form className="fixture-dialog" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>{vessel}</h3>
      {error && <p role="alert" className="record-sheet__error">{error}</p>}
      <footer className="modal-actions">
        <button type="button" className="ui-button ui-button--secondary" onClick={onClose} disabled={busy}>BACK</button>
        <button className={`ui-button ui-button--${reinstating ? 'primary' : 'danger'}`} disabled={busy}>
          {reinstating ? 'REINSTATE' : 'CONFIRM CANCELLATION'}
        </button>
      </footer>
    </form>
  </Modal>;
}
