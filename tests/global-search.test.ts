import test from 'node:test';
import assert from 'node:assert/strict';
import { globalSearchRecords, queryGlobalSearch } from '../src/lib/globalSearch';
import { createSeedState } from '../src/lib/seed';
import { actors } from '../src/lib/model';
import type { IncomingEnquiry } from '../src/inbox';

test('global search resolves stable buyer, supplier and location identities', () => {
  const state = createSeedState();
  const index = globalSearchRecords(state, actors[0], [], [], true);
  const buyer = queryGlobalSearch(index, 'eco20001')[0];
  assert.equal(buyer.category, 'Buyer');
  assert.deepEqual(buyer.context, { buyerId: 'company-meridian' });
  assert.equal(queryGlobalSearch(index, 'aster marine').some(item => item.category === 'Supplier'), false, 'Only authenticated shared supplier results are indexed.');
  assert.equal(queryGlobalSearch(index, 'jptyo')[0].context?.portId, 'port-tokyo');
  assert.deepEqual(queryGlobalSearch(index, 'tokyo bay').filter(item => item.workspace === 'ports'), [], 'Retired grouping names are not active search targets');
  assert.deepEqual(queryGlobalSearch(index, ''), []);
  assert(queryGlobalSearch(index, 'aster', 3).length <= 3);
});

test('combined country and port aliases produce one result retaining both names and the port code', () => {
  const state = createSeedState();
  const before = structuredClone(state);
  const index = globalSearchRecords(state, actors[0], []);
  const locations = (query: string) => queryGlobalSearch(index, query).filter(record => record.workspace === 'ports');
  const country = locations('Netherlands');
  assert.equal(country.length, 1);
  assert.deepEqual(country[0].context, { portId: 'port-rotterdam' });
  assert.equal(country[0].id, 'port:port-rotterdam');
  assert.equal(country[0].title, 'Rotterdam');
  assert.equal(locations('Rotterdam')[0].id, country[0].id);
  assert.equal(locations('Netherlands Rotterdam NLRTM')[0].id, country[0].id);
  assert.equal(locations('Singapore').length, 1);
  assert.equal(index.filter(record => record.workspace === 'ports' && record.id === 'country:Japan').length, 1);
  assert.equal(index.filter(record => record.workspace === 'ports' && record.id === 'port:port-tokyo').length, 1);
  assert.deepEqual(state, before);
});

test('registering a second port restores the independent country search result without losing either port', () => {
  const state = createSeedState();
  const port = state.ports.find(port => port.id === 'port-rotterdam')!;
  state.ports.push({ ...port, id: 'port-amsterdam', name: 'Amsterdam', code: 'NLAMS' });
  const index = globalSearchRecords(state, actors[0], []);
  const results = queryGlobalSearch(index, 'Netherlands').filter(record => record.workspace === 'ports');
  assert.deepEqual(results.map(record => record.id).sort(), ['country:Netherlands', 'port:port-amsterdam', 'port:port-rotterdam']);
  assert.deepEqual(queryGlobalSearch(index, 'NLAMS')[0].context, { portId: 'port-amsterdam' });
});

test('global search excludes another trader active work and private notes', () => {
  const state = createSeedState();
  const base = state.enquiries[0];
  state.enquiries.push({ ...base, id: 'mine-search', vessel: 'MY UNIQUE SHIP', owner: 'otto', status: 'draft' }, { ...base, id: 'other-search', vessel: 'OTHER PRIVATE SHIP', owner: 'filippo', status: 'draft' });
  state.privateNotes = { 'private-search': { owner: 'otto', text: 'PRIVATE SEARCH SECRET', updatedAt: new Date().toISOString() } };
  const index = globalSearchRecords(state, actors.find(actor => actor.id === 'otto')!, []);
  assert.equal(queryGlobalSearch(index, 'my unique')[0].context?.enquiryId, 'mine-search');
  assert.deepEqual(queryGlobalSearch(index, 'other private'), []);
  assert.deepEqual(queryGlobalSearch(index, 'PRIVATE SEARCH SECRET'), []);
  const credit = globalSearchRecords(state, actors.find(actor => actor.role === 'credit')!, []);
  assert.deepEqual(queryGlobalSearch(credit, 'my unique'), []);
});

test('incoming search retains message routing and omits linked or dismissed duplicates', () => {
  const state = createSeedState();
  const message = { id: 'incoming-search', owner: 'otto', channel: 'email', rawText: 'Vessel: SEARCH INCOMING\nBuyer: DEMO\nIMO: 9876123', read: false, receivedAt: new Date().toISOString() } as IncomingEnquiry;
  const index = globalSearchRecords(state, actors.find(actor => actor.id === 'otto')!, [message]);
  assert.equal(queryGlobalSearch(index, 'SEARCH INCOMING')[0].incomingId, message.id);
  const hidden = globalSearchRecords(state, actors.find(actor => actor.id === 'otto')!, [{ ...message, enquiryId: state.enquiries[0].id }]);
  assert.deepEqual(queryGlobalSearch(hidden, 'SEARCH INCOMING'), []);
  assert.equal(globalSearchRecords(state, actors.find(actor => actor.id === 'filippo')!, [message]).some(record => record.incomingId === message.id), false);
});
