import test from 'node:test';
import assert from 'node:assert/strict';
import { actorFromAccess } from '../src/lib/accessActor';
import type { AccessUser } from '../shared/access';
import type { DemoState } from '../src/lib/model';
import { actors } from '../src/lib/model';
import { createLiveState } from '../src/lib/testWorkspace';
import { emptyIntelligenceKeyInfo } from '../src/lib/intelligenceFields';
import { personalResources } from '../src/lib/economy';
import { contributionHistory } from '../src/lib/contributionActivity';
import { knowledgeDocument, type KnowledgeChange } from '../src/lib/knowledge';
import { applyCurrentLocationAction, splitLocationSnapshot, mergeCurrentLocationSnapshot, parseLocationContribution, applyLocationAction, canonicalLocationSnapshotJson, initialLocationSnapshot, locationSnapshotFromState, locationStateWithSnapshot, mergeLegacyLocationSnapshot, parseLocationAction, parseLocationSnapshot, readLegacyLocationCandidate, type LocationSnapshot } from '../src/lib/sharedLocationKnowledge';

const now = '2026-10-21T09:00:00.000Z';
const actor = actorFromAccess({ id: 'member-a', displayName: 'EXAMPLE STAFF', email: 'staff@example.invalid', officeId: 'office-a', officeName: 'EXAMPLE', isAdmin: true, isManager: false, isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 } satisfies AccessUser);
const state = (snapshot = initialLocationSnapshot()) => locationStateWithSnapshot(createLiveState(), snapshot);
function edit(snapshot = initialLocationSnapshot(), kind: 'port' | 'country' = 'port', id = kind === 'port' ? 'port-singapore' : 'Singapore'): KnowledgeChange {
  const base = knowledgeDocument(state(snapshot), { kind, id }), document = structuredClone(base);
  document.sections.push({ id: `custom-${base.version}`, title: 'EXAMPLE NOTE', blocks: [{ id: `note-${base.version}`, title: 'EXAMPLE', type: 'text', text: 'Synthetic shared location information.' }] });
  return { target: { kind, id }, baseVersion: base.version, baseDocument: base, document };
}
function published(snapshot = initialLocationSnapshot()) { return applyLocationAction(snapshot, { type: 'save-knowledge', change: edit(snapshot), reason: 'Synthetic verified update' }, actor, now); }
const candidate = (value: DemoState, namespace = 'ecosystem.live.v1:member-a') => readLegacyLocationCandidate({ ownerId: 'member-a', namespace, raw: JSON.stringify(value) });

