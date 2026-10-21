import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, personalResources, type Action, type DemoState } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { locationAncestors, locationChildren, locationCountries, locationCountryForPort, locationProfileTarget, locationRecords, profileCountryTarget } from '../src/lib/locations';
import { knowledgeDocument, knowledgeKey, knowledgeName } from '../src/lib/knowledge';
import { flattenLocationHierarchy } from '../src/lib/locationMigration';
import { attachmentFolderId, buildAttachmentFolders, type AttachmentCatalog } from '../src/lib/attachments';
import { createLiveState } from '../src/lib/testWorkspace';

test("every registered LIVE and TEST port resolves to a nonempty country", () => {
  for (const state of [createLiveState(), createSeedState()]) {
    for (const port of state.ports) {
      assert.ok(port.country.trim(), port.id);
      assert.ok(locationCountryForPort(state, port), port.id);
    }
  }
});

test("single-port countries retain both index entries with one navigation profile and independent storage", () => {
  const state = createSeedState();
  const before = structuredClone(state);
  for (const [country, portId] of [
    ["Singapore", "port-singapore"],
    ["Hong Kong", "port-hong-kong"],
    ["Gibraltar", "port-gibraltar"],
  ]) {
    assert.equal(
      locationRecords(state).filter((record) => record.name === country).length,
      2,
    );
    assert.deepEqual(locationRecords(state).filter(record => record.name === country).map(record => record.kind).sort(), ["country", "port"]);
    assert.deepEqual(locationProfileTarget(state, { kind: "country", id: country }), { kind: "port", id: portId });
    assert.deepEqual(profileCountryTarget(state, { kind: "port", id: portId }), { kind: "country", id: country });
    assert.equal(
      knowledgeKey(state, { kind: "country", id: country }),
      `country:${country}`,
    );
    assert.equal(knowledgeKey(state, { kind: "port", id: portId }), `port:${portId}`);
    assert.equal(locationRecords(state).find(record => record.key === `port:${portId}`)?.country, country);
    assert.deepEqual(locationChildren(state, { kind: "port", id: portId }), []);
    assert.deepEqual(
      locationAncestors(state, { kind: "country", id: country }),
      [],
    );
  }
  assert.deepEqual(state, before);
});

test("any country with exactly one registered port shares its profile regardless of port name or code", () => {
  const state = createSeedState();
  const port = state.ports.find(port => port.country === "Netherlands")!;
  port.code = "";
  const countryTarget = { kind: "country" as const, id: "Netherlands" };
  const portTarget = { kind: "port" as const, id: port.id };
  assert.deepEqual(locationProfileTarget(state, countryTarget), portTarget);
  assert.deepEqual(profileCountryTarget(state, portTarget), countryTarget);
  const records = locationRecords(state);
  assert.equal(records.find(record => record.key === "country:Netherlands")?.name, "Netherlands");
  assert.equal(records.find(record => record.key === `port:${port.id}`)?.country, "Netherlands");
  assert.equal(records.find(record => record.key === `port:${port.id}`)?.path, `Netherlands › ${port.name}`);
  assert.deepEqual(locationChildren(state, countryTarget).map(record => record.key), [`port:${port.id}`]);
  assert.deepEqual(locationChildren(state, portTarget), []);
  assert.deepEqual(locationAncestors(state, portTarget), []);
  state.ports.push({ ...port, id: "second-netherlands-port", name: "Amsterdam" });
  assert.deepEqual(locationProfileTarget(state, { kind: "country", id: "Netherlands" }), { kind: "country", id: "Netherlands" });
  assert.equal(profileCountryTarget(state, portTarget), undefined);
  assert.deepEqual(locationAncestors(state, portTarget).map(record => record.key), ["country:Netherlands"]);
  assert.equal(locationChildren(state, countryTarget).length, 2);
  assert.deepEqual(locationChildren(state, portTarget), []);
});

