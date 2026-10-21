import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeDemoState } from '../src/lib/seed';
import { createSupplierKnowledgeState as createSeedState } from './fixtures/knowledgeSuppliers';
import { actors, applyAction, personalResources, type DemoState } from '../src/lib/model';
import { knowledgeDocument, knowledgeEntryUpdate, withDefaultKnowledgeSections, validateKnowledge, type KnowledgeChange, type KnowledgeDocument, type KnowledgeTarget } from '../src/lib/knowledge';

const supplier: KnowledgeTarget = { kind: 'supplier', id: 'synthetic-supplier' };
const at = '2026-10-06T08:00:00.000Z';
const later = '2026-10-06T09:00:00.000Z';
const stamp = { updatedBy: actors[0].id, updatedAt: at };
function change(state: DemoState, target: KnowledgeTarget, edit: (document: KnowledgeDocument) => void): KnowledgeChange {
  const baseDocument = knowledgeDocument(state, target), document = structuredClone(baseDocument);
  edit(document);
  return { target, baseDocument, baseVersion: baseDocument.version, document };
}
function legacy(): KnowledgeDocument {
  return { version: 7, sections: [
    { id: 'general', title: 'General Information', blocks: [
      { id: 'legacy-note', type: 'text', title: 'Delivery', text: 'Confirmed delivery details.', update: stamp },
      { id: 'legacy-table', type: 'table', title: 'Contacts', columns: [{ id: 'legacy-column', name: 'Desk' }], rows: [{ id: 'legacy-row', cells: ['Operations'], update: stamp }] },
      { id: 'legacy-file', type: 'file', title: 'Terms', url: 'https://example.com/terms.pdf', update: stamp },
    ] },
    { id: 'custom', title: 'Custom contacts', blocks: [{ id: 'trader-remarks', type: 'text', title: 'Note', text: 'Existing custom content.' }] },
  ] };
}

test('supplier defaults are separate from location defaults and companies retain their existing layout', () => {
  const state = createSeedState();
  const originalRecords = structuredClone(state.knowledgeRecords);
  const document = knowledgeDocument(state, supplier);
  assert.deepEqual(document.sections.map(section => [section.title, section.role]), [
    ['Supplier Information', 'supplier-information'], ["Trader's Remarks", 'trader-remarks'], ['Uploaded Documents', 'uploaded-documents'], ['Fixtures', 'supplier-fixtures'],
  ]);
  assert.equal(document.sections[0].id, 'general');
  assert.equal(document.layoutVersion, 2);
  assert.equal(document.supplierFixturesVersion, 1);
  const company = knowledgeDocument(state, { kind: 'company', id: 'company-meridian' });
  assert.equal(company.sections[0].title, 'General Information');
  assert.equal(company.layoutVersion, undefined);
  assert.deepEqual(state.knowledgeRecords, originalRecords);
});

test('existing supplier records migrate once without changing IDs, versions, custom tabs, audits or revision history', () => {
  const state = createSeedState(), document = legacy();
  state.knowledgeRecords = { 'supplier:synthetic-supplier': document };
  state.knowledgeHistory = [{ target: supplier, version: 7, at, by: actors[0].id, reason: 'Original record', before: { version: 6, sections: [] }, after: structuredClone(document) }];
  const before = structuredClone(state);
  const upgraded = upgradeDemoState(state);
  const result = knowledgeDocument(upgraded, supplier);
  assert.equal(result.version, 7);
  assert.equal(result.layoutVersion, 2);
  assert.deepEqual(result.sections[0], { ...document.sections[0], title: 'Supplier Information', role: 'supplier-information', blocks: document.sections[0].blocks.slice(0, 2) });
  assert.deepEqual(result.sections.find(section => section.id === 'custom'), document.sections[1]);
  assert.deepEqual(result.sections.find(section => section.role === 'uploaded-documents')!.blocks, [document.sections[0].blocks[2]]);
  assert.notEqual(result.sections.find(section => section.role === 'trader-remarks')!.id, 'trader-remarks', 'New tab IDs cannot collide with existing block IDs');
  assert.deepEqual(knowledgeEntryUpdate(upgraded, supplier, 'legacy-note'), stamp);
  assert.deepEqual(knowledgeEntryUpdate(upgraded, supplier, 'legacy-table', 'legacy-row'), stamp);
  assert.deepEqual(upgraded.knowledgeHistory, before.knowledgeHistory);
  assert.deepEqual(state, before, 'Migration must not mutate the prior state');
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(upgraded))), upgraded);
  validateKnowledge(result);
});

test('renamed legacy general tab keeps its name and supplier role without altering company layouts', () => {
  const document = legacy();
  document.sections[0].title = 'Delivery desk';
  const result = withDefaultKnowledgeSections(document, 'supplier');
  assert.equal(result.sections[0].title, 'Delivery desk');
  assert.equal(result.sections[0].role, 'supplier-information');
  assert.equal(result.sections[0].id, 'general');
  assert.equal(withDefaultKnowledgeSections(document, 'company'), document);
});

test('all roles can update supplier tabs with one publication and reward; stale saves cannot overwrite information', () => {
  for (const actor of actors) {
    const state = createSeedState(), gold = personalResources(state, actor.id).gold;
    const update = change(state, supplier, document => { document.sections[0].title = 'Supply profile'; });
    const next = applyAction(state, { type: 'manage-knowledge-tabs', changes: [update] }, actor, at);
    assert.equal(knowledgeDocument(next, supplier).sections[0].title, 'Supply profile');
    assert.equal(knowledgeDocument(next, supplier).sections[0].role, 'supplier-information');
    assert.equal(next.contributions[0].targetType, 'supplier');
    assert.equal(next.knowledgeHistory![0].target.kind, 'supplier');
    assert.equal(personalResources(next, actor.id).gold, gold + 1);
    const snapshot = structuredClone(next);
    assert.throws(() => applyAction(next, { type: 'manage-knowledge-tabs', changes: [update] }, actor, later), /Information changed/);
    assert.deepEqual(next, snapshot);
  }
});

