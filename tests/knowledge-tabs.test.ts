import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { actors, applyAction, personalResources, type DemoState } from '../src/lib/model';
import { knowledgeDocument, knowledgeEntryUpdate, knowledgeSectionRole, validateKnowledge, type KnowledgeChange, type KnowledgeDocument, type KnowledgeTarget } from '../src/lib/knowledge';
import { getLocationIntelligence } from '../src/lib/intelligence';
import { buildExtractionBatch, type ReviewProposal } from '../src/lib/knowledgeExtraction';

const at = '2026-10-06T08:00:00.000Z';
const later = '2026-10-06T09:00:00.000Z';
const port: KnowledgeTarget = { kind: 'port', id: 'port-singapore' };
const country: KnowledgeTarget = { kind: 'country', id: 'Singapore' };
function change(state: DemoState, target: KnowledgeTarget, edit: (document: KnowledgeDocument) => void): KnowledgeChange {
  const base = knowledgeDocument(state, target), document = structuredClone(base);
  edit(document);
  return { target, baseVersion: base.version, baseDocument: base, document };
}
function byRole(document: KnowledgeDocument, role: string) {
  return document.sections.find(section => knowledgeSectionRole(section) === role)!;
}

test('default tabs including Price History can be renamed, removed and added without regenerating after reload or a later save', () => {
  let state = createSeedState();
  const first = change(state, port, document => {
    byRole(document, 'port-information').title = 'Operations';
    byRole(document, 'price-history').title = 'Past prices';
    document.sections = document.sections.filter(section => !['suppliers', 'uploaded-documents'].includes(section.role ?? ''));
    document.sections.push({ id: 'custom-working-notes', title: 'Working notes', blocks: [] });
  });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [first] }, actors[0], at);
  state = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  let doc = knowledgeDocument(state, port);
  assert.equal(doc.layoutVersion, 2);
  assert.equal(byRole(doc, 'port-information').title, 'Operations');
  assert.equal(byRole(doc, 'price-history').title, 'Past prices');
  assert.equal(byRole(doc, 'suppliers'), undefined);
  assert.equal(byRole(doc, 'uploaded-documents'), undefined);
  const next = change(state, port, document => document.sections.find(section => section.id === 'custom-working-notes')!.blocks.push({ id: 'new-content', type: 'text', title: 'Note', text: 'Verified details.' }));
  state = applyAction(state, { type: 'save-knowledge', change: next, reason: 'Updated' }, actors[0], later);
  doc = knowledgeDocument(upgradeDemoState(JSON.parse(JSON.stringify(state))), port);
  assert.equal(byRole(doc, 'suppliers'), undefined);
  assert.equal(byRole(doc, 'uploaded-documents'), undefined);
  assert.equal(doc.sections.filter(section => section.title === 'Operations').length, 1);
  assert.equal(doc.sections.find(section => section.id === 'custom-working-notes')!.blocks.length, 1);
  const removePrice = change(state, port, document => { document.sections = document.sections.filter(section => section.role !== 'price-history'); });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [removePrice] }, actors[1], later);
  assert.equal(byRole(knowledgeDocument(upgradeDemoState(JSON.parse(JSON.stringify(state))), port), 'price-history'), undefined);
});

test('combined country and port tab saves publish atomically with one reward and retain separate revision targets', () => {
  for (const [name, id] of [['Singapore', 'port-singapore'], ['Hong Kong', 'port-hong-kong'], ['Gibraltar', 'port-gibraltar']]) {
    const state = createSeedState();
    const targets: KnowledgeTarget[] = [{ kind: 'country', id: name }, { kind: 'port', id }];
    const gold = personalResources(state, actors[0].id).gold;
    const changes = targets.map(target => change(state, target, document => { byRole(document, 'suppliers').title = 'Our suppliers'; document.sections = document.sections.filter(section => section.role !== 'refineries'); }));
    const next = applyAction(state, { type: 'manage-knowledge-tabs', changes }, actors[0], at);
    for (const target of targets) {
      assert.equal(byRole(knowledgeDocument(next, target), 'suppliers').title, 'Our suppliers');
      assert.equal(byRole(knowledgeDocument(next, target), 'refineries'), undefined);
    }
    assert.equal(next.contributions.length, state.contributions.length + 1);
    assert.equal(next.contributions[0].tabChanges?.length, 2);
    assert.equal(personalResources(next, actors[0].id).gold, gold + 1);
    assert.deepEqual(new Set(next.knowledgeHistory!.map(item => item.target.kind)), new Set(['port', 'country']));
    assert.equal(next.knowledgeHistory!.length, 2);
  }
});

