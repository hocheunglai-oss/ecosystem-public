import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProductLines, outcomeSupplierNames, productSupplierName } from '../src/lib/fixtureSuppliers';
import { historicalSupplierFixtures } from '../src/lib/historicalSupplierFixtures';
import type { Outcome } from '../src/lib/model';

const base: Outcome = {
  id: 'fixture', enquiryId: 'enquiry', kind: 'fixture', buyerId: 'buyer', portId: 'port',
  vessel: 'VESSEL', grade: 'VLSFO', quantity: 1500, price: 600, margin: 12,
  bookedAt: '2026-10-05T00:00:00.000Z', owner: 'otto', reason: '',
  supplierId: historicalSupplierFixtures[0].id, supplierName: historicalSupplierFixtures[0].name,
};

test('fixture lines retain each grade supplier, requested quantity and buy price', () => {
  const outcome: Outcome = { ...base, stemProducts: [
    { grade: 'HSFO', quantityText: '350–400', buyPrice: 410, supplierId: historicalSupplierFixtures[1].id, supplierName: historicalSupplierFixtures[1].name },
    { grade: 'VLSFO', quantityText: '500–600', buyPrice: 550, supplierId: historicalSupplierFixtures[2].id },
    { grade: 'LSMGO', quantityText: '60', buyPrice: 695, supplierId: historicalSupplierFixtures[1].id },
  ] };
  const snapshot = structuredClone(outcome);
  assert.deepEqual(fixtureProductLines(outcome), [
    { grade: 'HSFO', quantityText: '350–400', buyPrice: 410, supplierId: historicalSupplierFixtures[1].id, supplierName: historicalSupplierFixtures[1].name },
    { grade: 'VLSFO', quantityText: '500–600', buyPrice: 550, supplierId: historicalSupplierFixtures[2].id, supplierName: historicalSupplierFixtures[2].name },
    { grade: 'LSMGO', quantityText: '60', buyPrice: 695, supplierId: historicalSupplierFixtures[1].id, supplierName: historicalSupplierFixtures[1].name },
  ]);
  assert.deepEqual(outcomeSupplierNames(outcome), [historicalSupplierFixtures[1].name, historicalSupplierFixtures[2].name]);
  assert.deepEqual(outcome, snapshot);
});

test('legacy STEM rows inherit the header supplier without rewriting stored records', () => {
  const outcome: Outcome = { ...base, stemProducts: [
    { grade: 'VLSFO', quantityText: '500–600', buyPrice: 550 },
    { grade: 'LSMGO', quantityText: '60', buyPrice: 695 },
  ] };
  assert.ok(fixtureProductLines(outcome).every(product => product.supplierId === base.supplierId && product.supplierName === base.supplierName));
  assert.deepEqual(outcomeSupplierNames(outcome), [base.supplierName]);
  assert.equal(productSupplierName(outcome, outcome.stemProducts![0]), base.supplierName);
  assert.equal(outcome.stemProducts![0].supplierId, undefined);
});

test('historical booked products preserve quantities and never fabricate a buy price from selling price or margin', () => {
  const outcome: Outcome = { ...base, products: [
    { grade: 'VLSFO', quantity: 1250, price: 630, margin: 20 },
    { grade: 'LSMGO', quantity: 250, price: 755, margin: 30 },
  ] };
  assert.deepEqual(fixtureProductLines(outcome).map(product => [product.grade, product.quantityText, product.buyPrice, product.supplierName]), [
    ['VLSFO', '1,250', undefined, base.supplierName],
    ['LSMGO', '250', undefined, base.supplierName],
  ]);
  assert.deepEqual(fixtureProductLines({ ...outcome, products: [], requestedProducts: [{ grade: 'VLSFO', quantityText: '350–400' }] }), [
    { grade: 'VLSFO', quantityText: '350–400', supplierId: base.supplierId, supplierName: base.supplierName },
  ]);
  assert.deepEqual(fixtureProductLines(base), [
    { grade: 'VLSFO', quantityText: '1,500', supplierId: base.supplierId, supplierName: base.supplierName },
  ]);
});

test('supplier snapshots and unknown grade suppliers do not inherit the wrong header identity', () => {
  assert.equal(productSupplierName(base, { grade: 'VLSFO', supplierId: 'historical', supplierName: 'Historical supply name' }), 'Historical supply name');
  assert.equal(productSupplierName(base, { grade: 'VLSFO', supplierName: 'Name-only grade supplier' }), 'Name-only grade supplier');
  assert.equal(productSupplierName(base, { grade: 'VLSFO', supplierId: 'unknown' }), '—');
  const unknown: Outcome = { ...base, supplierId: undefined, supplierName: undefined };
  assert.equal(fixtureProductLines(unknown)[0].supplierName, '—');
  assert.deepEqual(outcomeSupplierNames(unknown), []);
});
