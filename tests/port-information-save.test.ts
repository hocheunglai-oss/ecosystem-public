import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, personalResources, resourceHistory, type Action, type DemoState } from '../src/lib/model';
import { createSeedState } from '../src/lib/seed';
import { knowledgeDocument, knowledgeEntryUpdate, knowledgeKey, type KnowledgeChange, type KnowledgeTarget } from '../src/lib/knowledge';
import { emptyIntelligenceKeyInfo } from '../src/lib/intelligenceFields';

const target = { kind: 'port' as const, id: 'port-chiba' };
const at = '2026-10-21T08:00:00.000Z', earlier = '2026-10-20T08:00:00.000Z';
const actor = actors[0], previousActor = actors[1];
type Save = Extract<Action, { type: 'save-port-information' }>;

function fixture() {
  const state = createSeedState(), port = state.ports.find(item => item.id === target.id)!;
  port.intelligenceKeyInfo = { ...emptyIntelligenceKeyInfo(), isoSpecs: 'ISO 8217:2017', sampleLocation: 'MANIFOLD' };
  port.intelligenceEntryUpdates = { isoSpecs: { updatedBy: previousActor.id, updatedAt: earlier }, sampleLocation: { updatedBy: previousActor.id, updatedAt: earlier } };
  const document = knowledgeDocument(state, target);
  document.sections.find(section => section.role === 'port-information')!.blocks.push({ id: 'retained-source', type: 'text', title: 'EXISTING SOURCE', text: 'RETAIN THIS SOURCE AND ITS ATTRIBUTION.', update: { updatedBy: previousActor.id, updatedAt: earlier } });
  state.knowledgeRecords = { ...state.knowledgeRecords, [knowledgeKey(state, target)]: document };
  return state;
}
function change(state: DemoState, destination: KnowledgeTarget = target, id = 'new-note'): KnowledgeChange {
  const baseDocument = knowledgeDocument(state, destination), document = structuredClone(baseDocument);
  document.sections[0].blocks.push({ id, type: 'text', title: 'CONFIRMED OPERATIONS', text: 'UPDATED OPERATING ARRANGEMENTS FROM THE PORT TEAM.' });
  return { target: destination, baseVersion: baseDocument.version, baseDocument, document };
}
function save(state: DemoState, overrides: Partial<Save> = {}): Save {
  const baseKeyInfo = state.ports.find(item => item.id === target.id)!.intelligenceKeyInfo!;
  return { type: 'save-port-information', portId: target.id, baseKeyInfo, keyInfo: { ...baseKeyInfo, qualityClaim: '45 DAYS BY AGREEMENT' }, change: change(state), reason: 'Confirmed port information', ...overrides };
}
function oneContribution(before: DemoState, after: DemoState) {
  assert.equal(after.contributions.length, before.contributions.length + 1);
  assert.equal(personalResources(after, actor.id).gold, personalResources(before, actor.id).gold + 1);
  const contribution = after.contributions[0];
  assert.equal(contribution.author, actor.id);
  assert.equal(contribution.targetId, target.id);
  assert.equal(contribution.status, 'approved');
  assert.equal(contribution.publication, 'direct');
  assert.equal(resourceHistory(after, actor.id).filter(entry => entry.key === `gold:contribution:${contribution.id}`).length, 1);
  assert.equal(after.audit.length, before.audit.length + 1);
}
function rejectUnchanged(state: DemoState, action: Save, message: RegExp) {
  const snapshot = structuredClone(state);
  assert.throws(() => applyAction(state, action, actor, at), message);
  assert.deepEqual(state, snapshot, 'Rejected combined saves must leave facts, documents, history, attribution and rewards intact');
}

