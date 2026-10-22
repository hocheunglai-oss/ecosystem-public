import type { Company, CreditRequest, DemoState } from './model.ts';

export interface TemporaryCredit {
  id: string;
  requestId: string;
  amount: number;
  startsAt: string;
  expiresAt: string;
  approvedBy: string;
  terms?: string;
}

export interface CreditHistoryEntry {
  id: string;
  companyId: string;
  effectiveAt: string;
  recordedAt: string;
  by: string;
  type: 'limit' | 'terms' | 'temporary' | 'status' | 'remark';
  summary: string;
  previousLimit?: number;
  limit?: number;
  terms?: string;
  requestId?: string;
  expiresAt?: string;
  effectiveDateUnknown?: boolean;
}

export function activeTemporaryCredit(company: Company, at: string | Date = new Date()): number {
  const timestamp = new Date(at).getTime();
  return Math.round((company.temporaryCredits ?? []).reduce((total, facility) =>
    new Date(facility.startsAt).getTime() <= timestamp && timestamp < new Date(facility.expiresAt).getTime()
      ? total + facility.amount : total, 0) * 100) / 100;
}

export function effectiveCreditLimit(company: Company, at: string | Date = new Date()): number {
  return Math.round((company.limit + activeTemporaryCredit(company, at)) * 100) / 100;
}

export function companyTradingBlockedReason(company: Company): string | undefined {
  if (company.status !== 'approved') return 'Credit must approve this customer before STEM.';
  if (company.creditStatus && company.creditStatus !== 'Active') return `Buyer credit is ${company.creditStatus.toLowerCase()}. Contact Credit before STEM.`;
  return undefined;
}

export function creditRequestType(type: CreditRequest['type']): string {
  return type === 'temporary' ? 'One-off overage' : type === 'new-customer' ? 'Initial credit' : 'Limit increase';
}

export function creditRequestStage(request: CreditRequest): string {
  return request.status !== 'pending' ? request.status : request.acknowledgedAt ? 'Acknowledged' : 'Requested';
}

/** Keep imported credit events distinct from requests; include legacy approved decisions once. */
export function creditHistoryFor(state: DemoState, buyerId?: string): CreditHistoryEntry[] {
  const recorded = (state.creditHistory ?? []).filter(entry => !buyerId || entry.companyId === buyerId);
  const linked = new Set(recorded.flatMap(entry => entry.requestId ? [entry.requestId] : []));
  const legacy = state.requests.filter(request => (!buyerId || request.companyId === buyerId) && request.status === 'approved' && request.decision && !linked.has(request.id)).map(request => ({
    id: `decision:${request.id}`, companyId: request.companyId,
    effectiveAt: request.decision!.at, recordedAt: request.decision!.at, by: request.decision!.by,
    type: request.type === 'temporary' ? 'temporary' as const : 'limit' as const,
    summary: request.decision!.note, terms: request.decision!.terms,
    requestId: request.id, expiresAt: request.decision!.expiresAt,
    ...(request.type === 'new-customer' ? { limit: request.decision!.amount } : {}),
  }));
  return [...recorded, ...legacy].sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.recordedAt.localeCompare(a.recordedAt));
}

/** Browser-local demo IDs; a connected customer master should supply the standard ID. */
export function nextCustomerId(companies: Company[]): string {
  const used = new Set(companies.map(company => company.customerId?.trim().toUpperCase()));
  let sequence = Math.max(20000, ...companies.flatMap(company => /^ECO\d+$/.test(company.customerId ?? '') ? [Number(company.customerId!.slice(3))] : [])) + 1;
  while (used.has(`ECO${sequence}`)) sequence++;
  return `ECO${sequence}`;
}

export function nextCreditRequestNumber(requests: CreditRequest[], at: string): string {
  const year = new Date(at).getUTCFullYear();
  const prefix = `CR-${year}-`;
  const used = new Set(requests.map(request => request.requestNumber));
  let sequence = 1;
  while (used.has(`${prefix}${String(sequence).padStart(4, '0')}`)) sequence++;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

export { creditAttentionRequestIds, creditRequestRecipients, companyLifecycle, possibleBuyerDuplicates } from './creditWorkflow.ts';

/** Additive legacy bootstrap: preserve the existing text and credit position, once per buyer. */
export function initializeCreditRemarkHistory(state: DemoState, at = new Date().toISOString()): void {
  for (const company of state.companies) {
    if (!company.creditRemarks?.trim() || company.activeCreditRemarkId) continue;
    const id = `credit-remark-legacy-${company.id}`;
    const existing = state.creditHistory?.find(entry => entry.id === id && entry.companyId === company.id && entry.type === 'remark');
    if (existing && existing.summary !== company.creditRemarks) continue;
    state.creditHistory ??= [];
    if (!existing) {
      // Credit-review dates do not establish when a legacy remark was written.
      state.creditHistory.unshift({ id, companyId: company.id, effectiveAt: at, recordedAt: at, by: '—', type: 'remark', summary: company.creditRemarks, effectiveDateUnknown: true });
    }
    company.activeCreditRemarkId = id;
  }
}

export function needsCreditRemarkHistory(state: DemoState): boolean {
  return state.companies.some(company => {
    if (!company.creditRemarks?.trim() || company.activeCreditRemarkId) return false;
    const existing = state.creditHistory?.find(entry => entry.id === `credit-remark-legacy-${company.id}` && entry.companyId === company.id && entry.type === 'remark');
    return !existing || existing.summary === company.creditRemarks;
  });
}
