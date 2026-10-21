import { getLocationIntelligence } from './intelligence';
import type { Company, Port } from './model';

/** Both existing supplier sources retain their own stable identities and optional facts. */
export interface SupplierDirectorySource {
  id: string;
  name: string;
  /** Explicit shared legal-company identity; supplier IDs and trading history remain independent. */
  companyId?: Company['id'];
  portIds: readonly string[];
  grades: readonly string[];
  paymentTerms?: string;
  qualityClaimBar?: string;
  supplierTrader?: string;
  foBdn?: string;
  goBdn?: string;
  bargeCount?: number;
  sourceUrl?: string;
  fixtureCount?: number;
  fixturePeriod?: string;
  recordedAt?: string;
  delivery?: string;
  note?: string;
  contact?: string;
}

export interface SupplierDirectoryPort {
  id: string;
  /** Unknown coverage keeps the original port ID as its label. */
  name: string;
  country?: string;
  known: boolean;
}

export interface SupplierDirectoryRecord extends SupplierDirectorySource {
  portIds: string[];
  grades: string[];
  ports: SupplierDirectoryPort[];
  countries: string[];
  /** Search text is indexed once, before filtering or paging. */
  search: string;
  initial: string;
}

export type SupplierDirectorySort = 'name-asc' | 'name-desc' | 'fixtures-desc';
export interface SupplierDirectoryQuery {
  search?: string;
  companyId?: Company['id'];
  country?: string;
  portId?: string;
  grade?: string;
  letter?: string;
  sort?: SupplierDirectorySort;
  /** Zero-based, matching the existing records directory. */
  page?: number;
  pageSize?: number;
}
export interface SupplierDirectoryResult {
  rows: SupplierDirectoryRecord[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}
export interface SupplierDirectoryOptions {
  countries: string[];
  ports: SupplierDirectoryPort[];
  grades: string[];
  letters: string[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '')
  .toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const unique = (values: readonly string[], key: (value: string) => string = value => value) => {
  const seen = new Set<string>();
  return values.filter(value => {
    const normalized = key(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};
const optionalFields = ['companyId', 'paymentTerms', 'qualityClaimBar', 'supplierTrader', 'foBdn', 'goBdn', 'bargeCount', 'sourceUrl', 'fixtureCount', 'fixturePeriod', 'recordedAt', 'delivery', 'note', 'contact'] as const;

/** Build once per source/port revision. Dedupe IDs, never names or guessed company aliases. */
export function buildSupplierDirectory(
  ports: readonly Port[],
  sources: readonly SupplierDirectorySource[] = [],
): SupplierDirectoryRecord[] {
  const portIndex = new Map(ports.map(port => [port.id, {
    id: port.id, name: port.name, country: getLocationIntelligence(port).countryName, known: true,
  }]));
  const suppliers = new Map<string, SupplierDirectorySource>();
  for (const source of sources) {
    const previous = suppliers.get(source.id);
    if (!previous) {
      suppliers.set(source.id, { ...source, portIds: unique(source.portIds), grades: unique(source.grades, normalize) });
      continue;
    }
    // Earlier sources win conflicting scalars; missing details and extra coverage
    // are retained from the later source without altering either input object.
    const details = Object.fromEntries(optionalFields.flatMap(field =>
      previous[field] === undefined && source[field] !== undefined ? [[field, source[field]]] : [],
    ));
    suppliers.set(source.id, { ...previous, ...details,
      portIds: unique([...previous.portIds, ...source.portIds]),
      grades: unique([...previous.grades, ...source.grades], normalize),
    });
  }
  return [...suppliers.values()].map(supplier => {
    const coverage: SupplierDirectoryPort[] = supplier.portIds.map(id => ({ ...(portIndex.get(id) ?? { id, name: id, known: false }) }));
    const countries = unique(coverage.flatMap(port => port.country ? [port.country] : []), normalize);
    const normalizedName = normalize(supplier.name);
    const first = normalizedName.charAt(0).toUpperCase();
    return {
      ...supplier,
      portIds: [...supplier.portIds], grades: [...supplier.grades], ports: coverage, countries,
      initial: /^[A-Z]$/.test(first) ? first : '',
      search: normalize([supplier.name, supplier.id, ...coverage.flatMap(port => [port.name, port.id]), ...countries, ...supplier.grades].join(' ')),
    };
  });
}

/** Filters precede sorting and slicing; the original index and source facts remain unchanged. */
export function querySupplierDirectory(
  records: readonly SupplierDirectoryRecord[],
  query: SupplierDirectoryQuery = {},
): SupplierDirectoryResult {
  const words = normalize(query.search ?? '').split(' ').filter(Boolean);
  const country = normalize(query.country ?? ''), grade = normalize(query.grade ?? '');
  const letter = (query.letter ?? '').trim().toUpperCase();
  const alphabetical = /^[A-Z]$/.test(letter) ? letter : '';
  const filtered = records.filter(record => {
    if (query.companyId && record.companyId !== query.companyId) return false;
    if (query.portId) {
      const coverage = record.ports.find(port => port.id === query.portId);
      if (!coverage || (country && (!coverage.country || normalize(coverage.country) !== country))) return false;
    } else if (country && !record.countries.some(value => normalize(value) === country)) return false;
    if (grade && !record.grades.some(value => normalize(value) === grade)) return false;
    if (alphabetical && record.initial !== alphabetical) return false;
    return words.every(word => record.search.includes(word));
  });
  const compareName = (a: SupplierDirectoryRecord, b: SupplierDirectoryRecord) =>
    collator.compare(a.name, b.name) || collator.compare(a.id, b.id) || a.id.localeCompare(b.id, 'en');
  const count = (record: SupplierDirectoryRecord) =>
    typeof record.fixtureCount === 'number' && Number.isInteger(record.fixtureCount) && record.fixtureCount >= 0 ? record.fixtureCount : null;
  filtered.sort((a, b) => {
    if (query.sort === 'fixtures-desc') {
      const first = count(a), second = count(b);
      if (first !== second) {
        if (first === null) return 1;
        if (second === null) return -1;
        return second - first;
      }
    }
    return (query.sort === 'name-desc' ? -1 : 1) * compareName(a, b);
  });
  const pageSize = [25, 50, 100].includes(query.pageSize ?? 50) ? query.pageSize ?? 50 : 50;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requested = query.page ?? 0;
  const page = Math.max(0, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 0, pages - 1));
  return { rows: filtered.slice(page * pageSize, (page + 1) * pageSize), total: filtered.length, page, pages, pageSize };
}

/** Options describe source coverage, including unresolved port IDs, without inventing locations. */
export function supplierDirectoryOptions(records: readonly SupplierDirectoryRecord[]): SupplierDirectoryOptions {
  const ports = new Map<string, SupplierDirectoryPort>();
  for (const record of records) for (const port of record.ports) if (!ports.has(port.id)) ports.set(port.id, { ...port });
  return {
    countries: unique(records.flatMap(record => record.countries), normalize).sort(collator.compare),
    ports: [...ports.values()].sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.id, b.id)),
    grades: unique(records.flatMap(record => record.grades), normalize).sort(collator.compare),
    letters: unique(records.map(record => record.initial).filter(Boolean)).sort(),
  };
}


/** Buyer and supplier relationships can share a company without sharing profile/history keys. */
export function supplierCompany<T extends Pick<Company, 'id'>>(
  supplier: Pick<SupplierDirectorySource, 'companyId'>,
  companies: readonly T[],
): T | undefined {
  if (!supplier.companyId) return undefined;
  const matches = companies.filter(company => company.id === supplier.companyId);
  // Duplicate or missing company identities are unresolved; names and groups never substitute.
  return matches.length === 1 ? matches[0] : undefined;
}

/** A company may have multiple supplier-source records as well as its existing buyer record. */
export function suppliersForCompany(
  records: readonly SupplierDirectoryRecord[],
  companyId: Company['id'],
): SupplierDirectoryRecord[] {
  return companyId ? records.filter(record => record.companyId === companyId) : [];
}
