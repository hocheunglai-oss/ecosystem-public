import { useState } from 'react';
import { buyerLostReasons, type BuyerLostReason, type CommercialEnquiry, type CommercialEnquiryDecision, type CommercialEnquirySummary } from '../shared/commercialEnquiries';
import { useSubmission } from './FixtureDialogs';
import { commercialEnquiryApi } from './lib/commercialEnquiryApi';
import { Field, Modal } from './ui';

export function EnquiryDecisionDialog({ enquiry, action, onClose, onSaved }: {
  enquiry: CommercialEnquirySummary;
  action: CommercialEnquiryDecision['action'];
  onClose: () => void;
  onSaved: (item: CommercialEnquiry) => void;
}) {
  const [reason, setReason] = useState<BuyerLostReason | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useSubmission();
  const label = action === 'cancel' ? 'CANCEL ENQUIRY' : action === 'postpone' ? 'POSTPONE ENQUIRY' : 'LOST ENQUIRY';

  async function decide() {
    if (busy || (action === 'lost' && !reason)) return;
    const common = { dataMode: 'live' as const, id: enquiry.id, expectedRevision: enquiry.revision };
    const decision = action === 'lost' && reason ? { ...common, action, lostReason: reason } as const
      : { ...common, action: action as 'cancel' | 'postpone' };
    setBusy(true); setError('');
    try {
      const result = await commercialEnquiryApi.mutate(enquiry.ownerId, { ...decision, requestId: submission(decision) });
      onSaved(result.item);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Enquiry could not be updated.');
    } finally { setBusy(false); }
  }

  return <Modal title={label} onClose={() => { if (!busy) onClose(); }}>
    <form className="fixture-dialog" onSubmit={event => { event.preventDefault(); void decide(); }}>
      <h3>{enquiry.vessel || 'ENQUIRY'}</h3>
      {action === 'lost' && <Field label="LOST REASON">
        <select required value={reason} disabled={busy} onChange={event => setReason(event.target.value as BuyerLostReason)}>
          <option value="">SELECT LOST REASON</option>
          {buyerLostReasons.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </Field>}
      {error && <p role="alert">{error}</p>}
      <footer className="modal-actions">
        <button className={'ui-button ' + (action === 'cancel' ? 'ui-button--destructive' : 'ui-button--primary')}
          disabled={busy || action === 'lost' && !reason}>{busy ? 'SAVING…' : action === 'lost' ? 'SAVE' : label}</button>
      </footer>
    </form>
  </Modal>;
}
