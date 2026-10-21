import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { historicalSupplierFixtures } from '../src/lib/historicalSupplierFixtures';
import { activeAttachmentCatalog, buildAttachmentFolders, type AttachmentCatalog, type AttachmentItem } from '../src/lib/attachments';
import { applyAction, actors, type Action } from '../src/lib/model';
import { retireFictionalSupplierRecords } from '../src/lib/supplierRetirement';
import type { KnowledgeDocument } from '../src/lib/knowledge';

const retired = historicalSupplierFixtures[0];
const doc: KnowledgeDocument = { version: 4, layoutVersion: 2, sections: [{ id: 'suppliers', title: 'Suppliers', role: 'suppliers', blocks: [{ id: 'operator-note', type: 'text', title: 'Operator note', text: 'PRESERVE THIS NOTE' }, { id: 'edited-supply-table', type: 'table', title: 'Supply options', columns: [{ id: 'supplier', name: 'Supplier', width: 200 }, { id: 'remarks', name: 'Remarks', width: 200 }], rows: [{ id: 'retired-row', cells: [retired.name, 'old entry'] }, { id: 'legacy-row', cells: ['Meridian Bunker Supply · Demo', 'retired alias'] }, { id: 'real-row', cells: ['SYNTHETIC SUPPLIER', 'USER EDIT TO KEEP'] }, { id: 'lookalike', cells: ['Aster Marine Supply International', 'KEEP SIMILAR NAME'] }] }] }] };

test('retirement removes exact fictional current knowledge, archives edits, preserves financial/history/custom content and is idempotent', () => {
  const state = createSeedState();
  delete state.supplierRetirementVersion;
  state.knowledgeRecords = { 'port:port-singapore': structuredClone(doc), [`supplier:${retired.id}`]: structuredClone(doc), 'supplier:custom-real-id': { version: 2, sections: [{ id: 'general', title: 'Supplier information', blocks: [{ id: 'real-note', type: 'text', title: 'Real supplier', text: 'DO NOT DELETE' }] }] } };
  state.outcomes[0].supplierId = retired.id; state.outcomes[0].supplierName = retired.name;
  state.knowledgeHistory = [{ id: 'history', target: { kind: 'port', id: 'port-singapore' }, before: structuredClone(doc), after: structuredClone(doc), at: '2026-10-14', actor: 'otto', reason: 'Existing edit' } as never];
  const before = structuredClone(state), result = retireFictionalSupplierRecords(state);
  assert.deepEqual(state, before);
  assert.equal(result.knowledgeRecords?.[`supplier:${retired.id}`], undefined);
  assert.deepEqual(result.retiredSupplierKnowledge?.[`supplier:${retired.id}`], doc);
  assert.deepEqual(result.retiredSupplierKnowledge?.['port:port-singapore'], doc);
  const active = result.knowledgeRecords?.['port:port-singapore'];
  assert.ok(!JSON.stringify(active).includes('retired alias'));
  assert.match(JSON.stringify(active), /KEEP SIMILAR NAME/);
  const table = active?.sections.flatMap(section => section.blocks).find(block => block.type === 'table'); assert.equal(table?.type === 'table' && table.rows.some(row => row.cells[0] === retired.name), false);
  assert.match(JSON.stringify(active), /USER EDIT TO KEEP/); assert.match(JSON.stringify(active), /PRESERVE THIS NOTE/);
  assert.deepEqual(result.knowledgeRecords?.['supplier:custom-real-id'], before.knowledgeRecords?.['supplier:custom-real-id']);
  assert.deepEqual(result.outcomes, before.outcomes); assert.deepEqual(result.enquiries, before.enquiries); assert.deepEqual(result.knowledgeHistory, before.knowledgeHistory);
  assert.strictEqual(retireFictionalSupplierRecords(result), result);
  const upgraded = upgradeDemoState(result); assert.strictEqual(upgradeDemoState(upgraded), upgraded);
});

test('fresh prototype data cannot seed fictional supplier profiles, current port rows or active attachment folders', () => {
  const state = createSeedState();
  for (const supplier of historicalSupplierFixtures) {
    assert.equal(state.knowledgeRecords?.[`supplier:${supplier.id}`], undefined);
    assert.ok(!JSON.stringify(state.knowledgeRecords).includes(supplier.name));
    assert.ok(!buildAttachmentFolders(state, { items: [], folders: [] }).some(folder => folder.scope?.target.id === supplier.id));
  }
  assert.equal(buildAttachmentFolders(state, { items: [], folders: [] }).filter(folder => folder.scope?.target.kind === 'supplier').length, 0, 'No catalog is invented when authenticated references are unavailable');
  const references = { suppliers: [{ id: 'synthetic-supplier', name: 'SYNTHETIC SUPPLIER' }] };
  const supplierFolders = buildAttachmentFolders(state, { items: [], folders: [] }, undefined, references).filter(folder => folder.scope?.target.kind === 'supplier');
  assert.deepEqual(supplierFolders.map(folder => [folder.scope?.target.id, folder.name]), [['synthetic-supplier', 'SYNTHETIC SUPPLIER']]);
});