test('a stale source rejects a combined tab save completely without mutation, publication or reward', () => {
  const state = createSeedState();
  const changes = [port, country].map(target => change(state, target, document => { byRole(document, 'suppliers').title = 'Renamed'; }));
  const other = change(state, country, document => byRole(document, 'trader-remarks').blocks.push({ id: 'concurrent-note', type: 'text', title: 'Note', text: 'Concurrent source information.' }));
  const updated = applyAction(state, { type: 'save-knowledge', change: other, reason: 'Updated' }, actors[1], at), before = structuredClone(updated);
  assert.throws(() => applyAction(updated, { type: 'manage-knowledge-tabs', changes }, actors[0], later), /Information changed/);
  assert.deepEqual(updated, before);
  assert.equal(byRole(knowledgeDocument(updated, port), 'suppliers').title, 'Suppliers');
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [changes[0], changes[0]] }, actors[0], later), /same location/);
});

test('renaming tabs preserves entry audit while removed information remains in revision history', () => {
  let state = createSeedState();
  const note = change(state, country, document => byRole(document, 'suppliers').blocks.push({ id: 'audited-supplier-note', type: 'text', title: 'Note', text: 'Confirmed supplier information.' }));
  state = applyAction(state, { type: 'save-knowledge', change: note, reason: 'Updated' }, actors[0], at);
  const original = knowledgeEntryUpdate(state, country, 'audited-supplier-note');
  const rename = change(state, country, document => { byRole(document, 'suppliers').title = 'Local supply'; });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [rename] }, actors[1], later);
  assert.deepEqual(knowledgeEntryUpdate(state, country, 'audited-supplier-note'), original);
  const remove = change(state, country, document => { document.sections = document.sections.filter(section => section.role !== 'suppliers'); });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [remove] }, actors[1], later);
  assert.match(JSON.stringify(state.knowledgeHistory![0].before), /Confirmed supplier information/);
  assert.doesNotMatch(JSON.stringify(knowledgeDocument(state, country)), /Confirmed supplier information/);
});

test('renamed special tabs retain roles and refinery, extraction and file behavior', () => {
  let state = createSeedState();
  const renamed = change(state, port, document => {
    byRole(document, 'port-information').title = 'Operations';
    byRole(document, 'refineries').title = 'Plants';
    byRole(document, 'uploaded-documents').title = 'References';
  });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [renamed] }, actors[0], at);
  const info = change(state, port, document => {
    const table = byRole(document, 'refineries').blocks.find(block => block.type === 'table')!;
    if (table.type !== 'table') throw new Error('Expected table');
    table.rows[0].cells[2] = 'Updated plant capacity';
    byRole(document, 'uploaded-documents').blocks.push(...Array.from({ length: 101 }, (_, n) => ({ id: `reference-${n}`, type: 'file' as const, title: `Reference ${n}`, url: `https://example.com/${n}.pdf` })));
  });
  state = applyAction(state, { type: 'save-knowledge', change: info, reason: 'Updated' }, actors[1], later);
  assert.equal(getLocationIntelligence(state.ports.find(item => item.id === port.id)!, state.knowledgeRecords).refineries[0].capacity, 'Updated plant capacity');
  validateKnowledge(knowledgeDocument(state, port));
  const current = state.ports.find(item => item.id === port.id)!.intelligenceKeyInfo!.qualityClaim;
  const proposal: ReviewProposal = { id: 'one', selected: true, locationKey: 'port:port-singapore', locationName: 'Singapore', section: 'Port Information', title: 'Note', kind: 'keyInfo', text: '', columns: [], rows: [], field: 'qualityClaim', value: current === 'Possible' ? 'No' : 'Possible', evidence: 'Updated claim policy.', warning: null };
  state = applyAction(state, buildExtractionBatch(state, [proposal], { batchId: 'renamed-tab-extraction' }), actors[1], later);
  const doc = knowledgeDocument(state, port);
  assert.equal(byRole(doc, 'port-information').title, 'Operations');
  assert.ok(byRole(doc, 'port-information').blocks.some(block => block.id === 'keyinfo-source-qualityClaim'));
  assert.ok(!doc.sections.some(section => section.title === 'Port Information'));
});

