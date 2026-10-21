import { competitionAction } from './fixtures/profile-actions';
import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, canTrade, personalResources, type Action } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { buyerGroupKey } from '../src/lib/buyerProfile';
import { buyerSharedDraft, buyerSharedEntries, type BuyerSharedListKind } from '../src/lib/buyerSharedLists';
import { buyerCompetitionEntries } from '../src/lib/buyerCompetition';
const trader = actors.find(actor => actor.role === 'trader')!;
const manager = actors.find(actor => actor.role === 'manager')!;
const credit = actors.find(actor => actor.role === 'credit')!;
const buyerId = 'company-meridian';
const at = '2026-10-09T08:00:00Z', later = '2026-10-09T09:00:00Z';

for (const kind of ['group', 'competition'] as BuyerSharedListKind[]) test(`${kind}: migrate old entries into an editable list, preserve history, update/remove and award once per revision`, () => {
  let state = createSeedState();
  const buyer = state.companies.find(item => item.id === buyerId)!;
  const targetId = kind === 'group' ? buyerGroupKey(buyer) : buyerId;
  const text = 'A useful original shared record for this buyer group.';
  if (kind === 'group') state = applyAction(state, { type: 'submit-contribution', targetType: 'buyer-group', targetId, title: 'Group Remarks', body: text }, trader, at);
  else state.contributions.unshift({ id: 'legacy-competition', targetType: 'buyer-competition', targetId, title: 'Competition', body: text, author: trader.id, createdAt: at, publishedAt: at, publication: 'direct', status: 'approved' });
  const original = structuredClone(state), entries = buyerSharedEntries(state, kind, targetId), gold = personalResources(state, manager.id).gold;
  const action: Action = { type: 'save-buyer-shared-list', buyerId, kind, baseEntries: buyerSharedDraft(entries), entries: [{ id: entries[0].id, text: 'The current supplier competition or shared remark has changed.' }, { id: 'second-entry', text: 'A new list entry' }] };
  const saved = applyAction(state, action, manager, later);
  assert.deepEqual(state, original);
  assert.deepEqual(saved.contributions.find(entry => entry.id === entries[0].id), original.contributions.find(entry => entry.id === entries[0].id));
  const current = buyerSharedEntries(saved, kind, targetId);
  assert.equal(current.length, 2);
  assert.equal(current[0].author, trader.id);
  assert.equal(current[0].updatedBy, manager.id);
  assert.equal(current[0].updatedAt, later);
  assert.equal(current[1].author, manager.id);
  assert.equal(personalResources(saved, manager.id).gold, gold + 1);
  assert.throws(() => applyAction(saved, action, trader, later), /list changed/);
  const restored = upgradeDemoState(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(buyerSharedEntries(restored, kind, targetId), current);
  const removed = applyAction(restored, { type: 'save-buyer-shared-list', buyerId, kind, baseEntries: buyerSharedDraft(current), entries: [] }, manager, later);
  assert.deepEqual(buyerSharedEntries(removed, kind, targetId), []);
  assert.equal(personalResources(removed, manager.id).gold, gold + 2);
  assert.equal(removed.contributions.length, original.contributions.length + 2);
  assert.throws(() => applyAction(removed, { type: 'save-buyer-shared-list', buyerId, kind, baseEntries: [], entries: [] }, manager, later), /No list changes/);
});

test('unchanged, duplicate, blank, oversized and malformed lists cannot earn Gold or modify records', () => {
  const state = applyAction(createSeedState(), competitionAction(createSeedState(), 'Competitor A', buyerId), trader, at), original = structuredClone(state);
  const baseEntries = buyerSharedDraft(buyerSharedEntries(state, 'competition', buyerId));
  for (const entries of [baseEntries, [{ ...baseEntries[0], text: ' competitor   a ' }], [{ id: 'a', text: 'A' }, { id: 'b', text: ' a ' }], [{ id: 'a', text: '' }], [{ id: 'a', text: 'x'.repeat(10001) }], [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }]]) {
    assert.throws(() => applyAction(state, { type: 'save-buyer-shared-list', buyerId, kind: 'competition', baseEntries, entries }, trader, later));
    assert.deepEqual(state, original);
  }
});

test('competition permissions stay restricted, group remarks share only the group and new list entries still append after editing', () => {
  const initial = createSeedState();
  for (const actor of actors) {
    const action: Action = { type: 'save-buyer-shared-list', kind: 'competition', buyerId, baseEntries: [], entries: [{ id: 'one', text: 'A' }] };
    if (canTrade(actor)) assert.doesNotThrow(() => applyAction(initial, action, actor, at));
    else assert.throws(() => applyAction(initial, action, actor, at), /role/);
  }
  let state = applyAction(initial, { type: 'save-buyer-shared-list', kind: 'competition', buyerId, baseEntries: [], entries: [{ id: 'one', text: 'A' }] }, trader, at);
  state = applyAction(state, competitionAction(state, 'B', buyerId), trader, later);
  assert.deepEqual(buyerCompetitionEntries(state, buyerId).map(entry => entry.body), ['B','A']);
  const targetId = buyerGroupKey(state.companies.find(buyer => buyer.id === buyerId)!);
  state = applyAction(state, { type: 'save-buyer-shared-list', kind: 'group', buyerId, baseEntries: [], entries: [{ id: 'group-one', text: 'Group shared remark' }] }, credit, at);
  const sibling = state.companies.find(buyer => buyer.id !== buyerId && buyerGroupKey(buyer) === targetId)!;
  assert.ok(sibling);
  assert.equal(buyerSharedEntries(state, 'group', buyerGroupKey(sibling))[0].text, 'Group shared remark');
  state = applyAction(state, { type: 'submit-contribution', targetType: 'buyer-group', targetId, title: 'Legacy path', body: 'Another shared group remark from the existing entry path.' }, trader, later);
  assert.equal(buyerSharedEntries(state, 'group', targetId).length, 2);
  assert.equal(buyerSharedEntries(state, 'competition', sibling.id).length, 0);
  assert.deepEqual(state.companies, initial.companies);
  assert.deepEqual(state.buyerPrivateRemarks, initial.buyerPrivateRemarks);
});
