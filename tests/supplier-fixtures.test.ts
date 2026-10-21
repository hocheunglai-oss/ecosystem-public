import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeDemoState } from '../src/lib/seed';
import { createSupplierKnowledgeState as createSeedState } from './fixtures/knowledgeSuppliers';
import { actors, applyAction, type DemoState, type Outcome } from '../src/lib/model';
import { indexSupplierFixtures, querySupplierFixtures } from '../src/lib/supplierFixtures';
import { knowledgeDocument, validateKnowledge, withDefaultKnowledgeSections, isReadOnlyKnowledgeSection, type KnowledgeDocument, type KnowledgeChange } from '../src/lib/knowledge';

const supplier = { kind: 'supplier', id: 'synthetic-supplier' } as const;
const at = '2026-10-06T10:00:00.000Z';
const trader = actors.find(actor => actor.id === 'otto')!;
const admin = actors.find(actor => actor.role === 'admin')!;
const baseOutcome: Outcome = { id: 'fixture-a', enquiryId: 'enquiry-a', kind: 'fixture', buyerId: 'company-meridian', portId: 'port-singapore', vessel: 'VESSEL A', grade: 'VLSFO', quantity: 500, price: 600, margin: 15, bookedAt: at, owner: trader.id, reason: '', supplierId: supplier.id, supplierName: 'SYNTHETIC SUPPLIER' };
const readFixtures = (document: KnowledgeDocument) => document.sections.find(section => section.role === 'supplier-fixtures');
function change(state: DemoState, edit: (doc: KnowledgeDocument) => void): KnowledgeChange {
  const baseDocument = knowledgeDocument(state, supplier), document = structuredClone(baseDocument); edit(document);
  return { target: supplier, baseVersion: baseDocument.version, baseDocument, document };
}

test('supplier fixture projection retains only exact matching grade IDs and never exposes another supplier price', () => {
  const state = createSeedState();
  state.outcomes = [{ ...baseOutcome, stemProducts: [
    { grade: 'VLSFO', quantityText: '500–600', buyPrice: 550, supplierId: supplier.id },
    { grade: 'LSMGO', quantityText: '70', buyPrice: 799, supplierId: 'other-supplier', supplierName: 'Other supplier' },
    { grade: 'HSFO', quantityText: '300', buyPrice: 410, supplierName: 'SYNTHETIC SUPPLIER' },
  ] }, { ...baseOutcome, id: 'name-only', supplierId: undefined, supplierName: 'SYNTHETIC SUPPLIER' }, { ...baseOutcome, id: 'same-name-different-id', supplierId: 'other-supplier', supplierName: 'SYNTHETIC SUPPLIER' }, { ...baseOutcome, id: 'lost', kind: 'lost' }];
  const before = structuredClone(state);
  const rows = indexSupplierFixtures(state, trader, supplier.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'fixture-a');
  assert.deepEqual(rows[0].productLines.map(line => [line.grade, line.quantityText, line.buyPrice]), [['VLSFO', '500–600', 550]]);
  assert.equal(JSON.stringify(rows).includes('799'), false);
  assert.equal(JSON.stringify(rows).includes('other-supplier'), false);
  assert.equal(querySupplierFixtures(rows, { search: 'LSMGO' }).total, 0);
  assert.equal(querySupplierFixtures(rows, { search: 'HSFO' }).total, 0);
  assert.equal(querySupplierFixtures(rows, { search: 'aster singapore vlsfo' }).total, 1);
  assert.deepEqual(state, before);
});

test('fixture visibility follows existing actor ownership and does not fabricate aggregate snapshot transactions', () => {
  const state = createSeedState();
  state.outcomes = [{ ...baseOutcome }, { ...baseOutcome, id: 'other-owner', owner: 'joe' }];
  assert.equal(indexSupplierFixtures(state, trader, supplier.id).length, 1);
  assert.equal(indexSupplierFixtures(state, admin, supplier.id).length, 2);
  const manager = actors.find(actor => actor.role === 'manager')!;
  assert.equal(indexSupplierFixtures(state, manager, supplier.id).length, state.outcomes.filter(row => row.owner === manager.id).length);
  const credit = actors.find(actor => actor.role === 'credit')!;
  assert.equal(indexSupplierFixtures(state, credit, supplier.id).length, 2);
  assert.deepEqual(indexSupplierFixtures(createSeedState(), trader, supplier.id), []);
  assert.deepEqual(indexSupplierFixtures(state, trader, ''), []);
});

