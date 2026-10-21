import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { knowledgeDocument, knowledgeEntryUpdate, knowledgeKeyInfoUpdate, knowledgeKey, validateKnowledge, type KnowledgeBlock, type KnowledgeDocument, type KnowledgeTarget } from '../src/lib/knowledge';
import { buildExtractionBatch, type ReviewProposal } from '../src/lib/knowledgeExtraction';
import { emptyIntelligenceKeyInfo } from '../src/lib/intelligenceFields';

const target: KnowledgeTarget = { kind: 'port', id: 'port-chiba' };
const firstAt = '2026-10-05T08:00:00.000Z';
const laterAt = '2026-10-06T08:00:00.000Z';
function save(state: ReturnType<typeof createSeedState>, document: KnowledgeDocument, actor = actors[0], at = firstAt, destination = target) {
  const base = knowledgeDocument(state, destination);
  return applyAction(state, { type: 'save-knowledge', change: { target: destination, baseVersion: base.version, baseDocument: base, document }, reason: 'Confirmed source' }, actor, at);
}
function rows(document: KnowledgeDocument) {
  return document.sections.flatMap(section => section.blocks).find(block => block.id === 'delivery-table') as Extract<KnowledgeBlock, { type: 'table' }>;
}

test('every country and port has the requested default tabs, with independent Hong Kong records', () => {
  const state = createSeedState();
  const expected = ['Suppliers', 'Refineries', 'Grades and delivery modes', 'Tax and regulations', "Trader's Remarks", 'Uploaded Documents'];
  assert.deepEqual(knowledgeDocument(state, { kind: 'country', id: 'Hong Kong' }).sections.map(section => section.title), expected);
  assert.deepEqual(knowledgeDocument(state, { kind: 'port', id: 'port-hong-kong' }).sections.map(section => section.title), ['Port Information', ...expected, 'Price History']);
  const country = { kind: 'country' as const, id: 'Hong Kong' }, document = knowledgeDocument(state, country);
  document.sections[0].blocks.push({ id: 'country-only', type: 'text', title: 'Note', text: 'Country supplier conditions.' });
  const saved = save(state, document, actors[0], firstAt, country);
  assert.match(JSON.stringify(knowledgeDocument(saved, country)), /Country supplier conditions/);
  assert.doesNotMatch(JSON.stringify(knowledgeDocument(saved, { kind: 'port', id: 'port-hong-kong' })), /Country supplier conditions/);
});

test('changed information and table rows receive publication attribution while unchanged entries retain theirs', () => {
  let state = createSeedState();
  const first = knowledgeDocument(state, target);
  first.sections[0].blocks.push(
    { id: 'kept-note', type: 'text', title: 'Agent', text: 'Keep this note.' },
    { id: 'delivery-table', type: 'table', title: 'Delivery', columns: [{ id: 'place', name: 'Place' }, { id: 'hours', name: 'Hours' }], rows: [{ id: 'first-row', cells: ['North', '09:00'] }, { id: 'second-row', cells: ['South', '10:00'] }] },
  );
  state = save(state, first);
  const original = { updatedBy: actors[0].id, updatedAt: firstAt };
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'kept-note'), original);
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'delivery-table', 'first-row'), original);
  const next = structuredClone(knowledgeDocument(state, target));
  rows(next).rows[0].cells[1] = '11:00';
  // Untrusted editor metadata cannot rewrite the author of an unchanged entry.
  next.sections[0].blocks[0].update = { updatedBy: 'forged', updatedAt: laterAt };
  state = save(state, next, actors[1], laterAt);
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'kept-note'), original);
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'delivery-table', 'second-row'), original);
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'delivery-table', 'first-row'), { updatedBy: actors[1].id, updatedAt: laterAt });
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'delivery-table'), { updatedBy: actors[1].id, updatedAt: laterAt });
  const metadataOnly = structuredClone(knowledgeDocument(state, target));
  metadataOnly.sections[0].blocks[0].update = { updatedBy: 'forged', updatedAt: laterAt };
  assert.throws(() => save(state, metadataOnly), /No changes/);
  assert.deepEqual(knowledgeEntryUpdate(upgradeDemoState(JSON.parse(JSON.stringify(state))), target, 'delivery-table', 'second-row'), original);
});

