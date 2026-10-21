import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, personalResources } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { knowledgeDocument, validateKnowledge } from '../src/lib/knowledge';
import { buildExtractionBatch, parseExtractionResponse, type ReviewProposal } from '../src/lib/knowledgeExtraction';
import { emptyIntelligenceKeyInfo, INTELLIGENCE_VALUE_MAX_LENGTH } from '../src/lib/intelligenceFields';

const when = '2026-10-05T08:00:00.000Z';
const target = { kind: 'port' as const, id: 'port-chiba' };
const metadata = { batchId: 'batch-one', source: 'Agent circular', sourceDate: '2026-10-04' };
function proposal(overrides: Partial<ReviewProposal> = {}): ReviewProposal {
  return { id: 'one', selected: true, locationKey: 'port:port-chiba', locationName: 'Chiba', section: 'Operations', title: 'Delivery window', kind: 'text', text: 'Delivery window: 08:00–17:00, subject to weather.', columns: [], rows: [], field: null, value: null, evidence: 'Chiba: delivery window 08:00–17:00, subject to weather.', warning: null, ...overrides };
}
function mixed() {
  return [
    proposal(),
    proposal({ id: 'two', kind: 'table', locationKey: 'port:port-tokyo', locationName: 'Tokyo', section: 'Contacts', title: 'Agent contacts', text: '', columns: ['Office', 'Hours'], rows: [['Central desk', '08:00–17:00']], evidence: 'Tokyo Bay Central desk 08:00–17:00.' }),
    proposal({ id: 'three', locationKey: 'country:Japan', locationName: 'Japan', section: 'General Information', text: 'Public holiday enquiries need advance confirmation.', evidence: 'Japan: public holiday enquiries need advance confirmation.' }),
    proposal({ id: 'four', kind: 'keyInfo', field: 'qualityClaim', value: 'Possible', text: '', evidence: 'Chiba suppliers may agree to a 30-day quality claim period on enquiry.' }),
  ];
}

test('mixed country, ports and Key Info publish atomically for every role with one immediate Gold', () => {
  for (const actor of actors) {
    const state = createSeedState();
    const before = JSON.stringify(state);
    const gold = personalResources(state, actor.id).gold;
    const batch = buildExtractionBatch(state, mixed(), metadata);
    assert.equal(batch.changes.length, 3);
    assert.equal(batch.intelligenceChanges.length, 1);
    const saved = applyAction(state, batch, actor, when);
    assert.equal(JSON.stringify(state), before, 'Building and publishing never mutate the input state.');
    assert.equal(personalResources(saved, actor.id).gold, gold + 1);
    assert.equal(saved.contributions.length, state.contributions.length + 1);
    assert.equal(saved.contributions[0].status, 'approved');
    assert.equal(saved.contributions[0].reviewer, undefined);
    assert.equal(saved.contributions[0].extractionBatch?.changes.length, 3);
    assert.equal(saved.ports.find(port => port.id === target.id)?.intelligenceKeyInfo?.qualityClaim, 'Possible');
    assert.equal(saved.knowledgeHistory?.length, 3);
    assert.ok(saved.knowledgeHistory?.every(item => item.source === 'Agent circular' && item.by === actor.id && item.at === when));
    const source = knowledgeDocument(saved, target).sections.find(section => section.title === 'Port Information')!.blocks.find(block => block.id === 'keyinfo-source-qualityClaim')!;
    assert.deepEqual(source.provenance, { source: 'Agent circular', evidence: mixed()[3].evidence, date: '2026-10-04' });
    const restored = upgradeDemoState(JSON.parse(JSON.stringify(saved)));
    assert.equal(restored.contributions[0].extractionBatch?.id, metadata.batchId);
    assert.equal(personalResources(restored, actor.id).gold, gold + 1);
    assert.equal(knowledgeDocument(restored, target).version, 1);
  }
});

test('extracting, editing or cancelling drafts changes no record or reward', () => {
  const state = createSeedState(), before = JSON.stringify(state);
  const output = parseExtractionResponse({ proposals: mixed(), warnings: ['Confirm supplier applicability.'] });
  buildExtractionBatch(state, output.proposals.map((item, i) => ({ ...item, selected: true, id: `proposal-${i}` })), metadata);
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => buildExtractionBatch(state, [proposal({ selected: false })], metadata), /Select information/);
});

