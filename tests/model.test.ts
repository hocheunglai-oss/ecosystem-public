import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, availableCredit, currentMonth, monthlyStats, reportingMonth, parseProductQuantity, activeAccountTraders, enquiryImoHistory, personalResources, resourceHistory, type Action, type Company, type Enquiry, type DemoState, type Outcome } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { accountingTestState } from './fixtures/accounting';
import { applyAction, activeSupplierFixtures } from './fixtures/activeSuppliers';

const [trader, credit, admin] = actors;
const now = `${currentMonth()}-25T12:00:00.000Z`;

// Test enquiries are explicit fixtures; the public demo starts with no active work.
function createTestState() {
  const state = accountingTestState(now);
  // This credit behavior fixture has USD120k headroom independently of the public demo scenario.
  state.companies.find(company => company.id === "company-bluewater")!.exposure = 780000;
  const fixtures: [string, string, string, string, number, number, number, Enquiry['status']][] = [
    ['enquiry-001', 'meridian', 'singapore', 'MERIDIAN DAWN', 600, 580, 18, 'draft'],
    ['enquiry-002', 'bluewater', 'hong-kong', 'BLUEWATER SKY', 500, 610, 16, 'sent'],
    ['enquiry-003', 'novasea', 'singapore', 'NOVA HORIZON', 400, 585, 17, 'draft'],
    ['enquiry-004', 'pacific-orbit', 'tokyo', 'PACIFIC LANTERN', 350, 625, 21, 'sent'],
    ['enquiry-005', 'harborlight', 'gibraltar', 'HARBORLIGHT ONE', 700, 570, 19, 'draft'],
    ['enquiry-006', 'delta-horizon', 'rotterdam', 'DELTA EXPLORER', 450, 555, 15, 'sent'],
  ];
  state.enquiries.unshift(...fixtures.map(([id, buyer, port, vessel, quantity, price, margin, status]): Enquiry => ({
    id, buyerId: `company-${buyer}`, portId: `port-${port}`, vessel, imo: '',
    eta: '15-17 October', grade: 'VLSFO 0.5%', quantity, price, margin, status,
    rawText: `${vessel} / ${port} / VLSFO ${quantity} MT`,
    formattedText: `${vessel} / ${port.toUpperCase()} / 15-17 OCTOBER / ${quantity} MT VLSFO (0.5%)`,
    owner: trader.id, createdAt: now,
  })));
  state.requests.find((request) => request.id === 'credit-001')!.enquiryId = 'enquiry-002';
  return state;
}

// Stored historical sales are test input, not a replacement booking implementation.
function withHistoricalSale(original: DemoState, enquiryId: string, terms: Pick<Outcome, 'quantity' | 'price' | 'margin'> & Partial<Outcome>): DemoState {
  const state = structuredClone(original), enquiry = state.enquiries.find(item => item.id === enquiryId)!;
  state.outcomes.unshift({ id: `historical-${enquiryId}`, enquiryId, buyerId: enquiry.buyerId, portId: enquiry.portId,
    vessel: enquiry.vessel, grade: enquiry.grade, kind: 'fixture', owner: enquiry.owner, bookedAt: now, reason: '', ...terms });
  enquiry.status = 'fixture';
  return upgradeDemoState(JSON.parse(JSON.stringify(state)));
}
function stem(state: DemoState, id: string): Extract<Action, { type: 'record-stem' }> {
  const enquiry = state.enquiries.find(item => item.id === id)!;
  return { type: 'record-stem', id, complianceChecked: true, creditChecked: true, products: [
    { grade: enquiry.grade, quantityText: String(enquiry.quantity), buyPrice: enquiry.price, supplierId: activeSupplierFixtures[0].id },
  ] };
}

test('monthly progress includes only booked fixtures in that month, with margin × quantity profit', () => {
  const state = createTestState();
  assert.deepEqual(monthlyStats(state, trader.id, currentMonth()), { volume: 5200, profit: 89200, fixtures: 4 });
  assert.deepEqual(monthlyStats(state, credit.id, currentMonth()), { volume: 0, profit: 0, fixtures: 0 });
});

