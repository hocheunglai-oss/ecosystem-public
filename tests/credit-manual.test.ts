import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, type Action, type Company, type DemoState } from '../src/lib/model';
import { createSeedState } from '../src/lib/seed';
import { creditAttentionRequestIds, initializeCreditRemarkHistory, needsCreditRemarkHistory } from '../src/lib/credit';
import { companyLifecycle, creditRequestRecipients, exactBuyerDuplicates, possibleBuyerDuplicates } from '../src/lib/creditWorkflow';
import { readCreditAttachments, validateCreditAttachments, type CreditAttachment } from '../src/lib/creditAttachments';

const trader = actors.find(actor => actor.id === 'otto')!;
const credit = actors.find(actor => actor.id === 'elena')!;
const admin = actors.find(actor => actor.id === 'marco')!;
const manager = actors.find(actor => actor.id === 'gianmichele')!;
const now = '2030-02-04T09:00:00.000Z';
function setup(): DemoState {
  const state = createSeedState();
  state.requests = []; state.creditHistory = []; state.creditNotifications = [];
  const buyer = state.companies.find(company => company.id === 'company-meridian')!;
  Object.assign(buyer, { limit: 1000000, status: 'approved', lifecycle: 'buyer', creditStatus: 'Active', exposure: 100000, terms: '30 days', personInChargeId: trader.id, temporaryCredits: [], activeCreditRemarkId: undefined });
  return state;
}
const buyer = (state: DemoState) => state.companies.find(company => company.id === 'company-meridian')!;
const p1: Extract<Action, { type: 'request-credit' }> = { type: 'request-credit', companyId: 'company-meridian', workflow: 'p1', amountBasis: 'total', requestType: 'increase', amount: 1200000, reason: 'Raise total limit for fleet', priority: 'p1' };
const urgent: Extract<Action, { type: 'request-credit' }> = { ...p1, workflow: 'urgent', amountBasis: 'additional', requestType: 'temporary', amount: 200000, priority: 'urgent', expiresAt: '2030-02-12T23:59:59.000Z', voyage: { vessel: 'Ocean Test', imo: '9876543', portId: 'port-singapore', portName: 'Singapore', eta: '7-8 February' } };
const decision = (id: string, amount = 1200000): Extract<Action, { type: 'decide-credit' }> => ({ type: 'decide-credit', id, approve: true, amount, terms: '30 days', note: 'Approved total limit' });

test('P1 approves a total limit while legacy priority P1 remains additive', () => {
  let state = applyAction(setup(), p1, trader, now);
  const request = state.requests[0];
  assert.equal(request.amountBasis, 'total');
  assert.equal(request.reason, 'RAISE TOTAL LIMIT FOR FLEET');
  state = applyAction(state, decision(request.id), credit, now);
  assert.equal(buyer(state).limit, 1200000);
  assert.equal(state.creditHistory![0].previousLimit, 1000000);
  assert.equal(state.creditHistory![0].limit, 1200000);
  assert.equal(companyLifecycle(buyer(state)), 'buyer');
  const legacy = applyAction(setup(), { ...p1, workflow: undefined, amountBasis: undefined, amount: 200000 }, trader, now);
  const approved = applyAction(legacy, decision(legacy.requests[0].id, 200000), credit, now);
  assert.equal(buyer(approved).limit, 1200000);
  assert.equal(legacy.requests[0].workflow, undefined);
});

test('new workflows reject contradictory amount semantics and incomplete urgent voyage details', () => {
  for (const action of [{ ...p1, amountBasis: 'additional' as const }, { ...urgent, amountBasis: 'total' as const }, { ...p1, workflow: undefined }]) assert.throws(() => applyAction(setup(), action, trader, now), /total|additional|amount basis/);
  assert.throws(() => applyAction(setup(), { ...urgent, voyage: undefined }, trader, now), /vessel, IMO, port and ETA/);
  assert.throws(() => applyAction(setup(), { ...urgent, voyage: { ...urgent.voyage!, imo: '123' } }, trader, now), /seven-digit/);
  assert.throws(() => applyAction(setup(), { ...urgent, voyage: { ...urgent.voyage!, portId: 'missing' } }, trader, now), /valid port/);
  const state = applyAction(setup(), urgent, trader, now);
  assert.equal(state.requests[0].voyage?.vessel, 'OCEAN TEST');
  assert.equal(state.requests[0].voyage?.eta, '7-8 FEBRUARY');
  const approved = applyAction(state, decision(state.requests[0].id, 200000), credit, now);
  assert.equal(buyer(approved).limit, 1000000);
  assert.equal(buyer(approved).temporaryCredits![0].amount, 200000);
});

