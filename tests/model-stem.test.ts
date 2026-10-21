import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actors, currentMonth, monthlyStats, getOutcomePrivateNote,
  outcomeQuantityText, outcomeProfit, isPendingOutcome,
  type Action, type DemoState, type Enquiry,
} from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { defaultLostReasons, lostReasonsFor, DEFAULT_SUPPLIER_LOST_REASONS } from '../src/lib/lostReasons';
import { applyAction, activeSupplierFixtures as historicalSupplierFixtures } from './fixtures/activeSuppliers';

const [trader, credit, admin, otherTrader] = actors;
const now = `${currentMonth()}-25T10:00:00.000Z`;
function stateWithEnquiry(): DemoState {
  const state = createSeedState();
  const enquiry: Enquiry = {
    id: 'enquiry-range', buyerId: 'company-meridian', portId: 'port-singapore',
    vessel: 'MERIDIAN RANGE', imo: '9876543', eta: '2–4 OCT',
    grade: 'HSFO + VLSFO + LSMGO', quantity: 0, price: 0, margin: 0,
    rawText: 'Test enquiry', formattedText: 'MERIDIAN RANGE / SG / 2–4 OCT / 350–400 MT HSFO',
    status: 'sent', owner: trader.id, createdAt: now,
    products: [
      { grade: 'HSFO', quantityText: '350–400' },
      { grade: 'VLSFO', quantityText: '500–600' },
      { grade: 'LSMGO', quantityText: '60' },
    ],
  };
  state.enquiries.unshift(enquiry);
  return state;
}
function stem(): Extract<Action, { type: 'record-stem' }> {
  return {
    type: 'record-stem', id: 'enquiry-range', supplierId: historicalSupplierFixtures[0].id,
    products: [
      { grade: 'HSFO', quantityText: '350 - 400 MT', buyPrice: 410.25 },
      { grade: 'VLSFO', quantityText: '500 to 600', buyPrice: 550.35 },
      { grade: 'LSMGO', quantityText: '60', buyPrice: 695.44 },
    ],
    privateNote: 'Owner-only negotiation detail.', complianceChecked: true, creditChecked: true,
  };
}

test('STEM preserves requested ranges and buy prices, without estimating booked volume, margin, exposure or rewards', () => {
  const before = stateWithEnquiry();
  // A pending STEM should not reconcile unrelated targets either.
  before.goals = [{ owner: trader.id, month: currentMonth(), volume: 1, profit: 1 }];
  const snapshot = structuredClone(before);
  const next = applyAction(before, stem(), trader, now);
  const outcome = next.outcomes[0];
  assert.deepEqual(before, snapshot);
  assert.equal(next.enquiries[0].status, 'fixture');
  assert.equal(outcome.kind, 'fixture');
  assert.equal(outcome.commercialStatus, 'pending');
  assert.equal(isPendingOutcome(outcome), true);
  assert.equal(outcome.supplierId, historicalSupplierFixtures[0].id);
  assert.equal(outcome.supplierName, historicalSupplierFixtures[0].name);
  assert.deepEqual(outcome.stemProducts, [
    { grade: 'HSFO', quantityText: '350–400', buyPrice: 410.25 },
    { grade: 'VLSFO', quantityText: '500–600', buyPrice: 550.35 },
    { grade: 'LSMGO', quantityText: '60', buyPrice: 695.44 },
  ].map(product => ({ ...product, supplierId: historicalSupplierFixtures[0].id, supplierName: historicalSupplierFixtures[0].name })));
  assert.deepEqual([outcome.quantity, outcome.price, outcome.margin], [0, 0, 0]);
  assert.equal(outcomeQuantityText(outcome), '350–400 + 500–600 + 60');
  assert.deepEqual(next.companies, before.companies);
  assert.deepEqual(monthlyStats(next, trader.id, currentMonth()), monthlyStats(before, trader.id, currentMonth()));
  assert.deepEqual(next.drops, before.drops);
  assert.equal(outcomeProfit(outcome), 0);
  assert.equal(outcome.checkedBy, trader.id);
  assert.equal(outcome.checkedAt, now);
});