test('initial shared geography exactly matches live references, without operational/test data', () => {
  assert.deepEqual(initialLocationSnapshot().ports, createLiveState().ports);
  assert.deepEqual(locationSnapshotFromState(createLiveState()).locationCountries, [...initialLocationSnapshot().locationCountries].sort((a, b) => a.name.localeCompare(b.name, 'en')));
  assert.equal(candidate(createLiveState()), null);
  const copiedDefaults = createLiveState();
  copiedDefaults.knowledgeRecords = { 'port:port-singapore': knowledgeDocument(copiedDefaults, { kind: 'port', id: 'port-singapore' }) };
  assert.equal(candidate(copiedDefaults), null);
});
test('snapshot projection excludes private/commercial/identity fields and preserves nonlocation state', () => {
  const local = createLiveState();
  local.privateNotes = { private: { owner: 'another-user', text: 'PRIVATE SENTINEL', updatedAt: now } };
  local.companies = [{ id: 'company-example', notes: 'COMPANY SENTINEL' }] as never;
  local.knowledgeRecords = { 'company:company-example': { version: 0, layoutVersion: 2, sections: [] } };
  const snapshot = locationSnapshotFromState(local);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE SENTINEL|COMPANY SENTINEL|privateNotes|companies/);
  const next = locationStateWithSnapshot(local, published().snapshot);
  assert.deepEqual(next.privateNotes, local.privateNotes);
  assert.deepEqual(next.companies, local.companies);
  assert.deepEqual(next.knowledgeRecords?.['company:company-example'], local.knowledgeRecords['company:company-example']);
});
test('ordinary publication stamps authenticated server actor/time and returns one new publication', () => {
  const result = published();
  assert.equal(result.contributions.length, 1);
  assert.equal(result.audit.length, 1);
  assert.equal(result.snapshot.knowledgeHistory[0].by, actor.id);
  assert.equal(result.snapshot.knowledgeHistory[0].at, now);
  assert.equal(result.snapshot.knowledgeRecords['port:port-singapore'].version, 1);
  assert.deepEqual(result.snapshot.historicalContributionIds, []);
  assert.throws(() => applyLocationAction(initialLocationSnapshot(), { type: 'save-knowledge', change: edit(), reason: 'Reason' }, actors[0], now), /Sign in/);
});
test('stale knowledge and Key Info updates are rejected without partial changes', () => {
  const current = published().snapshot, before = structuredClone(current);
  assert.throws(() => applyLocationAction(current, { type: 'save-knowledge', change: edit(), reason: 'Old draft' }, actor, now), /changed/i);
  assert.deepEqual(current, before);
  const keyInfo = { ...emptyIntelligenceKeyInfo(), qualityClaim: 'Example updated' };
  assert.throws(() => applyLocationAction(current, { type: 'save-port-information', portId: 'port-singapore', keyInfo, baseKeyInfo: emptyIntelligenceKeyInfo(), change: edit(), reason: 'Old draft' }, actor, now), /changed/i);
  assert.deepEqual(current, before);
});
test('port document plus Key Info publish as one atomic update and one contribution', () => {
  const keyInfo = { ...emptyIntelligenceKeyInfo(), qualityClaim: 'Example amended value' };
  const result = applyLocationAction(initialLocationSnapshot(), { type: 'save-port-information', portId: 'port-singapore', keyInfo, baseKeyInfo: emptyIntelligenceKeyInfo(), change: edit(), reason: 'Verified source' }, actor, now);
  assert.deepEqual(result.snapshot.ports.find(port => port.id === 'port-singapore')!.intelligenceKeyInfo, keyInfo);
  assert.equal(result.snapshot.knowledgeRecords['port:port-singapore'].version, 1);
  assert.equal(result.contributions.length, 1);
});
test('combined country/port tab changes retain distinct records and reject the whole stale batch', () => {
  const snapshot = initialLocationSnapshot();
  const changes = (['country', 'port'] as const).map(kind => {
    const value = edit(snapshot, kind); value.document = structuredClone(value.baseDocument); value.document.sections[0].title = `RENAMED ${kind}`; return value;
  });
  const result = applyLocationAction(snapshot, { type: 'manage-knowledge-tabs', changes }, actor, now);
  assert.equal(result.snapshot.knowledgeRecords['country:Singapore'].version, 1);
  assert.equal(result.snapshot.knowledgeRecords['port:port-singapore'].version, 1);
  assert.equal(result.contributions.length, 1);
  const invalid = structuredClone(changes); invalid[1].baseVersion = 99;
  assert.throws(() => applyLocationAction(snapshot, { type: 'manage-knowledge-tabs', changes: invalid }, actor, now));
  assert.deepEqual(snapshot.knowledgeRecords, {});
});
test('combined tabs cannot remove every country and port tab', () => {
  const snapshot = initialLocationSnapshot();
  const changes = (['country', 'port'] as const).map(kind => { const value = edit(snapshot, kind); value.document = { ...value.baseDocument, layoutVersion: 2, sections: [] }; return value; });
  assert.throws(() => applyLocationAction(snapshot, { type: 'manage-knowledge-tabs', changes }, actor, now), /at least one tab/);
});
test('new countries/ports use shared domain identity and no duplicate case-insensitive names', () => {
  const country = applyLocationAction(initialLocationSnapshot(), { type: 'add-location', kind: 'country', name: 'Example Country' }, actor, now).snapshot;
  const next = applyLocationAction(country, { type: 'add-location', kind: 'port', name: 'Example Port', country: 'Example Country' }, actor, now).snapshot;
  assert.equal(next.ports.at(-1)!.country, 'Example Country');
  assert.throws(() => applyLocationAction(next, { type: 'add-location', kind: 'port', name: 'example port', country: 'Example Country' }, actor, now), /already exists/);
});
test('nonlocation actions, forged actors, archived writes and unknown payload keys fail closed', () => {
  for (const action of [
    { type: 'save-enquiry', enquiry: {} }, { type: 'set-hat', target: {} },
    { type: 'save-knowledge', change: { ...edit(), target: { kind: 'supplier', id: 'example-supplier' } }, reason: 'Wrong scope' },
    { type: 'save-knowledge', change: { ...edit(), target: { kind: 'area', id: 'legacy' } }, reason: 'Archived' },
    { type: 'save-knowledge', change: edit(), reason: 'Forged', author: 'another-user' },
    { type: 'submit-contribution', targetType: 'feedback', targetId: 'ecosystem', title: 'Wrong', body: 'This must not cross into feedback storage.' },
  ]) assert.throws(() => parseLocationAction(action));
});
test('extraction validates every target and Key Info port before any publication', () => {
  const snapshot = initialLocationSnapshot(), action = { type: 'save-extracted-knowledge', batchId: 'synthetic-batch', changes: [edit()], intelligenceChanges: [{ portId: 'supplier-not-port', baseKeyInfo: emptyIntelligenceKeyInfo(), keyInfo: { ...emptyIntelligenceKeyInfo(), isoSpecs: 'Example' } }], reason: 'Synthetic' };
  assert.throws(() => applyLocationAction(snapshot, action, actor, now), /valid port/);
  assert.deepEqual(snapshot, initialLocationSnapshot());
  assert.throws(() => parseLocationAction({ ...action, changes: [{ ...edit(), target: { kind: 'company', id: 'example' } }] }));
});
test('only the exact signed-in live namespace may propose migration; fictional and generic archives are rejected', () => {
  for (const namespace of ['ecosystem.test.v1:member-a:generation', 'ecosystem.live.v1:member-b', 'ecosystem.signed-out.live.v1', 'ecosystem']) assert.throws(() => candidate(createLiveState(), namespace));
  assert.throws(() => candidate({ ...createLiveState(), demoScenarioVersion: 1 }), /not an eligible live workspace/);
  assert.equal(readLegacyLocationCandidate({ ownerId: 'member-a', namespace: 'ecosystem.live.v1:member-a', raw: null }), null);
  assert.throws(() => readLegacyLocationCandidate({ ownerId: 'member-a', namespace: 'ecosystem.live.v1:member-a', raw: '{' }));
});
test('legacy hierarchy flattens relationships while preserving area documents, history and stable references', () => {
  const local = createLiveState(); delete local.locationStructureVersion;
  local.locationAreas = [{ id: 'legacy-group', name: 'Former Group', country: 'Singapore' }];
  Object.assign(local.ports[0], { areaId: 'legacy-group' });
  local.knowledgeRecords = { 'area:legacy-group': { version: 3, layoutVersion: 2, sections: [{ id: 'old-tab', title: 'Legacy', blocks: [{ id: 'old-note', title: '', type: 'text', text: 'Preserved example archive.' }] }] } };
  const result = candidate(local)!;
  assert.equal(result.snapshot.legacyPortAreaIds['port-singapore'], 'legacy-group');
  assert.equal(result.snapshot.knowledgeRecords['area:legacy-group'].version, 3);
  assert.equal(result.snapshot.knowledgeRecords['area:legacy-group'].sections[0].blocks[0].title, '');
  assert.equal('areaId' in result.snapshot.ports[0], false);
  assert.equal('areaId' in local.ports[0], true);
});
test('reviewed import retains stable content/history IDs and classifies all imported publications as uncredited', () => {
  const legacy = published().snapshot, result = mergeLegacyLocationSnapshot(initialLocationSnapshot(), legacy);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.snapshot.knowledgeRecords, legacy.knowledgeRecords);
  assert.deepEqual(result.snapshot.knowledgeHistory, legacy.knowledgeHistory);
  assert.equal(result.snapshot.contributions[0].id, legacy.contributions[0].id);
  assert.deepEqual(result.snapshot.historicalContributionIds, [legacy.contributions[0].id]);
  assert.equal((state(result.snapshot).contributions[0] as { historicalImport?: true }).historicalImport, true);
  const next = published(result.snapshot).snapshot;
  assert.equal(next.historicalContributionIds.length, 1);
  assert.equal(next.contributions.length, 2);
});
test('repeat identical imports are idempotent and do not reclassify genuine shared publications', () => {
  const legacy = published().snapshot, first = mergeLegacyLocationSnapshot(initialLocationSnapshot(), legacy).snapshot;
  assert.deepEqual(mergeLegacyLocationSnapshot(first, legacy), { snapshot: first, conflicts: [] });
  const shared = published().snapshot;
  assert.deepEqual(mergeLegacyLocationSnapshot(shared, shared).snapshot.historicalContributionIds, []);
});
test('one differing document prevents the entire import, even unrelated new locations', () => {
  const shared = published().snapshot, legacy = structuredClone(shared);
  legacy.knowledgeRecords['port:port-singapore'].sections[0].title = 'Different browser copy';
  legacy.locationCountries.push({ id: 'Example New Country', name: 'Example New Country' });
  const result = mergeLegacyLocationSnapshot(shared, legacy);
  assert.ok(result.conflicts.some(item => item.reason === 'RECORD_CONFLICT'));
  assert.deepEqual(result.snapshot, shared);
});
test('different versions and same-version histories conflict regardless of later browser dates', () => {
  const shared = published().snapshot, newer = structuredClone(shared);
  newer.knowledgeRecords['port:port-singapore'].version = 99;
  assert.ok(mergeLegacyLocationSnapshot(shared, newer).conflicts.some(item => item.reason === 'RECORD_CONFLICT'));
  const history = structuredClone(shared); history.knowledgeHistory[0].at = '2099-01-01T00:00:00Z';
  assert.ok(mergeLegacyLocationSnapshot(shared, history).conflicts.some(item => item.reason === 'HISTORY_CONFLICT'));
});
test('country aliases, duplicated port identities and changed legacy links require explicit resolution', () => {
  const initial = initialLocationSnapshot();
  const alias = structuredClone(initial); alias.locationCountries.push({ id: 'sg-alias', name: ' singapore ' });
  assert.ok(mergeLegacyLocationSnapshot(initial, alias).conflicts.some(item => item.reason === 'IDENTITY_CONFLICT'));
  const portAlias = structuredClone(initial); portAlias.ports.push({ ...portAlias.ports[0], id: 'other-singapore' });
  assert.ok(mergeLegacyLocationSnapshot(initial, portAlias).conflicts.some(item => item.reason === 'IDENTITY_CONFLICT'));
  const shared = { ...initial, legacyPortAreaIds: { 'port-singapore': 'old-a' } };
  assert.ok(mergeLegacyLocationSnapshot(shared, { ...initial, legacyPortAreaIds: { 'port-singapore': 'old-b' } }).conflicts.some(item => item.reason === 'LEGACY_LINK_CONFLICT'));
});
test('browser Key Info may fill untouched geography but cannot replace shared operational data', () => {
  const incoming = initialLocationSnapshot(); incoming.ports[0].intelligenceKeyInfo = { ...emptyIntelligenceKeyInfo(), isoSpecs: 'Example source' }; incoming.ports[0].updatedAt = now;
  const imported = mergeLegacyLocationSnapshot(initialLocationSnapshot(), incoming);
  assert.equal(imported.conflicts.length, 0);
  const changed = structuredClone(incoming); changed.ports[0].intelligenceKeyInfo!.isoSpecs = 'Other source';
  assert.ok(mergeLegacyLocationSnapshot(imported.snapshot, changed).conflicts.some(item => item.reason === 'RECORD_CONFLICT'));
  assert.deepEqual(mergeLegacyLocationSnapshot(imported.snapshot, initialLocationSnapshot()).snapshot, imported.snapshot);
});
test('strict snapshots reject private data, forged document metadata, duplicate IDs and prototype keys', () => {
  const snapshot = initialLocationSnapshot();
  assert.throws(() => parseLocationSnapshot({ ...snapshot, privateNotes: { secret: 'private' } }));
  assert.throws(() => parseLocationSnapshot({ ...snapshot, knowledgeRecords: { 'company:example': edit().document } }));
  assert.throws(() => parseLocationSnapshot({ ...snapshot, ports: [...snapshot.ports, snapshot.ports[0]] }));
  assert.throws(() => parseLocationSnapshot(JSON.parse(JSON.stringify(snapshot).replace('"knowledgeRecords":{}', '"knowledgeRecords":{"__proto__":{}}'))));
  const injected = edit().document as unknown as Record<string, unknown>; injected.privateNotes = { secret: 'private' };
  assert.throws(() => parseLocationSnapshot({ ...snapshot, knowledgeRecords: { 'port:port-singapore': injected } }));
  const extra = edit().document; Object.assign(extra.sections.at(-1)!.blocks[0], { columns: [{ privatePayload: 'must never survive as an unchecked irrelevant union field' }] });
  assert.throws(() => parseLocationSnapshot({ ...snapshot, knowledgeRecords: { 'port:port-singapore': extra } }));
  assert.throws(() => parseLocationSnapshot({ ...snapshot, historicalContributionIds: ['future-contribution'] }));
  assert.throws(() => parseLocationAction({ type: 'save-knowledge', reason: 'Missing actual change' }));
});
test('canonical migration digest ignores key order, but never content or array order', () => {
  const snapshot = published().snapshot;
  assert.equal(canonicalLocationSnapshotJson(snapshot), canonicalLocationSnapshotJson(Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as LocationSnapshot));
  const changed = structuredClone(snapshot); changed.ports.reverse();
  assert.notEqual(canonicalLocationSnapshotJson(snapshot), canonicalLocationSnapshotJson(changed));
});

