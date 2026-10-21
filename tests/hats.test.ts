import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, type DemoState } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { knowledgeDocument, publishKnowledge, type KnowledgeBlock, type KnowledgeDocument, type KnowledgeTarget } from '../src/lib/knowledge';
import { hatCount, hatForEntry, hatRanking, hatRecipient, recentHatsReceived, recordHat, type HatTarget } from '../src/lib/hats';
import { personalResources } from '../src/lib/economy';
import { emptyIntelligenceKeyInfo } from '../src/lib/intelligenceFields';
import { addSyntheticSupplierKnowledge, syntheticSupplier } from './fixtures/knowledgeSuppliers';

const target: KnowledgeTarget = { kind: 'port', id: 'port-chiba' };
const note: HatTarget = { kind: 'knowledge', target, blockId: 'hat-note' };
const row: HatTarget = { kind: 'knowledge', target, blockId: 'hat-table', rowId: 'hat-row' };
const firstAt = '2026-10-06T09:00:00.000Z', secondAt = '2026-10-06T09:01:00.000Z', thirdAt = '2026-10-06T09:02:00.000Z';
const author = actors[0], reader = actors[1], replacement = actors[2], otherReader = actors[3];

function save(state: DemoState, document: KnowledgeDocument, by = author, at = firstAt, destination = target) {
  const base = knowledgeDocument(state, destination);
  return applyAction(state, { type: 'save-knowledge', change: { target: destination, baseVersion: base.version, baseDocument: base, document }, reason: 'Confirmed source' }, by, at);
}
function prepared() {
  const state = createSeedState(), document = knowledgeDocument(state, target);
  document.sections[0].blocks.push(
    { id: 'hat-note', type: 'text', title: 'Delivery', text: 'Confirm the agent before arrival.' },
    { id: 'hat-table', type: 'table', title: 'Agent', columns: [{ id: 'agent', name: 'Agent' }], rows: [{ id: 'hat-row', cells: ['Port agent'] }, { id: 'other-row', cells: ['Other agent'] }] },
  );
  return save(state, document);
}
function give(state: DemoState, entry = note, by = reader, at = secondAt) {
  return applyAction(state, { type: 'set-hat', target: entry, expectedUpdate: hatRecipient(state, entry)!, active: true }, by, at);
}
function editNote(state: DemoState, by = replacement, at = thirdAt) {
  const document = knowledgeDocument(state, target);
  (document.sections.flatMap(section => section.blocks).find(block => block.id === 'hat-note') as Extract<KnowledgeBlock, { type: 'text' }>).text = `Updated agent contact by ${by.id} at ${at}.`;
  return save(state, document, by, at);
}

test('Hats award immediately without Gold effects, with immutable publication attribution and idempotent replay', () => {
  const state = prepared(), beforeGold = personalResources(state, author.id), expectedUpdate = hatRecipient(state, note)!;
  const next = give(state);
  assert.equal(state.hats, undefined);
  assert.equal(hatCount(next, author.id), 1);
  assert.equal(hatCount(next, reader.id), 0);
  assert.deepEqual(personalResources(next, author.id), beforeGold);
  assert.deepEqual(next.contributions, state.contributions);
  const award = hatForEntry(next, note, reader.id)!;
  assert.equal(award.recipientId, author.id);
  assert.equal(award.readerId, reader.id);
  assert.equal(award.awardedAt, secondAt);
  assert.deepEqual(award.update, expectedUpdate);
  assert.equal(award.documentVersion, knowledgeDocument(state, target).version);
  assert.equal(give(next), next);
  assert.equal(next.hats?.length, 1);
});

test('new Hats follow only the current contributor; previous Hats and reader slots survive edits', () => {
  let state = give(prepared());
  const original = structuredClone(state.hats![0]);
  state = editNote(state);
  assert.equal(hatRecipient(state, note)?.updatedBy, replacement.id);
  state = give(state, note, otherReader, '2026-10-06T09:03:00.000Z');
  assert.equal(hatCount(state, author.id), 1);
  assert.equal(hatCount(state, replacement.id), 1);
  assert.deepEqual(state.hats![0], original);
  assert.equal(give(state), state);
  assert.equal(state.hats?.length, 2);
});

test('stale authors and stale revisions are rejected before any award is made', () => {
  const before = prepared(), expectedUpdate = hatRecipient(before, note)!;
  for (const editor of [replacement, author]) {
    const state = editNote(before, editor);
    assert.throws(() => applyAction(state, { type: 'set-hat', target: note, expectedUpdate, active: true }, reader), /changed/);
    assert.equal(state.hats, undefined);
  }
});

