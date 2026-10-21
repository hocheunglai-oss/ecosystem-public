import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupplierDirectory, querySupplierDirectory, supplierDirectoryOptions, supplierCompany, suppliersForCompany, type SupplierDirectorySource } from '../src/lib/supplierDirectory';
import { type IntelligenceSupplier } from '../src/lib/intelligence';
import { historicalSupplierFixtures } from '../src/lib/historicalSupplierFixtures';
import { syntheticIntelligence } from './fixtures/intelligence.mjs';
import { createSeedState } from '../src/lib/seed';

const ports = createSeedState().ports;
const intelligenceSuppliers = syntheticIntelligence().suppliers;
const source = (id: string, name: string, overrides: Partial<SupplierDirectorySource> = {}): SupplierDirectorySource => ({ id, name, portIds: ['port-singapore'], grades: ['VLSFO'], ...overrides });

test('the directory contains existing supplier identities and optional facts without fabricating new records', () => {
  const rows = buildSupplierDirectory(ports, intelligenceSuppliers);
  assert.equal(rows.length, new Set(intelligenceSuppliers.map(item => item.id)).size);
  for (const original of intelligenceSuppliers) {
    const row = rows.find(item => item.id === original.id)!;
    assert.ok(row);
    for (const [key, value] of Object.entries(original)) assert.deepEqual(row[key as keyof typeof row], value);
  }
  assert.ok(historicalSupplierFixtures.every(supplier => !rows.some(item => item.id === supplier.id)));
  assert.ok(rows.some(item => item.fixtureCount === 0));
});

test('duplicate IDs combine complementary coverage and facts while distinct suppliers sharing a name remain separate', () => {
  const inputs = [
    source('same-id', 'Original name', { fixtureCount: 0, paymentTerms: '30', grades: ['VLSFO', 'vlsfo'] }),
    source('same-id', 'Conflicting later name', { fixtureCount: 10, paymentTerms: '45', delivery: 'Barge', portIds: ['port-singapore', 'port-hong-kong'], grades: ['HSFO'] }),
    source('different-id', 'Original name'),
  ];
  const before = structuredClone(inputs);
  const rows = buildSupplierDirectory(ports, inputs);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'same-id');
  assert.equal(rows[0].name, 'Original name');
  assert.equal(rows[0].fixtureCount, 0);
  assert.equal(rows[0].paymentTerms, '30');
  assert.equal(rows[0].delivery, 'Barge');
  assert.deepEqual(rows[0].portIds, ['port-singapore', 'port-hong-kong']);
  assert.deepEqual(rows[0].grades, ['VLSFO', 'HSFO']);
  assert.deepEqual(inputs, before);
});

test('coverage follows current port names and canonical Hong Kong country while unknown ports remain searchable and filterable', () => {
  const changedPorts = structuredClone(ports);
  changedPorts.find(port => port.id === 'port-hong-kong')!.country = 'Old country name';
  changedPorts.find(port => port.id === 'port-tokyo')!.name = 'Current Tokyo name';
  const rows = buildSupplierDirectory(changedPorts, [source('coverage', 'Coverage supplier', { portIds: ['port-hong-kong', 'port-tokyo', 'unresolved-port-42'] })]);
  assert.deepEqual(rows[0].countries, ['Hong Kong', 'Japan']);
  assert.deepEqual(rows[0].ports.find(port => port.id === 'unresolved-port-42'), { id: 'unresolved-port-42', name: 'unresolved-port-42', known: false });
  assert.equal(querySupplierDirectory(rows, { country: '  HONG KONG ', search: 'current TOKYO' }).total, 1);
  assert.equal(querySupplierDirectory(rows, { portId: 'unresolved-port-42' }).total, 1);
  assert.equal(querySupplierDirectory(rows, { country: 'Hong Kong', portId: 'port-tokyo' }).total, 0, 'The country and port must describe the same coverage entry.');
  assert.equal(querySupplierDirectory(rows, { country: 'Hong Kong', portId: 'unresolved-port-42' }).total, 0);
  assert.equal(querySupplierDirectory(rows, { country: 'Japan', portId: 'port-tokyo' }).total, 1);
  assert.equal(querySupplierDirectory(rows, { search: 'unresolved 42' }).total, 1);
  assert.deepEqual(supplierDirectoryOptions(rows).countries, ['Hong Kong', 'Japan']);
  assert.ok(supplierDirectoryOptions(rows).ports.some(port => port.id === 'unresolved-port-42'));
});