test('commercial months follow Hong Kong midnight rather than UTC or browser timezone', () => {
  const state = createTestState();
  const fixture = state.outcomes.find(outcome => outcome.kind === 'fixture')!;
  state.outcomes = [
    { ...fixture, id: 'september-last', bookedAt: '2026-09-30T15:59:00.000Z', quantity: 200, margin: 10 },
    { ...fixture, id: 'october-first', bookedAt: '2026-09-30T16:01:00.000Z', quantity: 100, margin: 12 },
  ];
  assert.equal(reportingMonth('2026-09-30T15:59:00.000Z'), '2026-09');
  assert.equal(reportingMonth('2026-09-30T16:01:00.000Z'), '2026-10');
  assert.equal(currentMonth(new Date('2026-09-30T16:01:00.000Z')), '2026-10');
  assert.deepEqual(monthlyStats(state, trader.id, '2026-09'), { volume: 200, profit: 2000, fixtures: 1 });
  assert.deepEqual(monthlyStats(state, trader.id, '2026-10'), { volume: 100, profit: 1200, fixtures: 1 });
});

test('credit approvals are role controlled, recorded, additive for increases and immutable', () => {
  const state = createTestState();
  const original = structuredClone(state);
  const action = { type: 'decide-credit' as const, id: 'credit-001', approve: true, amount: 350000, terms: '30 days', note: 'Reviewed financials and approved additional headroom.' };
  assert.throws(() => applyAction(state, action, trader, now), /role cannot/);
  const next = applyAction(state, action, credit, now);
  assert.deepEqual(state, original);
  assert.equal(next.companies.find(item => item.id === 'company-bluewater')!.limit, 1250000);
  assert.equal(next.requests[0].decision!.by, credit.id);
  assert.equal(next.requests[0].decision!.note, action.note);
  assert.match(next.audit[0].detail, /900000 → USD 1250000/);
  assert.throws(() => applyAction(next, action, credit, now), /already has/);
});

test('historical priced sales retain exposure and monthly totals after a credit increase', () => {
  let state = withHistoricalSale(createTestState(), 'enquiry-002', { quantity: 500, price: 610, margin: 16 });
  state.companies.find(item => item.id === 'company-bluewater')!.exposure = 1085000;
  assert.equal(availableCredit(state.companies.find(item => item.id === 'company-bluewater')!), -185000);
  state = applyAction(state, { type: 'decide-credit', id: 'credit-001', approve: true, amount: 350000, terms: '30 days', note: 'Approved after credit review.' }, credit, now);
  const company = state.companies.find(item => item.id === 'company-bluewater')!;
  assert.equal(company.exposure, 1085000);
  assert.equal(availableCredit(company), 165000);
  assert.equal(state.outcomes.filter(item => item.enquiryId === 'enquiry-002').length, 1);
  assert.deepEqual(monthlyStats(state, trader.id, currentMonth()), { volume: 5700, profit: 97200, fixtures: 5 });
  const snapshot = structuredClone(state);
  for (const actor of actors) assert.throws(() => applyAction(state, { type: 'record-outcome', id: 'enquiry-002' } as unknown as Action, actor, now), /not supported/);
  assert.deepEqual(state, snapshot);
});

test('lost records require a reason and do not consume credit or advance targets', () => {
  const state = createTestState();
  const action = { type: 'record-loss' as const, id: 'enquiry-002', reasonId: '' };
  assert.throws(() => applyAction(state, action, trader, now), /active lost reason/);
  const next = applyAction(state, { ...action, reasonId: state.lostReasons![0].id, groupNote: 'Supplier could not meet requested timing.' }, trader, now);
  assert.equal(next.companies.find(item => item.id === 'company-bluewater')!.exposure, 780000);
  assert.deepEqual(monthlyStats(next, trader.id, currentMonth()), monthlyStats(state, trader.id, currentMonth()));
});

test('new customers start pending with zero credit and receive an initial, not additive, approved limit', () => {
  let state = createTestState();
  const company: Company = { ...state.companies[0], id: 'company-new-demo', customerId: 'ECO-TEST-NEW', name: 'New Demo Shipping Ltd', aliases: [], status: 'pending', limit: 0, exposure: 0, overdue: 0 };
  state = applyAction(state, { type: 'add-company', company, requestedLimit: 250000, reason: 'New legal buyer for review.' }, trader, now);
  assert.equal(state.companies[0].status, 'pending');
  assert.equal(state.companies[0].limit, 0);
  assert.equal(state.requests[0].type, 'new-customer');
  state = applyAction(state, { type: 'decide-credit', id: state.requests[0].id, approve: true, amount: 200000, terms: '14 days', note: 'Initial limit approved with shorter terms.' }, credit, now);
  assert.equal(state.companies[0].limit, 200000);
  assert.equal(state.companies[0].status, 'approved');
  assert.equal(state.companies[0].terms, '14 days');
  assert.match(state.audit[0].detail, /terms: 30 days → 14 days/);
  assert.match(state.audit[0].detail, /status: pending → approved/);
});

