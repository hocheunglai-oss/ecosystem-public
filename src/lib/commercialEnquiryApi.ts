import type {
  CommercialEnquiry, CommercialEnquiryMutation, CommercialEnquiryMutationResult,
  CommercialEnquiryPage, CommercialEnquiryScope, CommercialEnquirySummary,
} from '../../shared/commercialEnquiries';
import { assertPreviewWritable } from './previewGuard';
import { assertLiveDataWritable } from './testWorkspaceGuard';
import {
  fixtureGrades, isFixtureDate, type FixtureAssignment, type FixtureBooking, type FixtureMutation, type FixtureOptions,
} from '../../shared/fixtureWorkflow';

const unavailable = () => new Error('Enquiries are unavailable. Try again.');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const strings = (value: unknown, keys: string[]) => record(value) && keys.every(key => typeof value[key] === 'string');
function summary(value: unknown, owner?: string): CommercialEnquirySummary {
  if (!record(value) || !uuid(value.id) || !uuid(value.ownerId) || owner && value.ownerId !== owner
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !['draft', 'confirmed'].includes(String(value.status))
    || !['reference', 'ownerName', 'vessel', 'imo', 'eta', 'createdAt', 'updatedAt'].every(key => typeof value[key] === 'string')
    || !Array.isArray(value.products) || value.products.some(item => !record(item) || !['HSFO', 'VLSFO', 'LSMGO'].includes(String(item.grade)) || typeof item.quantityText !== 'string')
    || value.port !== null && !strings(value.port, ['id', 'countryCode', 'countryName', 'portName'])
    || value.queue !== null && (!record(value.queue) || value.queue.status !== 'awaiting_connection' || typeof value.queue.queuedAt !== 'string')) throw unavailable();
  // List rows intentionally omit all source text, buyer data and private notes.
  const item = Object.fromEntries(['id', 'reference', 'ownerId', 'ownerName', 'revision', 'status', 'vessel', 'imo', 'eta', 'products', 'port', 'queue', 'createdAt', 'updatedAt', 'confirmedAt']
    .map(key => [key, value[key]])) as unknown as CommercialEnquirySummary;
  if (owner && value.fixture !== undefined) item.fixture = fixtureAssignment(value.fixture);
  return item;
}
export function commercialDetail(value: unknown, owner: string): CommercialEnquiry {
  const item = summary(value, owner);
  if (!record(value) || !record(value.source) || typeof value.source.rawText !== 'string'
    || !record(value.reviewed) || !strings(value.reviewed, ['vessel', 'imo', 'eta', 'remarks', 'formattedText'])
    || !Array.isArray(value.reviewed.products) || !Array.isArray(value.reviewed.warnings)
    || value.reviewed.warnings.some(warning => typeof warning !== 'string') || !Array.isArray(value.reviewed.viscosity)
    || typeof value.reviewed.rmk !== 'boolean') throw unavailable();
  return { ...item, source: value.source, reviewed: value.reviewed } as unknown as CommercialEnquiry;
}
export function commercialPage(value: unknown, owner?: string): CommercialEnquiryPage {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 100 || value.nextCursor !== null && typeof value.nextCursor !== 'string') throw unavailable();
  return { items: value.items.map(item => summary(item, owner)), nextCursor: value.nextCursor };
}
async function request(query: URLSearchParams, input?: CommercialEnquiryMutation | FixtureMutation, signal?: AbortSignal, resource: 'records' | 'fixtures' = 'records'): Promise<unknown> {
  // Reads also stay closed in TEST and VIEW AS; neither mode may reveal LIVE records.
  assertPreviewWritable(); assertLiveDataWritable();
  const response = await fetch(`/api/enquiries/${resource}${query.size ? `?${query}` : ''}`, {
    method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Eco-Data-Mode': 'live', ...(input ? { 'Content-Type': 'application/json', 'X-Eco-Request': '1' } : {}) },
    body: input ? JSON.stringify(input) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw unavailable();
  const text = await response.text();
  if (text.length > 2_000_000) throw unavailable();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw unavailable(); }
  if (!response.ok) throw Object.assign(new Error(record(data) && typeof data.message === 'string' ? data.message : 'Enquiry could not be saved.'), { status: response.status });
  return data;
}
export const commercialEnquiryApi = {
  page: async (owner: string, scope: CommercialEnquiryScope, cursor?: string, signal?: AbortSignal) =>
    commercialPage(await request(new URLSearchParams({ scope, limit: '25', ...(cursor ? { cursor } : {}) }), undefined, signal), scope === 'mine' ? owner : undefined),
  detail: async (owner: string, id: string, signal?: AbortSignal) => {
    const data = await request(new URLSearchParams({ id }), undefined, signal);
    if (!record(data)) throw unavailable();
    const item = commercialDetail(data.item, owner);
    if (item.id !== id) throw unavailable();
    return item;
  },
  byInbox: async (owner: string, inboxId: string, signal?: AbortSignal) => {
    const data = await request(new URLSearchParams({ inboxId }), undefined, signal);
    if (!record(data)) throw unavailable();
    if (data.item === null) return null;
    const item = commercialDetail(data.item, owner);
    if (item.source.inboxId !== inboxId) throw unavailable();
    return item;
  },
  mutate: async (owner: string, input: CommercialEnquiryMutation, signal?: AbortSignal): Promise<CommercialEnquiryMutationResult> => {
    const data = await request(new URLSearchParams(), input, signal);
    if (!record(data) || data.requestId !== input.requestId) throw unavailable();
    const item = commercialDetail(data.item, owner);
    if (item.id !== input.id) throw unavailable();
    return { requestId: input.requestId, item };
  },
};

function fixtureAssignment(value: unknown): FixtureAssignment {
  if (!record(value) || !uuid(value.id) || !uuid(value.supplierTraderId) || typeof value.supplierTrader !== 'string'
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || (value.status !== 'pending' && value.status !== 'confirmed')
      || !isFixtureDate(value.date) || !isFixtureDate(value.eta) || typeof value.etaReviewed !== 'boolean'
      || !['date', 'range', 'earliest'].includes(String(value.etaKind))
      || (value.etaKind === 'range' ? !isFixtureDate(value.etaEnd) || value.etaEnd <= value.eta : value.etaEnd !== null)) throw unavailable();
  return { id: value.id, revision: Number(value.revision), status: value.cancelled === true ? 'cancelled' : value.status, supplierTraderId: value.supplierTraderId,
    supplierTrader: value.supplierTrader, date: value.date, eta: value.eta, etaEnd: value.etaEnd as string | null,
    etaKind: value.etaKind as FixtureAssignment['etaKind'], etaReviewed: value.etaReviewed };
}
function fixtureDetail(value: unknown, id: string): FixtureBooking {
  const assignment = fixtureAssignment(value);
  if (!record(value) || assignment.id !== id || !strings(value, ['vessel', 'imo', 'reference', 'buyerTrader']) || typeof value.canConfirm !== 'boolean'
      || typeof value.canCancel !== 'boolean' || (value.cancellation !== null && !strings(value.cancellation, ['at', 'by', 'reason']))
      || (value.confirmedAt !== null && typeof value.confirmedAt !== 'string')
      || !Array.isArray(value.requested) || value.requested.some(product => !record(product) || !fixtureGrades.includes(product.grade as typeof fixtureGrades[number]) || typeof product.quantityText !== 'string')
      || !Array.isArray(value.lines) || value.lines.length > 30
      || value.lines.some(line => !record(line) || !fixtureGrades.includes(line.grade as typeof fixtureGrades[number])
        || !uuid(line.supplierId) || !strings(line, ['supplier', 'account', 'accountId']) || typeof line.supplierAvailable !== 'boolean'
        || !Number.isFinite(line.quantity) || !Number.isFinite(line.buyPrice))) throw unavailable();
  return { ...value, ...assignment } as unknown as FixtureBooking;
}
export const fixtureApi = {
  options: async (signal?: AbortSignal): Promise<FixtureOptions> => {
    const value = await request(new URLSearchParams({ options: '1' }), undefined, signal, 'fixtures');
    if (!record(value) || !Array.isArray(value.traders) || value.traders.some(trader => !record(trader) || !uuid(trader.id) || !strings(trader, ['name', 'office']))
      || !Array.isArray(value.accounts) || value.accounts.some(account => !strings(account, ['id', 'name'])) || !record(value.quantityReview)) throw unavailable();
    const ranges = value.quantityReview;
    for (const grade of fixtureGrades) {
      const range = ranges[grade];
      if (!record(range) || typeof range.min !== 'number' || typeof range.max !== 'number' || !Number.isFinite(range.min)
          || !Number.isFinite(range.max) || range.min <= 0 || range.max < range.min) throw unavailable();
    }
    return value as unknown as FixtureOptions;
  },
  detail: async (id: string, signal?: AbortSignal) => fixtureDetail(await request(new URLSearchParams({ id }), undefined, signal, 'fixtures'), id),
  assign: async (input: Extract<FixtureMutation, { action: 'assign' }>) => fixtureAssignment(await request(new URLSearchParams(), input, undefined, 'fixtures')),
  confirm: async (input: Extract<FixtureMutation, { action: 'confirm' }>) => fixtureDetail(await request(new URLSearchParams(), input, undefined, 'fixtures'), input.id),
  cancel: async (input: Extract<FixtureMutation, { action: 'cancel' }>) => fixtureDetail(await request(new URLSearchParams(), input, undefined, 'fixtures'), input.id),
};