test('STEM stores three grade suppliers in one outcome with canonical names and no commercial side effects', () => {
  const before = stateWithEnquiry();
  const snapshot = structuredClone(before);
  const action = stem();
  delete action.supplierId;
  action.products = action.products.map((product, index) => ({
    ...product, supplierId: historicalSupplierFixtures[index].id, supplierName: 'Forged supplier display name',
  }));
  const next = applyAction(before, action, trader, now);
  const outcome = next.outcomes[0];
  assert.deepEqual(before, snapshot);
  assert.equal(next.outcomes.length, before.outcomes.length + 1);
  assert.equal(outcome.supplierId, undefined);
  assert.equal(outcome.supplierName, undefined);
  assert.deepEqual(outcome.stemProducts?.map(product => [product.grade, product.supplierId, product.supplierName]), [
    ['HSFO', historicalSupplierFixtures[0].id, historicalSupplierFixtures[0].name],
    ['VLSFO', historicalSupplierFixtures[1].id, historicalSupplierFixtures[1].name],
    ['LSMGO', historicalSupplierFixtures[2].id, historicalSupplierFixtures[2].name],
  ]);
  assert.equal(JSON.stringify(next).includes('Forged supplier display name'), false);
  for (const product of outcome.stemProducts!) {
    assert.ok(next.audit[0].detail.includes(`${product.grade}: ${product.supplierName}; ${product.quantityText} MT at USD ${product.buyPrice}/MT`));
  }
  assert.equal(outcomeProfit(outcome), 0);
  assert.deepEqual([outcome.quantity, outcome.price, outcome.margin], [0, 0, 0]);
  assert.deepEqual(next.companies, before.companies);
  assert.deepEqual(next.drops, before.drops);
  assert.deepEqual(next.economy, before.economy);
  assert.deepEqual(monthlyStats(next, trader.id, currentMonth()), monthlyStats(before, trader.id, currentMonth()));
});

test('grade supplier overrides the legacy common supplier and same-supplier grades retain the legacy header', () => {
  const action = stem();
  action.products[1] = { ...action.products[1], supplierId: historicalSupplierFixtures[1].id };
  const mixed = applyAction(stateWithEnquiry(), action, trader, now).outcomes[0];
  assert.deepEqual(mixed.stemProducts?.map(product => product.supplierId), [historicalSupplierFixtures[0].id, historicalSupplierFixtures[1].id, historicalSupplierFixtures[0].id]);
  assert.equal(mixed.supplierId, undefined);
  action.products = action.products.map(product => ({ ...product, supplierId: historicalSupplierFixtures[2].id }));
  const same = applyAction(stateWithEnquiry(), action, trader, now).outcomes[0];
  assert.equal(same.supplierId, historicalSupplierFixtures[2].id);
  assert.equal(same.supplierName, historicalSupplierFixtures[2].name);
  assert.ok(same.stemProducts?.every(product => product.supplierId === historicalSupplierFixtures[2].id));
});

test('STEM rejects an invalid grade supplier atomically, including an explicitly cleared grade with a common supplier', () => {
  const before = stateWithEnquiry();
  const snapshot = structuredClone(before);
  for (const supplierId of ['', ' ', 'not-a-supplier', null]) {
    const action = stem();
    action.products[2] = { ...action.products[2], supplierId: supplierId as string };
    assert.throws(() => applyAction(before, action, trader, now), /Choose a supplier for LSMGO/);
    assert.deepEqual(before, snapshot);
  }
  const missing = stem();
  delete missing.supplierId;
  missing.products = missing.products.map((product, index) => ({ ...product, ...(index < 2 ? { supplierId: historicalSupplierFixtures[index].id } : {}) }));
  assert.throws(() => applyAction(before, missing, trader, now), /Choose a supplier for LSMGO/);
  assert.deepEqual(before, snapshot);
});

test('pending STEM ignores stale numeric commercial fields in all progress calculations', () => {
  const next = applyAction(stateWithEnquiry(), stem(), trader, now);
  const baseline = monthlyStats(stateWithEnquiry(), trader.id, currentMonth());
  const outcome = next.outcomes[0];
  outcome.quantity = 99999;
  outcome.margin = 99999;
  outcome.products = [{ grade: 'VLSFO', quantity: 99999, price: 99999, margin: 99999 }];
  assert.equal(outcomeProfit(outcome), 0);
  assert.deepEqual(monthlyStats(next, trader.id, currentMonth()), baseline);
});