test('a stale document or Key Info field rejects the entire batch without partial publishing or reward', () => {
  const state = createSeedState(), actor = actors[0];
  const batch = buildExtractionBatch(state, mixed(), metadata);
  const changed = applyAction(state, buildExtractionBatch(state, [proposal({ id: 'other', locationKey: 'country:Japan', text: 'Another verified update.', evidence: 'Another verified update.' })], { batchId: 'concurrent' }), actor, when);
  const before = JSON.stringify(changed);
  assert.throws(() => applyAction(changed, batch, actor, when), /Information changed/);
  assert.equal(JSON.stringify(changed), before);
  const keyInfoChanged = applyAction(state, { type: 'save-port-information', portId: target.id, baseKeyInfo: emptyIntelligenceKeyInfo(), keyInfo: { ...emptyIntelligenceKeyInfo(), isoSpecs: 'All' }, reason: 'Concurrent change' }, actor, when);
  const keyInfoBefore = JSON.stringify(keyInfoChanged);
  assert.throws(() => applyAction(keyInfoChanged, batch, actor, when), /Key Info changed/);
  assert.equal(JSON.stringify(keyInfoChanged), keyInfoBefore);
  assert.equal(knowledgeDocument(keyInfoChanged, { kind: 'country', id: 'Japan' }).version, 0);
});

test('a published batch cannot replay, including after persistence and with a different actor', () => {
  const state = createSeedState();
  const batch = buildExtractionBatch(state, mixed(), metadata);
  const saved = applyAction(state, batch, actors[0], when);
  assert.throws(() => applyAction(JSON.parse(JSON.stringify(saved)), batch, actors[1], when), /already been published/);
});

test('legitimate Key Info status cycles refresh one current source while retaining each earlier source in History', () => {
  let state = createSeedState();
  const gold = personalResources(state, actors[0].id).gold;
  for (const [index, value] of ['Possible', 'No', 'Possible'].entries()) {
    const evidence = `Circular ${index + 1}: Chiba 30-day quality claim status is ${value}.`;
    const batch = buildExtractionBatch(state, [proposal({ kind: 'keyInfo', field: 'qualityClaim', value, text: '', evidence })], { ...metadata, batchId: `cycle-${index}` });
    state = applyAction(state, batch, actors[0], when);
    const sources = knowledgeDocument(state, target).sections.find(section => section.title === 'Port Information')!.blocks.filter(block => block.id === 'keyinfo-source-qualityClaim');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, 'keyinfo-source-qualityClaim');
    assert.equal(sources[0].provenance?.evidence, evidence);
  }
  assert.equal(personalResources(state, actors[0].id).gold, gold + 3);
  assert.equal(state.knowledgeHistory?.length, 3);
  assert.match(JSON.stringify(state.knowledgeHistory?.[0].before), /Circular 2/);
  assert.match(JSON.stringify(state.knowledgeHistory?.[1].before), /Circular 1/);
});

test('manual Key Info changes do not prevent a later extraction from restoring a supported value', () => {
  let state = createSeedState();
  const field = proposal({ kind: 'keyInfo', field: 'qualityClaim', value: 'Possible', text: '' });
  state = applyAction(state, buildExtractionBatch(state, [field], metadata), actors[0], when);
  const changeManually = () => {
    const before = state.ports.find(port => port.id === target.id)!.intelligenceKeyInfo!;
    state = applyAction(state, { type: 'save-port-information', portId: target.id, baseKeyInfo: before, keyInfo: { ...before, qualityClaim: 'No' }, reason: 'Updated terms' }, actors[0], when);
  };
  changeManually();
  const sameSource = buildExtractionBatch(state, [field], { ...metadata, batchId: 'restore-original-source' });
  assert.equal(sameSource.changes.length, 0, 'An identical source document does not need another revision.');
  state = applyAction(state, sameSource, actors[0], when);
  changeManually();
  const updatedSource = buildExtractionBatch(state, [{ ...field, evidence: 'New circular confirms the same Possible status.' }], { ...metadata, batchId: 'restore-new-source' });
  assert.equal(updatedSource.changes.length, 1);
  state = applyAction(state, updatedSource, actors[0], when);
  assert.equal(state.ports.find(port => port.id === target.id)?.intelligenceKeyInfo?.qualityClaim, 'Possible');
  assert.match(JSON.stringify(state.knowledgeHistory?.[0].after), /New circular/);
  assert.throws(() => buildExtractionBatch(state, [field], { ...metadata, batchId: 'same-status' }), /already matches/);
});