test('credit approvals cannot round down to zero or overflow supported financial precision', () => {
  const state = createTestState();
  const action = { type: 'decide-credit' as const, id: 'credit-001', approve: true, amount: 0.001, terms: '30 days', note: 'Reviewed request.' };
  assert.throws(() => applyAction(state, action, credit, now), /greater than zero/);
  assert.throws(() => applyAction(state, { ...action, amount: Number.MAX_VALUE }, credit, now), /supported precision/);
  assert.equal(state.requests[0].status, 'pending');
  assert.equal(state.companies.find(company => company.id === 'company-bluewater')!.limit, 900000);
});

test('duplicate pending credit requests and missing decisions are rejected', () => {
  const state = createTestState();
  assert.throws(() => applyAction(state, { type: 'request-credit', companyId: 'company-bluewater', amount: 100000, reason: 'More credit required.', requestType: 'increase' }, trader, now), /already awaiting/);
  assert.throws(() => applyAction(state, { type: 'decide-credit', id: 'credit-001', approve: false, amount: 0, terms: '', note: ' ' }, credit, now), /Decision reason/);
  const next = applyAction(state, { type: 'decide-credit', id: 'credit-001', approve: false, amount: 0, terms: '', note: 'Updated financial statements required.' }, credit, now);
  assert.equal(next.requests[0].status, 'declined');
  assert.equal(next.requests[0].decision!.amount, 0);
  assert.equal(next.companies.find(item => item.id === 'company-bluewater')!.limit, 900000);
});

test('accepted knowledge is published and awards one Gold once; declined knowledge awards none', () => {
  const state = createTestState();
  assert.throws(() => applyAction(state, { type: 'review-contribution', id: 'contribution-001', approve: true, note: 'Useful information.' }, credit, now), /role cannot/);
  const next = applyAction(state, { type: 'review-contribution', id: 'contribution-001', approve: true, note: 'Accepted as an internal handover practice.' }, admin, now);
  assert.equal(resourceHistory(next, trader.id).filter(item => item.key === 'gold:contribution:contribution-001').length, 1);
  assert.equal(personalResources(next, trader.id).gold, personalResources(state, trader.id).gold + 1);
  assert.deepEqual(next.drops, state.drops);
  assert.ok(next.ports[0].notes.includes(next.contributions[0].body));
  assert.throws(() => applyAction(next, { type: 'review-contribution', id: 'contribution-001', approve: true, note: 'Again.' }, admin, now), /already/);
  const declined = applyAction(next, { type: 'review-contribution', id: 'contribution-002', approve: false, note: 'Please add supporting detail.' }, admin, now);
  assert.equal(declined.drops.length, next.drops.length);
});

test('trivial and duplicate contributions cannot earn Gold; direct saves cannot be rewarded again', () => {
  let state = createTestState();
  assert.throws(() => applyAction(state, { type: 'submit-contribution', targetType: 'port', targetId: 'port-singapore', title: 'Note', body: 'Looks good.' }, trader, now), /30 characters/);
  const action = { type: 'submit-contribution' as const, targetType: 'port' as const, targetId: 'port-singapore', title: 'Manager note', body: 'An independent reviewer should validate all operational knowledge before publishing.' };
  state = applyAction(state, action, admin, now);
  assert.throws(() => applyAction(state, { type: 'review-contribution', id: state.contributions[0].id, approve: true, note: 'Self review.' }, admin, now), /already/);
  assert.throws(() => applyAction(state, action, trader, now), /already been submitted/);
});

test('stored legacy goals and their audit survive migration without awarding resources', () => {
  const state = createTestState();
  state.goals = [{ owner: trader.id, month: currentMonth(), volume: 5200, profit: 89200 }];
  state.audit.unshift({ id: 'legacy-goal-audit', at: now, actor: admin.name, role: 'admin', action: 'Monthly goals updated', entity: trader.name, detail: 'Historical target' });
  const restored = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.goals, state.goals);
  assert.deepEqual(restored.audit, state.audit);
  assert.deepEqual(restored.drops, state.drops);
  assert.deepEqual(personalResources(restored, trader.id), personalResources(state, trader.id));
  assert.equal(restored.drops.filter(item => item.key.startsWith('goal:')).length, 0);
});

test('retired local goal mutations cannot alter historical goals for any role', () => {
  const state = createTestState(), snapshot = structuredClone(state);
  const retired = { type: 'set-goals', owner: trader.id, month: currentMonth(), volume: 5200, profit: 89200 } as unknown as Action;
  for (const actor of actors) assert.throws(() => applyAction(state, retired, actor, now), /not supported/);
  assert.deepEqual(state, snapshot);
});