test('STEM validates all quantities, supplier, buy prices and requested grades', () => {
  const state = stateWithEnquiry();
  const valid = stem();
  assert.throws(() => applyAction(state, { ...valid, supplierId: 'not-a-supplier' }, trader, now), /supplier/);
  assert.throws(() => applyAction(state, { ...valid, products: [] }, trader, now), /every requested product/);
  assert.throws(() => applyAction(state, { ...valid, products: valid.products.slice(0, 1) }, trader, now), /every requested product/);
  assert.throws(() => applyAction(state, { ...valid, products: [...valid.products, valid.products[0]] }, trader, now), /grades must match/);
  assert.throws(() => applyAction(state, { ...valid, products: [{ ...valid.products[0], grade: 'UNREQUESTED' }, ...valid.products.slice(1)] }, trader, now), /grades must match/);
  for (const quantityText of ['400–350', '0', '-10', 'abc', '100–Infinity']) {
    assert.throws(() => applyAction(state, { ...valid, products: [{ ...valid.products[0], quantityText }, ...valid.products.slice(1)] }, trader, now), /quantity or range/);
  }
  for (const buyPrice of [0, -1, NaN, Infinity, 0.001, Number.MAX_VALUE]) {
    assert.throws(() => applyAction(state, { ...valid, products: [{ ...valid.products[0], buyPrice }, ...valid.products.slice(1)] }, trader, now), /buy price|precision/);
  }
});

test('STEM still requires both checks, an approved buyer, ownership and a confirmed record exactly once', () => {
  const state = stateWithEnquiry();
  const valid = stem();
  assert.throws(() => applyAction(state, { ...valid, complianceChecked: false }, trader, now), /compliance and credit/);
  assert.throws(() => applyAction(state, { ...valid, creditChecked: false }, trader, now), /compliance and credit/);
  assert.throws(() => applyAction(state, valid, otherTrader, now), /Only the enquiry owner/);
  assert.throws(() => applyAction(state, valid, credit, now), /role cannot/);
  state.enquiries[0].buyerId = 'company-novasea';
  assert.throws(() => applyAction(state, valid, trader, now), /approve this customer/);
  state.enquiries[0].buyerId = 'company-meridian';
  state.enquiries[0].status = 'draft';
  assert.throws(() => applyAction(state, valid, trader, now), /Confirm the enquiry/);
  state.enquiries[0].status = 'sent';
  const next = applyAction(state, valid, trader, now);
  assert.throws(() => applyAction(next, valid, trader, now), /Confirm the enquiry|already/);
  // A stale status cannot produce a second outcome either.
  next.enquiries[0].status = 'sent';
  assert.throws(() => applyAction(next, valid, trader, now), /already has/);
});

test('an exact quantity remains exact and legacy single-product enquiries stay recordable', () => {
  const state = stateWithEnquiry();
  state.enquiries[0].products = undefined;
  state.enquiries[0].grade = 'VLSFO 0.5%';
  state.enquiries[0].quantity = 350;
  const next = applyAction(state, { ...stem(), products: [{ grade: 'VLSFO 0.5%', quantityText: '350', buyPrice: 555 }] }, trader, now);
  assert.equal(outcomeQuantityText(next.outcomes[0]), '350');
  assert.equal(next.enquiries[0].quantity, 350, 'the original single-product request remains available in the enquiry record');
  assert.equal(next.outcomes[0].quantity, 0, 'an exact requested amount is still not a settled booked total');
  assert.deepEqual(monthlyStats(next, trader.id, currentMonth()), monthlyStats(state, trader.id, currentMonth()));
});

test('SPC supplier lost reasons initialize once and preserve later customization, pending records and private notes', () => {
  assert.deepEqual(defaultLostReasons.map(reason => reason.label), [...DEFAULT_SUPPLIER_LOST_REASONS]);
  const old = stateWithEnquiry();
  delete old.lostReasons;
  delete old.privateNotes;
  const upgraded = upgradeDemoState(old);
  assert.deepEqual(upgraded.lostReasons, defaultLostReasons);
  assert.deepEqual(upgraded.enquiries, old.enquiries);
  upgraded.lostReasons = [{ id: 'custom-id', label: 'Custom reason', active: true }];
  upgraded.privateNotes = { 'old-note': { owner: trader.id, text: 'Keep me.', updatedAt: now } };
  const again = upgradeDemoState(upgraded);
  assert.equal(again, upgraded);
  assert.deepEqual(again.privateNotes, upgraded.privateNotes);
  assert.deepEqual(lostReasonsFor(again), upgraded.lostReasons);
});

