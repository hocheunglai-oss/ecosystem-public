import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessUser } from '../shared/access';
import { actorFromAccess } from '../src/lib/accessActor';
import { actors, applyAction, canTrade, type Action, type Actor, type Enquiry } from '../src/lib/model';
import { createSeedState } from '../src/lib/seed';
import { knowledgeDocument } from '../src/lib/knowledge';

// These tests cover the browser-local prototype workflow adapter. Live identity,
// session revocation and database permissions are enforced and tested server-side.
const user: AccessUser = {
  id: '51ac5c7e-50bf-4eb2-8d95-289587a25cba', email: 'person@example.test', displayName: 'Person',
  officeId: '4c1353e7-fb01-43df-aefb-e186f60ce88d', officeName: 'Hong Kong',
  isAdmin: false, isManager: false, isSpcTrader: false, isActive: true,
  activated: true, passwordChangeSuggested: true, revision: 1,
};
const at = '2026-10-14T08:00:00.000Z';
const feedback: Action = { type: 'submit-contribution', targetType: 'feedback', targetId: 'ecosystem',
  title: 'Enquiry details', body: 'Keep the enquiry details visible when selecting a supplier.' };
const settings: Action = { type: 'save-lost-reasons', reasons: [{ id: 'price', label: 'Price', active: true }] };

test('real authenticated UUID users can publish feedback with their own attribution', () => {
  const state = createSeedState(), actor = actorFromAccess(user);
  const next = applyAction(state, feedback, actor, at);
  assert.equal(next.contributions[0].author, user.id);
  assert.equal(next.contributions[0].status, 'approved');
  assert.equal(next.audit[0].actor, user.displayName);
  assert.equal(state.contributions.some(item => item.author === user.id), false);
  assert.throws(() => applyAction(next, feedback, actor, at), /already been submitted/);
});

test('real authenticated UUID users can publish knowledge with their own attribution', () => {
  const state = createSeedState(), actor = actorFromAccess(user);
  const target = { kind: 'port' as const, id: 'port-chiba' };
  const base = knowledgeDocument(state, target), document = structuredClone(base);
  document.sections[0].blocks.push({ id: 'real-user-note', type: 'text', title: 'Delivery', text: 'Confirm the port agent before arrival.' });
  const next = applyAction(state, { type: 'save-knowledge', change: { target, baseVersion: base.version, baseDocument: base, document }, reason: 'Source checked' }, actor, at);
  assert.equal(next.contributions[0].author, user.id);
  assert.equal(next.contributions[0].status, 'approved');
  assert.ok(knowledgeDocument(next, target).sections.flatMap(section => section.blocks).some(block => block.id === 'real-user-note'));
});

test('real administrators keep trading and receive only explicitly allowed admin actions', () => {
  for (const isManager of [false, true]) {
    const actor = actorFromAccess({ ...user, isAdmin: true, isManager });
    assert.equal(canTrade(actor), true);
    assert.equal(applyAction(createSeedState(), settings, actor, at).lostReasons?.[0].label, 'Price');
    assert.equal(applyAction(createSeedState(), feedback, actor, at).contributions[0].author, user.id);
  }
});

test('SPC Trader and Manager flags do not grant administrator or credit permissions', () => {
  for (const flags of [{}, { isSpcTrader: true }, { isManager: true }, { isSpcTrader: true, isManager: true }]) {
    const actor = actorFromAccess({ ...user, ...flags }), state = createSeedState();
    assert.throws(() => applyAction(state, settings, actor, at), /role cannot/);
    assert.throws(() => applyAction(state, { type: 'save-buyer-credit-remarks', buyerId: state.companies[0].id, text: 'Reviewed' }, actor, at), /role cannot/);
  }
});

test('a refreshed membership that removes admin access loses local admin actions', () => {
  const previous = actorFromAccess({ ...user, isAdmin: true });
  assert.doesNotThrow(() => applyAction(createSeedState(), settings, previous, at));
  const refreshed = actorFromAccess({ ...user, revision: user.revision + 1, isAdmin: false });
  assert.throws(() => applyAction(createSeedState(), settings, refreshed, at), /role cannot/);
});

test('copied, rehydrated and browser-profile identities cannot enter the real-user workflow', () => {
  const actor = actorFromAccess(user), state = createSeedState();
  state.profiles = { ...state.profiles, [user.id]: { email: user.email, phone: '' } };
  for (const untrusted of [{ ...actor }, JSON.parse(JSON.stringify(actor)), { ...actor, role: 'admin', isAdmin: true }] as Actor[]) {
    assert.throws(() => applyAction(state, feedback, untrusted, at), /valid demo role/);
    assert.throws(() => applyAction(state, settings, untrusted, at), /valid demo role/);
  }
  // Adding a flag to an old demo contact also cannot create admin authority.
  assert.throws(() => applyAction(state, settings, { ...actors[0], isAdmin: true }, at), /role cannot/);
});

test('authenticated projections cannot be mutated to elevate role or admin capability', () => {
  const actor = actorFromAccess(user);
  assert.equal(Object.isFrozen(actor), true);
  assert.throws(() => { actor.role = 'admin'; }, TypeError);
  assert.throws(() => { actor.isAdmin = true; }, TypeError);
  assert.throws(() => applyAction(createSeedState(), settings, actor, at), /role cannot/);
});

test('inactive or unactivated access responses cannot produce workflow identities', () => {
  assert.throws(() => actorFromAccess({ ...user, isActive: false }), /active account/);
  assert.throws(() => actorFromAccess({ ...user, activated: false }), /active account/);
});

test('real users including admins still cannot save another user’s enquiry', () => {
  const state = createSeedState();
  const enquiry: Enquiry = { id: 'real-enquiry', buyerId: state.companies[0].id, portId: state.ports[0].id,
    vessel: 'TEST VESSEL', imo: '', eta: '15 October', grade: 'VLSFO', quantity: 100, price: 500, margin: 10,
    status: 'draft', rawText: '', formattedText: '', owner: user.id, createdAt: at };
  const next = applyAction(state, { type: 'save-enquiry', enquiry }, actorFromAccess(user), at);
  assert.equal(next.enquiries[0].owner, user.id);
  for (const isAdmin of [false, true]) {
    const other = actorFromAccess({ ...user, id: '4e1cfa3f-11eb-4e64-b894-676f711f072b', isAdmin });
    assert.throws(() => applyAction(next, { type: 'save-enquiry', enquiry }, other, at), /only save your own/);
  }
});
