import { useTestWorkspace } from './TestWorkspace';
import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Download, FileText, Paperclip, Send, X } from 'lucide-react';
import { useDemo } from './store';
import { actors, availableCredit, teamForActor, uid, type Company, type CreditRequest } from './lib/model';
import { activeTemporaryCredit, creditRequestType, nextCustomerId } from './lib/credit';
import { creditRequestRecipients, exactBuyerDuplicates, possibleBuyerDuplicates } from './lib/creditWorkflow';
import { CREDIT_ATTACHMENT_ACCEPT, readCreditAttachments, type CreditAttachment } from './lib/creditAttachments';
import { Field, Modal, money, time } from './ui';
import type { ModalSpec } from './types';
import './credit-forms.css';

type Close = () => void;
type Workflow = 'urgent' | 'p1';
const localDate = () => new Date().toLocaleDateString('en-CA');
const officeFor = (actor: (typeof actors)[number]) => {
  if (actor.officeId) return actor.officeName || actor.officeId;
  const team = teamForActor(actor);
  return team?.id === 'team-gianmichele' ? 'HKG' : team?.id === 'team-italy' ? 'GOA' : 'UNASSIGNED';
};

function CreditFrame({ title, close, children }: { title: string; close: Close; children: ReactNode }) {
  const { toast } = useDemo();
  return <Modal title={title} onClose={close} wide><div className="credit-form">
    {toast?.error && <div className="notice rose" role="alert"><AlertTriangle size={16} />{toast.message}</div>}
    {children}
  </div></Modal>;
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="credit-form-section"><h3>{title}</h3><div className="credit-form-section__body">{children}</div></section>;
}

function attachmentText(attachment: CreditAttachment) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(attachment.dataUrl.split(',')[1]), character => character.charCodeAt(0)));
  } catch { return ''; }
}

function AttachmentPreview({ attachment }: { attachment: CreditAttachment }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => open && attachment.mimeType.startsWith('text/') ? attachmentText(attachment) : '', [open, attachment]);
  return <details className="credit-attachment__preview" onToggle={event => setOpen(event.currentTarget.open)}><summary>Preview</summary>
    {open && (attachment.mimeType.startsWith('image/') ? <img src={attachment.dataUrl} alt={attachment.name} /> : <pre>{text}</pre>)}
  </details>;
}

/** Shared read-only attachment view; browser-local files never leave this demo. */
export function CreditAttachmentList({ attachments, onRemove }: { attachments: CreditAttachment[]; onRemove?: (id: string) => void }) {
  return <div className="credit-attachments">{attachments.map(attachment => <article className="credit-attachment" key={attachment.id}>
    <div className="credit-attachment__row"><FileText size={14} /><strong>{attachment.name}</strong><span>{Math.max(1, Math.ceil(attachment.size / 1024))} KB</span>
      <a href={attachment.dataUrl} download={attachment.name} className="credit-action" aria-label={`Download ${attachment.name}`}><Download size={13} />Download</a>
      {onRemove && <button type="button" className="credit-action" onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}><X size={13} /></button>}
    </div>
    {/^(image\/|text\/)/.test(attachment.mimeType) && <AttachmentPreview attachment={attachment} />}
  </article>)}</div>;
}

function AttachmentEditor({ attachments, onChange, setBusy }: { attachments: CreditAttachment[]; onChange: (attachments: CreditAttachment[]) => void; setBusy: (busy: boolean) => void }) {
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  return <div className="credit-attachment-editor">
    <div className="credit-attachment-picker"><label className="button secondary"><Paperclip size={13} />Add files<input type="file" multiple accept={CREDIT_ATTACHMENT_ACCEPT} disabled={reading} aria-label="Request attachments" onChange={async event => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      if (!files.length) return;
      setError(''); setReading(true); setBusy(true);
      try {
        onChange(await readCreditAttachments(files, attachments));
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to read the selected files.'); }
      finally { setReading(false); setBusy(false); }
    }} /></label><small>5 files · 512 KB each · 1.5 MB total · saved in this browser</small></div>
    {reading && <span role="status">Reading files…</span>}
    {error && <div className="notice rose" role="alert">{error}</div>}
    <CreditAttachmentList attachments={attachments} onRemove={reading ? undefined : id => onChange(attachments.filter(file => file.id !== id))} />
  </div>;
}

function RecipientList({ company }: { company: Company }) {
  const { state, actor } = useDemo();
  const recipients = creditRequestRecipients(state, actor, company);
  return <div className="credit-form-recipients"><strong>Recipients</strong><ul>{recipients.map(recipient => <li key={recipient.actorId}><span>{recipient.name}</span>{recipient.office && <small>{recipient.office}</small>}</li>)}</ul></div>;
}