test('self-awards, unknown attribution, missing rows and deleted entries cannot earn Hats', () => {
  const state = prepared();
  assert.throws(() => give(state, note, author), /yourself/);
  const unknown = { ...note, blockId: 'note-0' } as HatTarget;
  assert.equal(hatRecipient(state, unknown), undefined);
  assert.throws(() => give(state, unknown), /no contributor/);
  const missingRow = { ...row, rowId: 'deleted-row' } as HatTarget;
  assert.equal(hatRecipient(state, missingRow), undefined);
  assert.throws(() => give(state, missingRow), /no contributor/);
  const document = knowledgeDocument(state, target);
  document.sections[0].blocks = document.sections[0].blocks.filter(block => block.id !== 'hat-note');
  const deleted = save(state, document, replacement, thirdAt);
  assert.throws(() => applyAction(deleted, { type: 'set-hat', target: note, expectedUpdate: hatRecipient(state, note)!, active: true }, reader), /no contributor/);
});

test('undo is reader-owned, replay-safe and cannot move an existing Hat to a different editor', () => {
  let state = give(prepared());
  const expectedUpdate = hatRecipient(state, note)!;
  assert.equal(applyAction(state, { type: 'set-hat', target: note, expectedUpdate, active: false }, otherReader), state);
  state = applyAction(state, { type: 'set-hat', target: note, expectedUpdate, active: false }, reader, thirdAt);
  assert.equal(hatCount(state, author.id), 0);
  assert.equal(hatForEntry(state, note, reader.id)?.undoneAt, thirdAt);
  assert.equal(applyAction(state, { type: 'set-hat', target: note, expectedUpdate, active: false }, reader), state);
  state = give(state);
  assert.equal(hatCount(state, author.id), 1);
  assert.equal(state.hats?.length, 1);
  assert.equal(state.hats![0].awardedAt, secondAt);
  state = editNote(state);
  state = applyAction(state, { type: 'set-hat', target: note, expectedUpdate, active: false }, reader);
  assert.equal(hatCount(state, author.id), 0);
  assert.throws(() => give(state), /cannot be transferred/);
  assert.equal(hatCount(state, replacement.id), 0);
});

test('table-row Hats identify that row, retaining its author when another row changes', () => {
  let state = prepared(), document = knowledgeDocument(state, target);
  const table = document.sections.flatMap(section => section.blocks).find(block => block.id === 'hat-table') as Extract<KnowledgeBlock, { type: 'table' }>;
  table.rows[1].cells[0] = 'New other agent';
  state = save(state, document, replacement, secondAt);
  assert.equal(hatRecipient(state, row)?.updatedBy, author.id);
  assert.equal(hatRecipient(state, { ...row, rowId: 'other-row' } as HatTarget)?.updatedBy, replacement.id);
  state = give(state, row);
  state = give(state, { ...row, rowId: 'other-row' } as HatTarget);
  assert.equal(hatCount(state, author.id), 1);
  assert.equal(hatCount(state, replacement.id), 1);
});

test('Key Info fields have independent latest-contributor attribution and reader slots', () => {
  let state = createSeedState();
  const base = state.ports.find(port => port.id === target.id)!.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
  state = applyAction(state, { type: 'save-port-information', portId: target.id, baseKeyInfo: base, keyInfo: { ...base, qualityClaim: 'All', isoSpecs: 'All' }, reason: 'Confirmed supplier terms' }, author, firstAt);
  const field: HatTarget = { kind: 'key-info', portId: target.id, field: 'qualityClaim' };
  const otherField: HatTarget = { ...field, field: 'isoSpecs' };
  assert.equal(hatRecipient(state, field)?.updatedBy, author.id);
  state = give(state, field);
  const current = state.ports.find(port => port.id === target.id)!.intelligenceKeyInfo!;
  state = applyAction(state, { type: 'save-port-information', portId: target.id, baseKeyInfo: current, keyInfo: { ...current, qualityClaim: 'No' }, reason: 'Reconfirmed claim terms' }, replacement, thirdAt);
  state = give(state, field, otherReader);
  state = give(state, otherField, reader);
  assert.equal(hatCount(state, author.id), 2);
  assert.equal(hatCount(state, replacement.id), 1);
  assert.equal(state.hats?.length, 3);
});

