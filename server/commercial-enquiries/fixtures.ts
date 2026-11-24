import { fixtureGrades, isFixtureDate, type FixtureMutation, type FixtureSupplyLine } from '../../shared/fixtureWorkflow.ts';
import { ApiError } from '../auth/validation.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new ApiError(400, 'Invalid fixture details.'); }
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) return invalid();
  return input as Record<string, unknown>;
}
function id(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value)) return invalid();
  return value;
}
function positive(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return invalid();
  return value;
}
export function fixtureQuery(url: URL) {
  if (url.searchParams.size === 1 && url.searchParams.get('options') === '1') return { dataMode: 'live', options: true };
  if (url.searchParams.size === 1 && url.searchParams.has('id')) return { dataMode: 'live', id: id(url.searchParams.get('id')) };
  return invalid();
}
export function fixtureMutation(input: unknown): FixtureMutation {
  const common = ['dataMode', 'requestId', 'expectedRevision', 'action'];
  const value = record(input, [...common, 'enquiryId', 'supplierTraderId', 'date', 'eta', 'etaEnd', 'etaKind', 'etaReviewed', 'id', 'lines', 'quantityReviewed', 'reason']);
  if (value.dataMode !== 'live') throw new ApiError(403, 'Switch to LIVE to use shared fixtures.');
  if (typeof value.expectedRevision !== 'number' || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision > 2147483646) return invalid();
  const base = { dataMode: 'live' as const, requestId: id(value.requestId), expectedRevision: value.expectedRevision };
  if (value.action === 'cancel') {
    record(input, [...common, 'id', 'reason']);
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    if (!base.expectedRevision || !reason || reason.length > 500 || reason.includes('\u0000')) return invalid();
    return { ...base, action: 'cancel', id: id(value.id), reason };
  }
  if (value.action === 'assign') {
    record(input, [...common, 'enquiryId', 'supplierTraderId', 'date', 'eta', 'etaEnd', 'etaKind', 'etaReviewed']);
    const { date, eta, etaEnd, etaKind, etaReviewed } = value;
    if (!isFixtureDate(date) || !isFixtureDate(eta) || typeof etaReviewed !== 'boolean' || (eta < date && !etaReviewed)) return invalid();
    if (etaKind !== 'date' && etaKind !== 'range' && etaKind !== 'earliest') return invalid();
    if (etaKind === 'range' ? !isFixtureDate(etaEnd) || etaEnd <= eta : etaEnd !== null) return invalid();
    return { ...base, action: 'assign', enquiryId: id(value.enquiryId), supplierTraderId: id(value.supplierTraderId), date, eta, etaEnd: etaEnd as string | null, etaKind, etaReviewed };
  }
  if (value.action !== 'confirm' || !value.expectedRevision || typeof value.quantityReviewed !== 'boolean') return invalid();
  record(input, [...common, 'id', 'lines', 'quantityReviewed']);
  if (!Array.isArray(value.lines) || !value.lines.length || value.lines.length > 30) return invalid();
  const lines = value.lines.map(inputLine => {
    const line = record(inputLine, ['grade', 'quantity', 'supplierId', 'accountId', 'buyPrice']);
    if (!fixtureGrades.includes(line.grade as FixtureSupplyLine['grade']) || typeof line.accountId !== 'string' || !line.accountId.trim() || line.accountId.length > 80) return invalid();
    return { grade: line.grade as FixtureSupplyLine['grade'], accountId: line.accountId, supplierId: id(line.supplierId), quantity: positive(line.quantity), buyPrice: positive(line.buyPrice) };
  });
  return { ...base, action: 'confirm', id: id(value.id), lines, quantityReviewed: value.quantityReviewed };
}
