import { Fragment, useEffect, useMemo, useState } from 'react';
import AttachmentsButton from './AttachmentsButton';
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Download, Plus, Search } from 'lucide-react';
import { useDemo } from './store';
import { actors, availableCredit, canTrade, teamForActor, type CreditRequest } from './lib/model';
import { creditHistoryFor, creditRequestStage, creditRequestType } from './lib/credit';
import { creditAttentionRequestIds } from './lib/creditWorkflow';
import { date, money } from './ui';
import type { OpenModal } from './types';
import type { OpenWorkspace } from './workspaceNavigation';
import './credit-records.css';

const PAGE_SIZE = 15;
const person = (id?: string) => actors.find(actor => actor.id === id)?.name ?? id ?? '—';
const stamp = (value?: string) => value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
function RecordStamp({ value }: { value?: string }) { return value ? <>{date(value)}<small>{new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></> : <>—</>; }
const shortId = (id: string) => id.startsWith('credit-') ? id.slice(7, 15) : id;
const requestLabel = (request: CreditRequest) => request.requestNumber ?? shortId(request.id);
const matches = (query: string, values: unknown[]) => values.filter(value => value !== undefined && value !== null).join(' ').toLowerCase().includes(query.trim().toLowerCase());
const amountLabel = (request: CreditRequest) => request.amountBasis === 'total' ? 'Expected total limit' : request.type === 'new-customer' ? 'Initial credit limit' : request.type === 'temporary' ? 'Additional overage' : 'Additional credit';
const historyType = (type: string) => ({ temporary: 'One-off overage', limit: 'Credit limit', terms: 'Payment terms', status: 'Credit status', remark: 'Credit remark' }[type] ?? type);
const validDownload = (dataUrl: string) => /^data:(?:application\/(?:pdf|octet-stream|msword|vnd\.[\w.+-]+)|text\/(?:plain|csv)|image\/(?:png|jpeg|webp));base64,[a-z\d+/=\s]+$/i.test(dataUrl);

function Pager({ page, count, setPage }: { page: number; count: number; setPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return <div className="credit-record-pager"><span>{count ? page * PAGE_SIZE + 1 : 0}–{Math.min(count, (page + 1) * PAGE_SIZE)} / {count}</span><button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={13} /></button><button type="button" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={13} /></button></div>;
}

export function CreditHistoryTable({ buyerId, initialType = 'all' }: { buyerId?: string; initialType?: string }) {
  const { state, actor, run } = useDemo();
  const [query, setQuery] = useState('');
  const [type, setType] = useState(initialType);
  const [page, setPage] = useState(0);
  useEffect(() => { setType(initialType); setPage(0); }, [initialType, buyerId]);
  const canEdit = actor.role === 'credit' || actor.role === 'admin';
  const remarksOnly = type === 'remark';
  const companies = useMemo(() => new Map(state.companies.map(buyer => [buyer.id, buyer])), [state.companies]);
  const requestNumbers = useMemo(() => new Map(state.requests.map(request => [request.id, request.requestNumber])), [state.requests]);
  const records = useMemo(() => creditHistoryFor(state, buyerId).filter(entry => (type === 'all' || entry.type === type) && matches(query, [companies.get(entry.companyId)?.name, companies.get(entry.companyId)?.customerId, entry.summary, entry.type, entry.requestId, entry.requestId && requestNumbers.get(entry.requestId), person(entry.by), entry.effectiveAt])), [state, buyerId, type, query, companies, requestNumbers]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(records.length / PAGE_SIZE) - 1));
  return <section className="credit-record-panel" aria-label="Credit history">
    <header className="credit-record-heading"><h3>Credit History</h3><Pager page={currentPage} count={records.length} setPage={setPage} /></header>
    <div className="credit-record-toolbar"><label className="credit-record-search"><Search size={13} /><input aria-label="Search credit history" placeholder="Search credit history" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><select aria-label="Credit history type" value={type} onChange={event => { setType(event.target.value); setPage(0); }}><option value="all">All types</option><option value="limit">Credit limit</option><option value="terms">Payment terms</option><option value="temporary">One-off overage</option><option value="status">Credit status</option><option value="remark">Credit remarks</option></select></div>
    <div className="credit-record-scroll"><table className="credit-record-table"><thead><tr><th>Effective date</th>{!buyerId && <th>Buyer / ID</th>}<th>Type</th>{!remarksOnly && <><th className="numeric">Previous</th><th className="numeric">Approved (USD)</th><th>Payment terms</th></>}<th>Details</th>{!remarksOnly && <th>Expiry</th>}<th>Recorded by / date</th>{!remarksOnly && <th>Request ID</th>}</tr></thead><tbody>
      {records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(entry => {
        const active = entry.type === 'remark' && companies.get(entry.companyId)?.activeCreditRemarkId === entry.id;
        return <tr key={entry.id} className={active ? 'credit-record-active-remark' : undefined}><td>{entry.effectiveDateUnknown ? '—' : date(entry.effectiveAt)}</td>{!buyerId && <td className="credit-record-buyer"><strong>{companies.get(entry.companyId)?.name ?? entry.companyId}</strong><small>{companies.get(entry.companyId)?.customerId}</small></td>}<td>{historyType(entry.type)}{active && <span className="credit-active-remark">Active remark</span>}</td>{!remarksOnly && <><td className="numeric">{entry.type === 'temporary' || entry.type === 'remark' ? '—' : entry.previousLimit !== undefined ? money(entry.previousLimit) : '—'}</td><td className="numeric">{entry.type !== 'remark' && entry.limit !== undefined ? money(entry.limit) : '—'}</td><td>{entry.type === 'remark' ? '—' : entry.terms || '—'}</td></>}<td className="credit-record-note">{entry.summary || (entry.type === 'remark' ? 'Cleared' : '—')}{entry.type === 'remark' && !active && canEdit && <button type="button" className="credit-action credit-set-active" onClick={() => run({ type: 'set-active-credit-remark', buyerId: entry.companyId, historyId: entry.id }, 'Active Credit Remark updated.')}>Set as active remark</button>}</td>{!remarksOnly && <td><RecordStamp value={entry.expiresAt} /></td>}<td>{person(entry.by)}<small>{date(entry.recordedAt)}</small></td>{!remarksOnly && <td>{entry.requestId ? requestNumbers.get(entry.requestId) ?? shortId(entry.requestId) : '—'}</td>}</tr>;
      })}
      {!records.length && <tr><td colSpan={remarksOnly ? (buyerId ? 4 : 5) : (buyerId ? 9 : 10)} className="credit-record-empty">No credit history</td></tr>}
    </tbody></table></div>
  </section>;
}

function CreditRequestDetails({ request, open }: { request: CreditRequest; open: OpenModal }) {
  const { state, actor } = useDemo();
  const enquiry = state.enquiries.find(item => item.id === request.enquiryId);
  const voyage = request.voyage;
  const notifications = (state.creditNotifications ?? []).filter(item => item.requestId === request.id && item.recipientId === actor.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const attachments = request.attachments ?? [];
  return <div className="credit-detail-grid">
    <div className="credit-detail-documents"><AttachmentsButton scope={{ target: { kind: 'credit', id: request.companyId }, section: { id: request.id, name: requestLabel(request) } }} /></div>
    {voyage && <div><span>Voyage</span><p><strong>{voyage.vessel}</strong>{voyage.imo && <> · IMO {voyage.imo}</>}<br/>{voyage.portName} · {voyage.eta}</p></div>}
    {enquiry && <div><span>Linked enquiry</span><p><button type="button" className="credit-buyer-link" onClick={() => open({ type: 'enquiry-detail', id: enquiry.id })}>{enquiry.vessel} · IMO {enquiry.imo || '—'} <ArrowUpRight size={11} /></button>{state.ports.find(port => port.id === enquiry.portId)?.name} · {enquiry.eta}</p></div>}
    <div><span>{amountLabel(request)} (USD)</span><p>{money(request.amount)}</p></div>
    <div><span>Request reason</span><p>{request.reason}</p></div>
    {request.expiresAt && <div><span>Requested expiry</span><p>{stamp(request.expiresAt)}</p></div>}
    {request.acknowledgedAt && <div><span>Acknowledged by</span><p>{person(request.acknowledgedBy)} · {stamp(request.acknowledgedAt)}</p></div>}
    {request.decision && <><div><span>Decision</span><p>{request.decision.note}</p></div><div><span>{request.amountBasis === 'total' ? 'Approved total limit / Terms' : request.type === 'new-customer' ? 'Approved initial limit / Terms' : 'Approved additional credit / Terms'}</span><p>{money(request.decision.amount)} · {request.decision.terms || '—'}{request.decision.expiresAt && <> · {stamp(request.decision.expiresAt)}</>}</p></div>{request.decision.resultingLimit !== undefined && <div><span>Resulting permanent limit</span><p>{money(request.decision.resultingLimit)}</p></div>}<div><span>Decision by / date</span><p>{person(request.decision.by)} · {stamp(request.decision.at)}</p></div></>}
    {attachments.length > 0 && <div className="credit-detail-documents"><span>Request attachments</span><ul>{attachments.map(file => <li key={file.id}>{validDownload(file.dataUrl) ? <a href={file.dataUrl} download={file.name}><Download size={12}/>{file.name}</a> : <strong>{file.name}</strong>}<small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small></li>)}</ul></div>}
    {request.recipients?.length ? <div><span>Notification recipients</span><ul className="credit-recipient-list">{request.recipients.map(recipient => <li key={recipient.actorId}><strong>{recipient.name}</strong>{recipient.office && <> · {recipient.office}</>}<small>{recipient.reasons.map(reason => ({ requester: 'Requestor', 'requester-office': 'Requestor office', 'pic-office': 'Person in charge office', credit: 'Credit' }[reason])).join(' / ')}</small></li>)}</ul></div> : null}
    {notifications.length > 0 && <div><span>Your notifications</span><ul className="credit-event-list">{notifications.map(event => <li key={event.id}><strong>{event.kind}</strong><span>{stamp(event.createdAt)}</span><small>{event.readAt ? `Read ${stamp(event.readAt)}` : 'Unread'}</small></li>)}</ul></div>}
  </div>;
}

export function CreditRequestsTable({ buyerId, open, onOpen, initialAttentionOnly = false, navigationContext }: { buyerId?: string; open: OpenModal; onOpen?: OpenWorkspace; initialAttentionOnly?: boolean; navigationContext?: object }) {
  const { state, actor, run } = useDemo();
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(initialAttentionOnly);
  useEffect(() => { setAttentionOnly(initialAttentionOnly); setExpanded(null); setPage(0); setStage('all'); setQuery(''); }, [initialAttentionOnly, buyerId, navigationContext]);
  const review = actor.role === 'credit' || actor.role === 'admin';
  const companies = useMemo(() => new Map(state.companies.map(buyer => [buyer.id, buyer])), [state.companies]);
  const attentionIds = useMemo(() => new Set(creditAttentionRequestIds(state, actor)), [state, actor]);
  const attentionCount = state.requests.filter(request => (!buyerId || request.companyId === buyerId) && attentionIds.has(request.id)).length;
  const records = useMemo(() => state.requests.filter(request => (!buyerId || request.companyId === buyerId) && (!attentionOnly || attentionIds.has(request.id) || expanded === request.id) && (stage === 'all' || (stage === 'pending' ? request.status === 'pending' : creditRequestStage(request).toLowerCase() === stage)) && matches(query, [request.id, request.requestNumber, companies.get(request.companyId)?.name, companies.get(request.companyId)?.customerId, companies.get(request.companyId)?.accountGroupName, person(request.requestedBy), request.requestedOffice, request.priority, request.workflow, request.voyage?.vessel, request.voyage?.imo, request.voyage?.portName, request.reason, request.decision?.note, creditRequestType(request.type), creditRequestStage(request)])).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)), [state.requests, buyerId, attentionOnly, attentionIds, expanded, stage, query, companies]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(records.length / PAGE_SIZE) - 1));
  function toggleDetails(request: CreditRequest) {
    if (expanded === request.id) { setExpanded(null); return; }
    setExpanded(request.id);
    if (state.creditNotifications?.some(item => item.requestId === request.id && item.recipientId === actor.id && !item.readAt)) run({ type: 'mark-credit-request-read', id: request.id });
  }
  function actions(request: CreditRequest) {
    return review && request.status === 'pending' ? <div className="credit-record-actions">{!request.acknowledgedAt && <button type="button" onClick={() => run({ type: 'acknowledge-credit', id: request.id }, 'Request acknowledged.')}>Acknowledge</button>}<button type="button" onClick={() => open({ type: 'decision', id: request.id })}>Decision <ArrowUpRight size={11} /></button></div> : null;
  }
  return <section className="credit-record-panel" aria-label="Credit requests">
    <header className="credit-record-heading"><h3>Credit Requests</h3><AttachmentsButton scope={{ target: { kind: 'credit', id: buyerId ?? '' } }} /><Pager page={currentPage} count={records.length} setPage={setPage} /></header>
    <div className="credit-record-toolbar"><label className="credit-record-search"><Search size={13} /><input aria-label="Search credit requests" placeholder="Search buyer, ID, vessel or request" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><select aria-label="Credit request stage" value={stage} onChange={event => { setStage(event.target.value); setPage(0); }}><option value="all">All stages</option><option value="pending">Open requests</option><option value="requested">Requested</option><option value="acknowledged">Acknowledged</option><option value="approved">Approved</option><option value="declined">Declined</option></select><button type="button" className="credit-attention-filter" aria-pressed={attentionOnly} onClick={() => { setAttentionOnly(value => !value); setExpanded(null); setPage(0); }}>Needs attention{attentionCount > 0 && <b>{attentionCount}</b>}</button></div>
    <div className="credit-record-scroll"><table className="credit-record-table"><thead><tr><th>ID</th>{!buyerId && <th>Buyer / ID</th>}<th>Group</th><th>Type</th><th className="numeric">Requested (USD)</th><th>Requestor</th><th>Stage</th><th>Requested</th><th>Acknowledged</th><th>Closed</th><th>Actions</th></tr></thead><tbody>
      {records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(request => { const buyer = companies.get(request.companyId); return <Fragment key={request.id}>
        <tr className={expanded === request.id ? 'credit-record-selected' : ''}><td><button className="credit-record-expand" type="button" aria-expanded={expanded === request.id} aria-label={`Request ${requestLabel(request)} details`} onClick={() => toggleDetails(request)}><ChevronDown size={12} />{requestLabel(request)}</button></td>{!buyerId && <td className="credit-record-buyer">{onOpen ? <button type="button" className="credit-buyer-link" onClick={() => onOpen('counterparties', { buyerId: request.companyId })}>{buyer?.name ?? request.companyId}</button> : <strong>{buyer?.name ?? request.companyId}</strong>}<small>{buyer?.customerId}</small></td>}<td className="credit-record-group">{buyer?.accountGroupName || '—'}</td><td>{request.workflow && <strong className="credit-workflow-label">{request.workflow}</strong>}{creditRequestType(request.type)}</td><td className="numeric">{money(request.amount)}<small>{amountLabel(request)}</small></td><td>{person(request.requestedBy)}<small>{request.requestedOffice ?? teamForActor(request.requestedBy)?.name}</small></td><td><span className={`credit-stage ${request.status}`}>{creditRequestStage(request)}</span>{!request.workflow && request.priority && request.priority !== 'normal' && <small className="credit-priority">{request.priority}</small>}</td><td><RecordStamp value={request.requestedAt} /></td><td><RecordStamp value={request.acknowledgedAt} /></td><td><RecordStamp value={request.closedAt ?? request.decision?.at} /></td><td>{actions(request)}</td></tr>
        {expanded === request.id && <tr className="credit-record-detail"><td colSpan={buyerId ? 10 : 11}><CreditRequestDetails request={request} open={open}/></td></tr>}
      </Fragment>; })}
      {!records.length && <tr><td colSpan={buyerId ? 10 : 11} className="credit-record-empty">No credit requests</td></tr>}
    </tbody></table></div>
  </section>;
}