test('non-PIC requests require confirmation and recipients are deduplicated immutable office snapshots', () => {
  const state = setup(); buyer(state).personInChargeId = 'silvia'; buyer(state).office = 'GOA';
  assert.throws(() => applyAction(state, p1, trader, now), /person in charge/);
  const recipients = creditRequestRecipients(state, trader, buyer(state));
  assert.equal(recipients.length, new Set(recipients.map(item => item.actorId)).size);
  assert.deepEqual(new Set(recipients.map(item => item.actorId)), new Set(['otto', 'gianmichele', 'silvia', 'filippo', 'elena', 'marco']));
  const saved = applyAction(state, { ...p1, nonPicConfirmed: true }, trader, now);
  const snapshot = structuredClone(saved.requests[0].recipients);
  buyer(saved).personInChargeId = 'luca'; buyer(saved).office = 'OTHER OFFICE';
  assert.deepEqual(saved.requests[0].recipients, snapshot);
  assert.equal(saved.requests[0].nonPicConfirmed, true);
});

test('attention tracks reviewer pending requests and each trader’s own unread notifications', () => {
  let state = applyAction(setup(), p1, trader, now);
  const id = state.requests[0].id;
  assert.deepEqual(creditAttentionRequestIds(state, credit), [id]);
  assert.deepEqual(creditAttentionRequestIds(state, trader), []);
  assert.deepEqual(creditAttentionRequestIds(state, manager), [id]);
  state = applyAction(state, { type: 'mark-credit-request-read', id }, manager, now);
  assert.deepEqual(creditAttentionRequestIds(state, manager), []);
  assert.deepEqual(creditAttentionRequestIds(state, credit), [id]);
  const creditNotification = state.creditNotifications!.find(item => item.recipientId === credit.id)!;
  assert.equal(creditNotification.readAt, undefined, 'Reading by a manager cannot mark Credit read');
  state = applyAction(state, { type: 'acknowledge-credit', id }, credit, now);
  const ackCount = state.creditNotifications!.length;
  state = applyAction(state, { type: 'acknowledge-credit', id }, credit, now);
  assert.equal(state.creditNotifications!.length, ackCount);
  state = applyAction(state, decision(id), credit, now);
  assert.deepEqual(creditAttentionRequestIds(state, credit), []);
  assert.deepEqual(creditAttentionRequestIds(state, trader), [id]);
  assert.ok(state.creditNotifications!.some(item => item.recipientId === trader.id && item.kind === 'approved' && !item.readAt));
  state = applyAction(state, { type: 'mark-credit-request-read', id }, trader, now);
  assert.deepEqual(creditAttentionRequestIds(state, trader), []);
  assert.deepEqual(creditAttentionRequestIds(state, manager), [id]);
});

const attachment = (name = 'Proof.pdf', body = '%PDF-1.7\nTest'): CreditAttachment => ({ id: 'file-proof', name, mimeType: 'application/pdf', size: body.length, dataUrl: `data:application/pdf;base64,${btoa(body)}` });
test('attachments are bounded, persist unchanged and reject active or forged formats', async () => {
  const file = attachment();
  const state = applyAction(setup(), { ...p1, attachments: [file] }, trader, now);
  assert.deepEqual(JSON.parse(JSON.stringify(state.requests[0])).attachments, [file]);
  assert.equal(validateCreditAttachments([file])[0].dataUrl, file.dataUrl);
  assert.throws(() => validateCreditAttachments([{ ...file, name: 'Page.html', mimeType: 'text/html' }]), /PDF, PNG/);
  assert.throws(() => validateCreditAttachments([{ ...file, dataUrl: 'https://example.com/proof.pdf' }]), /data/);
  assert.throws(() => validateCreditAttachments([{ ...file, name: '../Proof.pdf' }]), /name/);
  assert.throws(() => validateCreditAttachments([{ ...file, size: 1024 * 1024 }]), /512 KB/);
  assert.throws(() => validateCreditAttachments([file, file]), /reference/);
  assert.throws(() => validateCreditAttachments([{ ...file, dataUrl: `data:application/pdf;base64,${btoa('Bad PDF contents')}`, size: 16 }]), /contents/);
  const added = await readCreditAttachments([new File(['Plain support'], 'Support.txt', { type: 'text/plain' })], [file]);
  assert.equal(added.length, 2);
  assert.equal(added[0].dataUrl, file.dataUrl);
  const big = 'a'.repeat(400 * 1024);
  const bigAttachments = Array.from({ length: 4 }, (_, index) => ({ id: `f${index}`, name: `f${index}.txt`, mimeType: 'text/plain', size: big.length, dataUrl: `data:text/plain;base64,${btoa(big)}` }));
  assert.throws(() => validateCreditAttachments(bigAttachments), /1.5 MB/);
});