test('legacy header IDs and retired source IDs still match without inventing buy prices or changing records', () => {
  const state = createSeedState();
  state.outcomes = [
    { ...baseOutcome, supplierId: 'retired-source-id', products: [{ grade: 'VLSFO', quantity: 500, price: 600, margin: 15 }] },
    { ...baseOutcome, id: 'legacy-stem', supplierId: 'retired-source-id', stemProducts: [{ grade: 'HSFO', quantityText: '400–500', buyPrice: 401 }] },
  ];
  const before = structuredClone(state.outcomes);
  const rows = indexSupplierFixtures(state, trader, 'retired-source-id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].productLines[0].buyPrice, undefined);
  assert.equal(rows[1].productLines[0].buyPrice, 401);
  assert.deepEqual(state.outcomes, before);
});

test('large supplier fixture queries filter before sorting and pagination without mutations or boundary duplication', () => {
  const state = createSeedState();
  state.outcomes = Array.from({ length: 5000 }, (_, i) => ({ ...baseOutcome, id: `fixture-${i}`, vessel: `VESSEL ${i}`, bookedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), stemProducts: [{ grade: i % 2 ? 'LSMGO' : 'VLSFO', quantityText: String(i), buyPrice: 500 + i, supplierId: supplier.id }] }));
  const rows = indexSupplierFixtures(state, trader, supplier.id), before = structuredClone(rows);
  const first = querySupplierFixtures(rows), second = querySupplierFixtures(rows, { page: 1 });
  assert.equal(first.total, 5000); assert.equal(first.rows.length, 50); assert.equal(first.pages, 100);
  assert.equal(first.rows[0].id, 'fixture-4999'); assert.equal(second.rows[0].id, 'fixture-4949');
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 100);
  const filtered = querySupplierFixtures(rows, { search: 'vlsfo', sort: 'vessel', direction: 'asc', pageSize: 100, page: 1 });
  assert.equal(filtered.total, 2500); assert.equal(filtered.rows[0].vessel, 'VESSEL 200'); assert.equal(filtered.rows.length, 100);
  assert.equal(querySupplierFixtures(rows, { pageSize: 25, page: 9999 }).rows.length, 25);
  assert.equal(querySupplierFixtures(rows, { search: 'missing', page: 50 }).page, 0);
  assert.equal(querySupplierFixtures(rows, { pageSize: 3, page: -20 }).pageSize, 50);
  assert.equal(querySupplierFixtures(rows, { page: Number.NaN }).page, 0);
  assert.deepEqual(rows, before);
});

test('date sorting keeps unknown dates last and tie order stable in either direction', () => {
  const state = createSeedState();
  state.outcomes = [{ ...baseOutcome, id: 'b' }, { ...baseOutcome, id: 'a' }, { ...baseOutcome, id: 'unknown', bookedAt: 'unknown' }];
  const rows = indexSupplierFixtures(state, trader, supplier.id);
  assert.deepEqual(querySupplierFixtures(rows).rows.map(row => row.id), ['a', 'b', 'unknown']);
  assert.deepEqual(querySupplierFixtures(rows, { direction: 'asc' }).rows.map(row => row.id), ['a', 'b', 'unknown']);
});