test('legacy state loads with zero Hats; saved awards survive upgrade and rank by Hats then distinct colleagues', () => {
  const legacy = createSeedState();
  assert.equal(hatCount(legacy, author.id), 0);
  assert.deepEqual(hatRanking(legacy), []);
  let state = give(prepared());
  state = give(state, row);
  state = editNote(state);
  state = give(state, note, otherReader);
  state = give(state, note, actors[4]);
  state = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(hatRanking(state), [
    { actorId: replacement.id, count: 2, uniqueReaders: 2 },
    { actorId: author.id, count: 2, uniqueReaders: 1 },
  ]);
  assert.equal(hatCount(state, author.id), 2);
  assert.equal(state.hats?.length, 4);
});

test('supplier and location entries with the same block ID have separate awards, and deletion still permits undo', () => {
  let state = addSyntheticSupplierKnowledge(give(prepared()));
  const supplier: KnowledgeTarget = syntheticSupplier;
  const document = knowledgeDocument(state, supplier);
  document.sections[0].blocks.push({ id: 'hat-note', type: 'text', title: 'Delivery', text: 'Confirm delivery terms with the supplier.' });
  state = save(state, document, replacement, thirdAt, supplier);
  const supplierNote: HatTarget = { kind: 'knowledge', target: supplier, blockId: 'hat-note' };
  state = give(state, supplierNote);
  assert.equal(hatCount(state, author.id), 1);
  assert.equal(hatCount(state, replacement.id), 1);
  const expectedUpdate = hatRecipient(state, note)!;
  const portDocument = knowledgeDocument(state, target);
  portDocument.sections[0].blocks = portDocument.sections[0].blocks.filter(block => block.id !== 'hat-note');
  state = save(state, portDocument, author, '2026-10-06T09:04:00.000Z');
  state = applyAction(state, { type: 'set-hat', target: note, expectedUpdate, active: false }, reader);
  assert.equal(hatCount(state, author.id), 0);
  assert.equal(hatCount(state, replacement.id), 1);
  assert.equal(hatForEntry(state, supplierNote, reader.id)?.recipientId, replacement.id);
  assert.throws(() => applyAction(state, { type: 'set-hat', target: { kind: 'key-info', portId: target.id, field: 'made-up' } as unknown as HatTarget, expectedUpdate, active: true }, reader), /valid information/);
});

const realAuthor = 'f4f8cfe0-c0d4-4426-a526-c693080a0297';
const realReader = '04de09c5-11d9-407c-a151-a9ac89da7f23';
function realProfileState() {
  const state = prepared();
  state.profiles = { ...state.profiles, [realAuthor]: { email: 'author@ecosystem.example', phone: '' },
    [realReader]: { email: 'reader@ecosystem.example', phone: '' } };
  const before = knowledgeDocument(state, target), document = structuredClone(before);
  const block = document.sections.flatMap(section => section.blocks).find(item => item.id === 'hat-note');
  if (!block || block.type !== 'text') throw new Error('Missing note fixture');
  block.text = 'Delivery information published by the authenticated author.';
  publishKnowledge(state, { target, baseVersion: before.version, baseDocument: before, document }, realAuthor, secondAt, 'Confirmed source');
  return state;
}

test('authenticated UUID profiles receive Hats, retain original attribution and reject self-awards and replay', () => {
  const initial = realProfileState(), expected = hatRecipient(initial, note)!;
  assert.equal(expected.updatedBy, realAuthor);
  assert.throws(() => recordHat(structuredClone(initial), note, expected, true, realAuthor, thirdAt, 'self'), /yourself/);
  let state = structuredClone(initial);
  const awarded = recordHat(state, note, expected, true, realReader, thirdAt, 'real-award')!;
  assert.equal(awarded.recipientId, realAuthor);
  assert.equal(hatCount(state, realAuthor), 1);
  assert.deepEqual(hatRanking(state), [{ actorId: realAuthor, count: 1, uniqueReaders: 1 }]);
  assert.equal(recordHat(state, note, expected, true, realReader, thirdAt, 'replay'), undefined);
  assert.equal(state.hats?.length, 1);
  const awardedAt = awarded.awardedAt;
  state = structuredClone(state);
  recordHat(state, note, expected, false, realReader, '2026-10-06T09:03:00Z', 'undo');
  assert.equal(hatCount(state, realAuthor), 0);
  state = structuredClone(state);
  recordHat(state, note, expected, true, realReader, '2026-10-06T09:04:00Z', 'restore');
  assert.equal(hatCount(state, realAuthor), 1);
  assert.equal(state.hats![0].awardedAt, awardedAt);
  state = editNote(state, replacement, '2026-10-06T09:05:00Z');
  assert.equal(hatCount(state, realAuthor), 1);
  assert.equal(hatCount(state, replacement.id), 0);
  assert.throws(() => recordHat(structuredClone(state), note, expected, true, otherReader.id, '2026-10-06T09:06:00Z', 'stale'), /changed/);
  state = structuredClone(state);
  recordHat(state, note, expected, false, realReader, '2026-10-06T09:06:00Z', 'undo-after-edit');
  assert.throws(() => recordHat(state, note, hatRecipient(state, note)!, true, realReader, '2026-10-06T09:07:00Z', 'transfer'), /cannot be transferred/);
});