test('legacy revision attribution is recovered per changed row without guessing unknown authors', () => {
  const state = createSeedState(), before = knowledgeDocument(state, target), after = structuredClone(before);
  before.sections[0].blocks.push({ id: 'delivery-table', type: 'table', title: 'Delivery', columns: [{ id: 'place', name: 'Place' }], rows: [{ id: 'first-row', cells: ['North'] }, { id: 'second-row', cells: ['South'] }] });
  after.sections[0].blocks = structuredClone(before.sections[0].blocks);
  rows(after).rows[0].cells[0] = 'North berth';
  state.knowledgeRecords = { [knowledgeKey(state, target)]: after };
  state.knowledgeHistory = [{ target, version: 1, before, after: structuredClone(after), by: actors[1].id, at: firstAt, reason: 'Legacy update' }];
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'delivery-table', 'first-row'), { updatedBy: actors[1].id, updatedAt: firstAt });
  assert.equal(knowledgeEntryUpdate(state, target, 'delivery-table', 'second-row'), undefined);
  const doc = structuredClone(knowledgeDocument(state, target));
  doc.sections[0].blocks.push({ id: 'new-note', type: 'text', title: 'Note', text: 'Another update.' });
  const saved = save(state, doc, actors[0], laterAt);
  assert.deepEqual(rows(knowledgeDocument(saved, target)).rows[0].update, { updatedBy: actors[1].id, updatedAt: firstAt });
  assert.equal(rows(knowledgeDocument(saved, target)).rows[1].update, undefined);
});

test('layout migration preserves historical combined content, existing country records and custom sections exactly once', () => {
  const state = createSeedState();
  delete state.knowledgeTabsVersion;
  const old: KnowledgeDocument = { version: 5, sections: [
    { id: 'general', title: 'General Information', blocks: [{ id: 'saved-note', type: 'text', title: 'Saved', text: 'Original combined record.' }] },
    { id: 'custom-section', title: 'My own section', blocks: [{ id: 'custom-file', type: 'file', title: 'File', url: 'https://example.com/reference.pdf' }] },
  ] };
  state.knowledgeRecords = {
    'port:port-hong-kong': old,
    'country:Hong Kong': { version: 3, sections: [{ id: 'local', title: 'Local country notes', blocks: [{ id: 'country-note', type: 'text', title: 'Note', text: 'Country-specific information.' }] }] },
    'area:area-tokyo-bay': structuredClone(old),
  };
  state.knowledgeHistory = [{ target: { kind: 'port', id: 'port-hong-kong' }, version: 5, at: firstAt, by: actors[0].id, reason: 'Prior update', before: old, after: old }];
  const history = structuredClone(state.knowledgeHistory), upgraded = upgradeDemoState(state);
  const doc = knowledgeDocument(upgraded, { kind: 'port', id: 'port-hong-kong' });
  assert.equal(doc.version, 5);
  assert.deepEqual(doc.sections.flatMap(section => section.blocks), old.sections.flatMap(section => section.blocks));
  assert.ok(doc.sections.some(section => section.id === 'custom-section' && section.title === 'My own section'));
  assert.match(JSON.stringify(knowledgeDocument(upgraded, { kind: 'country', id: 'Hong Kong' })), /Country-specific information/);
  assert.deepEqual(upgraded.knowledgeRecords?.['area:area-tokyo-bay'], old);
  assert.deepEqual(upgraded.knowledgeHistory, history);
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(upgraded))), upgraded);
  validateKnowledge(doc);
});

test('first plain contributions and reviewed amendments both receive entry-level publication history', () => {
  let state = applyAction(createSeedState(), { type: 'submit-contribution', targetType: 'country', targetId: 'Japan', title: 'Tax', body: 'Confirmed local tax information for this country.' }, actors[0], firstAt);
  const country: KnowledgeTarget = { kind: 'country', id: 'Japan' };
  const block = knowledgeDocument(state, country).sections.flatMap(section => section.blocks).find(block => block.type === 'text' && block.text.includes('Confirmed local'))!;
  assert.deepEqual(knowledgeEntryUpdate(state, country, block.id), { updatedBy: actors[0].id, updatedAt: firstAt });
  assert.equal(state.knowledgeHistory?.[0].target.kind, 'country');
  const base = knowledgeDocument(state, country), amended = structuredClone(base);
  const edited = amended.sections.flatMap(section => section.blocks).find(item => item.id === block.id)!;
  if (edited.type !== 'text') throw new Error('Expected text');
  edited.text = 'Revised confirmed tax information for this country.';
  state.contributions.unshift({ id: 'pending-amendment', targetType: 'country', targetId: 'Japan', title: 'Tax amendment', body: 'Updated source', author: actors[0].id, createdAt: firstAt, status: 'pending', knowledgeChange: { target: country, baseVersion: base.version, baseDocument: base, document: amended } });
  state = applyAction(state, { type: 'review-contribution', id: 'pending-amendment', approve: true, note: 'Source checked' }, actors[2], laterAt);
  assert.deepEqual(knowledgeEntryUpdate(state, country, block.id), { updatedBy: actors[2].id, updatedAt: laterAt });
});

