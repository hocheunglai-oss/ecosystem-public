import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { actors, applyAction, personalResources } from '../src/lib/model';
import { defaultKnowledgeTitle, knowledgeDocument, knowledgeEntryUpdate, validateKnowledge, type KnowledgeTarget } from '../src/lib/knowledge';
import { buildExtractionBatch, type ReviewProposal } from '../src/lib/knowledgeExtraction';
import { hatRecipient } from '../src/lib/hats';

const target: KnowledgeTarget = { kind: 'port', id: 'port-chiba' };
const at = '2026-10-06T08:00:00.000Z';
const update = { updatedBy: actors[0].id, updatedAt: at };

test('legacy title backfill preserves content, evidence, authors, history, awards and document versions', () => {
  const state = createSeedState();
  const before = knowledgeDocument(state, target);
  const document = structuredClone(before);
  document.version = 4;
  document.sections[0].blocks = []; // Explicit legacy fixture, independent of populated demo content.
  document.sections[0].blocks.push(
    { id: 'legacy-blank', type: 'text', title: '  ', text: 'Exact original source text.', provenance: { source: 'Agent', evidence: 'Original excerpt.' } },
    { id: 'legacy-unknown', type: 'table', title: '', columns: [{ id: 'column', name: 'Name' }], rows: [{ id: 'row', cells: ['Original row'], update }] },
  );
  state.knowledgeRecords = { 'port:port-chiba': document };
  const historyBefore = structuredClone(document);
  historyBefore.sections[0].blocks = historyBefore.sections[0].blocks.filter(block => block.id !== 'legacy-blank');
  state.knowledgeHistory = [{ target, version: 4, at, by: actors[0].id, reason: 'Saved source', before: historyBefore, after: structuredClone(document) }];
  state.hats = [{ id: 'existing-hat', target: { kind: 'knowledge', target, blockId: 'legacy-blank' }, targetKey: JSON.stringify(['knowledge', 'port', 'port-chiba', 'legacy-blank', null]), readerId: actors[1].id, recipientId: actors[0].id, awardedAt: at, update, documentVersion: 4 }];
  const original = structuredClone(state);
  const migrated = upgradeDemoState(state);
  const result = knowledgeDocument(migrated, target);
  const [text, table] = result.sections[0].blocks;
  assert.equal(text.title, 'Port Information 1');
  assert.equal(table.title, 'Port Information 2');
  assert.deepEqual({ ...text, title: '  ', update: undefined }, { ...document.sections[0].blocks[0], update: undefined });
  assert.deepEqual({ ...table, title: '' }, document.sections[0].blocks[1]);
  assert.deepEqual(knowledgeEntryUpdate(migrated, target, 'legacy-blank'), update);
  assert.equal(knowledgeEntryUpdate(migrated, target, 'legacy-unknown'), undefined);
  assert.deepEqual(knowledgeEntryUpdate(migrated, target, 'legacy-unknown', 'row'), update);
  assert.deepEqual(hatRecipient(migrated, { kind: 'knowledge', target, blockId: 'legacy-blank' }), update);
  assert.equal(result.version, 4);
  assert.deepEqual(migrated.knowledgeHistory, original.knowledgeHistory);
  assert.deepEqual(migrated.contributions, original.contributions);
  assert.deepEqual(migrated.hats, original.hats);
  assert.deepEqual(migrated.economy, original.economy);
  assert.equal(personalResources(migrated, actors[0].id).gold, personalResources(original, actors[0].id).gold);
  assert.deepEqual(state, original);
  assert.equal(upgradeDemoState(migrated), migrated, 'Backfill runs once and is stable on reload.');
  validateKnowledge(result);
});

test('seeded and legacy country, port and supplier blocks always read with titles', () => {
  const state = createSeedState();
  for (const port of state.ports) assert.ok(knowledgeDocument(state, { kind: 'port', id: port.id }).sections.flatMap(section => section.blocks).every(block => block.title.trim()));
  for (const item of [{ kind: 'country', id: 'Japan' }, { kind: 'port', id: 'port-chiba' }, { kind: 'supplier', id: 'synthetic-supplier' }] as KnowledgeTarget[]) {
    const document = knowledgeDocument(state, item, { suppliers: [{ id: 'synthetic-supplier', name: 'SYNTHETIC SUPPLIER' }] });
    document.sections[0].blocks.push({ id: 'untitled', type: 'text', title: '', text: 'Existing content.' });
    state.knowledgeRecords ??= {};
    state.knowledgeRecords[`${item.kind}:${item.id}`] = document;
    const read = knowledgeDocument(state, item);
    assert.ok(read.sections.flatMap(section => section.blocks).every(block => block.title.trim()));
    assert.equal(document.sections[0].blocks.at(-1)?.title, '', 'Reading does not mutate saved input.');
  }
  assert.equal(defaultKnowledgeTitle('X'.repeat(150), 99).length, 150);
});