test('retired attachment roots, section paths, recursive descendants, items and current scope remain hidden without storage deletion', () => {
  const root = `supplier:${retired.id}`;
  const item = (id: string, folderId: string, target = { kind: 'supplier' as const, id: retired.id }): AttachmentItem => ({ id, folderId, scope: { target }, name: id, type: 'link', mime: '', size: 0, createdAt: '', createdBy: '', url: 'https://example.test' });
  const catalog: AttachmentCatalog = { folders: [{ id: 'child', parentId: root, name: 'Retired child' }, { id: 'grandchild', parentId: 'child', name: 'Retired nested child' }, { id: `${root}:section:legacy`, parentId: 'suppliers', name: 'Retired section' }, { id: 'real-custom', parentId: 'supplier:synthetic-supplier', name: 'Keep', scope: { target: { kind: 'supplier', id: 'synthetic-supplier' } } }], items: [item('retired', root), item('orphan', 'missing'), item('nested', 'grandchild', { kind: 'supplier', id: 'synthetic-supplier' }), item('keep', 'real-custom', { kind: 'supplier', id: 'synthetic-supplier' })] };
  const before = structuredClone(catalog), active = activeAttachmentCatalog(catalog);
  assert.deepEqual(active.folders.map(folder => folder.id), ['real-custom']); assert.deepEqual(active.items.map(item => item.id), ['keep']); assert.deepEqual(catalog, before);
  const folders = buildAttachmentFolders(createSeedState(), catalog, { target: { kind: 'supplier', id: retired.id } });
  assert.ok(!folders.some(folder => folder.id === root || folder.id === 'grandchild'));
});

test('STEM fails closed without a shared catalog, rejects retired and unknown suppliers, and snapshots the real catalog name', () => {
  const state = createSeedState(), actor = actors[0], buyer = state.companies[0]; buyer.limit = 1e8; buyer.exposure = 0; buyer.creditStatus = 'Active';
  state.enquiries = [{ id: 'new', buyerId: buyer.id, portId: 'port-singapore', vessel: 'TEST', imo: '', eta: '', grade: 'VLSFO', quantity: 1, price: 0, margin: 0, rawText: '', formattedText: '', status: 'sent', createdAt: new Date().toISOString(), owner: actor.id, products: [{ grade: 'VLSFO', quantityText: '1' }] }];
  const real = { id: '91000000-0000-4000-8000-000000000001', name: 'REAL SHARED SUPPLIER' };
  const action: Action = { type: 'record-stem', id: 'new', complianceChecked: true, creditChecked: true, products: [{ grade: 'VLSFO', quantityText: '1', buyPrice: 1, supplierId: real.id, supplierName: 'FORGED' }] };
  assert.throws(() => applyAction(state, action, actor), /Choose a supplier/);
  const saved = applyAction(state, action, actor, undefined, { suppliers: [real] }); assert.equal(saved.outcomes[0].supplierName, real.name);
  for (const id of [retired.id, 'unknown']) { const changed = structuredClone(action); if (changed.type === 'record-stem') changed.products[0].supplierId = id; assert.throws(() => applyAction(state, changed, actor, undefined, { suppliers: [real, { id: retired.id, name: 'FORGED' }] }), /Choose a supplier/); }
});


test('older scenario and knowledge upgrades cannot recreate retired supplier data after cleanup', () => {
  const state = createSeedState();
  delete state.supplierRetirementVersion; delete state.demoScenarioVersion; delete state.knowledgeLayoutVersion;
  state.knowledgeRecords![`supplier:${retired.id}`] = structuredClone(doc);
  const upgraded = upgradeDemoState(state);
  for (const supplier of historicalSupplierFixtures) assert.equal(upgraded.knowledgeRecords?.[`supplier:${supplier.id}`], undefined);
  assert.ok(!JSON.stringify(upgraded.knowledgeRecords).includes(retired.name));
  assert.deepEqual(upgraded.retiredSupplierKnowledge?.[`supplier:${retired.id}`], doc);
  assert.strictEqual(upgradeDemoState(upgraded), upgraded);
});