test('one port-information save publishes document and Key Info with exactly one contribution', () => {
  const state = fixture(), snapshot = structuredClone(state), action = save(state);
  const next = applyAction(state, action, actor, at), port = next.ports.find(item => item.id === target.id)!;
  oneContribution(state, next);
  assert.deepEqual(port.intelligenceKeyInfo, action.keyInfo);
  assert.equal(knowledgeDocument(next, target).version, action.change!.baseVersion + 1);
  assert.deepEqual(knowledgeEntryUpdate(next, target, 'new-note'), { updatedBy: actor.id, updatedAt: at });
  assert.deepEqual(knowledgeEntryUpdate(next, target, 'retained-source'), { updatedBy: previousActor.id, updatedAt: earlier });
  assert.deepEqual(port.intelligenceEntryUpdates!.qualityClaim, { updatedBy: actor.id, updatedAt: at });
  assert.deepEqual(port.intelligenceEntryUpdates!.isoSpecs, snapshot.ports.find(item => item.id === target.id)!.intelligenceEntryUpdates!.isoSpecs);
  assert.deepEqual(next.contributions[0].proposedKeyInfo, action.keyInfo);
  assert.deepEqual(next.contributions[0].keyInfoBase, action.baseKeyInfo);
  assert.equal(next.contributions[0].knowledgeChange!.target.id, target.id);
  assert.equal(next.knowledgeHistory!.length, (state.knowledgeHistory?.length ?? 0) + 1);
  assert.deepEqual(next.knowledgeHistory![0].before, action.change!.baseDocument);
  assert.deepEqual(state, snapshot, 'The source snapshot remains unchanged on success');
  rejectUnchanged(next, action, /changed/);
});

test('Key Info-only save leaves the document and document history unchanged and contributes once', () => {
  const state = fixture(), action = save(state, { change: undefined });
  const next = applyAction(state, action, actor, at);
  oneContribution(state, next);
  assert.deepEqual(next.ports.find(item => item.id === target.id)!.intelligenceKeyInfo, action.keyInfo);
  assert.deepEqual(next.knowledgeRecords, state.knowledgeRecords);
  assert.deepEqual(next.knowledgeHistory, state.knowledgeHistory);
  assert.equal(next.contributions[0].knowledgeChange, undefined);
});

test('document-only save preserves all Key Info values and attribution and contributes once', () => {
  const state = fixture(), originalPort = state.ports.find(item => item.id === target.id)!;
  const next = applyAction(state, save(state, { keyInfo: originalPort.intelligenceKeyInfo! }), actor, at);
  oneContribution(state, next);
  assert.deepEqual(next.ports.find(item => item.id === target.id), originalPort);
  assert.equal(knowledgeDocument(next, target).version, knowledgeDocument(state, target).version + 1);
  assert.equal(next.contributions[0].proposedKeyInfo, undefined);
  assert.equal(next.contributions[0].keyInfoBase, undefined);
});

test('stale Key Info rejects a still-current document edit atomically', () => {
  const state = fixture(), pending = save(state);
  const concurrent = applyAction(state, { type: 'save-port-information', portId: target.id, keyInfo: { ...pending.baseKeyInfo, sampleLocation: 'DUPLICATE SAMPLE RETAINED' }, baseKeyInfo: pending.baseKeyInfo, reason: 'Concurrent facts' }, previousActor, earlier);
  assert.deepEqual(knowledgeDocument(concurrent, target), pending.change!.baseDocument);
  rejectUnchanged(concurrent, pending, /Key Info changed/);
});

test('stale document rejects a still-current Key Info edit atomically', () => {
  const state = fixture(), pending = save(state);
  const concurrent = applyAction(state, { type: 'save-knowledge', change: change(state, target, 'concurrent-note'), reason: 'Concurrent document' }, previousActor, earlier);
  assert.deepEqual(concurrent.ports.find(item => item.id === target.id)!.intelligenceKeyInfo, pending.baseKeyInfo);
  rejectUnchanged(concurrent, pending, /Information changed/);
});

test('combined save rejects another port or country document without changing either scope', () => {
  const state = fixture();
  for (const destination of [{ kind: 'port', id: 'port-tokyo' }, { kind: 'country', id: 'Japan' }] as KnowledgeTarget[]) {
    rejectUnchanged(state, save(state, { change: change(state, destination) }), /same port/);
  }
  rejectUnchanged(state, save(state, { portId: 'missing-port' }), /valid port/);
});

test('unchanged combined saves cannot publish history or earn a contribution', () => {
  const state = fixture(), base = knowledgeDocument(state, target), keyInfo = state.ports.find(item => item.id === target.id)!.intelligenceKeyInfo!;
  rejectUnchanged(state, save(state, { keyInfo, change: undefined }), /No changes/);
  rejectUnchanged(state, save(state, { keyInfo, change: { target, baseVersion: base.version, baseDocument: base, document: structuredClone(base) } }), /No changes/);
});