test('extraction and key info track the actor and date per entry and per changed field', () => {
  let state = createSeedState();
  const proposal: ReviewProposal = { id: 'one', selected: true, locationKey: 'port:port-chiba', locationName: 'Chiba', section: 'Port Information', title: 'Quality claim', kind: 'keyInfo', text: '', columns: [], rows: [], field: 'qualityClaim', value: 'Possible', evidence: 'Supplier confirmed a possible quality claim period.', warning: null };
  state = applyAction(state, buildExtractionBatch(state, [proposal], { batchId: 'entry-history' }), actors[0], firstAt);
  const original = { updatedBy: actors[0].id, updatedAt: firstAt };
  assert.deepEqual(knowledgeKeyInfoUpdate(state, target.id, 'qualityClaim'), original);
  assert.deepEqual(knowledgeEntryUpdate(state, target, 'keyinfo-source-qualityClaim'), original);
  const before = state.ports.find(port => port.id === target.id)?.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
  state = applyAction(state, { type: 'save-intelligence', portId: target.id, baseKeyInfo: before, keyInfo: { ...before, isoSpecs: 'All' }, reason: 'Specification confirmed' }, actors[1], laterAt);
  assert.deepEqual(knowledgeKeyInfoUpdate(state, target.id, 'qualityClaim'), original);
  assert.deepEqual(knowledgeKeyInfoUpdate(state, target.id, 'isoSpecs'), { updatedBy: actors[1].id, updatedAt: laterAt });
});

test('default tab IDs cannot collide with retained block, column or row IDs', () => {
  const state = createSeedState();
  delete state.knowledgeTabsVersion;
  state.knowledgeRecords = { [knowledgeKey(state, target)]: { version: 2, sections: [{ id: 'old-general', title: 'General Information', blocks: [
    { id: 'suppliers', type: 'text', title: 'Note', text: 'Saved supplier note.' },
    { id: 'existing-table', type: 'table', title: 'Data', columns: [{ id: 'refineries', name: 'Refinery' }], rows: [{ id: 'uploaded-documents', cells: ['Existing refinery'] }] },
  ] }] } };
  const upgraded = upgradeDemoState(state), document = knowledgeDocument(upgraded, target);
  assert.doesNotThrow(() => validateKnowledge(document));
  assert.equal(document.sections.find(section => section.title === 'Suppliers')?.id, 'suppliers-default-1');
  assert.equal(document.sections.find(section => section.title === 'Refineries')?.id, 'refineries-default-1');
  assert.equal(document.sections.find(section => section.title === 'Uploaded Documents')?.id, 'uploaded-documents-default-1');
  document.sections[0].blocks.push({ id: 'new-collision-test-note', type: 'text', title: 'Note', text: 'New verified information.' });
  const saved = save(upgraded, document);
  assert.equal(knowledgeDocument(saved, target).version, 3);
  assert.doesNotThrow(() => validateKnowledge(knowledgeDocument(saved, target)));
});

test('large valid legacy sections preserve overflow tabs and remain editable after migration', () => {
  const state = createSeedState();
  delete state.knowledgeTabsVersion;
  const old: KnowledgeDocument = { version: 3, sections: ['Supplier Portfolio', 'Supplier Introduction'].map((title, index) => ({ id: `old-suppliers-${index}`, title, blocks: Array.from({ length: 60 }, (_, n) => ({ id: `supplier-${index}-${n}`, type: 'text' as const, title: 'Note', text: `Saved supplier ${index} ${n}` })) })) };
  validateKnowledge(old);
  state.knowledgeRecords = { [knowledgeKey(state, target)]: old };
  const upgraded = upgradeDemoState(state), document = knowledgeDocument(upgraded, target);
  validateKnowledge(document);
  assert.equal(document.sections.flatMap(section => section.blocks).length, 120);
  assert.ok(document.sections.every(section => section.blocks.length <= 100));
  assert.ok(document.sections.some(section => section.title === 'Supplier Introduction'));
  assert.deepEqual(knowledgeDocument(upgradeDemoState(JSON.parse(JSON.stringify(upgraded))), target), document);
  document.sections[0].blocks.push({ id: 'overflow-new', type: 'text', title: 'Note', text: 'New verified information.' });
  assert.equal(knowledgeDocument(save(upgraded, document), target).version, 4);
});

test('fifty existing custom sections retain their capacity alongside the required default tabs', () => {
  const state = createSeedState();
  delete state.knowledgeTabsVersion;
  const old: KnowledgeDocument = { version: 3, sections: Array.from({ length: 50 }, (_, n) => ({ id: `custom-${n}`, title: `Custom ${n}`, blocks: [] })) };
  validateKnowledge(old);
  state.knowledgeRecords = { [knowledgeKey(state, target)]: old };
  const upgraded = upgradeDemoState(state), document = knowledgeDocument(upgraded, target);
  assert.equal(document.sections.length, 58);
  validateKnowledge(document);
  document.sections.find(section => section.id === 'custom-49')!.blocks.push({ id: 'capacity-new', type: 'text', title: 'Note', text: 'New verified information.' });
  assert.equal(knowledgeDocument(save(upgraded, document), target).version, 4);
  document.sections.push({ id: 'over-capacity', title: 'Extra', blocks: [] });
  assert.throws(() => validateKnowledge(document), /50 additional/);
});

