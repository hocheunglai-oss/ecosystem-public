import type { Outcome } from './model';
import { historicalSupplierFixtures } from './historicalSupplierFixtures';

type SupplierProduct = { grade?: string; supplierId?: string; supplierName?: string };

export interface FixtureProductLine {
  grade: string;
  quantityText: string;
  supplierId?: string;
  supplierName: string;
  buyPrice?: number;
}

function productSupplier(outcome: Outcome, product: SupplierProduct): Pick<FixtureProductLine, 'supplierId' | 'supplierName'> {
  // A grade's supplier is authoritative. The header is only a legacy fallback.
  const source = product.supplierId || product.supplierName ? product : outcome;
  const supplierId = source.supplierId;
  const supplierName = source.supplierName?.trim()
    || historicalSupplierFixtures.find(supplier => supplier.id === supplierId)?.name
    || '—';
  return { ...(supplierId ? { supplierId } : {}), supplierName };
}

export function productSupplierName(outcome: Outcome, product: SupplierProduct): string {
  return productSupplier(outcome, product).supplierName;
}

/** Keep each supplier, quantity and buy price associated with its own grade. */
export function fixtureProductLines(outcome: Outcome): FixtureProductLine[] {
  if (outcome.stemProducts?.length) {
    return outcome.stemProducts.map(product => ({
      grade: product.grade,
      quantityText: product.quantityText,
      ...productSupplier(outcome, product),
      buyPrice: product.buyPrice,
    }));
  }
  if (outcome.products?.length) {
    return outcome.products.map(product => ({
      grade: product.grade,
      quantityText: product.quantity.toLocaleString('en-US'),
      ...productSupplier(outcome, product),
      // A booked selling price or margin must not be presented as a buy price.
    }));
  }
  if (outcome.requestedProducts?.length) {
    return outcome.requestedProducts.map(product => ({
      grade: product.grade,
      quantityText: product.quantityText,
      ...productSupplier(outcome, product),
    }));
  }
  return [{
    grade: outcome.grade,
    quantityText: outcome.quantity.toLocaleString('en-US'),
    ...productSupplier(outcome, {}),
  }];
}

export function outcomeSupplierNames(outcome: Outcome): string[] {
  return [...new Set(fixtureProductLines(outcome).map(product => product.supplierName))]
    .filter(name => name !== '—');
}