test('imported publications earn no activity or legacy Gold, while a later verified edit still counts', () => {
  const staff = actorFromAccess({ id: 'otto', displayName: 'SYNTHETIC OWNER', email: 'synthetic@example.invalid', officeId: 'office-a', officeName: 'EXAMPLE', isAdmin: true, isManager: false, isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 });
  const legacy = applyLocationAction(initialLocationSnapshot(), { type: 'save-knowledge', change: edit(), reason: 'Historical synthetic update' }, staff, now).snapshot;
  assert.equal(personalResources(state(legacy), staff.id).gold, 1);
  assert.equal(contributionHistory(state(legacy), staff.id, new Date(now)).length, 1);
  const imported = mergeLegacyLocationSnapshot(initialLocationSnapshot(), legacy).snapshot, projected = state(imported);
  projected.drops = [{ id: 'legacy-drop', at: now, owner: staff.id, amount: 1, reason: 'Old reward reference', key: `contribution:${legacy.contributions[0].id}` }];
  assert.equal(personalResources(projected, staff.id).gold, 0);
  assert.equal(contributionHistory(projected, staff.id, new Date(now)).length, 0);
  const next = applyLocationAction(imported, { type: 'save-knowledge', change: edit(imported), reason: 'New verified update' }, staff, now).snapshot;
  assert.equal(personalResources(state(next), staff.id).gold, 1);
  assert.equal(contributionHistory(state(next), staff.id, new Date(now)).length, 1);
});

