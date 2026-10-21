import type { SupplierSummary, SupplierRecord, SupplierContact, SupplierFact, SupplierSource } from '../../shared/suppliers';
export const supplierGrades = (value: string): string[] => [...new Set(value.split(/[,/·]/).map(item => item.trim().toUpperCase()).filter(Boolean))];
export const normalizeSupplierName = (value: string): string => value.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
export function supplierName(record: Pick<SupplierSummary, 'legalName' | 'shortName'>): string { return normalizeSupplierName(record.legalName.trim() || record.shortName); }
export function supplierShortName(record: Pick<SupplierSummary, 'legalName' | 'shortName'>): string { return normalizeSupplierName(record.shortName.trim() || record.legalName); }
export function supplierSourceUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export const supplierDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Hong_Kong' }) : value;
};
/** Operational contacts only. Other source rows remain preserved in the underlying record. */
export function supplierContacts(record: Pick<SupplierRecord, 'contacts' | 'sources'>): SupplierContact[] {
  const types = new Map(record.sources.map(source => [source.id, source.type]));
  return record.contacts.filter(contact => ['spc', 'user'].includes(types.get(contact.sourceId) ?? '') || contact.sourceId === '');
}
/** Report-derived background, excluding imported contact/address/grade/listing material. */
export function supplierBackground(record: Pick<SupplierRecord, 'facts' | 'sources'>): SupplierFact[] {
  const reports = new Set(record.sources.filter(source => source.type === 'infospectrum').map(source => source.id));
  return record.facts.filter(fact => reports.has(fact.sourceId) && fact.label.trim().toUpperCase() !== 'INFOSPECTRUM SUMMARY'
    && !/address|contact|phone|email|e-mail|listing|licensed|mpa|fuel categor|fuel grade|available grade/i.test(fact.label)
    && /background|overview|summary|incorporat|establish|registration|business|ownership|shareholder|group|parent|geograph|operation|history/i.test(fact.label));
}
/** Curated main-report summaries remain separate from editable company background. */
export function supplierInfospectrumSummary(record: Pick<SupplierRecord, 'facts' | 'sources'>): { text: string; source: SupplierSource } | undefined {
  const sources = new Map(record.sources.filter(source => source.type === 'infospectrum').map(source => [source.id, source]));
  return record.facts.flatMap(fact => {
    const source = sources.get(fact.sourceId);
    return source && fact.label.trim().toUpperCase() === 'INFOSPECTRUM SUMMARY' && fact.value.trim() ? [{ text: fact.value.trim(), source }] : [];
  }).sort((a, b) => b.source.documentDate.localeCompare(a.source.documentDate) || b.source.retrievedAt.localeCompare(a.source.retrievedAt))[0];
}
export function supplierFactTitle(value: string): string { return value.replace(/\s*[·|]\s*report\b.*$/i, '').trim(); }
