import type { SupplierSummary } from '../../shared/suppliers';
export interface SupplierPage { items: SupplierSummary[]; page: number; pageSize: number; total: number }

/** A complete, consistent catalog is required before the STEM picker becomes writable. */
export async function completeSupplierCatalog(first: SupplierPage, loadPage: (page: number) => Promise<SupplierPage>): Promise<SupplierPage> {
  const invalid = () => new Error('Supplier list changed or is unavailable. Refresh and try again.');
  if (!Number.isSafeInteger(first.total) || first.total < 0 || first.total > 100_000
    || first.page !== 1 || !Number.isSafeInteger(first.pageSize) || first.pageSize < 1 || first.pageSize > 100) throw invalid();
  const pages = Math.max(1, Math.ceil(first.total / first.pageSize));
  if (pages > 1_000) throw invalid();
  const items: SupplierSummary[] = [], seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const result = page === 1 ? first : await loadPage(page);
    const expectedCount = Math.min(first.pageSize, Math.max(0, first.total - (page - 1) * first.pageSize));
    if (result.page !== page || result.pageSize !== first.pageSize || result.total !== first.total || !Array.isArray(result.items) || result.items.length !== expectedCount) throw invalid();
    for (const item of result.items) {
      if (!item.id || seen.has(item.id)) throw invalid();
      seen.add(item.id); items.push(item);
    }
  }
  return { ...first, items };
}