test('country updates validate their country, remain recorded for publication and award the contributor once', () => {
  const state = createTestState();
  const action = { type: 'submit-contribution' as const, targetType: 'country' as const, targetId: state.ports[0].country, title: 'Country documentation update', body: 'The country team has supplied an updated checklist for delivery documentation.' };
  assert.throws(() => applyAction(state, { ...action, targetId: 'Unknown country' }, trader, now), /valid country/);
  const submitted = applyAction(state, action, trader, now);
  const contribution = submitted.contributions[0];
  assert.equal(contribution.targetType, 'country');
  assert.equal(contribution.targetId, action.targetId);
  assert.equal(contribution.status, 'approved');
  assert.equal(submitted.drops.length, state.drops.length);
  assert.equal(submitted.audit[0].action, 'Knowledge submitted');
  const approved = submitted;
  assert.equal(approved.contributions[0].status, 'approved');
  assert.equal(approved.contributions[0].reviewer, undefined);
  assert.equal(personalResources(approved, trader.id).gold, personalResources(state, trader.id).gold + 1);
  assert.equal(resourceHistory(approved, trader.id).filter(entry => entry.key === `gold:contribution:${contribution.id}`).length, 1);
  assert.deepEqual(approved.drops, state.drops);
  assert.equal(approved.audit[0].action, 'Knowledge submitted');
  assert.throws(() => applyAction(approved, { type: 'review-contribution', id: contribution.id, approve: true, note: 'Again.' }, admin, now), /already/);
  assert.deepEqual(approved.ports, state.ports);
});

test('ecosystem feedback persists and earns one immediate Gold', () => {
  const state = createTestState();
  const action = { type: 'submit-contribution' as const, targetType: 'feedback' as const, targetId: 'ecosystem', title: 'Keep enquiry draft visible', body: 'Please retain the enquiry draft when switching between credit and port information.' };
  assert.throws(() => applyAction(state, { ...action, targetId: 'another-platform' }, trader, now), /valid feedback target/);
  const submitted = applyAction(state, action, trader, now);
  assert.equal(submitted.contributions[0].body, action.body);
  assert.equal(submitted.contributions[0].status, 'approved');
  assert.equal(submitted.audit[0].action, 'Feedback submitted');
  assert.equal(personalResources(submitted, trader.id).gold, personalResources(state, trader.id).gold + 1);
  assert.equal(submitted.audit[0].detail, 'Published.');
  assert.deepEqual(submitted.drops, state.drops);
  assert.throws(()=>applyAction(submitted,action,trader,now),/already/);
});

test('historical negative margins reduce profit; current STEM rejects invalid quantities and prices', () => {
  const state = createTestState();
  const historical = withHistoricalSale(state, 'enquiry-004', { quantity: 350, price: 625, margin: -5 });
  assert.equal(monthlyStats(historical, trader.id, currentMonth()).profit, 87450);
  const action = stem(state, 'enquiry-004');
  for (const quantityText of ['-1', 'NaN', 'Infinity']) assert.throws(() => applyAction(state, { ...action, products: [{ ...action.products[0], quantityText }] }, trader, now));
  for (const buyPrice of [-1, NaN, Infinity, Number.MAX_VALUE]) assert.throws(() => applyAction(state, { ...action, products: [{ ...action.products[0], buyPrice }] }, trader, now));
});

test('profit changes no longer generate or retract resources', () => {
  let state = createTestState();
  state.goals = [{ owner: trader.id, month: currentMonth(), volume: null, profit: 89000 }];
  assert.equal(state.drops.reduce((sum, drop) => sum + drop.amount, 0), 70);
  state = withHistoricalSale(state, 'enquiry-004', { quantity: 350, price: 625, margin: -5 });
  assert.equal(state.drops.reduce((sum, drop) => sum + drop.amount, 0), 70);
  assert.deepEqual(personalResources(state, trader.id), personalResources(createTestState(), trader.id));
  state = withHistoricalSale(state, 'enquiry-006', { quantity: 450, price: 555, margin: 15 });
  assert.equal(state.drops.reduce((sum, drop) => sum + drop.amount, 0), 70);
  assert.equal(state.drops.filter(drop => drop.key.startsWith(`goal:otto:${currentMonth()}:profit`)).reduce((sum, drop) => sum + drop.amount, 0), 0);
});

