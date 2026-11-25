import { fixtureGrades, isFixtureDate, type FixtureMutation, type FixtureSupplyLine } from '../../shared/fixtureWorkflow.ts';
import type { FixtureRegisterFields, FixtureRegisterMutation } from '../../shared/fixtureHistory.ts';
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
  if (url.searchParams.size === 1 && url.searchParams.has('edit')) return { dataMode: 'live', edit: id(url.searchParams.get('edit')) };
  return invalid();
}

function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000') || (required && !value.trim())) return invalid();
  return value;
}

function registerFields(input: unknown): FixtureRegisterFields {
  const value = record(input, ['vessel', 'imo', 'date', 'eta', 'etaEnd', 'etaKind', 'etaReviewed', 'lines']);
  const { date, eta, etaEnd, etaKind, etaReviewed } = value;
  const imo = text(value.imo, 7);
  if (imo && !/^\d{7}$/.test(imo)) return invalid();
  if (!isFixtureDate(date) || (eta !== null && !isFixtureDate(eta)) || typeof etaReviewed !== 'boolean'
      || (etaKind !== 'date' && etaKind !== 'range' && etaKind !== 'earliest')
      || (etaKind === 'range' ? !eta || !isFixtureDate(etaEnd) || etaEnd <= eta : etaEnd !== null)
      || (eta && eta < date && !etaReviewed) || !Array.isArray(value.lines) || value.lines.length > 30) return invalid();
  const lines = value.lines.map(raw => {
    const line = record(raw, ['grade', 'quantity', 'supplierId', 'accountId', 'price', 'barging', 'cancelled']);
    const grade = line.grade as FixtureSupplyLine['grade'];
    if (!fixtureGrades.includes(grade) || typeof line.cancelled !== 'boolean') return invalid();
    return { grade, supplierId: line.supplierId === '' ? '' : id(line.supplierId), accountId: text(line.accountId, 81),
      quantity: text(line.quantity, 80), price: text(line.price, 120), barging: text(line.barging, 120), cancelled: line.cancelled };
  });
  return { vessel: text(value.vessel, 240, true), imo, date, eta, etaEnd: etaEnd as string | null, etaKind, etaReviewed, lines };
}

function registerMutation(input: unknown): FixtureRegisterMutation {
  const common = ['action', 'dataMode', 'id', 'requestId', 'version'];
  const value = record(input, [...common, 'fields', 'reason', 'quantityReviewed']);
  if (value.dataMode !== 'live') throw new ApiError(403, 'Switch to LIVE to use shared fixtures.');
  const version = text(value.version, 32);
  if (!/^[0-9a-f]{32}$/.test(version)) return invalid();
  const base = { dataMode: 'live' as const, id: id(value.id), requestId: id(value.requestId), version };
  switch (value.action) {
    case 'update': case 'complete':
      record(input, [...common, 'fields', 'quantityReviewed']);
      if (typeof value.quantityReviewed !== 'boolean') return invalid();
      return { ...base, action: value.action, fields: registerFields(value.fields), quantityReviewed: value.quantityReviewed };
    case 'void':
      record(input, [...common, 'reason']);
      return { ...base, action: 'void', reason: text(value.reason, 500, true).trim() };
    case 'delete': case 'restore':
      record(input, common);
      return { ...base, action: value.action };
    default: return invalid();
  }
}

export function fixtureWrite(input: unknown): FixtureMutation | FixtureRegisterMutation {
  return input && typeof input === 'object' && 'action' in input && typeof input.action === 'string' && ['assign', 'confirm', 'cancel'].includes(input.action)
    ? fixtureMutation(input) : registerMutation(input);
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