test('legacy migration preserves section identities and pending amendments while adding roles and Price History only once', () => {
  const state = createSeedState();
  state.knowledgeTabsVersion = 1;
  const legacy: KnowledgeDocument = { version: 7, sections: [{ id: 'my-suppliers', title: 'Suppliers', blocks: [{ id: 'old-note', type: 'text', title: 'Note', text: 'Existing source.' }] }, { id: 'custom', title: 'Custom facts', blocks: [] }] };
  state.knowledgeRecords = { 'country:Singapore': legacy };
  const proposed = structuredClone(legacy);
  proposed.sections[0].title = 'Supplier contacts';
  state.contributions.unshift({ id: 'pending-layout', targetType: 'country', targetId: 'Singapore', title: 'Amendment', body: 'Updated', author: actors[0].id, createdAt: at, status: 'pending', knowledgeChange: { target: country, baseVersion: 7, baseDocument: legacy, document: proposed } });
  const upgraded = upgradeDemoState(state);
  const document = knowledgeDocument(upgraded, country);
  assert.equal(document.sections[0].id, 'my-suppliers');
  assert.equal(document.sections[0].blocks[0].id, 'old-note');
  assert.equal(document.sections[1].id, 'custom');
  assert.equal(document.sections.filter(section => section.role === 'price-history').length, 0);
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(upgraded))), upgraded);
  const approved = applyAction(upgraded, { type: 'review-contribution', id: 'pending-layout', approve: true, note: 'Confirmed' }, actors[2], later);
  assert.equal(knowledgeDocument(approved, country).sections.find(section => section.id === 'my-suppliers')?.title, 'Supplier contacts');
});

test('tab management requires one tab, protects special roles and rejects content edits or content in Price History', () => {
  const state = createSeedState();
  const standalone: KnowledgeTarget = { kind: 'port', id: 'port-chiba' };
  const empty = change(state, standalone, document => { document.sections = []; });
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [empty] }, actors[0], at), /at least one tab/);
  const forged = change(state, port, document => { byRole(document, 'port-information').role = undefined; });
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [forged] }, actors[0], at), /type unchanged/);
  const edited = change(state, port, document => byRole(document, 'trader-remarks').blocks.push({ id: 'hidden-content', type: 'text', title: 'Note', text: 'A content edit.' }));
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [edited] }, actors[0], at), /Edit information separately/);
  const price = change(state, port, document => byRole(document, 'price-history').blocks.push({ id: 'price-note', type: 'text', title: 'Note', text: 'A hidden note.' }));
  assert.throws(() => applyAction(state, { type: 'save-knowledge', change: price, reason: 'Updated' }, actors[0], at), /Price History/);
  const onlyPrice = change(state, port, document => { document.sections = [byRole(document, 'price-history')]; });
  const saved = applyAction(state, { type: 'manage-knowledge-tabs', changes: [onlyPrice] }, actors[0], at);
  assert.equal(knowledgeDocument(saved, port).sections.length, 1);
});

test('a combined profile can remove all tabs from either source without regenerating them', () => {
  let state = createSeedState();
  const clearCountry = change(state, country, document => { document.sections = []; });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [clearCountry] }, actors[0], at);
  state = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(knowledgeDocument(state, country).sections, []);
  assert.ok(knowledgeDocument(state, port).sections.length > 0);
  const clearPort = change(state, port, document => { document.sections = []; });
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [clearPort] }, actors[0], later), /at least one tab/);
  const addCountry = change(state, country, document => document.sections.push({ id: 'replacement-country-tab', title: 'Custom information', blocks: [] }));
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [clearPort, addCountry] }, actors[0], later);
  assert.deepEqual(knowledgeDocument(state, port).sections, []);
  assert.equal(knowledgeDocument(state, country).sections.length, 1);
  const fresh = createSeedState();
  assert.throws(() => applyAction(fresh, { type: 'manage-knowledge-tabs', changes: [port, country].map(target => change(fresh, target, document => { document.sections = []; })) }, actors[0], at), /at least one tab/);
});

