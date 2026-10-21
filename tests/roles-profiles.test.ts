import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, canTrade, contactsFor, currentMonth, getOutcomePrivateNote, isAdmin, profileFor, teamDrops, teamMembers, teamMonthlyStats, activeAccountTraders, type Enquiry } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { createDemoIncoming, deserializeInbox, receiveInboxMessage, routeInboxSender } from '../src/inbox';
import { applyAction, activeSupplierFixtures as historicalSupplierFixtures } from './fixtures/activeSuppliers';
import { accountingTestState } from './fixtures/accounting';

const trader = actors.find(actor => actor.id === 'otto')!;
const manager = actors.find(actor => actor.id === 'gianmichele')!;
const admin = actors.find(actor => actor.id === 'marco')!;
const credit = actors.find(actor => actor.id === 'elena')!;
const now = new Date().toISOString();
function managerDraft(): Enquiry {
  return { id: 'manager-enquiry', buyerId: 'company-meridian', portId: 'port-singapore', vessel: 'MANAGER DAWN', imo: '9876543', eta: '1-3 OCT', grade: 'VLSFO', quantity: 0, price: 0, margin: 0, rawText: 'MANAGER DAWN VLSFO 500-600 MT', formattedText: 'MANAGER DAWN / SG / 1-3 OCT / 500-600 MT VLSFO (0.5%)', status: 'draft', createdAt: now, owner: manager.id, products: [{ grade: 'VLSFO', quantityText: '500-600' }] };
}

test('public identities distinguish Manager from Admin and preserve trading owners', () => {
  assert.equal(trader.name, 'SAMPLE TRADER');
  assert.equal(trader.role, 'trader');
  assert.equal(manager.name, 'SAMPLE MANAGER A');
  assert.equal(manager.role, 'manager');
  assert.equal(admin.name, 'SAMPLE ADMINISTRATOR');
  assert.equal(admin.role, 'admin');
  assert(canTrade(manager));
  assert(!canTrade(admin));
  assert(isAdmin(admin));
  assert(!isAdmin(manager));
});

test('Manager trades own enquiries, makes credit requests and owns private STEM notes', () => {
  let state = applyAction(accountingTestState(now), { type: 'save-enquiry', enquiry: managerDraft() }, manager, now);
  state = applyAction(state, { type: 'confirm-enquiry', id: 'manager-enquiry' }, manager, now);
  assert.throws(() => applyAction(state, { type: 'amend-enquiry', id: 'manager-enquiry' }, trader, now), /Only the enquiry owner/);
  state = applyAction(state, { type: 'request-credit', companyId: 'company-meridian', enquiryId: 'manager-enquiry', amount: 1000, reason: 'Review headroom.', requestType: 'increase' }, manager, now);
  assert.equal(state.requests[0].requestedBy, manager.id);
  const pending = { type: 'record-stem' as const, id: 'manager-enquiry', supplierId: historicalSupplierFixtures[0].id, products: [{ grade: 'VLSFO', quantityText: '500-600', buyPrice: 500 }], privateNote: 'Manager private reference', complianceChecked: true, creditChecked: true };
  state = applyAction(state, pending, manager, now);
  const outcome = state.outcomes[0];
  assert.equal(outcome.owner, manager.id);
  assert.equal(getOutcomePrivateNote(state, outcome.id, manager.id), 'Manager private reference');
  for (const other of [trader, admin, credit]) assert.equal(getOutcomePrivateNote(state, outcome.id, other.id), '');
  assert.deepEqual(teamMonthlyStats(state, manager.id, currentMonth()), { volume: 5200, profit: 89200, fixtures: 4 });
});

test('Manager can contribute but cannot approve credit or change Admin controls', () => {
  const state = createSeedState();
  const contributed = applyAction(state, { type: 'submit-contribution', targetType: 'port', targetId: 'port-singapore', title: 'Handover', body: 'Include buyer confirmation in the shared port handover.' }, manager, now);
  assert.equal(contributed.contributions[0].author, manager.id);
  for (const action of [
    { type: 'decide-credit' as const, id: 'credit-001', approve: true, amount: 1000, terms: '30 days', note: 'Approved' },
    { type: 'save-lost-reasons' as const, reasons: state.lostReasons! },
    { type: 'review-contribution' as const, id: 'contribution-001', approve: true, note: 'Reviewed' },
    { type: 'set-goals' as const, owner: trader.id, month: currentMonth(), volume: 10000, profit: 130000 },
  ]) assert.throws(() => applyAction(state, action, manager, now), /role cannot/);
  assert.doesNotThrow(() => applyAction(state, { type: 'save-lost-reasons', reasons: state.lostReasons! }, admin, now));
});

test('team totals include only assigned traders and manager, current settled fixtures, and net Drops', () => {
  const state = accountingTestState(now);
  assert.deepEqual(teamMembers(manager).map(actor => actor.id), ['gianmichele', 'otto']);
  assert.deepEqual(teamMembers(admin), []);
  const base = state.outcomes.find(outcome => outcome.kind === 'fixture')!;
  state.outcomes.push(
    { ...base, id: 'manager-fixture', owner: manager.id, quantity: 100, margin: 10 },
    { ...base, id: 'luca-fixture', owner: 'luca', quantity: 200, margin: 15 },
    { ...base, id: 'outside-team', owner: credit.id, quantity: 9999, margin: 100 },
    { ...base, id: 'pending-team', owner: manager.id, quantity: 9999, margin: 100, commercialStatus: 'pending' },
  );
  state.drops.push(
    { id: 'manager-drops', owner: manager.id, at: now, amount: 50, reason: 'Contribution', key: 'manager' },
    { id: 'luca-drops', owner: 'luca', at: now, amount: -10, reason: 'Adjustment', key: 'luca' },
    { id: 'credit-drops', owner: credit.id, at: now, amount: 999, reason: 'Outside team', key: 'credit' },
  );
  assert.deepEqual(teamMonthlyStats(state, manager.id, currentMonth()), { volume: 5300, profit: 90200, fixtures: 5 });
  assert.equal(teamDrops(state, manager.id), 120);
  assert.equal(teamDrops(state, admin.id), 0);
});