test("zero/one/multiple port transitions preserve country and port records, histories and file identities", () => {
  const countryTarget = { kind: "country" as const, id: "Canada" };
  let state = applyAction(createSeedState(), { type: "add-location", kind: "country", name: "Canada" }, actors[0]);
  state = applyAction(state, { type: "submit-contribution", targetType: "country", targetId: "Canada", title: "Country note", body: "Keep this original country information and its attribution." }, actors[0]);
  assert.deepEqual(locationProfileTarget(state, countryTarget), countryTarget);
  state = applyAction(state, { type: "add-location", kind: "port", name: "Vancouver", country: "Canada" }, actors[0]);
  const port = state.ports.find(port => port.country === "Canada")!;
  const portTarget = { kind: "port" as const, id: port.id };
  state = applyAction(state, { type: "submit-contribution", targetType: "port", targetId: port.id, title: "Port note", body: "Keep this original port information and its attribution." }, actors[0]);
  const countryDocument = structuredClone(knowledgeDocument(state, countryTarget));
  const portDocument = structuredClone(knowledgeDocument(state, portTarget));
  const history = structuredClone(state.knowledgeHistory);
  const contributions = structuredClone(state.contributions);
  assert.deepEqual(locationProfileTarget(state, countryTarget), portTarget);
  state = applyAction(state, { type: "add-location", kind: "port", name: "Montreal", country: "Canada" }, actors[0]);
  assert.deepEqual(locationProfileTarget(state, countryTarget), countryTarget);
  state.ports = state.ports.filter(item => item.country !== "Canada" || item.id === port.id);
  assert.deepEqual(locationProfileTarget(state, countryTarget), portTarget);
  assert.deepEqual(knowledgeDocument(state, countryTarget), countryDocument);
  assert.deepEqual(knowledgeDocument(state, portTarget), portDocument);
  assert.deepEqual(state.knowledgeHistory, history);
  assert.deepEqual(state.contributions, contributions);
  const folders = buildAttachmentFolders(state, { items: [], folders: [] });
  assert.equal(folders.find(folder => folder.id === `port:${port.id}`)?.parentId, "country:Canada");
  assert.equal(folders.find(folder => folder.id === "country:Canada")?.scope?.target.id, "Canada");
});

test("registered country relationships survive formatting differences without inferring countries from port names", () => {
  const state = createSeedState();
  const port = state.ports.find(port => port.country === "Netherlands")!;
  const country = state.locationCountries!.find(country => country.name === "Netherlands")!;
  country.id = "country-nl";
  port.country = " netherlands ";
  const before = structuredClone(state);
  assert.deepEqual(locationCountryForPort(state, port), country);
  assert.deepEqual(locationProfileTarget(state, { kind: "country", id: "country-nl" }), { kind: "port", id: port.id });
  assert.equal(locationRecords(state).find(record => record.key === `port:${port.id}`)?.country, "Netherlands");
  assert.deepEqual(locationChildren(state, { kind: "country", id: "country-nl" }).map(record => record.target.id), [port.id]);
  assert.deepEqual(state, before);
  port.country = " ";
  port.name = "Netherlands";
  assert.equal(locationCountryForPort(state, port), undefined);
  assert.deepEqual(locationProfileTarget(state, { kind: "country", id: "country-nl" }), { kind: "country", id: "country-nl" });
  assert.ok(!locationCountries(state).some(country => !country.name.trim()));
});

test("both aliases show the newest shared update while retaining independent audit targets", () => {
  const state = createSeedState();
  const port = state.ports.find(port => port.country === "Netherlands")!;
  port.updatedAt = "2026-01-01T00:00:00Z";
  state.knowledgeHistory = [];
  state.contributions = [{
    id: "country-update", targetType: "country", targetId: "Netherlands", title: "Country note",
    body: "New shared information.", author: "otto", createdAt: "2026-10-20T00:00:00Z", status: "approved",
  }];
  const before = structuredClone(state);
  const records = locationRecords(state);
  assert.equal(records.find(record => record.key === "country:Netherlands")?.updatedAt, "2026-10-20T00:00:00Z");
  assert.equal(records.find(record => record.key === `port:${port.id}`)?.updatedAt, "2026-10-20T00:00:00Z");
  assert.deepEqual(state, before);
});

test("all roles create independent country records without rewards for empty locations", () => {
  for (const actor of actors) {
    const state = createSeedState(),
      gold = personalResources(state, actor.id).gold;
    const next = applyAction(
      state,
      { type: "add-location", kind: "country", name: "Canada" },
      actor,
    );
    assert.equal(
      knowledgeName(next, { kind: "country", id: "Canada" }),
      "Canada",
    );
    assert.deepEqual(
      locationChildren(next, { kind: "country", id: "Canada" }),
      [],
    );
    assert.equal(
      knowledgeDocument(next, { kind: "country", id: "Canada" }).sections[0]
        .blocks.length,
      0,
    );
    assert.equal(personalResources(next, actor.id).gold, gold);
    assert.equal(next.contributions.length, state.contributions.length);
    assert.ok(
      !locationCountries(state).some((country) => country.name === "Canada"),
    );
  }
});