export function CreditRequestForm({ spec, close }: { spec: Extract<ModalSpec, { type: 'credit' }>; close: Close }) {
  const { state, actor, run } = useDemo();
  const company = state.companies.find(item => item.id === spec.companyId)!;
  const enquiry = state.enquiries.find(item => item.id === spec.enquiryId && item.buyerId === company.id);
  const [workflow, setWorkflow] = useState<Workflow>(company.status === 'pending' ? 'p1' : 'urgent');
  const requestType: CreditRequest['type'] = workflow === 'urgent' ? 'temporary' : company.status === 'pending' ? 'new-customer' : 'increase';
  const [amounts, setAmounts] = useState({ urgent: '250000', p1: String(company.limit || 500000) });
  const amount = amounts[workflow];
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [nonPicConfirmed, setNonPicConfirmed] = useState(false);
  const [attachments, setAttachments] = useState<CreditAttachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [voyage, setVoyage] = useState({ vessel: enquiry?.vessel ?? '', imo: enquiry?.imo ?? '', portId: enquiry?.portId ?? '', portName: state.ports.find(port => port.id === enquiry?.portId)?.name ?? '', eta: enquiry?.eta ?? '' });
  const existing = state.requests.find(request => request.companyId === company.id && request.status === 'pending' && request.type === requestType);
  const notPersonInCharge = Boolean(company.personInChargeId && company.personInChargeId !== actor.id);
  const personInCharge = actors.find(person => person.id === company.personInChargeId);
  const resultingLimit = workflow === 'urgent' ? company.limit + activeTemporaryCredit(company) + Number(amount) : Number(amount);
  return <CreditFrame title="Credit request" close={close}>
    <div className="credit-form-buyer"><strong>{company.name}</strong><span>{[company.customerId, company.office, personInCharge?.name].filter(Boolean).join(' · ')}</span></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (existing || readingFiles || (notPersonInCharge && !nonPicConfirmed)) return;
      if (run({ type: 'request-credit', companyId: company.id, enquiryId: enquiry?.id, amount: Number(amount), reason, requestType, priority: workflow, workflow, amountBasis: workflow === 'urgent' ? 'additional' : 'total', nonPicConfirmed, attachments,
        ...(workflow === 'urgent' ? { voyage, expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : '' } : {}),
      }, 'Credit request submitted.')) close();
    }}>
      <div className="credit-workflow-tabs" role="group" aria-label="Request type"><button type="button" aria-pressed={workflow === 'urgent'} disabled={company.status === 'pending'} onClick={() => setWorkflow('urgent')}>URGENT <span>Additional overage</span></button><button type="button" aria-pressed={workflow === 'p1'} onClick={() => setWorkflow('p1')}>P1 <span>Total credit limit</span></button></div>
      <div className="credit-form-metrics"><div><span>Approved credit</span><strong>{money(company.limit)}</strong></div><div><span>Available</span><strong>{money(availableCredit(company))}</strong></div></div>
      {existing ? <div className="notice amber" role="status">{creditRequestType(existing.type)} · {money(existing.amount)} · {existing.acknowledgedAt ? 'Acknowledged' : 'Awaiting decision'}</div> : <>
        <FormSection title={workflow === 'urgent' ? 'URGENT · One-off overage' : 'P1 · Permanent credit limit'}>
          <div className="form-grid"><Field label={workflow === 'urgent' ? 'Additional overage requested (USD)' : 'Expected total credit limit (USD)'}><input type="number" min="0.01" step="0.01" required value={amount} onChange={event => setAmounts(current => ({ ...current, [workflow]: event.target.value }))} /></Field>{workflow === 'urgent' && <Field label="Expiry date"><input type="date" required min={localDate()} value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></Field>}</div>
          <div className="credit-form-calculation"><span>{workflow === 'urgent' ? 'Limit with this overage' : 'New permanent limit'}</span><strong>{money(resultingLimit)}</strong>{workflow === 'p1' && <><span>Change</span><strong>{Number(amount) >= company.limit ? '+' : '−'}{money(Math.abs(Number(amount) - company.limit))}</strong></>}</div>
          <Field label="Reason"><textarea required rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field>
        </FormSection>
        {workflow === 'urgent' && <FormSection title="Voyage"><div className="form-grid">
          <Field label="Vessel"><input required value={voyage.vessel} onChange={event => setVoyage(current => ({ ...current, vessel: event.target.value }))} /></Field>
          <Field label="IMO"><input required inputMode="numeric" pattern="[0-9]{7}" maxLength={7} value={voyage.imo} onChange={event => setVoyage(current => ({ ...current, imo: event.target.value }))} /></Field>
          <Field label="Port"><input required list="credit-voyage-ports" value={voyage.portName} onChange={event => { const portName = event.target.value; const matched = state.ports.find(port => port.name.toUpperCase() === portName.toUpperCase()); setVoyage(current => ({ ...current, portName, portId: matched?.id ?? '' })); }} /><datalist id="credit-voyage-ports">{state.ports.map(port => <option value={port.name} key={port.id} />)}</datalist></Field>
          <Field label="ETA"><input required value={voyage.eta} onChange={event => setVoyage(current => ({ ...current, eta: event.target.value }))} /></Field>
        </div></FormSection>}
        <FormSection title="Supporting documents"><AttachmentEditor attachments={attachments} onChange={setAttachments} setBusy={setReadingFiles} /></FormSection>
        <FormSection title="Trader information"><dl className="credit-form-identity"><div><dt>Requested by</dt><dd>{actor.name}</dd></div><div><dt>Office</dt><dd>{officeFor(actor)}</dd></div><div><dt>Person in charge</dt><dd>{personInCharge?.name ?? 'Unassigned'}</dd></div><div><dt>Buyer office</dt><dd>{company.office ?? 'Unassigned'}</dd></div></dl>
          {notPersonInCharge && <label className="check-label credit-form-warning"><input type="checkbox" checked={nonPicConfirmed} onChange={event => setNonPicConfirmed(event.target.checked)} required /><span>I am not the person in charge. Proceed with this request.</span></label>}
          <RecipientList company={company} />
        </FormSection>
      </>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={Boolean(existing) || readingFiles || (notPersonInCharge && !nonPicConfirmed)}><Send size={14} />Submit request</button></div>
    </form>
  </CreditFrame>;
}