test('confirming an enquiry records a local confirmation without sending externally', () => {
  const state = createTestState();
  assert.throws(() => applyAction(state, { type: 'send-enquiry', id: 'enquiry-001' }, credit, now), /role cannot/);
  Object.assign(state.enquiries.find(item => item.id === 'enquiry-001')!, { complianceChecked: true, creditChecked: true, creditConfirmations: ['luca'] });
  const next = applyAction(state, { type: 'send-enquiry', id: 'enquiry-001' }, trader, now);
  assert.equal(next.enquiries.find(item => item.id === 'enquiry-001')!.status, 'sent');
  assert.equal(next.audit[0].action, 'Enquiry confirmed (demo)');
  assert.match(next.audit[0].detail, /recorded locally/);
  assert.throws(() => applyAction(next, { type: 'save-enquiry', enquiry: { ...next.enquiries[0], status: 'draft' } }, trader, now), /Only draft enquiries/);
});


test('unpriced multi-grade enquiries and ranges can be sent without assuming a booked quantity', () => {
  let state = createTestState();
  const draft = { ...state.enquiries[0], id: 'unpriced-multiple', complianceChecked: true, creditChecked: true, creditConfirmations: ['luca'], quantity: 0, price: 0, margin: 0,
    products: [{ grade: 'VLSFO' as const, quantityText: '450-500' }, { grade: 'LSMGO' as const, quantityText: '100' }] };
  state = applyAction(state, { type: 'save-enquiry', enquiry: draft }, trader, now);
  state = applyAction(state, { type: 'send-enquiry', id: draft.id }, trader, now);
  const sent = state.enquiries.find(item => item.id === draft.id)!;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.price, 0);
  assert.equal(sent.margin, 0);
  assert.equal(sent.quantity, 0);
  assert.deepEqual(sent.products, draft.products);
  assert.equal(state.outcomes.some(outcome => outcome.enquiryId === draft.id), false);
  assert.deepEqual(parseProductQuantity('450-500 MT'), { min: 450, max: 500 });
  for (const value of ['500-450', '0', '-1', '450 CBM', 'Infinity', '1,00']) assert.equal(parseProductQuantity(value), null, value);
});

test('historical multi-grade sales retain item terms, weighted summaries and exposure', () => {
  const state = createTestState(), enquiry = state.enquiries[0];
  const products = [{ grade: 'VLSFO', quantity: 500, price: 600, margin: 10 }, { grade: 'LSMGO', quantity: 100, price: 800, margin: -5 }];
  const company = state.companies.find(item => item.id === enquiry.buyerId)!;
  company.exposure += 380000;
  const before = monthlyStats(state, trader.id, currentMonth());
  const booked = withHistoricalSale(state, enquiry.id, { quantity: 600, price: 380000 / 600, margin: 7.5, grade: 'VLSFO + LSMGO', products });
  assert.deepEqual(booked.outcomes[0].products, products);
  assert.equal(booked.outcomes[0].grade, 'VLSFO + LSMGO');
  assert.equal(booked.outcomes[0].margin, 7.5);
  assert.equal(booked.companies.find(item => item.id === enquiry.buyerId)!.exposure, company.exposure);
  assert.deepEqual(monthlyStats(booked, trader.id, currentMonth()), { volume: before.volume + 600, profit: before.profit + 4500, fixtures: before.fixtures + 1 });
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(booked))).outcomes, booked.outcomes);
});

test('current multi-grade STEM requires matching complete valid grades without booking sale exposure', () => {
  let state = createTestState();
  const enquiry = { ...state.enquiries[0], id: 'multi-grade-fixture', quantity: 0, price: 0, margin: 0,
    products: [{ grade: 'VLSFO' as const, quantityText: '450-500' }, { grade: 'LSMGO' as const, quantityText: '100' }] };
  state = applyAction(state, { type: 'save-enquiry', enquiry }, trader, now);
  state = applyAction(state, { type: 'send-enquiry', id: enquiry.id }, trader, now);
  const action = { type: 'record-stem' as const, id: enquiry.id, complianceChecked: true, creditChecked: true,
    products: [{ grade: 'VLSFO', quantityText: '450-500', buyPrice: 600, supplierId: activeSupplierFixtures[0].id }, { grade: 'LSMGO', quantityText: '100', buyPrice: 800, supplierId: activeSupplierFixtures[0].id }] };
  assert.throws(() => applyAction(state, { ...action, products: [] }, trader, now), /every requested product/);
  assert.throws(() => applyAction(state, { ...action, products: action.products.slice(0, 1) }, trader, now), /every requested product/);
  assert.throws(() => applyAction(state, { ...action, products: [action.products[0], { ...action.products[1], grade: 'HSFO' }] }, trader, now), /grades must match/);
  assert.throws(() => applyAction(state, { ...action, products: [action.products[0], action.products[0]] }, trader, now), /grades must match/);
  for (const invalid of [{ quantityText: '0' }, { buyPrice: 0 }, { buyPrice: NaN }]) assert.throws(() => applyAction(state, { ...action, products: [{ ...action.products[0], ...invalid }, action.products[1]] }, trader, now));
  const insufficient = structuredClone(state), company = insufficient.companies.find(item => item.id === enquiry.buyerId)!;
  company.limit = company.exposure + 350000;
  assert.throws(() => applyAction(insufficient, action, trader, now), /estimated purchase cost USD 380,000/);
  const booked = applyAction(state, action, trader, now);
  assert.equal(booked.outcomes[0].commercialStatus, 'pending');
  assert.deepEqual(booked.companies, state.companies);
  assert.deepEqual(monthlyStats(booked, trader.id, currentMonth()), monthlyStats(state, trader.id, currentMonth()));
  assert.throws(() => applyAction(booked, action, trader, now), /before recording|already/);
});