test('new blocks preserve existing data; replacing an existing block requires its explicit identity', () => {
  const state = createSeedState();
  const hongKong = { kind: 'port' as const, id: 'port-hong-kong' };
  const original = knowledgeDocument(state, hongKong);
  const appended = buildExtractionBatch(state, [proposal({ locationKey: 'port:port-hong-kong', sectionId: 'general' })], metadata);
  assert.deepEqual(appended.changes[0].document.sections[0].blocks.slice(0, -1), original.sections[0].blocks);
  const replaced = buildExtractionBatch(state, [proposal({ locationKey: 'port:port-hong-kong', sectionId: 'general', replaceBlockId: original.sections[0].blocks[0].id })], metadata);
  assert.equal(replaced.changes[0].document.sections[0].blocks[0].id, original.sections[0].blocks[0].id);
  assert.deepEqual(replaced.changes[0].document.sections[0].blocks.slice(1), original.sections[0].blocks.slice(1));
  assert.throws(() => buildExtractionBatch(state, [proposal({ replaceBlockId: 'missing' })], metadata), /valid information block/);
});

test('duplicate source content and unchanged Key Info cannot be used to earn additional Gold', () => {
  const state = createSeedState();
  assert.throws(() => buildExtractionBatch(state, [proposal(), proposal({ id: 'duplicate', title: 'Different title', text: ' DELIVERY WINDOW: 08:00–17:00, subject to weather. ' })], metadata), /already exists/);
  const saved = applyAction(state, buildExtractionBatch(state, [proposal()], metadata), actors[0], when);
  assert.throws(() => buildExtractionBatch(saved, [proposal({ title: 'Another heading' })], { batchId: 'second' }), /already exists/);
  const sameKeyInfo = proposal({ kind: 'keyInfo', locationKey: 'port:port-singapore', field: 'qualityClaim', value: state.ports.find(port => port.id === 'port-singapore')!.intelligenceKeyInfo!.qualityClaim });
  assert.throws(() => buildExtractionBatch(state, [sameKeyInfo], metadata), /already matches/);
  const repeated = mixed().slice(3);
  assert.throws(() => buildExtractionBatch(state, [...repeated, { ...repeated[0], id: 'another', value: 'No' }], metadata), /one update/);
});

test('direct batch actions reject duplicate targets, copied content, metadata-only changes and invalid destinations', () => {
  const state = createSeedState(), actor = actors[0];
  const batch = buildExtractionBatch(state, [proposal()], metadata);
  assert.throws(() => applyAction(state, { ...batch, changes: [...batch.changes, batch.changes[0]] }, actor), /same location/);
  assert.throws(() => applyAction(state, { ...batch, changes: [{ ...batch.changes[0], target: { kind: 'company', id: state.companies[0].id } }] }, actor), /country(?:, area)? or port/);
  assert.throws(() => buildExtractionBatch(state, [proposal({ locationKey: null })], metadata), /country(?:, area)? or port/);
  assert.throws(() => buildExtractionBatch(state, [proposal({ locationKey: 'country:Missing' })], metadata), /country(?:, area)? or port/);
  assert.throws(() => buildExtractionBatch(state, [proposal({ locationKey: 'country:Japan', kind: 'keyInfo', field: 'isoSpecs', value: 'All' })], metadata), /belongs to a port/);
  const twice = structuredClone(batch);
  const section = twice.changes[0].document.sections.find(section => section.title === 'Operations')!;
  section.blocks.push({ ...section.blocks[0], id: 'new-id', title: 'Other title' });
  assert.throws(() => applyAction(state, twice, actor), /already exists/);
  const saved = applyAction(state, batch, actor);
  const base = knowledgeDocument(saved, target), doc = structuredClone(base);
  doc.sections.find(section => section.title === 'Operations')!.blocks[0].title = 'A new heading';
  assert.throws(() => applyAction(saved, { ...batch, batchId: 'metadata-only', changes: [{ target, baseVersion: base.version, baseDocument: base, document: doc }] }, actor), /No new information/);
});