export function DecisionForm({ id, close }: { id: string; close: Close }) {
  const { state, run } = useDemo();
  const request = state.requests.find(item => item.id === id)!;
  const company = state.companies.find(item => item.id === request.companyId)!;
  const [amount, setAmount] = useState(String(request.amount));
  const [terms, setTerms] = useState(company.status === 'pending' ? '30 days' : company.terms);
  const [note, setNote] = useState('');
  const [approve, setApprove] = useState(true);
  const [expiresAt, setExpiresAt] = useState(request.expiresAt ? new Date(request.expiresAt).toLocaleDateString('en-CA') : '');
  const isTemporary = request.type === 'temporary';
  const isTotal = request.amountBasis === 'total' || request.type === 'new-customer';
  const resultingLimit = isTotal ? Number(amount) : company.limit + Number(amount);
  const requestLabel = request.workflow === 'p1' ? 'P1 · Expected total credit limit' : request.workflow === 'urgent' ? 'URGENT · Additional overage' : `${creditRequestType(request.type)} · ${isTotal ? 'Total limit' : 'Additional credit'}`;
  return <CreditFrame title="Credit decision" close={close}>
    <div className="credit-form-buyer"><strong>{company.name}</strong><span>{requestLabel} · {money(request.amount)}</span></div>
    <div className="credit-form-request"><p>{request.reason}</p><small>{actors.find(actor => actor.id === request.requestedBy)?.name ?? request.requestedBy} · {time(request.requestedAt)}</small></div>
    {request.voyage && <FormSection title="Voyage"><dl className="credit-form-identity"><div><dt>Vessel</dt><dd>{request.voyage.vessel}</dd></div><div><dt>IMO</dt><dd>{request.voyage.imo}</dd></div><div><dt>Port</dt><dd>{request.voyage.portName}</dd></div><div><dt>ETA</dt><dd>{request.voyage.eta}</dd></div></dl></FormSection>}
    {!!request.attachments?.length && <FormSection title="Supporting documents"><CreditAttachmentList attachments={request.attachments} /></FormSection>}
    <form onSubmit={event => { event.preventDefault(); if (run({ type: 'decide-credit', id, approve, amount: approve ? Number(amount) : 0, terms, note, ...(approve && isTemporary ? { expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : '' } : {}) }, approve ? 'Credit decision recorded.' : 'Credit request declined.')) close(); }}>
      <div className="segmented"><button type="button" className={approve ? 'active' : ''} onClick={() => setApprove(true)}><Check size={14} />Approve</button><button type="button" className={!approve ? 'active danger' : ''} onClick={() => setApprove(false)}>Decline</button></div>
      {approve && <><div className="form-grid"><Field label={isTemporary ? 'Approved additional overage (USD)' : isTotal ? 'Approved total credit limit (USD)' : 'Approved increase (USD)'}><input type="number" min="0.01" step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} /></Field><Field label="Payment terms"><select value={terms} onChange={event => setTerms(event.target.value)}>{['Prepayment', '7 days', '14 days', '21 days', '30 days', '45 days', '60 days'].map(value => <option key={value}>{value}</option>)}</select></Field>{isTemporary && <Field label="Expiry date"><input type="date" required min={localDate()} value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></Field>}</div>
        <div className="credit-form-metrics"><div><span>{isTemporary ? 'Permanent limit' : 'Resulting permanent limit'}</span><strong>{money(isTemporary ? company.limit : resultingLimit)}</strong></div><div><span>Available after decision</span><strong>{money(resultingLimit + activeTemporaryCredit(company) - company.exposure)}</strong></div></div></>}
      <Field label={approve ? 'Conditions / Decision remarks' : 'Reason for declining'}><textarea required rows={3} value={note} onChange={event => setNote(event.target.value)} /></Field>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button type="submit" className={`button ${approve ? 'primary' : 'danger'}`}>{approve ? 'Approve credit' : 'Record decline'}</button></div>
    </form>
  </CreditFrame>;
}

