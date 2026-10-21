import { isAccessActor } from './accessActor';
import { actors, teamForActor, type Actor, type Company, type DemoState } from './model';
import type { CreditAttachment } from './creditAttachments';

export type CreditWorkflow = 'urgent' | 'p1';
export interface CreditVoyage { vessel: string; imo: string; portId?: string; portName: string; eta: string }
export interface CreditRecipient { actorId: string; name: string; office?: string; reasons: ('requester' | 'requester-office' | 'pic-office' | 'credit')[] }
export interface CreditNotification { id: string; requestId: string; recipientId: string; kind: 'requested' | 'acknowledged' | 'approved' | 'declined'; createdAt: string; readAt?: string }
export interface CreditRequestInputFields {
  workflow?: CreditWorkflow;
  amountBasis?: 'additional' | 'total';
  voyage?: CreditVoyage;
  attachments?: CreditAttachment[];
  nonPicConfirmed?: boolean;
}

export function companyLifecycle(company: Company): 'lead' | 'buyer' { return company.lifecycle ?? (company.status === 'approved' ? 'buyer' : 'lead'); }

export function creditRequestRecipients(_state: DemoState, requester: Actor, company: Company): CreditRecipient[] {
  const recipients = new Map<string, CreditRecipient>();
  const add = (id: string, reason: CreditRecipient['reasons'][number], office?: string) => {
    const actor = id === requester.id ? requester : actors.find(item => item.id === id);
    if (!actor) return;
    const record = recipients.get(id) ?? { actorId: id, name: actor.name, office: office ?? teamForActor(id)?.name, reasons: [] };
    if (!record.reasons.includes(reason)) record.reasons.push(reason);
    recipients.set(id, record);
  };
  add(requester.id, 'requester', teamForActor(requester)?.name);
  // Live routing must come from a real directory/integration, never fictional fixture IDs.
  if (isAccessActor(requester) && !_state.demoScenarioVersion) return [...recipients.values()];
  for (const member of teamForActor(requester)?.memberIds ?? []) add(member, 'requester-office');
  const pic = company.personInChargeId;
  if (pic) {
    add(pic, 'pic-office', company.office);
    for (const member of teamForActor(pic)?.memberIds ?? []) add(member, 'pic-office', company.office);
  }
  for (const actor of actors.filter(item => item.role === 'credit' || item.role === 'admin')) add(actor.id, 'credit');
  return [...recipients.values()];
}

export function creditAttentionRequestIds(state: DemoState, actor: Actor): string[] {
  const visible = new Set(state.requests.map(request => request.id));
  const attention = new Set<string>();
  if (actor.role === 'credit' || actor.role === 'admin') return state.requests.filter(request => request.status === 'pending').map(request => request.id);
  for (const notification of state.creditNotifications ?? []) if (notification.recipientId === actor.id && !notification.readAt && visible.has(notification.requestId)) attention.add(notification.requestId);
  return [...attention];
}

export function buyerNameKey(name: string): string { return name.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/&/g, 'AND').replace(/[^\p{L}\p{N}]/gu, ''); }
function legalNameKey(name: string): string {
  return buyerNameKey(name.toUpperCase().replace(/\b(?:PTE|PTY|LTD|LIMITED|INC|INCORPORATED|CORPORATION|CORP|CO|COMPANY|SA|AS|BV|KK|LLC|PLC|GMBH)\b/g, ''));
}
export function exactBuyerDuplicates(companies: Company[], name: string, aliases: string[] = [], excludeId?: string): Company[] {
  const keys = new Set([name, ...aliases].map(buyerNameKey).filter(Boolean));
  return companies.filter(company => company.id !== excludeId && [company.name, ...company.aliases].some(candidate => keys.has(buyerNameKey(candidate))));
}
export function possibleBuyerDuplicates(companies: Company[], name: string, aliases: string[] = [], excludeId?: string): Company[] {
  const values = [name, ...aliases].map(legalNameKey).filter(key => key.length >= 5);
  const exact = new Set(exactBuyerDuplicates(companies, name, aliases, excludeId).map(company => company.id));
  return companies.filter(company => company.id !== excludeId && (exact.has(company.id) || [company.name, ...company.aliases].map(legalNameKey).some(candidate => candidate.length >= 5 && values.some(value => candidate === value || candidate.startsWith(value) || value.startsWith(candidate)))));
}