test('new and changed block/row attribution comes only from authenticated publication', () => {
  const forged = { updatedBy: 'forged-author', updatedAt: '2099-01-01T00:00:00Z' }, change = edit();
  change.document.sections.at(-1)!.blocks[0].update = forged;
  change.document.sections.at(-1)!.blocks.push({ id: 'test-table', title: 'TABLE', type: 'table', columns: [{ id: 'test-column', name: 'COLUMN' }], rows: [{ id: 'test-row', cells: ['EXAMPLE'], update: forged }], update: forged });
  const first = applyLocationAction(initialLocationSnapshot(), { type: 'save-knowledge', change, reason: 'Check author' }, actor, now).snapshot;
  const blocks = first.knowledgeRecords['port:port-singapore'].sections.at(-1)!.blocks;
  assert.deepEqual(blocks[0].update, { updatedBy: actor.id, updatedAt: now });
  assert.equal(blocks[1].type, 'table');
  if (blocks[1].type === 'table') assert.deepEqual(blocks[1].rows[0].update, { updatedBy: actor.id, updatedAt: now });
  const second = edit(first), edited = second.document.sections.find(section => section.id === 'custom-0')!.blocks;
  edited[0].update = forged;
  if (edited[1].type === 'table') { edited[1].rows[0].cells[0] = 'CHANGED'; edited[1].rows[0].update = forged; }
  const later = '2026-10-22T09:00:00Z', result = applyLocationAction(first, { type: 'save-knowledge', change: second, reason: 'Check updated author' }, actor, later).snapshot;
  const after = result.knowledgeRecords['port:port-singapore'].sections.find(section => section.id === 'custom-0')!.blocks;
  assert.deepEqual(after[0].update, { updatedBy: actor.id, updatedAt: now }, 'Unchanged block retains its existing server attribution');
  if (after[1].type === 'table') assert.deepEqual(after[1].rows[0].update, { updatedBy: actor.id, updatedAt: later });
});


