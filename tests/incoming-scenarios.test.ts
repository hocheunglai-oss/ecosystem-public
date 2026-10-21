import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { incomingScenarios, incomingScenarioText } from '../src/lib/incomingScenarios';
import { activeAccountTraders, availableCredit, contactsFor } from '../src/lib/model';
import { parseEnquiry } from '../src/lib/parser';
import { createDemoIncoming, receiveInboxMessage } from '../src/inbox';
import { knowledgeDocument } from '../src/lib/knowledge';

const now = new Date('2026-10-07T03:30:00Z');

test('every incoming scenario parses its intended entity, port and products without invented unknown IDs', () => {
  const state = createSeedState();
  assert.equal(incomingScenarios.length, 10);
  for (const scenario of incomingScenarios) {
    const text = incomingScenarioText(state, scenario.id, now);
    const parsed = parseEnquiry(text, state.companies, state.ports);
    assert.equal(Boolean(parsed.buyerId), scenario.id !== 'unknown-buyer', scenario.id);
    assert.equal(Boolean(parsed.portId), scenario.id !== 'unknown-port', scenario.id);
    assert(parsed.vessel && parsed.eta && parsed.products.length, scenario.id);
    if (scenario.id === 'multi-grade') assert.deepEqual(parsed.products.map(product => product.grade), ['HSFO', 'VLSFO', 'LSMGO']);
    if (scenario.id === 'insufficient-credit') assert(availableCredit(state.companies.find(buyer => buyer.id === parsed.buyerId)!) < 0);
    if (scenario.id === 'suspended-buyer') assert.equal(state.companies.find(buyer => buyer.id === parsed.buyerId)!.creditStatus, 'Suspended');
    if (scenario.id === 'overdue-payment') assert(state.companies.find(buyer => buyer.id === parsed.buyerId)!.overdue > 0);
    if (scenario.id === 'pending-credit') assert.equal(state.companies.find(buyer => buyer.id === parsed.buyerId)!.status, 'pending');
  }
});

test('same-enquiry and same-account scenarios point at genuine other-trader activity', () => {
  const state = createSeedState();
  for (const owner of ['otto', 'luca', 'filippo', 'gianmichele']) {
    const duplicate = parseEnquiry(incomingScenarioText(state, 'same-enquiry', now, owner), state.companies, state.ports);
    const peers = activeAccountTraders(state, duplicate.buyerId, owner);
    assert(peers.some(peer => peer.enquiries.some(enquiry => enquiry.imo === duplicate.imo && enquiry.vessel === duplicate.vessel)));
    const account = parseEnquiry(incomingScenarioText(state, 'same-account', now, owner), state.companies, state.ports);
    const accountPeers = activeAccountTraders(state, account.buyerId, owner);
    assert(accountPeers.length > 0);
    assert(accountPeers.every(peer => peer.enquiries.every(enquiry => enquiry.imo !== account.imo)));
  }
});

test('scenario messages retain verified inbox routing and duplicate delivery protection', () => {
  const state = createSeedState();
  for (const channel of ['whatsapp', 'email'] as const) {
    const message = createDemoIncoming(channel, 'otto', now, `scenario-${channel}`, contactsFor(state), { id: 'unknown-port', state });
    const first = receiveInboxMessage([], message, contactsFor(state));
    assert.equal(first.received?.owner, 'otto');
    assert.match(first.received!.rawText, /Puerto Brisa/);
    const duplicate = receiveInboxMessage(first.items, message, contactsFor(state));
    assert.equal(duplicate.reason, 'duplicate');
    assert.equal(duplicate.items.length, 1);
  }
});

test('demo refresh preserves edited identity, financials, knowledge, user records and reward ledgers', () => {
  const state = createSeedState();
  state.demoScenarioVersion = 1;
  state.companies[0].name = 'MY EDITED BUYER';
  state.companies[0].limit = 345678;
  state.companies[0].contact = 'USER CONTACT';
  state.companies[0].exposure = 12345;
  state.knowledgeRecords!['port:port-singapore'].sections[0].blocks[0] = { id: 'manual', type: 'text', title: 'MANUAL TITLE', text: 'MY CONTENT', update: { updatedBy: 'otto', updatedAt: '2026-10-01T00:00:00Z' } };
  state.enquiries.push({ ...state.enquiries[0], id: 'manual-enquiry', vessel: 'MY VESSEL' });
  const original = structuredClone(state);
  const upgraded = upgradeDemoState(state);
  assert.deepEqual(state, original);
  assert.deepEqual(upgraded.companies[0], original.companies[0]);
  for (const key of ['enquiries', 'outcomes', 'contributions', 'hats', 'drops', 'economy', 'knowledgeRecords', 'knowledgeHistory'] as const) assert.deepEqual(upgraded[key], original[key], key);
  assert.strictEqual(upgradeDemoState(upgraded), upgraded);
});