test('multi-grade lost enquiries retain requested products without invented volume, pricing or credit use', () => {
  let state = createTestState();
  const enquiry = { ...state.enquiries[0], id: 'multi-grade-lost', complianceChecked: true, creditChecked: true, creditConfirmations: ['luca'], quantity: 0, price: 0, margin: 0,
    products: [{ grade: 'VLSFO' as const, quantityText: '450-500' }, { grade: 'LSMGO' as const, quantityText: '100' }] };
  state = applyAction(state, { type: 'save-enquiry', enquiry }, trader, now);
  state = applyAction(state, { type: 'send-enquiry', id: enquiry.id }, trader, now);
  const lost = applyAction(state, { type: 'record-loss', id: enquiry.id, reasonId: state.lostReasons![0].id, groupNote: 'Schedule changed.' }, trader, now);
  assert.equal(lost.outcomes[0].quantity, 0);
  assert.deepEqual(lost.enquiries.find(item => item.id === enquiry.id)!.products, enquiry.products);
  assert.deepEqual(lost.companies, state.companies);
  assert.deepEqual(monthlyStats(lost, trader.id, currentMonth()), monthlyStats(state, trader.id, currentMonth()));
});


test('confirmation does not require compliance, credit or peer checks and reserves no credit', () => {
  const state = createTestState();
  const draft = state.enquiries.find(item => item.id === 'enquiry-001')!;
  draft.complianceChecked = false;
  draft.creditChecked = false;
  draft.creditConfirmations = [];
  state.enquiries.push({ ...draft, id: 'luca-account-peer', owner: 'luca', status: 'sent' });
  const confirmed = applyAction(state, { type: 'confirm-enquiry', id: draft.id }, trader, now);
  assert.equal(confirmed.enquiries.find(item => item.id === draft.id)!.status, 'sent');
  assert.equal(confirmed.enquiries.find(item => item.id === draft.id)!.sentAt, now);
  assert.deepEqual(confirmed.companies, state.companies);
  assert.deepEqual(confirmed.outcomes, state.outcomes);
  assert.equal(activeAccountTraders(confirmed, draft.buyerId, trader.id).length, 1);
});

test('STEM requires fresh compliance and credit checks and records who checked and when', () => {
  const state = createTestState();
  const enquiry = state.enquiries.find(item => item.id === 'enquiry-004')!;
  // Legacy enquiry flags cannot satisfy the fixture's explicit checks.
  enquiry.complianceChecked = true;
  enquiry.creditChecked = true;
  const action = { ...stem(state, enquiry.id), complianceChecked: false, creditChecked: false };
  for (const checks of [{}, {complianceChecked: true}, {creditChecked: true},
    {complianceChecked: false, creditChecked: true}, {complianceChecked: true, creditChecked: false}]) {
    assert.throws(() => applyAction(state, { ...action, ...checks }, trader, now), /compliance and credit checks before STEM/);
  }
  const booked = applyAction(state, { ...action, complianceChecked: true, creditChecked: true }, trader, now);
  assert.equal(booked.outcomes[0].complianceChecked, true);
  assert.equal(booked.outcomes[0].creditChecked, true);
  assert.equal(booked.outcomes[0].checkedBy, trader.id);
  assert.equal(booked.outcomes[0].checkedAt, now);
  assert.equal(state.outcomes.some(item => item.enquiryId === enquiry.id), false);
  const lost = applyAction(state, { type: 'record-loss', id: enquiry.id, reasonId: state.lostReasons![0].id, groupNote: 'Schedule changed.' }, trader, now);
  assert.equal(lost.outcomes[0].complianceChecked, undefined);
  assert.equal(lost.outcomes[0].creditChecked, undefined);
  assert.equal(lost.outcomes[0].checkedBy, undefined);
  assert.deepEqual(lost.companies, state.companies);
});