export function CompanyForm({ name, close }: { name?: string; close: Close }) {
  const { dataMode } = useTestWorkspace();
  const { state, actor, run } = useDemo();
  const customerId = nextCustomerId(state.companies);
  const office = officeFor(actor);
  const [form, setForm] = useState({ name: name || '', sellingEntity: dataMode === 'test' ? 'ECOSYSTEM Marine Energy (Demo)' : '', country: '', city: '', contact: '', email: '', limit: '500000', reason: '' });
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);
  const [attachments, setAttachments] = useState<CreditAttachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const duplicates = possibleBuyerDuplicates(state.companies, form.name);
  const exactDuplicate = exactBuyerDuplicates(state.companies, form.name).length > 0;
  const change = (key: keyof typeof form, value: string) => { setForm(current => ({ ...current, [key]: value })); if (key === 'name') setDuplicateConfirmed(false); };
  const company: Company = { id: 'new-lead', name: form.name, customerId, personInChargeId: actor.id, office, aliases: [], country: form.country, city: form.city, contact: form.contact, email: form.email, status: 'pending', limit: 0, exposure: 0, overdue: 0, terms: 'Pending review', reviewDate: new Date().toISOString().slice(0, 10), sellingEntity: form.sellingEntity, notes: form.reason };
  return <CreditFrame title="New lead" close={close}><form onSubmit={event => {
    event.preventDefault();
    if (readingFiles || exactDuplicate || (duplicates.length && !duplicateConfirmed)) return;
    if (run({ type: 'add-company', company: { ...company, id: uid('company') }, requestedLimit: Number(form.limit), reason: form.reason, workflow: 'p1', attachments, duplicateConfirmed }, 'Lead created. Initial credit request submitted.')) close();
  }}>
    <FormSection title="Company identity"><div className="form-grid"><Field label="Customer ID"><input readOnly value={customerId} /></Field><Field label="Status"><input readOnly value="LEAD · PENDING CREDIT" /></Field></div>
      <Field label="Legal company name"><input required value={form.name} onChange={event => change('name', event.target.value)} /></Field>
      <Field label="Selling entity"><input required value={form.sellingEntity} onChange={event => change('sellingEntity', event.target.value)} /></Field>
      {!!duplicates.length && <div className="credit-form-duplicates" role="status"><strong>{exactDuplicate ? 'An existing buyer / lead uses this name or alias' : 'Possible existing buyers / leads'}</strong><ul>{duplicates.map(buyer => <li key={buyer.id}><strong>{buyer.name}</strong><span>{[buyer.customerId, buyer.country, buyer.office].filter(Boolean).join(' · ')}</span></li>)}</ul>{!exactDuplicate && <label className="check-label"><input type="checkbox" checked={duplicateConfirmed} onChange={event => setDuplicateConfirmed(event.target.checked)} required /><span>This is a separate legal entity.</span></label>}</div>}
      <div className="form-grid"><Field label="Country"><input required value={form.country} onChange={event => change('country', event.target.value)} /></Field><Field label="City"><input value={form.city} onChange={event => change('city', event.target.value)} /></Field><Field label="Contact name"><input value={form.contact} onChange={event => change('contact', event.target.value)} /></Field><Field label="Contact email"><input type="email" value={form.email} onChange={event => change('email', event.target.value)} /></Field></div>
    </FormSection>
    <FormSection title="P1 · Initial credit request"><Field label="Expected total credit limit (USD)"><input required type="number" min="0.01" step="0.01" value={form.limit} onChange={event => change('limit', event.target.value)} /></Field><Field label="Reason"><textarea required rows={3} value={form.reason} onChange={event => change('reason', event.target.value)} /></Field><AttachmentEditor attachments={attachments} onChange={setAttachments} setBusy={setReadingFiles} /></FormSection>
    <FormSection title="Account ownership"><dl className="credit-form-identity"><div><dt>Person in charge</dt><dd>{actor.name}</dd></div><div><dt>Office</dt><dd>{office}</dd></div></dl><RecipientList company={company} /></FormSection>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={readingFiles || exactDuplicate || Boolean(duplicates.length && !duplicateConfirmed)}>Create lead & request credit</button></div>
  </form></CreditFrame>;
}