test('new blocks and cleared titles cannot publish or earn Gold', () => {
  const state = createSeedState(), baseDocument = knowledgeDocument(state, target);
  for (const title of ['', '   ']) for (const type of ['text', 'table', 'file'] as const) {
    const document = structuredClone(baseDocument);
    document.sections[0].blocks.push(type === 'text' ? { id: 'new', type, title, text: 'New text.' }
      : type === 'table' ? { id: 'new', type, title, columns: [{ id: 'c', name: 'Name' }], rows: [] }
        : { id: 'new', type, title, url: 'https://example.com/reference.pdf' });
    assert.throws(() => applyAction(state, { type: 'save-knowledge', change: { target, baseVersion: baseDocument.version, baseDocument, document }, reason: 'Update' }, actors[0], at), /Enter a title/);
  }
  const document = structuredClone(baseDocument);
  document.sections[0].blocks.push({ id: 'saved', type: 'text', title: 'Existing title', text: 'Original information.' });
  const saved = applyAction(state, { type: 'save-knowledge', change: { target, baseVersion: baseDocument.version, baseDocument, document }, reason: 'Update' }, actors[0], at);
  const base = knowledgeDocument(saved, target), cleared = structuredClone(base);
  cleared.sections[0].blocks[0].title = '';
  assert.throws(() => applyAction(saved, { type: 'save-knowledge', change: { target, baseVersion: base.version, baseDocument: base, document: cleared }, reason: 'Update' }, actors[0], at), /Enter a title/);
  assert.equal(saved.contributions.length, state.contributions.length + 1);
});

test('an open legacy draft keeps its generated title through a valid content update', () => {
  const state = createSeedState(), base = knowledgeDocument(state, target);
  base.sections[0].blocks = [];
  base.sections[0].blocks.push({ id: 'legacy', title: '', type: 'text', text: 'Before.', update });
  state.knowledgeRecords = { 'port:port-chiba': structuredClone(base) };
  const draft = structuredClone(base), block = draft.sections[0].blocks[0];
  if (block.type !== 'text') throw new Error('Expected text');
  block.text = 'After.';
  const change = { target, baseVersion: base.version, baseDocument: base, document: draft };
  const saved = applyAction(upgradeDemoState(state), { type: 'save-knowledge', change, reason: 'Updated source' }, actors[1], at);
  assert.equal(knowledgeDocument(saved, target).sections[0].blocks[0].title, 'Port Information 1');
  assert.equal(knowledgeEntryUpdate(saved, target, 'legacy')?.updatedBy, actors[1].id);
  assert.throws(() => applyAction(saved, { type: 'save-knowledge', change, reason: 'Stale' }, actors[1], at), /Information changed/);
});

test('AI text and table proposals with blank titles receive reviewable section-based titles', () => {
  const state = createSeedState();
  const proposal: ReviewProposal = { id: 'text', selected: true, locationKey: 'port:port-chiba', locationName: 'Chiba', section: 'Operations', title: '', kind: 'text', text: 'Delivery requires confirmation.', columns: [], rows: [], field: null, value: null, evidence: 'Delivery requires confirmation.', warning: null };
  const table: ReviewProposal = { ...proposal, id: 'table', kind: 'table', text: '', columns: ['Desk'], rows: [['Operations']] };
  const batch = buildExtractionBatch(state, [proposal, table], { batchId: 'blank-ai-titles' });
  const blocks = batch.changes[0].document.sections.find(section => section.title === 'Operations')!.blocks;
  assert.deepEqual(blocks.map(block => block.title), ['Operations 1', 'Operations 2']);
  assert.ok(blocks.every(block => block.provenance?.evidence === proposal.evidence));
  validateKnowledge(batch.changes[0].document);
  const saved = applyAction(state, batch, actors[0], at);
  assert.equal(personalResources(saved, actors[0].id).gold, personalResources(state, actors[0].id).gold + 1);
});