test('current-only storage survives 1,000 repeated 10KB edits while retaining every full revision separately', async () => {
  let current = initialLocationSnapshot();
  const history: unknown[] = [], contributions: Contribution[] = [];
  for (let index = 0; index < 1000; index++) {
    const base = knowledgeDocument(state(current), { kind: 'port', id: 'port-singapore' }), document = structuredClone(base);
    let section = document.sections.find(section => section.id === 'capacity');
    if (!section) { section = { id: 'capacity', title: 'CAPACITY', blocks: [] }; document.sections.push(section); }
    section.blocks = [{ id: 'capacity-note', type: 'text', title: 'NOTE', text: 'x'.repeat(10000) + index }];
    const result = await applyCurrentLocationAction(current, { type: 'save-knowledge', change: { target: { kind: 'port', id: 'port-singapore' }, baseVersion: base.version, baseDocument: base, document }, reason: 'Synthetic scale check' }, actor, now);
    assert.equal(result.history.length, 1); assert.equal(result.contributions.length, 1);
    assert.deepEqual(result.snapshot.knowledgeHistory, []); assert.deepEqual(result.snapshot.contributions, []);
    history.push(...result.history); contributions.push(...result.contributions); current = result.snapshot;
    assert.ok(JSON.stringify(current).length < 20000, 'Current save size is independent of archived versions');
    assert.ok(JSON.stringify(result.publications[0]).length < 1200, 'A 10KB body never appears in the activity projection');
  }
  assert.equal(current.knowledgeRecords['port:port-singapore'].version, 1000);
  assert.equal(history.length, 1000); assert.equal(contributions.length, 1000);
  assert.ok(JSON.stringify({ history, contributions }).length > 40_000_000, 'Full archive retained beyond the former 3.5MB cap');
  assert.equal(contributions[0].knowledgeChange!.document.sections.find(s => s.id === 'capacity')!.blocks[0].type, 'text');
  assert.ok(JSON.stringify(contributions[999]).includes('x'.repeat(10000) + '999'));
});

