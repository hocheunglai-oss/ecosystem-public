import { competitionAction, privateRemarkAction } from './fixtures/profile-actions';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { actors, applyAction, canTrade, personalResources, type Action, type DemoState } from '../src/lib/model';
import { buyerCompetitionEntries, BUYER_COMPETITION_MAX_LENGTH, validateBuyerCompetitionText } from '../src/lib/buyerCompetition';

const buyerId = 'company-meridian';
const otherBuyerId = 'company-cape-union';
const at = '2026-10-09T08:00:00.000Z';
const later = '2026-10-09T09:00:00.000Z';
const trader = actors.find(actor => actor.role === 'trader')!;
const manager = actors.find(actor => actor.role === 'manager')!;
const admin = actors.find(actor => actor.role === 'admin')!;
const action = (state: DemoState, text = 'COMPETITOR A', target = buyerId): Action => competitionAction(state, text, target);
const withoutPublications = ({ contributions: _contributions, audit: _audit, buyerSharedLists: _lists, ...other }: DemoState) => other;

test('only traders and managers add Competition; each accepted entry publishes once and earns exactly one Gold', () => {
  for (const actor of actors) {
    const state = createSeedState(), before = structuredClone(state);
    if (!canTrade(actor)) {
      assert.throws(() => applyAction(state, action(state), actor, at), /role/);
      assert.deepEqual(state, before);
      continue;
    }
    const gold = personalResources(state, actor.id).gold;
    const saved = applyAction(state, action(state), actor, at);
    const entries = buyerCompetitionEntries(saved, buyerId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].body, 'COMPETITOR A');
    assert.equal(entries[0].targetId, buyerId);
    assert.equal(entries[0].author, actor.id);
    assert.equal(entries[0].createdAt, at); assert.equal(entries[0].publishedAt, at);
    assert.equal(entries[0].publication, 'direct'); assert.equal(entries[0].status, 'approved');
    assert.equal(personalResources(saved, actor.id).gold, gold + 1);
    assert.equal(saved.audit[0].action, 'Competition updated'); assert.equal(saved.audit[0].actor, actor.name);
    assert.deepEqual(withoutPublications(saved), withoutPublications(before), 'No financial, company, private, credit or group state is mutated');
    assert.deepEqual(saved.contributions.slice(1), before.contributions);
    assert.deepEqual(saved.audit.slice(1), before.audit);
    assert.deepEqual(state, before);
  }
});

test('normalized retries and duplicates across authors fail atomically without another Gold', () => {
  const state = applyAction(createSeedState(), action(createSeedState(), '  Competitor A\n  supplied this buyer.  '), trader, at);
  assert.equal(buyerCompetitionEntries(state, buyerId)[0].body, 'Competitor A\n  supplied this buyer.');
  const before = structuredClone(state), traderGold = personalResources(state, trader.id).gold, managerGold = personalResources(state, manager.id).gold;
  for (const actor of [trader, manager]) for (const text of ['Competitor A\n  supplied this buyer.', ' competitor a supplied this buyer. ', 'COMPETITOR\tA\nSUPPLIED THIS BUYER.']) {
    assert.throws(() => applyAction(state, action(state, text), actor, later), /duplicate/);
    assert.deepEqual(state, before);
  }
  assert.equal(personalResources(state, trader.id).gold, traderGold);
  assert.equal(personalResources(state, manager.id).gold, managerGold);
  assert.throws(() => applyAction(state, { type: 'review-contribution', id: state.contributions[0].id, approve: true, note: 'Retry' }, admin, later), /already been reviewed/);
  assert.deepEqual(state, before);
});