test('active locations have only country and port records with direct country paths', () => {
  const state = createSeedState();
  assert.equal(state.locationAreas, undefined);
  assert.equal(state.legacyLocationAreas, undefined, 'Fresh seeds do not invent old grouping records');
  assert.ok(state.ports.every(port => !('areaId' in port)));
  assert.ok(locationRecords(state).every(record => ['country', 'port'].includes(record.kind)));
  assert.equal(locationRecords(state).find(record => record.target.id === 'port-chiba')?.path, 'Japan › Chiba');
  assert.deepEqual(locationChildren(state, { kind: 'country', id: 'Japan' }).map(record => record.name).sort(), ['Chiba', 'Osaka', 'Tokyo', 'Yokohama']);
  assert.deepEqual(locationAncestors(state, { kind: 'port', id: 'port-chiba' }).map(record => record.name), ['Japan']);
});

test('new country and port actions reject old grouping payloads and retain scoped uniqueness', () => {
  let state = applyAction(createSeedState(), { type: 'add-location', kind: 'country', name: 'Canada' }, actors[0]);
  state = applyAction(state, { type: 'add-location', kind: 'port', name: 'Vancouver', country: 'Canada' }, actors[0]);
  const before = structuredClone(state);
  const invalid = [
    { type: 'add-location', kind: 'country', name: ' canada ' },
    { type: 'add-location', kind: 'country', name: 'New', country: 'Japan' },
    { type: 'add-location', kind: 'area', name: 'Pacific Coast', country: 'Canada' },
    { type: 'add-location', kind: 'port', name: 'New', country: 'Unknown' },
    { type: 'add-location', kind: 'port', name: 'Vancouver', country: 'Canada' },
    { type: 'add-location', kind: 'port', name: 'New', country: 'Canada', areaId: 'legacy-group' },
  ];
  for (const action of invalid) assert.throws(() => applyAction(state, action as Action, actors[0]));
  assert.deepEqual(state, before);
  const other = applyAction(state, { type: 'add-location', kind: 'port', name: 'Vancouver', country: 'Japan' }, actors[0]);
  assert.equal(other.ports.filter(port => port.name === 'Vancouver').length, 2);
});

function legacyState() {
  const state = createSeedState();
  delete state.locationStructureVersion;
  state.locationAreas = [{ id: 'area-tokyo-bay', name: 'Tokyo Bay', country: 'Japan' }, { id: 'uninhabited-group', name: 'Offshore group', country: 'Japan' }];
  Object.assign(state.ports.find(port => port.id === 'port-chiba')!, { areaId: 'area-tokyo-bay' });
  const target = { kind: 'area' as const, id: 'area-tokyo-bay' };
  const document = { version: 7, layoutVersion: 2 as const, sections: [{ id: 'original-section', title: 'Saved group notes', blocks: [{ id: 'original-note', type: 'text' as const, title: 'User note', text: 'Retain the exact user-written information.', update: { updatedBy: 'otto', updatedAt: '2026-10-12T00:00:00Z' } }] }] };
  state.knowledgeRecords![knowledgeKey(state, target)] = document;
  state.knowledgeHistory = [{ target, version: 7, at: '2026-10-12T00:00:00Z', by: 'otto', reason: 'Original source', before: { ...document, version: 6 }, after: structuredClone(document) }];
  state.contributions.push({ id: 'legacy-contribution', targetType: 'area', targetId: target.id, title: 'Legacy note', body: 'Preserve this contribution without rewriting its target.', author: 'otto', createdAt: '2026-10-12T00:00:00Z', status: 'approved' });
  return { state, target, document };
}