test('managed supplier migration adds only Fixtures once, keeping removed defaults, custom IDs, audits and history', () => {
  const state = createSeedState();
  const stamp = { updatedBy: 'otto', updatedAt: at };
  const document: KnowledgeDocument = { version: 8, layoutVersion: 2, sections: [
    { id: 'saved-docs', title: 'Library', role: 'uploaded-documents', blocks: [{ id: 'supplier-fixtures', type: 'file', title: 'Terms', url: 'https://example.com/terms.pdf', update: stamp }] },
    { id: 'custom-fixtures', title: 'Fixtures', blocks: [{ id: 'saved-text', type: 'text', title: 'Note', text: 'Saved notes', update: stamp }] },
  ] };
  state.knowledgeRecords = { 'supplier:synthetic-supplier': document };
  state.knowledgeHistory = [{ target: supplier, version: 8, at, by: 'otto', reason: 'Earlier revision', before: { version: 7, sections: [] }, after: structuredClone(document) }];
  const before = structuredClone(state), upgraded = upgradeDemoState(state), migrated = knowledgeDocument(upgraded, supplier);
  assert.equal(migrated.version, 8); assert.equal(migrated.supplierFixturesVersion, 1);
  assert.equal(migrated.sections.length, 3); assert.equal(migrated.sections[1].role, 'supplier-fixtures');
  assert.equal(readFixtures(migrated)!.title, 'Fixtures (records)');
  assert.notEqual(readFixtures(migrated)!.id, 'supplier-fixtures');
  assert.deepEqual(migrated.sections.filter(section => section.role !== 'supplier-fixtures'), document.sections);
  assert.deepEqual(upgraded.knowledgeHistory, before.knowledgeHistory); assert.deepEqual(state, before);
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(upgraded))), upgraded);
  validateKnowledge(migrated);
});

test('Fixtures can be renamed, removed and restored without regeneration or entry attribution changes', () => {
  let state = createSeedState();
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [change(state, doc => { readFixtures(doc)!.title = 'Previous fixtures'; })] }, trader, at);
  state = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.equal(readFixtures(knowledgeDocument(state, supplier))!.title, 'Previous fixtures');
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [change(state, doc => { doc.sections = doc.sections.filter(section => section.role !== 'supplier-fixtures'); })] }, trader, at);
  state = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.equal(readFixtures(knowledgeDocument(state, supplier)), undefined);
  assert.equal(state.knowledgeRecords!['supplier:synthetic-supplier'].supplierFixturesVersion, 1);
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [change(state, doc => doc.sections.push({ id: 'restored-fixtures', title: 'Fixtures', role: 'supplier-fixtures', blocks: [] }))] }, trader, at);
  assert.equal(readFixtures(knowledgeDocument(state, supplier))!.id, 'restored-fixtures');
  assert.ok(isReadOnlyKnowledgeSection(readFixtures(knowledgeDocument(state, supplier))!));
  assert.equal(state.knowledgeHistory!.length, 3);
  const content = change(state, doc => readFixtures(doc)!.blocks.push({ id: 'hidden', type: 'text', title: 'Note', text: 'Hidden text' }));
  assert.throws(() => applyAction(state, { type: 'save-knowledge', change: content, reason: '' }, trader, at), /recorded fixtures/);
});

test('pre-Fixtures managed pending amendments remain compatible while stale saves stay rejected', () => {
  const state = createSeedState();
  const base = knowledgeDocument(state, supplier); delete base.supplierFixturesVersion;
  base.sections = base.sections.filter(section => section.role !== 'supplier-fixtures');
  base.version = 9;
  base.sections[0].blocks.push({ id: 'note-before-fixtures', type: 'text', title: 'Note', text: 'Before' });
  state.knowledgeRecords = { 'supplier:synthetic-supplier': structuredClone(base) };
  const document = structuredClone(base);
  const block = document.sections[0].blocks[0]; if (block.type !== 'text') throw new Error('Expected text'); block.text = 'After';
  const pending: KnowledgeChange = { target: supplier, baseVersion: 9, baseDocument: base, document };
  state.contributions.unshift({ id: 'pre-fixtures', targetType: 'supplier', targetId: supplier.id, title: 'Earlier draft', body: 'Verified', author: trader.id, createdAt: at, status: 'pending', knowledgeChange: pending });
  const upgraded = upgradeDemoState(state);
  const saved = applyAction(upgraded, { type: 'review-contribution', id: 'pre-fixtures', approve: true, note: 'Approved' }, admin, at);
  assert.equal(knowledgeDocument(saved, supplier).version, 10);
  assert.match(JSON.stringify(knowledgeDocument(saved, supplier)), /After/);
  assert.ok(readFixtures(knowledgeDocument(saved, supplier)));
  assert.throws(() => applyAction(saved, { type: 'save-knowledge', change: pending, reason: '' }, trader, at), /Information changed/);
});