test('untrusted extraction data is bounded, validates field identity and keeps source markup as inert text', () => {
  assert.throws(() => parseExtractionResponse({ proposals: [proposal({ evidence: '' })], warnings: [] }), /source excerpt/);
  assert.equal(parseExtractionResponse({ proposals: [proposal({ kind: 'keyInfo', field: 'isoSpecs', value: 'Usually supplied to the nominated ISO revision' })], warnings: [] }).proposals[0].value, 'Usually supplied to the nominated ISO revision');
  assert.throws(() => parseExtractionResponse({ proposals: [proposal({ kind: 'keyInfo', field: 'isoSpecs', value: 'x'.repeat(INTELLIGENCE_VALUE_MAX_LENGTH + 1) })], warnings: [] }), /too long/);
  assert.throws(() => parseExtractionResponse({ proposals: [proposal({ kind: 'keyInfo', field: 'isoSpecs', value: ' \n ' })], warnings: [] }), /field and value/);
  assert.throws(() => parseExtractionResponse({ proposals: [proposal({ kind: 'table', columns: ['A'], rows: [['A', 'B']] })], warnings: [] }), /match/);
  assert.throws(() => parseExtractionResponse({ proposals: [proposal({ kind: 'table', columns: ['A'], rows: [[' ']] })], warnings: [] }), /needs columns and information/);
  assert.throws(() => parseExtractionResponse({ proposals: Array.from({ length: 41 }, () => proposal()), warnings: [] }), /too large/);
  assert.throws(() => parseExtractionResponse({ proposals: [proposal({ text: 'x'.repeat(30001) })], warnings: [] }), /too long/);
  assert.throws(() => buildExtractionBatch(createSeedState(), [proposal()], { ...metadata, sourceDate: '2026-02-30' }), /valid source date/);
  const text = '<script>fetch("https://example.com")</script>';
  const batch = buildExtractionBatch(createSeedState(), [proposal({ text, evidence: text })], metadata);
  const doc = validateKnowledge(batch.changes[0].document);
  const block = doc.sections.find(section => section.title === 'Operations')!.blocks[0];
  assert.equal(block.type, 'text');
  assert.equal(block.provenance?.evidence, text);
  if (block.type === 'text') assert.equal(block.text, text);
});

test('free-text extraction publishes multiline values, current source and per-field history without replacing unchanged fields', () => {
  let state = createSeedState();
  const port = state.ports.find(item => item.id === target.id)!;
  const initial = { ...emptyIntelligenceKeyInfo(), sampleLocation: 'EXISTING AGREED SAMPLE LOCATION' };
  state = applyAction(state, { type: 'save-port-information', portId: port.id, baseKeyInfo: emptyIntelligenceKeyInfo(), keyInfo: initial, reason: 'Saved prior information' }, actors[1], '2026-10-09T07:00:00.000Z');
  const sampleStamp = state.ports.find(item => item.id === port.id)!.intelligenceEntryUpdates!.sampleLocation;
  const value = 'ISO 8217:2024 for the nominated grade.\nConfirm sulphur limit and certificate before delivery. '.repeat(3);
  assert.ok(value.length > 100, 'Free-text extraction is not limited by the former dropdown response bound');
  const firstProposal = proposal({ kind: 'keyInfo', field: 'isoSpecs', value, text: '', evidence: value });
  const parsed = parseExtractionResponse({ proposals: [firstProposal], warnings: [] });
  assert.equal(parsed.proposals[0].value, value);
  const batch = buildExtractionBatch(state, [firstProposal], { ...metadata, batchId: 'free-text-first' });
  const first = applyAction(state, batch, actors[0], '2026-10-09T08:00:00.000Z');
  const savedPort = first.ports.find(item => item.id === port.id)!;
  assert.equal(savedPort.intelligenceKeyInfo!.isoSpecs, value);
  assert.deepEqual(savedPort.intelligenceEntryUpdates!.sampleLocation, sampleStamp);
  assert.deepEqual(savedPort.intelligenceEntryUpdates!.isoSpecs, { updatedBy: actors[0].id, updatedAt: '2026-10-09T08:00:00.000Z' });
  assert.equal(upgradeDemoState(JSON.parse(JSON.stringify(first))).ports.find(item => item.id === port.id)!.intelligenceKeyInfo!.isoSpecs, value);
  const nextValue = 'RMG 380 / ISO 8217:2024\nPORT SPECIFIC AGREEMENT';
  const second = buildExtractionBatch(first, [proposal({ kind: 'keyInfo', field: 'isoSpecs', value: nextValue, text: '', evidence: nextValue })], { ...metadata, batchId: 'free-text-second' });
  const updated = applyAction(first, second, actors[1], '2026-10-09T09:00:00.000Z');
  const sources = knowledgeDocument(updated, target).sections.flatMap(section => section.blocks).filter(block => block.id === 'keyinfo-source-isoSpecs');
  assert.equal(sources.length, 1); assert.equal(sources[0].provenance!.evidence, nextValue);
  assert.ok(JSON.stringify(updated.knowledgeHistory).includes('Confirm sulphur limit'));
  const staleSnapshot = structuredClone(updated);
  assert.throws(() => applyAction(updated, { ...second, batchId: 'free-text-stale' }, actors[0]), /changed/);
  assert.deepEqual(updated, staleSnapshot);
});
