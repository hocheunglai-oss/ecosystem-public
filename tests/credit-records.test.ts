import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, availableCredit, type Action, type Company, type DemoState } from '../src/lib/model';
import { activeTemporaryCredit, creditHistoryFor, creditRequestStage, effectiveCreditLimit } from '../src/lib/credit';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { applyAction, activeSupplierFixtures as historicalSupplierFixtures } from './fixtures/activeSuppliers';

const [trader, credit, admin] = actors;
const now = '2030-01-05T09:00:00.000Z';
const expiry = '2030-01-10T09:00:00.000Z';
function setup(): DemoState {
  const state = createSeedState();
  const company = state.companies.find(item => item.id === 'company-meridian')!;
  Object.assign(company, { status: 'approved', limit: 100000, exposure: 80000, terms: '30 days', creditStatus: 'Active', temporaryCredits: [] });
  state.requests = [];
  state.creditHistory = [];
  state.enquiries = [{ id: 'credit-enquiry', buyerId: company.id, portId: state.ports[0].id, vessel: 'CREDIT TEST', imo: '1234567', eta: '8 JAN', grade: 'VLSFO', quantity: 100, price: 500, margin: 10, rawText: '', formattedText: '', status: 'sent', createdAt: now, owner: trader.id, products: [{ grade: 'VLSFO', quantityText: '90–100' }] }];
  state.outcomes = [];
  return state;
}
const request: Extract<Action, { type: 'request-credit' }> = { type: 'request-credit', companyId: 'company-meridian', enquiryId: 'credit-enquiry', requestType: 'temporary', amount: 50000, reason: 'ONE-OFF STEM EXPOSURE', priority: 'urgent', expiresAt: expiry };
const buyer = (state: DemoState): Company => state.companies.find(item => item.id === 'company-meridian')!;
function approved(): DemoState {
  const requested = applyAction(setup(), request, trader, now);
  return applyAction(requested, { type: 'decide-credit', id: requested.requests[0].id, approve: true, amount: 50000, terms: '30 days', note: 'APPROVED UNTIL EXPIRY' }, credit, now);
}

test('temporary overage has an independent expiry and never changes permanent limit or terms', () => {
  const state = approved();
  assert.equal(buyer(state).limit, 100000);
  assert.equal(buyer(state).terms, '30 days');
  assert.equal(activeTemporaryCredit(buyer(state), now), 50000);
  assert.equal(effectiveCreditLimit(buyer(state), now), 150000);
  assert.equal(availableCredit(buyer(state), now), 70000);
  assert.equal(availableCredit(buyer(state), expiry), 20000);
  assert.equal(activeTemporaryCredit(buyer(state), '2029-12-31'), 0);
  assert.equal(state.requests[0].closedAt, now);
  assert.equal(state.requests[0].requestNumber, 'CR-2030-0001');
  assert.equal(state.requests[0].decision?.expiresAt, expiry);
  assert.equal(state.requests[0].requestedOffice, 'Hong Kong');
  assert.equal(state.creditHistory![0].type, 'temporary');
  assert.equal(state.creditHistory![0].requestId, state.requests[0].id);
});

test('acknowledgement records the first credit reviewer and cannot be performed by a trader', () => {
  const requested = applyAction(setup(), request, trader, now);
  const action: Action = { type: 'acknowledge-credit', id: requested.requests[0].id };
  assert.throws(() => applyAction(requested, action, trader, now), /role cannot/);
  const acknowledged = applyAction(requested, action, credit, now);
  assert.equal(acknowledged.requests[0].acknowledgedBy, credit.id);
  assert.equal(creditRequestStage(acknowledged.requests[0]), 'Acknowledged');
  const repeated = applyAction(acknowledged, action, admin, '2030-01-06T09:00:00.000Z');
  assert.equal(repeated.requests[0].acknowledgedAt, now);
  assert.equal(repeated.requests[0].acknowledgedBy, credit.id);
  assert.equal(repeated.audit.length, acknowledged.audit.length);
});

test('temporary requests and decisions reject missing, expired or invalid expiries', () => {
  for (const expiresAt of [undefined, 'invalid', '2029-01-01']) assert.throws(() => applyAction(setup(), { ...request, expiresAt }, trader, now), /expiry/);
  const requested = applyAction(setup(), request, trader, now);
  assert.throws(() => applyAction(requested, { type: 'decide-credit', id: requested.requests[0].id, approve: true, amount: 50000, terms: '30 days', note: 'REVIEWED' }, credit, '2030-01-11T09:00:00.000Z'), /expiry/);
  assert.equal(requested.requests[0].status, 'pending');
});