test('legacy Fixtures notes remain editable custom content and supplier-only roles are rejected elsewhere', () => {
  const legacy: KnowledgeDocument = { version: 4, sections: [{ id: 'supplier-fixtures', title: 'Fixtures', blocks: [{ id: 'note', type: 'text', title: 'Note', text: 'Existing fixture observations' }] }] };
  const migrated = withDefaultKnowledgeSections(legacy, 'supplier');
  assert.equal(migrated.sections[0].role, undefined); assert.deepEqual(migrated.sections[0].blocks, legacy.sections[0].blocks);
  assert.equal(readFixtures(migrated)!.title, 'Fixtures (records)');
  assert.equal(readFixtures(migrated)!.blocks.length, 0); validateKnowledge(migrated);
  const state = createSeedState(), target = { kind: 'company', id: 'company-meridian' } as const;
  const baseDocument = knowledgeDocument(state, target), document = structuredClone(baseDocument);
  document.sections.push({ id: 'invalid-fixtures', title: 'Fixtures', role: 'supplier-fixtures', blocks: [] });
  assert.throws(() => applyAction(state, { type: 'save-knowledge', change: { target, baseVersion: 0, baseDocument, document }, reason: '' }, trader, at), /belong to a supplier/);
});

test('managed and legacy Fixtures title collisions keep custom names and choose one stable distinct records label', () => {
  for (const managed of [false, true]) {
    const document: KnowledgeDocument = { version: 7, ...(managed ? { layoutVersion: 2 as const } : {}), sections: [
      { id: 'custom-fixtures', title: ' fixtures ', blocks: [{ id: 'custom-note', type: 'text', title: 'Note', text: 'Preserved custom note', update: { updatedBy: 'otto', updatedAt: at } }] },
      { id: 'custom-records', title: 'FIXTURES (RECORDS)', blocks: [] },
      { id: 'custom-numbered', title: 'Fixtures (records) 2', blocks: [] },
    ] };
    const before = structuredClone(document), state = createSeedState();
    state.knowledgeRecords = { 'supplier:synthetic-supplier': document };
    const upgraded = upgradeDemoState(state), migrated = knowledgeDocument(upgraded, supplier);
    assert.equal(readFixtures(migrated)!.title, 'Fixtures (records) 3');
    for (const custom of before.sections) assert.deepEqual(migrated.sections.find(section => section.id === custom.id), custom);
    assert.deepEqual(document, before);
    assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(upgraded))), upgraded);
    assert.deepEqual(withDefaultKnowledgeSections(migrated, 'supplier'), migrated);
    validateKnowledge(migrated);
  }
  assert.equal(readFixtures(knowledgeDocument(createSeedState(), supplier))!.title, 'Fixtures', 'Ordinary new profiles retain the requested label');
});

test('already migrated Fixtures titles are never renamed by collision handling', () => {
  for (const title of ['Fixtures', 'OUR FIXTURE RECORDS']) {
    const document: KnowledgeDocument = { version: 5, layoutVersion: 2, supplierFixturesVersion: 1, sections: [
      { id: 'custom', title, blocks: [{ id: 'custom-note', type: 'text', title: 'Note', text: 'Custom content' }] },
      { id: 'saved-fixtures', title, role: 'supplier-fixtures', blocks: [] },
    ] };
    const state = createSeedState(); state.knowledgeRecords = { 'supplier:synthetic-supplier': document };
    assert.deepEqual(knowledgeDocument(upgradeDemoState(state), supplier), document);
  }
});
