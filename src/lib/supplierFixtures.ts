import type { Actor, DemoState } from './model';
import { indexRecords } from './recordQuery';
import type { FixtureProductLine } from './fixtureSuppliers';

export interface SupplierFixtureRecord {
  id: string;
  bookedAt: string;
  day: string;
  timestamp: number;
  vessel: string;
  buyer: string;
  port: string;
  productLines: FixtureProductLine[];
  search: string;
}
export type SupplierFixtureSort = 'date' | 'vessel' | 'buyer' | 'port';
export interface SupplierFixtureQuery {
  search?: string;
  sort?: SupplierFixtureSort;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Retain the Records workspace's actor visibility, then project only this supplier's grade lines.
 * IDs from saved fixtures remain authoritative even if no current supplier source contains them.
 * Never resolve identity by supplier name or shared company identity, or return other grade prices. */
export function indexSupplierFixtures(
  state: Pick<DemoState, 'companies' | 'ports' | 'enquiries' | 'outcomes'>,
  actor: Actor,
  supplierId: string,
): SupplierFixtureRecord[] {
  if (!supplierId) return [];
  return indexRecords(state, actor).flatMap(row => {
    if (row.outcome.kind !== 'fixture') return [];
    const productLines = row.productLines.filter(product => product.supplierId === supplierId).map(product => ({ ...product }));
    if (!productLines.length) return [];
    return [{
      id: row.outcome.id, bookedAt: row.outcome.bookedAt, day: row.day, timestamp: row.timestamp,
      vessel: row.outcome.vessel, buyer: row.buyer, port: row.port, productLines,
      search: normalize([row.outcome.vessel, row.buyer, row.port, row.day, ...productLines.flatMap(product => [product.grade, product.quantityText])].join(' ')),
    }];
  });
}

export function querySupplierFixtures(records: readonly SupplierFixtureRecord[], query: SupplierFixtureQuery = {}) {
  const words = normalize(query.search ?? '').split(/\s+/).filter(Boolean);
  const filtered = records.filter(row => words.every(word => row.search.includes(word)));
  const sort = query.sort ?? 'date', multiplier = query.direction === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    if (sort === 'date') {
      const validA = Number.isFinite(a.timestamp), validB = Number.isFinite(b.timestamp);
      if (validA !== validB) return validA ? -1 : 1;
      return (validA ? multiplier * (a.timestamp - b.timestamp) : 0) || collator.compare(a.id, b.id);
    }
    return multiplier * collator.compare(a[sort], b[sort]) || collator.compare(a.id, b.id);
  });
  const pageSize = [25, 50, 100].includes(query.pageSize ?? 0) ? query.pageSize! : 50;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(0, Math.min(Number.isFinite(query.page) ? Math.floor(query.page!) : 0, pages - 1));
  return { rows: filtered.slice(page * pageSize, (page + 1) * pageSize), total: filtered.length, page, pages, pageSize };
}