test('normalized search combines supplier name, port, country and grades before applying exact filters and alphabetical selection', () => {
  const rows = buildSupplierDirectory(ports, [
    source('east', 'Éast–Marine', { portIds: ['port-hong-kong'], grades: ['HSFO', 'VLSFO'] }),
    source('euro', 'Euro Marine', { portIds: ['port-rotterdam'], grades: ['LSMGO'] }),
    source('numeric', '123 Marine'),
  ]);
  assert.equal(querySupplierDirectory(rows, { search: '  EAST MARINE hong kong VLSFO  ', country: 'Hong Kong', portId: 'port-hong-kong', grade: 'vlsfo', letter: 'e' }).total, 1);
  assert.equal(querySupplierDirectory(rows, { search: 'east netherlands' }).total, 0);
  assert.equal(querySupplierDirectory(rows, { grade: 'MGO' }).total, 0, 'Unknown grade equivalences must not be invented.');
  assert.deepEqual(querySupplierDirectory(rows, { letter: 'E' }).rows.map(row => row.id), ['east', 'euro']);
  assert.deepEqual(supplierDirectoryOptions(rows).letters, ['E']);
  assert.equal(querySupplierDirectory(rows).total, 3);
});

test('stable name and fixture sorting retain zero counts ahead of unknown counts without mutating source order', () => {
  const rows = buildSupplierDirectory(ports, [
    source('b', 'Alpha', { fixtureCount: 0 }),
    source('unknown', 'Aardvark'),
    source('top', 'Zulu', { fixtureCount: 7 }),
    source('a', 'Alpha', { fixtureCount: 0 }),
    source('nan', 'Unknown', { fixtureCount: NaN }),
  ]);
  const order = rows.map(row => row.id);
  assert.deepEqual(querySupplierDirectory(rows, { sort: 'name-asc' }).rows.map(row => row.id), ['unknown', 'a', 'b', 'nan', 'top']);
  assert.deepEqual(querySupplierDirectory(rows, { sort: 'name-desc' }).rows.map(row => row.id), ['top', 'nan', 'b', 'a', 'unknown']);
  assert.deepEqual(querySupplierDirectory(rows, { sort: 'fixtures-desc' }).rows.map(row => row.id), ['top', 'a', 'b', 'unknown', 'nan']);
  assert.deepEqual(rows.map(row => row.id), order);
});

test('5,000 suppliers filter and sort before bounded pagination with stable page boundaries', () => {
  const sources = Array.from({ length: 5000 }, (_, index) => source(`supplier-${index}`, `Supplier ${String(index).padStart(4, '0')}`, {
    portIds: [index % 2 ? 'port-hong-kong' : 'port-singapore'],
    grades: [index % 5 ? 'VLSFO' : 'HSFO'], fixtureCount: index,
  })).reverse();
  const rows = buildSupplierDirectory(ports, sources);
  const before = structuredClone(rows);
  const defaultPage = querySupplierDirectory(rows);
  assert.equal(defaultPage.total, 5000);
  assert.equal(defaultPage.pageSize, 50);
  assert.equal(defaultPage.pages, 100);
  assert.equal(defaultPage.rows[0].id, 'supplier-0');
  assert.equal(defaultPage.rows.at(-1)!.id, 'supplier-49');
  const next = querySupplierDirectory(rows, { page: 1 });
  assert.equal(next.rows[0].id, 'supplier-50');
  const filtered = querySupplierDirectory(rows, { country: 'Hong Kong', grade: 'HSFO', sort: 'fixtures-desc', page: 1, pageSize: 25 });
  assert.equal(filtered.total, 500);
  assert.equal(filtered.pages, 20);
  assert.equal(filtered.rows[0].fixtureCount, 4745);
  assert.equal(filtered.rows.at(-1)!.fixtureCount, 4505);
  const last = querySupplierDirectory(rows, { page: 9999, pageSize: 100 });
  assert.equal(last.page, 49);
  assert.equal(last.rows.length, 100);
  assert.equal(last.rows.at(-1)!.id, 'supplier-4999');
  const filteredLast = querySupplierDirectory(rows, { search: 'supplier 4999', page: 99 });
  assert.equal(filteredLast.total, 1);
  assert.equal(filteredLast.page, 0);
  assert.equal(filteredLast.rows[0].id, 'supplier-4999');
  assert.deepEqual(rows, before);
});