test('old file links move into Uploaded Documents with identities, attribution and custom tabs retained', () => {
  const state = createSeedState();
  delete state.knowledgeTabsVersion;
  const update = { updatedBy: actors[0].id, updatedAt: firstAt };
  const files: KnowledgeBlock[] = Array.from({ length: 125 }, (_, n) => ({ id: `legacy-file-${n}`, type: 'file', title: `Document ${n}`, url: `https://example.com/${n}.pdf`, update, provenance: { source: 'Agent', evidence: `Document ${n} from agent` } }));
  const old: KnowledgeDocument = { version: 7, sections: [
    { id: 'general', title: 'General Information', blocks: files.slice(0, 75) },
    { id: 'my-documents', title: 'My custom documents', blocks: files.slice(75) },
  ] };
  validateKnowledge(old);
  state.knowledgeRecords = { [knowledgeKey(state, target)]: old };
  const upgraded = upgradeDemoState(state), document = knowledgeDocument(upgraded, target);
  const uploaded = document.sections.find(section => section.title === 'Uploaded Documents')!;
  assert.deepEqual(uploaded.blocks, files);
  assert.equal(document.sections.flatMap(section => section.blocks).filter(block => block.type === 'file').length, files.length);
  assert.equal(document.sections.find(section => section.id === 'my-documents')?.blocks.length, 0);
  assert.deepEqual(old.sections[0].blocks, files.slice(0, 75), 'Normalization never changes its input.');
  assert.deepEqual(knowledgeEntryUpdate(upgraded, target, 'legacy-file-124'), update);
  validateKnowledge(document);
  uploaded.blocks.push({ id: 'new-document', type: 'file', title: 'New document', url: 'https://example.com/new.pdf' });
  const saved = save(upgraded, document, actors[1], laterAt);
  assert.equal(knowledgeDocument(saved, target).version, 8);
  assert.deepEqual(knowledgeEntryUpdate(saved, target, 'new-document'), { updatedBy: actors[1].id, updatedAt: laterAt });
  assert.deepEqual(knowledgeEntryUpdate(saved, target, 'legacy-file-124'), update);
  assert.deepEqual(knowledgeDocument(upgradeDemoState(JSON.parse(JSON.stringify(saved))), target), knowledgeDocument(saved, target));
});

test('pending amendments survive a layout migration while stale content is still rejected', () => {
  const state = createSeedState();
  delete state.knowledgeTabsVersion;
  const country: KnowledgeTarget = { kind: 'country', id: 'Japan' };
  const base: KnowledgeDocument = { version: 4, sections: [{ id: 'general', title: 'General Information', blocks: [{ id: 'pending-note', type: 'text', title: 'Note', text: 'Existing country information.' }] }] };
  const proposed = structuredClone(base);
  const block = proposed.sections[0].blocks[0];
  if (block.type !== 'text') throw new Error('Expected text');
  block.text = 'Amended country information.';
  state.knowledgeRecords = { 'country:Japan': base };
  state.contributions.unshift({ id: 'old-pending', targetType: 'country', targetId: 'Japan', title: 'Country amendment', body: 'New source', author: actors[0].id, createdAt: firstAt, status: 'pending', knowledgeChange: { target: country, baseVersion: 4, baseDocument: structuredClone(base), document: proposed } });
  const upgraded = upgradeDemoState(state);
  const approved = applyAction(upgraded, { type: 'review-contribution', id: 'old-pending', approve: true, note: 'Confirmed' }, actors[2], laterAt);
  assert.equal(knowledgeDocument(approved, country).version, 5);
  assert.match(JSON.stringify(knowledgeDocument(approved, country)), /Amended country information/);
  assert.deepEqual(knowledgeEntryUpdate(approved, country, 'pending-note'), { updatedBy: actors[2].id, updatedAt: laterAt });
  const concurrent = structuredClone(knowledgeDocument(upgraded, country));
  concurrent.sections.find(section => section.role === "trader-remarks")!.blocks.push({ id: 'other-country-note', type: 'text', title: 'Note', text: 'Concurrent update.' });
  const changed = save(upgraded, concurrent, actors[1], laterAt, country);
  assert.throws(() => applyAction(changed, { type: 'review-contribution', id: 'old-pending', approve: true, note: 'Confirmed' }, actors[2], laterAt), /Information changed/);
});
