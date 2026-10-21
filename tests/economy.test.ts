import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actors, applyAction, personalResources, resourceHistory,
  teamById, teamForActor, teamResources,
  type Action, type Contribution, type DemoState, type Outcome,
} from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';

const trader = actors.find(actor => actor.id === 'otto')!;
const manager = actors.find(actor => actor.id === 'gianmichele')!;
const admin = actors.find(actor => actor.role === 'admin')!;
const credit = actors.find(actor => actor.role === 'credit')!;
const now = '2026-09-30T06:00:00.000Z';
const teamId = teamForActor(trader)!.id;
function unfundedState(): DemoState {
  const state = createSeedState();
  state.economy!.grants = [];
  state.outcomes = state.outcomes.filter(item=>!item.id.startsWith('outcome-demo-v1-'));
  return state;
}
function fundedState(): DemoState {
  const state = unfundedState();
  state.contributions = Array.from({ length: 300 }, (_, index): Contribution => ({
    id: `accepted-${index}`, title: `Accepted contribution ${index}`, body: 'Confirmed useful information from a completed contribution.',
    targetType: 'feedback', targetId: 'ecosystem', author: index % 2 ? trader.id : manager.id,
    createdAt: now, status: 'approved', reviewer: admin.id, reviewedAt: now,
  }));
  const historic = state.outcomes.find(outcome => outcome.kind === 'fixture')!;
  state.outcomes = [{ ...historic, id: 'funding-fixture', enquiryId: 'funding-enquiry', quantity: 200_000, bookedAt: now }];
  return state;
}
function pendingStem(state: DemoState): Outcome {
  const base = state.outcomes.find(outcome => outcome.kind === 'fixture')!;
  return { ...base, id: 'pending-stem', enquiryId: 'pending-enquiry', quantity: 0, price: 0, margin: 0,
    commercialStatus: 'pending', stemProducts: [{ grade: 'VLSFO', quantityText: '100–300', buyPrice: 400 }] };
}

test('Gold counts accepted contributions, never trading quantities, old Drops amounts or milestones', () => {
  const state = unfundedState();
  assert.deepEqual(personalResources(state, trader.id), { gold: 2 });
  state.drops.push({ ...state.drops[0], id: 'duplicate-seed' },
    { id: 'old-goal', key: 'goal:otto:2026-09:volume', at: now, owner: trader.id, amount: 50, reason: 'Old goal' });
  assert.deepEqual(personalResources(state, trader.id), { gold: 2 });
  const approved = { ...state.contributions[0], status: 'approved' as const, reviewedAt: now };
  state.contributions.push(approved, { ...approved });
  state.drops.push({ id: 'old-contribution', key: `contribution:${approved.id}`, at: now, owner: trader.id, amount: 20, reason: 'Already counted' });
  assert.equal(personalResources(state, trader.id).gold, 3);
  assert.equal(resourceHistory(state, trader.id).filter(entry => entry.key === `gold:contribution:${approved.id}`).length, 1);
  state.outcomes.push({ ...state.outcomes[0], id: 'duplicate-fixture' }, pendingStem(state));
  assert.deepEqual(personalResources(state, trader.id), { gold: 3 });
  assert.ok(resourceHistory(state, trader.id).every(entry => entry.resource === 'gold'));
});

test('feedback earns one immediate Gold for every role without repeat awards',()=>{
 const state=unfundedState();for(const actor of [trader,admin]){const action={type:'submit-contribution' as const,targetType:'feedback' as const,targetId:'ecosystem',title:'Feedback',body:'Keep the enquiry details visible when selecting a supplier.'};const next=applyAction(state,action,actor,now);assert.equal(personalResources(next,actor.id).gold,personalResources(state,actor.id).gold+1);assert.throws(()=>applyAction(next,action,actor,now),/already/);assert.deepEqual(next.drops,state.drops);}
});

test('owner records exact actual STEM volume without changing Gold or finances', () => {
  const state = unfundedState();
  const outcome = pendingStem(state);
  state.outcomes.unshift(outcome);
  const before = personalResources(state, trader.id);
  const action = { type: 'record-actual-volume' as const, id: outcome.id, quantity: 123.456789 };
  for (const unauthorized of [manager, credit, admin]) assert.throws(() => applyAction(state, action, unauthorized, now), /Only the trader|role cannot/);
  for (const quantity of [0, -1, Infinity, NaN, 0.0000001, Number.MAX_VALUE]) assert.throws(() => applyAction(state, { ...action, quantity }, trader, now));
  const next = applyAction(state, action, trader, now);
  const recorded = next.outcomes.find(item => item.id === outcome.id)!;
  assert.equal(recorded.actualVolume?.quantity, 123.456789);
  assert.deepEqual(personalResources(next, trader.id), before);
  assert.equal(next.audit[0].detail, '123.456789 MT.');
  assert.equal(recorded.commercialStatus, 'pending');
  assert.equal(recorded.quantity, 0);
  assert.equal(recorded.price, 0);
  assert.equal(recorded.margin, 0);
  assert.deepEqual(next.companies, state.companies);
  assert.deepEqual(recorded.stemProducts, outcome.stemProducts);
  assert.deepEqual(applyAction(next, action, trader, now), next);
  assert.throws(() => applyAction(next, { ...action, quantity: 125 }, trader, now), /already/);
  assert.throws(() => applyAction(state, { ...action, id: state.outcomes.find(item => !item.commercialStatus && item.kind === 'fixture')!.id }, trader, now), /already has an exact/);
  assert.throws(() => applyAction(state, { ...action, id: state.outcomes.find(item => item.kind === 'lost')!.id }, trader, now), /Select a STEM/);
});