test('approvals and declines are immutable, role controlled and separate from credit history', () => {
  const requested = applyAction(setup(), request, trader, now);
  const decision: Extract<Action, { type: 'decide-credit' }> = { type: 'decide-credit', id: requested.requests[0].id, approve: false, amount: 0, terms: '', note: 'LIMIT RETAINED' };
  assert.throws(() => applyAction(requested, decision, trader, now), /role cannot/);
  const declined = applyAction(requested, decision, credit, now);
  assert.equal(declined.requests[0].closedAt, now);
  assert.equal(creditHistoryFor(declined).length, 0);
  assert.throws(() => applyAction(declined, decision, credit, now), /already has/);
  assert.throws(() => applyAction(declined, { type: 'acknowledge-credit', id: decision.id }, credit, now), /already has/);
  const approvedState = approved();
  assert.equal(creditHistoryFor(approvedState).length, 1);
});

test('historical priced exposure persists while temporary credit expires at the exact boundary', () => {
  const state = approved();
  buyer(state).exposure = 130000;
  const restored = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.equal(buyer(restored).exposure, 130000);
  assert.equal(availableCredit(buyer(restored), now), 20000);
  assert.equal(availableCredit(buyer(restored), expiry), -30000);
  assert.equal(creditHistoryFor(restored).length, 1);
});

test('unpriced STEM checks maximum purchase cost and does not book estimated exposure', () => {
  const action: Action = { type: 'record-stem', id: 'credit-enquiry', complianceChecked: true, creditChecked: true, products: [{ grade: 'VLSFO', quantityText: '90–100', buyPrice: 500, supplierId: historicalSupplierFixtures[0].id }] };
  assert.throws(() => applyAction(setup(), action, trader, now), /estimated purchase cost USD 50,000/);
  const state = approved();
  const booked = applyAction(state, action, trader, now);
  assert.equal(buyer(booked).exposure, 80000);
  assert.equal(booked.outcomes[0].commercialStatus, 'pending');
  assert.equal(booked.outcomes[0].price, 0);
});

test('suspended, on-hold and closed buyers cannot record STEM despite sufficient headroom', () => {
  for (const creditStatus of ['Suspended', 'On hold', 'Closed'] as const) {
    const state = approved();
    buyer(state).creditStatus = creditStatus;
    const common = { id: 'credit-enquiry', complianceChecked: true, creditChecked: true };
    assert.throws(() => applyAction(state, { type: 'record-stem', ...common, products: [{ grade: 'VLSFO', quantityText: '1', buyPrice: 1, supplierId: historicalSupplierFixtures[0].id }] }, trader, now), /Buyer credit is/);
  }
});

test('permanent increases retain additive behavior and write before/after credit history', () => {
  const requested = applyAction(setup(), { ...request, requestType: 'increase' }, trader, now);
  const state = applyAction(requested, { type: 'decide-credit', id: requested.requests[0].id, approve: true, amount: 50000, terms: '14 days', note: 'LIMIT REVIEW' }, credit, now);
  assert.equal(buyer(state).limit, 150000);
  assert.equal(buyer(state).terms, '14 days');
  assert.equal(state.creditHistory![0].previousLimit, 100000);
  assert.equal(state.creditHistory![0].limit, 150000);
  assert.equal(state.requests[0].decision?.resultingLimit, 150000);
  assert.equal(creditHistoryFor(state).length, 1);
});

test('new buyers receive a unique standard ID and owner office with no inherited temporary facility', () => {
  const state = setup();
  const template = { ...buyer(state), id: 'new-standard-buyer', name: 'NEW STANDARD BUYER', aliases: [], customerId: undefined, personInChargeId: undefined, office: undefined, status: 'pending' as const, limit: 0, exposure: 0, overdue: 0, temporaryCredits: [{ id: 'forged', requestId: 'forged', amount: 1000000, startsAt: now, expiresAt: expiry, approvedBy: credit.id }] };
  const created = applyAction(state, { type: 'add-company', company: template, requestedLimit: 300000, reason: 'NEW FLEET ACCOUNT' }, trader, now);
  const company = created.companies[0];
  assert.match(company.customerId!, /^ECO\d+$/);
  assert.ok(!state.companies.some(item => item.customerId === company.customerId));
  assert.equal(company.personInChargeId, trader.id);
  assert.equal(company.office, 'HKG');
  assert.deepEqual(company.temporaryCredits, []);
  assert.equal(company.creditStatus, undefined);
  assert.equal(company.limit, 0);
  assert.equal(company.inChargeHistory![0].personId, trader.id);
  const next = applyAction(created, { type: 'add-company', company: { ...template, id: 'next-buyer', name: 'NEXT BUYER' }, requestedLimit: 300000, reason: 'ANOTHER FLEET ACCOUNT' }, trader, now);
  assert.notEqual(next.companies[0].customerId, company.customerId);
});

test('combined permanent and temporary facilities cannot exceed supported financial precision', () => {
  const state = setup();
  buyer(state).limit = Number.MAX_SAFE_INTEGER / 100 - 25000;
  const requested = applyAction(state, request, trader, now);
  const previous = structuredClone(requested);
  assert.throws(() => applyAction(requested, { type: 'decide-credit', id: requested.requests[0].id, approve: true, amount: 50000, terms: '30 days', note: 'REVIEWED' }, credit, now), /supported precision/);
  assert.deepEqual(requested, previous);
});
