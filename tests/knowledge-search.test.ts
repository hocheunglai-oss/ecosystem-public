import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeBlockMatches, knowledgeRowMatches, matchesKnowledgeSearch, portBuyPriceRows } from '../src/lib/knowledgeSearch';
import { createSeedState } from '../src/lib/seed';
import type { KnowledgeBlock } from '../src/lib/knowledge';

test('profile search matches words across visible data with case and accent tolerance', () => {
  assert.equal(matchesKnowledgeSearch('quality manifold', 'Quality claim period', "Vessel's manifold"), true);
  assert.equal(matchesKnowledgeSearch('cafe TOKYO', 'Café', 'Tokyo Bay'), true);
  assert.equal(matchesKnowledgeSearch('no', null, undefined), false);
  assert.equal(matchesKnowledgeSearch(' ', null, undefined), true);
  assert.equal(matchesKnowledgeSearch('port terms', 'Port', 'Delivery'), false);
});

test('profile search excludes internal block IDs and attribution while matching text and file contents', () => {
  const block: KnowledgeBlock = { id: 'private-internal-id', type: 'text', title: 'Anchorage', text: 'Confirm the northern berth.', update: { updatedBy: 'hidden-author-id', updatedAt: '2026-10-01' } };
  assert.equal(knowledgeBlockMatches(block, 'anchorage northern'), true);
  assert.equal(knowledgeBlockMatches(block, 'private-internal'), false);
  assert.equal(knowledgeBlockMatches(block, 'hidden-author'), false);
  assert.equal(knowledgeBlockMatches({ id: 'document', type: 'file', title: 'Port circular', url: 'https://example.test/delivery-2026.pdf' }, 'delivery'), true);
});

test('table search returns only matching rows and permits title or column searches', () => {
  const block: KnowledgeBlock = { id: 'table', type: 'table', title: 'Refineries', columns: [{ id: 'name', name: 'Name' }, { id: 'capacity', name: 'Capacity' }], rows: [
    { id: 'aster-row', cells: ['Aster Bukom', '300,000 bpd'] },
    { id: 'src-row', cells: ['SRC', '290,000 bpd'] },
  ] };
  assert.equal(knowledgeBlockMatches(block, 'ASTER 300'), true);
  assert.equal(knowledgeBlockMatches(block, 'src-row'), false);
  assert.equal(knowledgeBlockMatches(block, 'Aster 290'), false);
  assert.deepEqual(block.rows.filter(row => knowledgeRowMatches(block, row.cells, 'aster')).map(row => row.id), ['aster-row']);
  assert.equal(block.rows.filter(row => knowledgeRowMatches(block, row.cells, 'capacity')).length, 2);
});

test('price-history search keeps supplier identity for each grade and excludes other ports', () => {
  const state = createSeedState();
  state.outcomes = [{ id: 'split', enquiryId: 'enquiry', kind: 'fixture', buyerId: 'buyer', portId: 'port-singapore', vessel: 'NORTH STAR',
    grade: 'VLSFO', quantity: 580, price: 650, margin: 15, owner: 'otto', reason: '', bookedAt: '2026-10-06T09:00:00Z', supplierName: 'Legacy supplier', stemProducts: [
    { grade: 'VLSFO', quantityText: '500', buyPrice: 555, supplierName: 'First supplier', supplierId: 'first' },
    { grade: 'LSMGO', quantityText: '80', buyPrice: 777, supplierName: 'Second supplier', supplierId: 'second' },
  ] }];
  assert.equal(portBuyPriceRows(state, 'port-singapore').length, 2);
  assert.deepEqual(portBuyPriceRows(state, 'port-singapore', 'second').map(row => row.grade), ['LSMGO']);
  assert.equal(portBuyPriceRows(state, 'port-singapore', '6 Oct 2026').length, 2);
  assert.equal(portBuyPriceRows(state, 'port-singapore', 'north 777')[0].supplier, 'Second supplier');
  assert.equal(portBuyPriceRows(state, 'port-hong-kong', 'north').length, 0);
});