test('Competition is exact-buyer shared information, persists after reload and allows another buyer in the same group', () => {
  const initial = createSeedState();
  for (const buyer of initial.companies.filter(buyer => [buyerId, otherBuyerId].includes(buyer.id))) buyer.accountGroupId = 'same-buyer-group';
  const first = applyAction(initial, action(initial, 'A'), trader, at);
  const second = applyAction(first, action(first, 'A', otherBuyerId), manager, later);
  const third = applyAction(second, action(second, 'B'), manager, later);
  const restored = upgradeDemoState(JSON.parse(JSON.stringify(third)));
  assert.deepEqual(buyerCompetitionEntries(restored, buyerId).map(entry => entry.body), ['B', 'A']);
  assert.deepEqual(buyerCompetitionEntries(restored, otherBuyerId).map(entry => entry.body), ['A']);
  assert.deepEqual(buyerCompetitionEntries(restored, 'missing'), []);
  assert.deepEqual(buyerCompetitionEntries(restored, buyerId), buyerCompetitionEntries(third, buyerId));
  assert.equal(personalResources(restored, trader.id).gold, personalResources(initial, trader.id).gold + 1);
  assert.equal(personalResources(restored, manager.id).gold, personalResources(initial, manager.id).gold + 2);
  assert.throws(() => applyAction(restored, action(restored, ' a '), manager, later), /duplicate/);
});

test('blank, malformed, oversized and unknown-buyer submissions cannot publish or reward; a short name is sufficient', () => {
  const state = createSeedState(), before = structuredClone(state);
  for (const text of ['', ' \n\t ', null, 12, {}, 'x'.repeat(BUYER_COMPETITION_MAX_LENGTH + 1)]) {
    assert.throws(() => applyAction(state, { type: 'save-buyer-shared-list', kind: 'competition', buyerId, baseEntries: [], entries: [{ id: 'invalid-entry', text }] } as Action, trader, at), /Competition/);
    assert.deepEqual(state, before);
  }
  assert.throws(() => applyAction(state, action(state, 'A', 'not-a-company'), trader, at), /company database/);
  assert.deepEqual(state, before);
  assert.equal(validateBuyerCompetitionText('A'), 'A');
  const max = 'x'.repeat(BUYER_COMPETITION_MAX_LENGTH);
  assert.equal(buyerCompetitionEntries(applyAction(state, action(state, max), trader, at), buyerId)[0].body, max);
});

test('generic contributions and legacy review cannot bypass Competition validation or roles', () => {
  const state = createSeedState(), before = structuredClone(state);
  for (const actor of actors) {
    assert.throws(() => applyAction(state, { type: 'submit-contribution', targetType: 'buyer-competition', targetId: buyerId, title: 'Competition', body: 'Generic path must not publish or grant Competition rewards.' }, actor, at), /Competition/);
    assert.deepEqual(state, before);
  }
  state.contributions.unshift({ id: 'legacy-pending-competition', targetType: 'buyer-competition', targetId: buyerId, title: 'Competition', body: 'Unvalidated legacy input', author: trader.id, createdAt: at, status: 'pending' });
  const pending = structuredClone(state);
  assert.deepEqual(buyerCompetitionEntries(state, buyerId), []);
  assert.throws(() => applyAction(state, { type: 'review-contribution', id: 'legacy-pending-competition', approve: true, note: 'Attempt' }, admin, later), /published directly/);
  assert.deepEqual(state, pending);
});

test('Competition does not copy private or credit remarks and does not broaden existing permissions', () => {
  const credit = actors.find(actor => actor.role === 'credit')!;
  let state = applyAction(createSeedState(), privateRemarkAction(createSeedState(), buyerId, trader.id, 'PRIVATE FOLLOW-UP'), trader, at);
  state = applyAction(state, { type: 'save-buyer-credit-remarks', buyerId, text: 'CREDIT TEAM REMARK' }, credit, at);
  const before = structuredClone(state), saved = applyAction(state, action(state, 'COMPETITOR A'), manager, later);
  assert.deepEqual(withoutPublications(saved), withoutPublications(before));
  assert.equal(JSON.stringify(buyerCompetitionEntries(saved, buyerId)).includes('PRIVATE FOLLOW-UP'), false);
  assert.equal(JSON.stringify(buyerCompetitionEntries(saved, buyerId)).includes('CREDIT TEAM REMARK'), false);
  assert.equal(saved.audit[0].detail.includes('PRIVATE FOLLOW-UP'), false);
  assert.throws(() => applyAction(saved, { type: 'save-buyer-credit-remarks', buyerId, text: 'Attempt' }, manager, later), /role/);
});
