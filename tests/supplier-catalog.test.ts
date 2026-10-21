import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSupplierCatalog, type SupplierPage } from '../src/lib/supplierCatalog';
const page = (number: number, total = 3): SupplierPage => ({ items: Array.from({ length: Math.max(0, Math.min(2, total - (number - 1) * 2)) }, (_, i) => ({ id: `real-${(number - 1) * 2 + i}` })) as SupplierPage['items'], page: number, pageSize: 2, total });
test('complete catalog collects all pages without mutating responses and accepts an empty catalog', async () => {
  const first = page(1), before = structuredClone(first), calls: number[] = [];
  const result = await completeSupplierCatalog(first, async number => { calls.push(number); return page(number); });
  assert.deepEqual(calls, [2]); assert.deepEqual(result.items.map(item => item.id), ['real-0', 'real-1', 'real-2']); assert.deepEqual(first, before);
  assert.deepEqual((await completeSupplierCatalog(page(1, 0), async () => { throw Error('Unexpected request'); })).items, []);
});
test('catalog rejects invalid bounds before more requests and rejects changed, duplicate, missing or overfull pages', async () => {
  for (const malformed of [{ total: Infinity }, { total: -1 }, { total: 0.5 }, { total: 100001 }, { page: 2 }, { pageSize: 0 }, { pageSize: 101 }, { total: 10000, pageSize: 1 }]) {
    await assert.rejects(completeSupplierCatalog({ ...page(1), ...malformed }, async () => { assert.fail('Invalid first page must not request more data'); }), /Supplier list/);
  }
  for (const next of [{ ...page(2), page: 1 }, { ...page(2), total: 4 }, { ...page(2), pageSize: 3 }, { ...page(2), items: [] }, { ...page(2), items: page(1).items }, { ...page(2), items: [page(1).items[0]] }]) await assert.rejects(completeSupplierCatalog(page(1), async () => next), /Supplier list/);
});