test('fresh demo uses standard identities and useful titled knowledge with actual demo attachment', () => {
  const state = createSeedState();
  const buyer = state.companies[0];
  assert.equal(buyer.name, 'Aster Ocean Navigation Pte Ltd');
  assert.equal(buyer.customerId, 'ECO20001');
  assert.equal(buyer.personInChargeId, 'otto');
  assert.equal(buyer.office, 'HKG');
  assert(buyer.aliases.includes('Meridian Shipping Pte Ltd'));
  assert.equal(parseEnquiry('Buyer: Meridian Shipping Pte Ltd\nVessel: TEST\nPort: Singapore\nETA: 10 OCT\nVLSFO: 500 MT', state.companies, state.ports).buyerId, buyer.id);
  assert(buyer.files?.some(file => file.url === '/demo/aster-buyer-profile.txt'));
  for (const target of [{ kind: 'port' as const, id: 'port-singapore' }, { kind: 'country' as const, id: 'Japan' }]) {
    const document = knowledgeDocument(state, target);
    assert(document.sections.flatMap(section => section.blocks).length > 0);
    assert(document.sections.every(section => section.blocks.every(block => block.title.trim())));
  }
  assert(state.requests.some(request => request.status === 'pending' && request.acknowledgedAt));
  assert(state.requests.some(request => request.status === 'approved' && request.type === 'temporary'));
  assert(state.requests.some(request => request.status === 'declined'));
  for (const request of state.requests) {
    if (request.acknowledgedAt) assert(request.acknowledgedAt >= request.requestedAt);
    if (request.closedAt) assert(request.closedAt >= (request.acknowledgedAt ?? request.requestedAt));
  }
});

test('fresh credit dates, request links and approved limits agree with their histories', () => {
  const state = createSeedState();
  const finishedAt = Date.now();
  for (const value of [
    ...state.enquiries.flatMap(item => [item.createdAt, item.sentAt].filter(Boolean)),
    ...state.requests.flatMap(item => [item.requestedAt, item.acknowledgedAt, item.closedAt, item.decision?.at].filter(Boolean)),
    ...state.audit.map(item => item.at),
  ]) assert(Date.parse(value!) <= finishedAt, `Past event cannot be in the future: ${value}`);
  const aster = state.requests.find(item => item.id === 'demo-v2-request-aster-approved')!;
  const history = state.creditHistory!.find(item => item.requestId === aster.id)!;
  assert.equal(aster.decision?.previousLimit, history.previousLimit);
  assert.equal(aster.decision?.resultingLimit, history.limit);
  assert.equal(aster.decision!.previousLimit! + aster.decision!.amount, aster.decision!.resultingLimit);
  assert.equal(aster.decision?.at, history.effectiveAt);
  for (const id of ['demo-v2-request-beacon', 'demo-v2-request-nacre']) {
    const request = state.requests.find(item => item.id === id)!;
    assert(request.enquiryId);
    const enquiry = state.enquiries.find(item => item.id === request.enquiryId)!;
    assert.equal(enquiry.buyerId, request.companyId);
    assert(Date.parse(enquiry.createdAt) <= Date.parse(request.requestedAt));
  }
  assert(state.requests.some(item => item.priority === 'p1'));
  assert.match(state.requests.find(item => item.id === 'credit-001')!.reason, /BEACON STRAIT/);
  assert.equal(state.audit.find(item => item.id === 'audit-seed-3')!.entity, 'Beacon Strait Shipping Ltd');
  for (const enquiry of state.enquiries.filter(item => item.id.startsWith('enquiry-closed-'))) {
    const buyer = state.companies.find(item => item.id === enquiry.buyerId)!;
    assert(enquiry.rawText.toUpperCase().includes(`BUYER: ${buyer.name.toUpperCase()}`), enquiry.id);
    assert(enquiry.formattedText.toUpperCase().includes(`BUYER: ${buyer.name.toUpperCase()}`), enquiry.id);
  }
});
