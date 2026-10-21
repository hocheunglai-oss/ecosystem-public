import type { IntelligenceSnapshotInput } from '../../shared/intelligence.ts';
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
function check(value: unknown, message = 'Invalid intelligence snapshot.'): asserts value { if (!value) throw new Error(message); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))); }
function text(value: unknown, max: number, empty = false): asserts value is string { check(typeof value === 'string' && [...value].length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)); }
function id(value: unknown): asserts value is string { check(typeof value === 'string' && identifier.test(value)); }
function date(value: unknown): string { check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value); return value; }
function source(value: unknown) { text(value, 2048); let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid intelligence source.'); } check(url.protocol === 'https:' && !url.username && !url.password && !/\s/.test(value)); }
export function validateIntelligenceSnapshot(value: unknown, now = new Date()): IntelligenceSnapshotInput {
  object(value, ['schemaVersion','portId','recordedAt','supplierRecordedAt','periodStart','periodEnd','sourceUrl','supplierSourceUrl','suppliers','counts']);
  check(value.schemaVersion === 1 && Buffer.byteLength(JSON.stringify(value)) <= 2_097_152); id(value.portId);
  const start = date(value.periodStart), end = date(value.periodEnd);
  check(start <= end && end <= now.toISOString().slice(0, 10) && Date.parse(end) - Date.parse(start) <= 3660 * 86_400_000);
  for (const key of ['recordedAt','supplierRecordedAt']) { text(value[key], 40); date(value[key].slice(0, 10)); check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value[key]) && Number.isFinite(Date.parse(value[key])) && Date.parse(value[key]) <= now.getTime() + 300_000); }
  check(Date.parse(value.recordedAt as string) >= Date.parse(end)); source(value.sourceUrl); source(value.supplierSourceUrl);
  check(Array.isArray(value.suppliers) && value.suppliers.length >= 1 && value.suppliers.length <= 500);
  const ids = new Set<string>();
  for (const supplier of value.suppliers) {
    object(supplier, ['id','name','companyId','portIds','grades','paymentTerms','qualityClaimBar','supplierTrader','foBdn','goBdn','bargeCount','sourceUrl']);
    id(supplier.id); check(!ids.has(supplier.id)); ids.add(supplier.id); text(supplier.name, 300);
    if ('companyId' in supplier) id(supplier.companyId);
    check(Array.isArray(supplier.portIds) && supplier.portIds.length >= 1 && supplier.portIds.length <= 50 && supplier.portIds.includes(value.portId));
    check(Array.isArray(supplier.grades) && supplier.grades.length <= 30);
    supplier.portIds.forEach(id); supplier.grades.forEach(v => text(v, 80));
    check(new Set(supplier.portIds).size === supplier.portIds.length && new Set(supplier.grades).size === supplier.grades.length);
    for (const key of ['paymentTerms','qualityClaimBar','supplierTrader','foBdn','goBdn']) if (key in supplier) text(supplier[key], 500, true);
    if ('bargeCount' in supplier) check(Number.isInteger(supplier.bargeCount) && Number(supplier.bargeCount) >= 0 && Number(supplier.bargeCount) <= 100_000);
    if ('sourceUrl' in supplier) source(supplier.sourceUrl);
  }
  check(Array.isArray(value.counts) && value.counts.length <= 20_000);
  const countKeys = new Set<string>();
  for (const row of value.counts) {
    object(row, ['supplierId','date','count']); id(row.supplierId); check(ids.has(row.supplierId));
    const day = date(row.date); check(day >= start && day <= end);
    check(Number.isInteger(row.count) && Number(row.count) >= 0 && Number(row.count) <= 1_000_000);
    const key = `${row.supplierId}:${day}`; check(!countKeys.has(key)); countKeys.add(key);
  }
  return value as unknown as IntelligenceSnapshotInput;
}