test('empty results and invalid pagination inputs remain bounded without inventing rows', () => {
  const rows = buildSupplierDirectory(ports, [source('one', 'Only supplier')]);
  assert.deepEqual(querySupplierDirectory([], { page: 100 }), { rows: [], total: 0, page: 0, pages: 1, pageSize: 50 });
  for (const page of [-10, NaN, Infinity, -Infinity]) assert.equal(querySupplierDirectory(rows, { page }).page, 0);
  for (const pageSize of [0, -1, 1, 5000, NaN, Infinity]) assert.equal(querySupplierDirectory(rows, { pageSize }).pageSize, 50);
  assert.equal(querySupplierDirectory(rows, { search: 'no match', page: 30 }).rows.length, 0);
  assert.equal(querySupplierDirectory(rows, { page: 0.9, pageSize: 25 }).page, 0);
  assert.deepEqual(supplierDirectoryOptions([]), { countries: [], ports: [], grades: [], letters: [] });
});


test('a company can remain a buyer and link to multiple suppliers without merging source identities or history', () => {
  const state = createSeedState(), company = state.companies[0];
  const original = structuredClone(state);
  const inputs = [
    source('source-supplier-one', 'First supplier source', { companyId: company.id, paymentTerms: '15', fixtureCount: 0 }),
    source('source-supplier-two', 'Second supplier source', { companyId: company.id, paymentTerms: '30', portIds: ['port-hong-kong'] }),
    source('unlinked-lookalike', company.name),
  ];
  const rows = buildSupplierDirectory(state.ports, inputs);
  assert.deepEqual(suppliersForCompany(rows, company.id).map(row => row.id), ['source-supplier-one', 'source-supplier-two']);
  assert.deepEqual(querySupplierDirectory(rows, { companyId: company.id, portId: 'port-hong-kong' }).rows.map(row => row.id), ['source-supplier-two']);
  assert.equal(supplierCompany(rows[0], state.companies), company);
  assert.equal(supplierCompany(rows[1], state.companies), company);
  assert.equal(supplierCompany(rows[2], state.companies), undefined, 'A matching name is not an identity link.');
  assert.equal(rows[0].paymentTerms, '15');
  assert.equal(rows[1].paymentTerms, '30');
  assert.equal('limit' in rows[0], false, 'Supplier records do not copy buyer credit fields.');
  assert.deepEqual(state, original, 'Buyer IDs, supplier IDs in fixtures and all existing financial history stay unchanged.');
  assert.deepEqual(buildSupplierDirectory(state.ports, JSON.parse(JSON.stringify(inputs))).map(row => row.companyId), [company.id, company.id, undefined]);
});

test('shared company links resolve exact unique IDs only and survive supplier-source deduplication', () => {
  const companies = [{ id: 'company-one', name: 'Same name', accountGroupId: 'group-one' }, { id: 'company-two', name: 'Same name', accountGroupId: 'group-one' }];
  const rows = buildSupplierDirectory(ports, [
    source('linked', 'Supplier name'),
    source('linked', 'A later label', { companyId: 'company-two' }),
    source('unknown', 'Same name', { companyId: 'missing-company' }),
  ]);
  assert.equal(rows[0].id, 'linked');
  assert.equal(rows[0].companyId, 'company-two');
  assert.equal(supplierCompany(rows[0], companies), companies[1]);
  assert.equal(supplierCompany(rows[0], [...companies, { ...companies[1] }]), undefined);
  assert.equal(supplierCompany(rows[1], companies), undefined);
  assert.equal(rows[1].companyId, 'missing-company', 'An unresolved link is retained rather than replaced by a name match.');
  assert.equal(supplierCompany({ companyId: 'group-one' }, companies), undefined, 'A buyer account group is not a legal company ID.');
  assert.equal(supplierCompany({ companyId: 'COMPANY-TWO' }, companies), undefined);
  assert.deepEqual(suppliersForCompany(rows, 'company-one'), []);
  assert.deepEqual(suppliersForCompany(rows, ''), []);
  assert.ok(buildSupplierDirectory(ports).every(row => row.companyId === undefined), 'Existing unverified sources receive no invented identity assignments.');
});


test('both supplier source contracts can carry the same company link without copying buyer terms', () => {
  const state = createSeedState(), company = state.companies[0];
  const imported: IntelligenceSupplier = { ...intelligenceSuppliers[0], companyId: company.id, paymentTerms: 'Supplier terms' };
  const demonstration = source('explicit-test-source', 'Explicit test supplier', { companyId: company.id });
  const rows = buildSupplierDirectory(state.ports, [imported, demonstration]);
  assert.deepEqual(rows.map(row => row.companyId), [company.id, company.id]);
  assert.equal(rows[0].paymentTerms, 'Supplier terms');
  assert.equal(rows[1].paymentTerms, undefined);
  assert.equal(rows[0].id, imported.id);
  assert.equal(rows[1].id, demonstration.id);
});


test('omitted authenticated references leave the legacy directory empty', () => {
  assert.deepEqual(buildSupplierDirectory(ports), []);
});