test('deleted special tabs can be restored with their roles while custom lookalike names stay custom', () => {
  let state = createSeedState();
  const remove = change(state, port, document => { document.sections = document.sections.filter(section => !['port-information', 'price-history', 'uploaded-documents'].includes(section.role ?? '')); });
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [remove] }, actors[0], at);
  const restore = change(state, port, document => document.sections.push(
    { id: 'restored-operations', title: 'Operations', role: 'port-information', blocks: [] },
    { id: 'restored-files', title: 'Documents', role: 'uploaded-documents', blocks: [] },
    { id: 'restored-prices', title: 'Prices', role: 'price-history', blocks: [] },
    { id: 'custom-prices-name', title: 'Price History', blocks: [] },
  ));
  state = applyAction(state, { type: 'manage-knowledge-tabs', changes: [restore] }, actors[0], later);
  const doc = knowledgeDocument(upgradeDemoState(JSON.parse(JSON.stringify(state))), port);
  assert.equal(byRole(doc, 'port-information').id, 'restored-operations');
  assert.equal(byRole(doc, 'uploaded-documents').id, 'restored-files');
  assert.equal(byRole(doc, 'price-history').id, 'restored-prices');
  assert.equal(doc.sections.find(section => section.id === 'custom-prices-name')?.role, undefined);
  const duplicate = change(state, port, document => document.sections.push({ id: 'duplicate-prices', title: 'More prices', role: 'price-history', blocks: [] }));
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [duplicate] }, actors[0], later), /unique/);
  const invalidCountry = change(state, country, document => document.sections.push({ id: 'country-prices', title: 'Price History', role: 'price-history', blocks: [] }));
  assert.throws(() => applyAction(state, { type: 'manage-knowledge-tabs', changes: [invalidCountry] }, actors[0], later), /belong to a port/);
});

test('legacy custom Price History content stays editable without being turned into the live-price tab', () => {
  const state = createSeedState();
  state.knowledgeTabsVersion = 1;
  state.knowledgeRecords = { 'port:port-singapore': { version: 3, sections: [{ id: 'custom-prices', title: 'Price History', blocks: [{ id: 'legacy-price-note', type: 'text', title: 'Note', text: 'Saved price observations.' }] }] } };
  const upgraded = upgradeDemoState(state), document = knowledgeDocument(upgraded, port);
  assert.equal(document.sections.find(section => section.id === 'custom-prices')?.role, undefined);
  assert.equal(byRole(document, 'price-history').blocks.length, 0);
  assert.match(JSON.stringify(document.sections.find(section => section.id === 'custom-prices')), /Saved price observations/);
  validateKnowledge(document);
});

test('legacy country tabs with port-only names stay editable custom tabs and general maps to country remarks', () => {
  for (const entry of [
    { id: 'custom-port-information', title: 'Port Information', role: undefined },
    { id: 'general', title: 'Port Information', role: undefined },
    { id: 'price-history', title: 'Price History', role: undefined },
    { id: 'general', title: 'Prior country notes', role: 'trader-remarks' },
  ]) {
    const state = createSeedState();
    state.knowledgeTabsVersion = 1;
    state.knowledgeRecords = { 'country:Singapore': { version: 3, sections: [{ id: entry.id, title: entry.title, blocks: [{ id: 'legacy-country-note', type: 'text', title: 'Note', text: 'Existing country information.' }] }] } };
    const upgraded = upgradeDemoState(state), document = knowledgeDocument(upgraded, country);
    assert.equal(document.sections.find(section => section.id === entry.id)?.role, entry.role);
    const rename = change(upgraded, country, next => { next.sections.find(section => section.id === entry.id)!.title = 'Country notes'; });
    let saved = applyAction(upgraded, { type: 'manage-knowledge-tabs', changes: [rename] }, actors[0], at);
    const edit = change(saved, country, next => {
      const block = next.sections.find(section => section.id === entry.id)!.blocks[0];
      if (block.type !== 'text') throw new Error('Expected text');
      block.text = 'Updated country information.';
    });
    saved = applyAction(saved, { type: 'save-knowledge', change: edit, reason: 'Updated' }, actors[0], later);
    assert.match(JSON.stringify(knowledgeDocument(saved, country)), /Updated country information/);
    assert.equal(knowledgeDocument(saved, country).version, 5);
  }
});