test('account activity distinguishes exact entities from related groups and ignores closed enquiries', () => {
  const state = createTestState();
  state.enquiries = state.enquiries.filter(item => item.owner !== 'luca');
  const buyer = state.companies.find(item => item.id === 'company-meridian')!;
  const related = state.companies.find(item => item.id === 'company-cape-union')!;
  buyer.accountGroupId = 'same-group'; related.accountGroupId = 'same-group';
  const seed = state.enquiries.find(item => item.id === 'enquiry-001')!;
  state.enquiries.push({ ...seed, id: 'luca-related', owner: 'luca', buyerId: related.id, status: 'postponed' });
  let peers = activeAccountTraders(state, buyer.id, trader.id);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].trader.id, 'luca');
  assert.equal(peers[0].sameAccount, false);
  state.enquiries.push({ ...seed, id: 'luca-exact', owner: 'luca', status: 'draft' });
  peers = activeAccountTraders(state, buyer.id, trader.id);
  assert.equal(peers[0].sameAccount, true);
  assert.equal(peers[0].enquiries.length, 2);
  assert.equal(activeAccountTraders(state, buyer.id, trader.id, 'luca-exact')[0].sameAccount, false);
  state.enquiries.filter(item => item.owner === 'luca').forEach(item => { item.status = 'cancelled'; });
  assert.deepEqual(activeAccountTraders(state, buyer.id, trader.id), []);
});

test('amendments retain the same enquiry and previous snapshots before reconfirming', () => {
  let state = createTestState();
  const original = structuredClone(state.enquiries.find(item => item.id === 'enquiry-002')!);
  state = applyAction(state, { type: 'amend-enquiry', id: original.id }, trader, now);
  let amended = state.enquiries.find(item => item.id === original.id)!;
  assert.equal(amended.status, 'draft');
  assert.equal(amended.complianceChecked, false);
  assert.equal(amended.creditChecked, false);
  assert.deepEqual(amended.creditConfirmations, []);
  assert.equal(amended.amendments![0].before.formattedText, original.formattedText);
  assert.equal(amended.amendments![0].before.status, 'sent');
  assert.doesNotThrow(() => applyAction(state, { type: 'confirm-enquiry', id: amended.id }, trader, now));
  state = applyAction(state, { type: 'save-enquiry', enquiry: { ...amended, vessel: 'AMENDED VESSEL', complianceChecked: true, creditChecked: true, creditConfirmations: ['luca'], amendments: [] } }, trader, now);
  state = applyAction(state, { type: 'send-enquiry', id: original.id }, trader, now);
  amended = state.enquiries.find(item => item.id === original.id)!;
  assert.equal(amended.status, 'sent');
  assert.equal(amended.vessel, 'AMENDED VESSEL');
  assert.equal(amended.createdAt, original.createdAt);
  assert.equal(amended.amendments!.length, 1);
  assert.equal(amended.amendments![0].before.vessel, original.vessel);
  assert.equal(state.enquiries.filter(item => item.id === original.id).length, 1);
  assert.ok(state.audit.some(item => item.action === 'Enquiry amendment started'));
});

test('postponing and cancelling do not create losses, credit exposure or target progress', () => {
  const state = createTestState();
  for (const action of ['amend-enquiry', 'postpone-enquiry', 'cancel-enquiry'] as const) {
    assert.throws(() => applyAction(state, { type: action, id: 'enquiry-002' }, credit, now), /role cannot/);
    const luca = actors.find(actor => actor.id === 'luca')!;
    assert.throws(() => applyAction(state, { type: action, id: 'enquiry-002' }, luca, now), /owner/);
  }
  const postponed = applyAction(state, { type: 'postpone-enquiry', id: 'enquiry-002' }, trader, now);
  assert.equal(postponed.enquiries.find(item => item.id === 'enquiry-002')!.status, 'postponed');
  assert.throws(() => applyAction(postponed, stem(postponed, 'enquiry-002'), trader, now), /before recording/);
  const cancelled = applyAction(postponed, { type: 'cancel-enquiry', id: 'enquiry-002' }, trader, now);
  assert.equal(cancelled.enquiries.find(item => item.id === 'enquiry-002')!.status, 'cancelled');
  assert.deepEqual(cancelled.outcomes, state.outcomes);
  assert.deepEqual(cancelled.companies, state.companies);
  assert.deepEqual(cancelled.drops, state.drops);
  assert.deepEqual(monthlyStats(cancelled, trader.id, currentMonth()), monthlyStats(state, trader.id, currentMonth()));
  assert.throws(() => applyAction(cancelled, { type: 'amend-enquiry', id: 'enquiry-002' }, trader, now), /Only confirmed or postponed/);
  const closed = state.enquiries.find(item => item.status === 'fixture')!;
  assert.throws(() => applyAction(state, { type: 'cancel-enquiry', id: closed.id }, trader, now), /Only open/);
});