test('separation materializes approved legacy free text before removing contribution bodies', async () => {
  const legacy = initialLocationSnapshot();
  legacy.contributions = [{ id: 'historical-note', targetType: 'country', targetId: 'Singapore', title: 'Historic heading', body: 'Original approved information', author: actor.id, createdAt: now, status: 'approved', publishedAt: now }];
  legacy.historicalContributionIds = ['historical-note'];
  const split = await splitLocationSnapshot(legacy);
  assert.match(JSON.stringify(split.snapshot.knowledgeRecords['country:Singapore']), /Original approved information/);
  assert.equal(split.contributions[0].body, 'Original approved information');
  assert.equal(split.contributions[0].historicalImport, true);
  assert.equal(split.publications[0].body, '');
  assert.equal(split.publications[0].locationPublication!.eligible, false);
  assert.deepEqual(split.snapshot.contributions, []);
});

test('current review hydrates only the original pending proposal, never a compact projection', async () => {
  const pending = initialLocationSnapshot();
  pending.contributions = [{ id: 'retained-pending-proposal', targetType: 'port', targetId: 'port-singapore', title: 'Original suggestion', body: 'Original pending source', author: 'another-authenticated-member', createdAt: now, status: 'pending', knowledgeChange: edit() }];
  const original = await splitLocationSnapshot(pending);
  assert.equal(original.contributions[0].status, 'pending');
  const action = { type: 'review-contribution', id: original.contributions[0].id, approve: true, note: 'Reviewed source' };
  await assert.rejects(() => applyCurrentLocationAction(original.snapshot, action, actor, now), /original/);
  await assert.rejects(() => applyCurrentLocationAction(original.snapshot, action, actor, now, { contributions: original.publications }), /original/);
  const reviewed = await applyCurrentLocationAction(original.snapshot, action, actor, now, { contributions: original.contributions });
  assert.equal(reviewed.contributions[0].status, 'approved'); assert.equal(reviewed.history.length, 1);
  assert.equal(reviewed.publications[0].locationPublication!.eligible, true);
  assert.deepEqual(reviewed.snapshot.contributions, []);
});