test('unknown UUID authors and readers remain ineligible and profile changes refresh the Hat index', () => {
  const state = realProfileState(), expected = hatRecipient(state, note)!;
  const unknownReader = 'afe6fcf8-6cf3-4e36-a6b8-e2cf7b883c70';
  assert.throws(() => recordHat(structuredClone(state), note, expected, true, unknownReader, thirdAt, 'unknown-reader'), /not available/);
  const unknownAuthor = { ...state, profiles: { ...state.profiles } };
  delete unknownAuthor.profiles[realAuthor];
  assert.equal(hatRecipient(unknownAuthor, note), undefined);
  assert.throws(() => recordHat(structuredClone(unknownAuthor), note, expected, true, realReader, thirdAt, 'unknown-author'), /no contributor/);
  recordHat(state, note, expected, true, realReader, thirdAt, 'recorded');
  const withoutProfiles = { hats: state.hats };
  assert.equal(hatCount(withoutProfiles, realAuthor), 0);
  assert.equal(hatCount(state, realAuthor), 1);
  assert.equal(hatCount(withoutProfiles, realAuthor), 0);
  assert.deepEqual(hatRanking(state), [{ actorId: realAuthor, count: 1, uniqueReaders: 1 }]);
});

test('recent Hats share counting exclusions and sort newest first without changing the ledger', () => {
  const state = give(prepared());
  const original = state.hats![0];
  state.hats = [
    { ...original, id: 'undone', targetKey: 'undone-slot', undoneAt: thirdAt },
    { ...original, id: 'restored-duplicate', targetKey: 'undone-slot', awardedAt: thirdAt },
    { ...original, id: 'self', targetKey: 'self-slot', readerId: author.id },
    { ...original, id: 'unknown-reader', targetKey: 'unknown-slot', readerId: 'unknown-reader' },
    { ...original, id: 'another-recipient', targetKey: 'other-recipient-slot', recipientId: replacement.id },
    original,
    { ...original, id: 'newest', targetKey: 'newest-slot', readerId: otherReader.id, awardedAt: thirdAt },
    { ...original, id: 'duplicate', awardedAt: '2026-10-07T09:00:00Z' },
  ];
  const before = structuredClone(state.hats);
  assert.equal(hatCount(state, author.id), 2);
  assert.deepEqual(recentHatsReceived(state, author.id).map(hat => hat.id), ['newest', original.id]);
  assert.deepEqual(recentHatsReceived(state, author.id, 1).map(hat => hat.id), ['newest']);
  assert.deepEqual(recentHatsReceived(state, author.id, 0), []);
  assert.deepEqual(recentHatsReceived(state, author.id, -1), []);
  assert.deepEqual(state.hats, before);
});

test('recent Hats default to five and omit invalid dates from the dated history', () => {
  const state = give(prepared());
  const original = state.hats![0];
  state.hats = Array.from({ length: 7 }, (_, index) => ({
    ...original, id: `recent-${index}`, targetKey: `recent-slot-${index}`,
    awardedAt: `2026-10-${String(index + 1).padStart(2, '0')}T09:00:00Z`,
  }));
  state.hats.push({ ...original, id: 'invalid-date', targetKey: 'invalid-date-slot', awardedAt: 'unavailable' });
  assert.deepEqual(recentHatsReceived(state, author.id).map(hat => hat.id), ['recent-6', 'recent-5', 'recent-4', 'recent-3', 'recent-2']);
  assert.equal(recentHatsReceived(state, author.id, 20).length, 7);
  assert.deepEqual(recentHatsReceived(state, 'unknown-recipient'), []);
});