test('IMO history finds wins and losses through immutable outcomes or linked legacy enquiries', () => {
  const state = createTestState();
  state.outcomes = state.outcomes.slice(0, 3);
  state.outcomes[0].imo = '9319466';
  state.outcomes[1].kind = 'lost';
  state.enquiries.find(item => item.id === state.outcomes[1].enquiryId)!.imo = '9319466';
  state.outcomes[2].imo = '9876543';
  const history = enquiryImoHistory(state, '9319466');
  assert.deepEqual(history.wins.map(item => item.id), [state.outcomes[0].id]);
  assert.deepEqual(history.losses.map(item => item.id), [state.outcomes[1].id]);
  assert.equal(enquiryImoHistory(state, '9319466', state.outcomes[0].enquiryId).wins.length, 0);
  assert.deepEqual(enquiryImoHistory(state, '9319467'), { wins: [], losses: [] });
  assert.deepEqual(enquiryImoHistory(state, ''), { wins: [], losses: [] });
});


test('fresh demo keeps credit positions and includes linked history plus active demo enquiries', () => {
  const state = createSeedState();
  assert.equal(state.enquiryCleanupVersion, 2);
  assert(state.enquiries.length > 0);
  assert.equal(state.enquiries.filter(item => item.status === 'sent' && item.owner === 'otto').length, 3);
  assert.equal(state.enquiries.filter(item => item.id.startsWith('demo-v2-peer-')).length, 4);
  assert(state.outcomes.every(outcome => state.enquiries.some(enquiry => enquiry.id === outcome.enquiryId)));
  assert(state.enquiries.some(item => item.owner === 'luca' && item.id.startsWith('demo-v2-peer-')));
  assert(state.requests.every(request => !request.enquiryId || state.enquiries.some(enquiry => enquiry.id === request.enquiryId)));
  const history = enquiryImoHistory(state, '9876543');
  assert.equal(history.wins.length, 1);
  assert.equal(history.losses.length, 1);
  assert.equal(state.companies.find(item => item.id === 'company-meridian')!.exposure, 610000);
});

test('one-time cleanup preserves completed history and credit decisions, then leaves new work intact', () => {
  const previous = createTestState();
  delete previous.enquiryCleanupVersion;
  previous.enquiries.push({ ...previous.enquiries[0], id: 'enquiry-demo-luca', owner: 'luca', status: 'sent' });
  previous.enquiries.push({ ...previous.enquiries[0], id: 'old-postponed', status: 'postponed' });
  previous.enquiries.push({ ...previous.enquiries[0], id: 'old-cancelled', status: 'cancelled' });
  const snapshot = structuredClone(previous);
  const cleared = upgradeDemoState(previous);
  assert.deepEqual(previous, snapshot);
  assert.equal(cleared.enquiryCleanupVersion, 2);
  assert.deepEqual(cleared.enquiries.map(item => item.id).sort(), previous.outcomes.map(item => item.enquiryId).sort());
  assert.equal(cleared.requests[0].enquiryId, undefined);
  const { enquiryId: _removedLink, ...preservedRequest } = previous.requests[0];
  assert.deepEqual(cleared.requests[0], preservedRequest);
  for (const key of ['outcomes', 'companies', 'audit', 'drops', 'goals', 'contributions'] as const) {
    assert.deepEqual(cleared[key], previous[key], key);
  }
  const fresh = { ...previous.enquiries[0], id: 'new-after-cleanup', status: 'draft' as const };
  const updated = applyAction(cleared, { type: 'save-enquiry', enquiry: fresh }, trader, now);
  const restored = JSON.parse(JSON.stringify(updated));
  assert.strictEqual(upgradeDemoState(restored), restored);
  assert(restored.enquiries.some((item: Enquiry) => item.id === fresh.id));
  assert.equal(restored.enquiries.some((item: Enquiry) => item.id === 'enquiry-demo-luca'), false);
});