test('current archive merge retains original detail and preserves historical classification across retries', async () => {
  const full = published().snapshot;
  const imported = await mergeCurrentLocationSnapshot(initialLocationSnapshot(), full);
  assert.equal(imported.conflicts.length, 0); assert.equal(imported.contributions[0].historicalImport, true);
  const repeated = await mergeCurrentLocationSnapshot(imported.snapshot, full, { contributions: imported.contributions, history: imported.history });
  assert.equal(repeated.conflicts.length, 0); assert.deepEqual(repeated.snapshot, imported.snapshot);
  assert.equal(repeated.contributions[0].historicalImport, true);
  const conflict = structuredClone(full); conflict.knowledgeHistory[0].reason = 'Changed old history';
  assert.equal((await mergeCurrentLocationSnapshot(imported.snapshot, conflict, { history: imported.history, contributions: imported.contributions })).conflicts[0].reason, 'HISTORY_CONFLICT');
});

test('dropping shared contribution payloads cannot resurrect their old local reward references', async () => {
  const full = published().snapshot, local = state(full), id = full.contributions[0].id;
  local.drops = [{ id: 'location-drop', key: `contribution:${id}`, owner: actor.id, at: now, amount: 1, reason: 'Old local reference' }, { id: 'unrelated', key: 'contribution:unrelated', owner: actor.id, at: now, amount: 1, reason: 'Other old record' }];
  const current = (await splitLocationSnapshot(full)).snapshot;
  const projected = locationStateWithSnapshot(local, current);
  assert.deepEqual(projected.drops.map(item => item.id), ['unrelated']);
  assert.equal(contributionHistory(projected, actor.id, new Date(now), [actor.id]).length, 1, 'Only the unrelated retained legacy evidence can count');
  assert.equal(local.drops.length, 2, 'The original archive is not edited');
});

test('compact facts reject raw payload mixtures and full details stay bounded', async () => {
  const split = await splitLocationSnapshot(published().snapshot);
  assert.deepEqual(parseLocationContribution(split.publications[0]), split.publications[0]);
  assert.throws(() => parseLocationContribution({ ...split.publications[0], body: 'Unverified content' }));
  assert.throws(() => parseLocationContribution({ ...split.publications[0], knowledgeChange: split.contributions[0].knowledgeChange }));
  assert.throws(() => parseLocationContribution({ ...split.contributions[0], historicalImport: false }));
  const oversized = edit(); oversized.document.sections.at(-1)!.blocks = Array.from({ length: 50 }, (_, i) => ({ id: `large-${i}`, title: 'NOTE', type: 'text', text: 'x'.repeat(30000) }));
  await assert.rejects(() => applyCurrentLocationAction(initialLocationSnapshot(), { type: 'save-knowledge', change: oversized, reason: 'Synthetic oversize' }, actor, now), /too large/);
});