test('flattening preserves original ports, knowledge, history and commercial references without creating a port for a group', () => {
  const { state, target, document } = legacyState(), before = structuredClone(state);
  const next = flattenLocationHierarchy(state);
  assert.deepEqual(state, before, 'Pure migration must not mutate its input');
  assert.equal(next.locationAreas, undefined);
  assert.deepEqual(next.legacyLocationAreas, before.locationAreas);
  assert.deepEqual(next.legacyPortAreaIds, { 'port-chiba': 'area-tokyo-bay' });
  assert.deepEqual(next.ports, before.ports.map(port => { const copy = { ...port } as typeof port & { areaId?: string }; delete copy.areaId; return copy; }));
  for (const key of ['knowledgeRecords', 'knowledgeHistory', 'contributions', 'enquiries', 'outcomes', 'hats', 'audit'] as const) assert.deepEqual(next[key], before[key], key);
  assert.deepEqual(knowledgeDocument(next, target), document);
  assert.equal(knowledgeName(next, target), 'Tokyo Bay');
  assert.deepEqual(locationProfileTarget(next, target), { kind: 'country', id: 'Japan' });
  assert.ok(!locationRecords(next).some(record => record.name === 'Tokyo Bay' || record.name === 'Offshore group'));
  assert.strictEqual(flattenLocationHierarchy(next), next);
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(next))), next);
});

test('archived group content is readable but cannot receive new knowledge or contributions', () => {
  const { state, target } = legacyState(), next = flattenLocationHierarchy(state), before = structuredClone(next);
  const base = knowledgeDocument(next, target), document = structuredClone(base);
  document.sections[0].blocks.push({ id: 'new', type: 'text', title: 'New', text: 'Do not write this to the old grouping target.' });
  assert.throws(() => applyAction(next, { type: 'save-knowledge', change: { target, baseVersion: base.version, baseDocument: base, document }, reason: 'Updated' }, actors[0]), /archived/);
  assert.throws(() => applyAction(next, { type: 'submit-contribution', targetType: 'area', targetId: target.id, title: 'New', body: 'This new information must use a country or port.' }, actors[0]), /archived/);
  assert.deepEqual(next, before);
});

test('existing group attachments retain their IDs and are exposed as ordinary country subfolders', () => {
  const { state, target } = legacyState(), next = flattenLocationHierarchy(state), scope = { target };
  const root = attachmentFolderId(scope), child = root + ':section:original-note';
  const catalog: AttachmentCatalog = { folders: [{ id: root, parentId: 'old-parent', name: 'Tokyo Bay (Area)', scope }, { id: 'user-subfolder', parentId: child, name: 'Original files', scope, custom: true }], items: [
    { id: 'original-file', folderId: child, scope: { target, section: { id: 'original-note', name: 'User note' } }, name: 'source.pdf', type: 'file', mime: 'application/pdf', size: 100, createdAt: '2026-10-12T00:00:00Z', createdBy: 'otto' },
  ] };
  const before = structuredClone(catalog), folders = buildAttachmentFolders(next, catalog);
  assert.deepEqual(catalog, before, 'Presentation does not rewrite stored item/blob references');
  assert.equal(folders.find(folder => folder.id === root)?.name, 'Tokyo Bay');
  assert.equal(folders.find(folder => folder.id === root)?.parentId, 'country:Japan');
  assert.equal(folders.find(folder => folder.id === child)?.parentId, root);
  assert.equal(folders.find(folder => folder.id === 'user-subfolder')?.parentId, child);
  assert.equal(folders.find(folder => folder.id === 'port:port-chiba')?.parentId, 'country:Japan');
  assert.ok(!folders.some(folder => folder.name.includes('(Area)')));
  assert.ok(!folders.some(folder => folder.scope?.target.kind === 'area'), 'New file destinations use current country scopes');
  assert.ok(!buildAttachmentFolders(next, { folders: [], items: [] }).some(folder => folder.id.startsWith('area:')));
});

test('country notes still publish and hydrate without restoring removed grouping nodes or deleted ports', () => {
  let state = applyAction(createSeedState(), { type: 'add-location', kind: 'country', name: 'Canada' }, actors[0]);
  state = applyAction(state, { type: 'submit-contribution', targetType: 'country', targetId: 'Canada', title: 'Note', body: 'This country note has been confirmed by the source.' }, actors[0]);
  assert.match(JSON.stringify(knowledgeDocument(state, { kind: 'country', id: 'Canada' })), /country note/);
  state.ports = state.ports.filter(port => port.id !== 'port-yokohama');
  const next = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.equal(next.locationAreas, undefined);
  assert.ok(!next.ports.some(port => port.id === 'port-yokohama'));
});