test('active credit remarks restore history without rewriting credit or earlier remarks', () => {
  const initial = setup();
  let state = applyAction(initial, { type: 'save-buyer-credit-remarks', buyerId: buyer(initial).id, text: 'FIRST CREDIT REMARK' }, credit, now);
  const first = state.creditHistory![0];
  state = applyAction(state, { type: 'save-buyer-credit-remarks', buyerId: buyer(state).id, text: 'SECOND CREDIT REMARK' }, admin, '2030-02-05T09:00:00.000Z');
  const history = structuredClone(state.creditHistory);
  const company = structuredClone(buyer(state));
  assert.throws(() => applyAction(state, { type: 'set-active-credit-remark', buyerId: company.id, historyId: first.id }, trader, now), /role cannot/);
  assert.throws(() => applyAction(state, { type: 'set-active-credit-remark', buyerId: 'company-bluewater', historyId: first.id }, credit, now), /this buyer/);
  const restored = applyAction(state, { type: 'set-active-credit-remark', buyerId: company.id, historyId: first.id }, credit, now);
  assert.deepEqual(restored.creditHistory, history);
  assert.equal(buyer(restored).creditRemarks, first.summary);
  assert.equal(buyer(restored).activeCreditRemarkId, first.id);
  assert.equal(buyer(restored).limit, company.limit);
  assert.equal(buyer(restored).exposure, company.exposure);
  assert.equal(buyer(restored).terms, company.terms);
});

test('legacy remark initialization is additive and idempotent with unknown attribution preserved', () => {
  const state = setup(); const company = buyer(state);
  Object.assign(company, { creditRemarks: 'EXISTING LEGACY REMARK', creditUpdatedAt: '2025-05-01T12:00:00.000Z', reviewDate: '2025-05-01', activeCreditRemarkId: undefined });
  const creditPosition = [company.limit, company.exposure, company.terms];
  assert.equal(needsCreditRemarkHistory(state), true);
  initializeCreditRemarkHistory(state, now);
  const record = state.creditHistory!.find(item => item.id === company.activeCreditRemarkId)!;
  assert.equal(record.by, '—'); assert.equal(record.effectiveDateUnknown, true); assert.equal(record.recordedAt, now);
  assert.deepEqual([company.limit, company.exposure, company.terms], creditPosition);
  const before = JSON.stringify(state);
  initializeCreditRemarkHistory(state, '2030-03-01T00:00:00.000Z');
  assert.equal(JSON.stringify(state), before);
  assert.equal(needsCreditRemarkHistory(state), false);
});

test('lead names and aliases reject exact normalized duplicates; distinct similar entities need confirmation', () => {
  const state = setup(); const original = buyer(state);
  original.name = 'ASTER OCEAN NAVIGATION PTE LTD'; original.aliases = ['Aster Fleet'];
  assert.equal(exactBuyerDuplicates(state.companies, '  ASTER-FLEET  ')[0].id, original.id);
  assert.equal(possibleBuyerDuplicates(state.companies, 'Aster Ocean Navigation SA')[0].id, original.id);
  const company: Company = { ...original, id: 'new-lead', customerId: undefined, name: 'Aster Ocean Navigation SA', aliases: [], limit: 0, exposure: 0, overdue: 0, status: 'pending' };
  const action: Extract<Action, { type: 'add-company' }> = { type: 'add-company', company, requestedLimit: 300000, reason: 'NEW LEGAL BUYER', workflow: 'p1' };
  assert.throws(() => applyAction(state, action, trader, now), /different legal buyer/);
  assert.throws(() => applyAction(state, { ...action, company: { ...company, name: 'Aster Fleet' }, duplicateConfirmed: true }, trader, now), /already exists/);
  let saved = applyAction(state, { ...action, duplicateConfirmed: true }, trader, now);
  assert.equal(saved.companies[0].lifecycle, 'lead');
  assert.equal(saved.requests[0].workflow, 'p1'); assert.equal(saved.requests[0].amountBasis, 'total'); assert.equal(saved.requests[0].priority, 'p1');
  saved = applyAction(saved, decision(saved.requests[0].id, 300000), credit, now);
  assert.equal(saved.companies[0].lifecycle, 'buyer'); assert.equal(saved.companies[0].limit, 300000);
});