test('supplier tab removal persists after reload, restored roles stay functional, and removed content remains in history', () => {
  let state = createSeedState();
  const note = change(state, supplier, document => document.sections[0].blocks.push({ id: 'supplier-note', type: 'text', title: 'Note', text: 'Verified supplier delivery details.' }));
  state = applyAction(state, { type: 'save-knowledge', change: note, reason: 'Verified' }, actors[0], at);
  const rename = change(state, supplier, document => { document.sections[0].title = 'Desk information'; });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [rename] }, actors[1], later);
  assert.deepEqual(knowledgeEntryUpdate(state, supplier, 'supplier-note'), stamp);
  const removal = change(state, supplier, document => { document.sections = document.sections.filter(section => section.role === 'trader-remarks'); });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [removal] }, actors[1], later);
  state = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(knowledgeDocument(state, supplier).sections.map(section => section.role), ['trader-remarks']);
  assert.match(JSON.stringify(state.knowledgeHistory![0].before), /Verified supplier delivery details/);
  const restore = change(state, supplier, document => document.sections.push(
    { id: 'restored-supplier-information', title: 'Operations', role: 'supplier-information', blocks: [] },
    { id: 'restored-supplier-documents', title: 'References', role: 'uploaded-documents', blocks: [] },
  ));
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [restore] }, actors[1], later);
  const files = change(state, supplier, document => document.sections.find(section => section.role === 'uploaded-documents')!.blocks.push({ id: 'new-file', type: 'file', title: 'Current terms', url: 'https://example.com/current.pdf' }));
  state = applyAction(state, { type: 'save-knowledge', change: files, reason: 'Current terms' }, actors[0], later);
  const result = knowledgeDocument(upgradeDemoState(JSON.parse(JSON.stringify(state))), supplier);
  assert.equal(result.sections.find(section => section.role === 'supplier-information')?.title, 'Operations');
  assert.equal(result.sections.find(section => section.role === 'uploaded-documents')?.blocks[0].id, 'new-file');
  assert.match(JSON.stringify(state.knowledgeHistory), /Verified supplier delivery details/);
});

test('supplier Manage Tabs rejects cross-record batches, missing tabs, role forgery and hidden content edits atomically', () => {
  const state = createSeedState(), before = structuredClone(state);
  const renamed = change(state, supplier, document => { document.sections[0].title = 'Supplier details'; });
  const port = change(state, { kind: 'port', id: 'port-singapore' }, document => { document.sections[0].title = 'Operations'; });
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [renamed, port] }, actors[0], at), /one supplier profile/);
  const empty = change(state, supplier, document => { document.sections = []; });
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [empty] }, actors[0], at), /at least one tab/);
  const forged = change(state, supplier, document => { document.sections[0].role = undefined; });
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [forged] }, actors[0], at), /type unchanged/);
  const content = change(state, supplier, document => document.sections[0].blocks.push({ id: 'not-a-tab-change', type: 'text', title: 'Note', text: 'Hidden content edit' }));
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [content] }, actors[0], at), /Edit information separately/);
  for (const role of ['port-information', 'price-history', 'refineries'] as const) {
    const invalid = change(state, supplier, document => document.sections.push({ id: 'wrong-role', title: 'Wrong role', role, blocks: [] }));
    assert.throws(() => applyAction(state, { type: 'save-knowledge', change: invalid, reason: 'Invalid' }, actors[0], at), /belong to a port|supplier tab type/);
  }
  const location = change(state, { kind: 'port', id: 'port-singapore' }, document => document.sections.push({ id: 'supplier-only', title: 'Supplier Information', role: 'supplier-information', blocks: [] }));
  assert.throws(() => applyAction(state, { type: 'save-knowledge', change: location, reason: 'Invalid' }, actors[0], at), /belong to a supplier/);
  assert.deepEqual(state, before);
});

test('legacy supplier amendments survive migration without replacing source identity or history', () => {
  const state = createSeedState(), base = legacy(), document = structuredClone(base);
  const block = document.sections[0].blocks[0];
  if (block.type !== 'text') throw new Error('Expected text');
  block.text = 'Amended delivery details from the original supplier draft.';
  state.knowledgeRecords = { 'supplier:synthetic-supplier': base };
  state.contributions.unshift({ id: 'supplier-legacy-review', targetType: 'supplier', targetId: supplier.id, title: 'Legacy update', body: 'Source verified', author: actors[0].id, createdAt: at, status: 'pending', knowledgeChange: { target: supplier, baseVersion: 7, baseDocument: structuredClone(base), document } });
  const migrated = upgradeDemoState(state);
  const approved = applyAction(migrated, { type: 'review-contribution', id: 'supplier-legacy-review', approve: true, note: 'Confirmed' }, actors.find(actor => actor.role === 'admin')!, later);
  const result = knowledgeDocument(approved, supplier);
  assert.equal(result.version, 8);
  assert.equal(result.sections[0].id, 'general');
  assert.match(JSON.stringify(result), /Amended delivery details/);
  assert.equal(approved.knowledgeHistory![0].target.id, supplier.id);
});