test('office Gold includes assigned members only', () => {
  const state = fundedState();
  assert.deepEqual(teamById(teamId)?.memberIds, ['gianmichele', 'otto']);
  assert.equal(teamForActor('unknown'), undefined);
  assert.equal(teamById('other-team'), undefined);
  state.contributions.push({ ...state.contributions[0], id: 'foreign-contribution', author: 'other-person' });
  assert.deepEqual(personalResources(state, 'other-person'), { gold: 0 });
  assert.deepEqual(teamResources(state, teamId), { gold: 302, earnedGold: 302 });
  assert.deepEqual(teamResources(state, 'other-team'), { gold: 0, earnedGold: 0 });
});

test('retired transport actions cannot spend Gold or change state', () => {
  const state = fundedState(), before = structuredClone(state);
  for (const action of [
    { type: 'dispatch-tanker', teamId, tankerId: 'gp', oil: 1000, requestId: 'obsolete' },
    { type: 'reset-team-transport', teamId },
    { type: 'save-annual-reward', year: 2026, reward: 'Obsolete', targetOil: 1000 },
  ]) assert.throws(() => applyAction(state, action as Action, manager, now), /not supported/);
  assert.deepEqual(state, before);
});

test('transport migration retains cumulative Gold and all other saved work without granting a refund twice', () => {
  const state = createSeedState();
  state.privateNotes = { 'keep-note': { owner: trader.id, text: 'Private', updatedAt: now } };
  state.profiles![trader.id] = { phone: '+85212345678', email: 'custom@example.test' };
  const goldGrants = [{
    id: 'existing-gold', key: 'existing-gold', resource: 'gold' as const, owner: trader.id,
    amount: 5998, reason: 'Demo resources', at: now, teamId, source: 'demo' as const,
  }, {
    id: 'existing-migration', key: 'existing-migration', resource: 'gold' as const, owner: manager.id,
    amount: 4000, reason: 'Office migration', at: now, teamId, source: 'migration' as const,
  }];
  const oldState = { ...state, economy: {
    version: 1, officeFundingVersion: 1, grants: [...goldGrants, {
      id: 'old-oil', key: 'old-oil', resource: 'oil', owner: trader.id, amount: 3_000_000,
      reason: 'Old Oil', at: now, teamId, source: 'demo',
    }],
    arrivals: [{ id: 'old-arrival', teamId, oil: 30_000, goldCost: 30 }],
    annualRewards: [{ year: 2026, reward: 'Old transport reward', targetOil: 30_000 }],
  }} as unknown as DemoState;
  const before = structuredClone(oldState);
  const personalBefore = personalResources(oldState, trader.id);
  const migrated = upgradeDemoState(oldState);
  assert.deepEqual(oldState, before, 'Migration must not mutate input');
  const { economy: ignored, ...preserved } = migrated;
  const { economy: retired, ...original } = before;
  assert.deepEqual(preserved, original);
  assert.deepEqual(migrated.economy, { version: 2, grants: goldGrants });
  assert.deepEqual(personalResources(migrated, trader.id), personalBefore);
  assert.deepEqual(teamResources(migrated, teamId), { gold: 10_000, earnedGold: 10_000 });
  assert.ok(resourceHistory(migrated, trader.id).every(entry => entry.resource === 'gold'));
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(migrated))), migrated);
});

test('states predating the economy upgrade without changing business, knowledge or personal records', () => {
  const state = fundedState();
  delete state.economy;
  state.privateNotes = { 'funding-fixture': { owner: trader.id, text: 'Private', updatedAt: now } };
  const original = structuredClone(state);
  const migrated = upgradeDemoState(state);
  assert.deepEqual(state, original);
  const { economy, ...preserved } = migrated;
  assert.deepEqual(preserved, original);
  assert.equal(economy!.version, 2);
  assert.deepEqual(economy!.grants, []);
  assert.equal(teamResources(migrated, teamId).gold, 302);
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(migrated))), migrated);
});