test('account activity includes Manager enquiries for other traders', () => {
  const state = createSeedState();
  state.enquiries.unshift(managerDraft());
  assert.equal(activeAccountTraders(state, 'company-meridian', trader.id)[0].trader.id, manager.id);
});

test('own contact edits validate identities and route new demo arrivals without changing old ownership', () => {
  const original = createSeedState();
  const oldMessage = createDemoIncoming('email', trader.id, new Date(now), 'before-edit');
  const accepted = receiveInboxMessage([], oldMessage).items;
  const state = applyAction(original, { type: 'update-profile', phone: '+852 1111 2222', email: ' OTTO.NEW@ECOSYSTEM.EXAMPLE ' }, trader, now);
  assert.deepEqual(profileFor(state, trader.id), { phone: '+85211112222', email: 'otto.new@ecosystem.example' });
  assert.equal(profileFor(original, trader.id).email, 'otto@ecosystem.example');
  assert.equal(routeInboxSender('email', 'otto@ecosystem.example', contactsFor(state)).owner, null);
  assert.equal(routeInboxSender('email', 'otto.new@ecosystem.example', contactsFor(state)).owner, trader.id);
  const restoredState = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  const newMessage = createDemoIncoming('whatsapp', trader.id, new Date(now), 'after-edit', contactsFor(restoredState));
  assert.equal(newMessage.sender, '+85211112222');
  const newReceived = receiveInboxMessage(accepted, newMessage, contactsFor(restoredState));
  assert.equal(newReceived.received?.owner, trader.id);
  assert.deepEqual(deserializeInbox(JSON.stringify({ version: 2, items: newReceived.items })), newReceived.items);
  // The previous demo name mapped Gianmichele's email to the stable Otto actor ID.
  const historical = { ...accepted[0], sender: 'gianmichele@ecosystem.example' };
  assert.equal(deserializeInbox(JSON.stringify({ version: 2, items: [historical] }))?.[0].owner, trader.id);
  assert.equal(routeInboxSender('email', 'vincent@ecosystem.example', contactsFor(state)).owner, manager.id);
});

test('invalid or duplicate contacts cannot capture another profile\'s enquiries', () => {
  const state = createSeedState();
  for (const details of [
    { phone: 'abc', email: 'otto@ecosystem.example' },
    { phone: '+85211112222', email: 'Otto <otto@ecosystem.example>' },
    { phone: profileFor(state, manager.id).phone, email: 'new@ecosystem.example' },
    { phone: '+85211112222', email: 'VINCENT@ECOSYSTEM.EXAMPLE' },
  ]) assert.throws(() => applyAction(state, { type: 'update-profile', ...details }, trader, now), /valid|belongs to another/);
  const snapshot = structuredClone(state);
  assert.doesNotThrow(() => applyAction(state, { type: 'update-profile', ...profileFor(state, credit.id) }, credit, now));
  assert.deepEqual(state, snapshot);
});

test('profile migration preserves current enquiries, history, notes and administrator edits', () => {
  const state = createSeedState();
  state.enquiries.unshift(managerDraft());
  state.privateNotes = { 'outcome-1': { owner: trader.id, text: 'Keep private', updatedAt: now } };
  state.lostReasons![0].label = 'Custom reason';
  delete state.profiles;
  const upgraded = upgradeDemoState(state);
  assert.deepEqual(upgraded.enquiries, state.enquiries);
  assert.deepEqual(upgraded.privateNotes, state.privateNotes);
  assert.deepEqual(upgraded.lostReasons, state.lostReasons);
  assert.deepEqual(upgraded.outcomes, state.outcomes);
  assert.equal(profileFor(upgraded, manager.id).email, 'vincent@ecosystem.example');
  assert.deepEqual(upgradeDemoState(upgraded), upgraded);
});

test('Guido remains an administrator and legacy enquiries are preserved without granting confirmation permission', () => {
  const state = createSeedState();
  const legacy = { ...managerDraft(), id: 'legacy-guido-enquiry', owner: admin.id, vessel: 'MERIDIAN DAWN' };
  state.enquiries.unshift(legacy);
  const restored = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.enquiries.find(item => item.id === legacy.id), legacy);
  assert.equal(admin.id, 'marco');
  assert.equal(admin.name, 'SAMPLE ADMINISTRATOR');
  assert.equal(admin.role, 'admin');
  assert.equal(canTrade(admin), false);
  for (const actor of [admin, credit]) {
    assert.throws(() => applyAction(restored, { type: 'save-enquiry', enquiry: { ...legacy, owner: actor.id } }, actor, now), /role cannot/);
    assert.throws(() => applyAction(restored, { type: 'confirm-enquiry', id: legacy.id }, actor, now), /role cannot/);
  }
  assert.deepEqual(restored.enquiries.find(item => item.id === legacy.id), legacy);
});