export function CreditWorkspace({ open, onOpen, initialAttentionOnly = false, navigationContext }: { open: OpenModal; onOpen: OpenWorkspace; initialAttentionOnly?: boolean; navigationContext?: object }) {
  const { state, actor } = useDemo();
  const [companyId, setCompanyId] = useState(state.companies[0]?.id ?? '');
  const buyer = state.companies.find(company => company.id === companyId);
  return <div className="credit-workspace"><header className="credit-workspace-heading"><nav aria-label="Credit navigation"><button type="button" className="credit-action" onClick={() => onOpen('counterparties')}>Buyer Profiles <ArrowUpRight size={12} /></button></nav></header>
    {canTrade(actor) && <div className="credit-compose-row"><select aria-label="Credit request buyer" value={companyId} onChange={event => setCompanyId(event.target.value)}>{state.companies.map(company => <option key={company.id} value={company.id}>{company.name}{company.customerId ? ` · ${company.customerId}` : ''}</option>)}</select>{buyer && <><span>Available <strong>{money(availableCredit(buyer))}</strong></span><button type="button" className="credit-action" onClick={() => open({ type: 'credit', companyId })}><Plus size={13} />Credit request</button></>}</div>}
    <CreditRequestsTable open={open} onOpen={onOpen} initialAttentionOnly={initialAttentionOnly} navigationContext={navigationContext}/>
  </div>;
}