test('LOST uses current active reasons, snapshots the label and retains separate group/private notes without financial effects', () => {
  const before = stateWithEnquiry();
  const reason = lostReasonsFor(before)[0];
  const action: Extract<Action, { type: 'record-loss' }> = {
    type: 'record-loss', id: 'enquiry-range', reasonId: reason.id,
    groupNote: 'No barge in the requested window.', privateNote: 'Private follow-up with operations.',
  };
  const next = applyAction(before, action, trader, now);
  const outcome = next.outcomes[0];
  assert.equal(outcome.kind, 'lost');
  assert.equal(outcome.reasonId, reason.id);
  assert.equal(outcome.reason, reason.label);
  assert.equal(outcome.groupNote, action.groupNote);
  assert.equal(outcomeQuantityText(outcome), '350–400 + 500–600 + 60');
  assert.deepEqual(next.companies, before.companies);
  assert.deepEqual(next.drops, before.drops);
  assert.deepEqual(monthlyStats(next, trader.id, currentMonth()), monthlyStats(before, trader.id, currentMonth()));
  const revised = applyAction(next, { type: 'save-lost-reasons', reasons: lostReasonsFor(next).map(item => item.id === reason.id ? { ...item, label: 'New label', active: false } : item).reverse() }, admin, now);
  assert.equal(revised.outcomes[0].reason, reason.label);
  assert.equal(revised.outcomes[0].reasonId, reason.id);
  assert.equal(lostReasonsFor(revised).at(-1)!.label, 'New label');
  assert.equal(lostReasonsFor(revised).at(-1)!.active, false);
  revised.enquiries[0] = { ...revised.enquiries[0], id: 'enquiry-new', status: 'sent' };
  assert.throws(() => applyAction(revised, { ...action, id: 'enquiry-new' }, trader, now), /active lost reason/);
  assert.throws(() => applyAction(before, { ...action, reasonId: 'missing' }, trader, now), /active lost reason/);
});

test('private notes are accessible only to their owning trader and never placed in shared outcomes or audits', () => {
  for (const action of [stem(), { type: 'record-loss' as const, id: 'enquiry-range', reasonId: defaultLostReasons[0].id, groupNote: 'Shared note', privateNote: 'Private negotiation detail.' }]) {
    const next = applyAction(stateWithEnquiry(), action, trader, now);
    const outcome = next.outcomes[0];
    assert.equal(getOutcomePrivateNote(next, outcome.id, trader.id), action.privateNote);
    for (const actorId of [otherTrader.id, credit.id, admin.id, 'missing']) {
      assert.equal(getOutcomePrivateNote(next, outcome.id, actorId), '');
    }
    assert.equal(getOutcomePrivateNote(next, 'unknown', trader.id), '');
    assert.equal(JSON.stringify(next.outcomes).includes(action.privateNote), false);
    assert.equal(JSON.stringify(next.audit).includes(action.privateNote), false);
    const note = next.privateNotes![outcome.id];
    assert.deepEqual(note, { owner: trader.id, text: action.privateNote, updatedAt: now });
    note.owner = otherTrader.id;
    assert.equal(getOutcomePrivateNote(next, outcome.id, trader.id), '');
    assert.equal(getOutcomePrivateNote(next, outcome.id, otherTrader.id), '');
  }
});

test('Admin can add, rename, disable and reorder reasons; other roles cannot edit options', () => {
  const state = stateWithEnquiry();
  const reasons = lostReasonsFor(state).map((reason, index) => index === 0 ? { ...reason, active: false } : reason);
  reasons.unshift({ id: 'new-custom-reason', label: '  Supplier   allocation  ', active: true });
  const action = { type: 'save-lost-reasons' as const, reasons };
  for (const actor of [trader, otherTrader, credit]) {
    assert.throws(() => applyAction(state, action, actor, now), /role cannot/);
  }
  const next = applyAction(state, action, admin, now);
  assert.equal(next.lostReasons![0].id, 'new-custom-reason');
  assert.equal(next.lostReasons![0].label, 'Supplier allocation');
  assert.equal(next.lostReasons![1].active, false);
  assert.equal(next.audit[0].action, 'Lost reasons updated');
  assert.throws(() => applyAction(state, { type: 'save-lost-reasons', reasons: [] }, admin, now), /between 1 and 100/);
  assert.throws(() => applyAction(state, { type: 'save-lost-reasons', reasons: reasons.map(reason => ({ ...reason, active: false })) }, admin, now), /at least one/);
  assert.throws(() => applyAction(state, { type: 'save-lost-reasons', reasons: [...reasons, reasons[0]] }, admin, now), /unique IDs/);
  assert.throws(() => applyAction(state, { type: 'save-lost-reasons', reasons: [{ ...reasons[0], label: ' ' }] }, admin, now), /Lost reason is required/);
});
