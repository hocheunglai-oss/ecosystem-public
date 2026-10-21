import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actors, applyAction, offices, personalResources, resourceHistory,
  teamById, teamForActor, teamMembers, teamResources, type DemoState,
} from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
const vincent = actors.find(actor => actor.id === 'gianmichele')!;
const silvia = actors.find(actor => actor.id === 'silvia')!;
const hk = 'team-gianmichele', italy = 'team-italy';
const now = '2026-09-30T06:00:00.000Z';
function legacyState() {
  const state = createSeedState();
  state.outcomes = state.outcomes.filter(item=>!item.id.startsWith('outcome-demo-v1-'));
  state.economy = { version: 1, arrivals: [], annualRewards: [] } as unknown as DemoState['economy'];
  delete state.profiles!.silvia; delete state.profiles!.filippo;
  state.profiles!.gianmichele = { phone: '+390000000005', email: 'gianmichele@ecosystem.example' };
  return state;
}

test('Hong Kong and Italy have separate managers and two members, with defensive office metadata', () => {
  assert.equal(vincent.name, 'SAMPLE MANAGER A'); assert.equal(vincent.id, 'gianmichele');
  assert.equal(silvia.name, 'SAMPLE MANAGER B'); assert.equal(silvia.role, 'manager');
  assert.equal(actors.find(actor => actor.id === 'filippo')!.name, 'SAMPLE TRADER B');
  assert.deepEqual(offices().map(office => [office.name, office.memberIds]), [['Hong Kong', ['gianmichele', 'otto']], ['Italy', ['silvia', 'filippo']]]);
  assert.deepEqual(teamMembers(silvia).map(actor => actor.id), ['silvia', 'filippo']);
  for (const id of ['luca', 'marco', 'elena']) assert.equal(teamForActor(id), undefined);
  const copy = offices(); copy[0].name = 'Changed'; copy[0].memberIds.push('elena');
  assert.equal(teamById(hk)!.name, 'Hong Kong'); assert.deepEqual(teamById(hk)!.memberIds, ['gianmichele', 'otto']);
});

test('fresh Gold comes only from accepted contributions with no transport startup grants', () => {
  const state = createSeedState();
  assert.deepEqual(teamResources(state, hk), { gold: 2, earnedGold: 2 });
  assert.deepEqual(teamResources(state, italy), { gold: 0, earnedGold: 0 });
  assert.deepEqual(personalResources(state, 'gianmichele'), { gold: 0 });
  assert.deepEqual(personalResources(state, 'otto'), { gold: 2 });
  assert.deepEqual(personalResources(state, 'silvia'), { gold: 0 });
  assert.deepEqual(personalResources(state, 'filippo'), { gold: 0 });
  assert.deepEqual(personalResources(state, 'elena'), { gold: 0 });
  assert.equal(state.outcomes.length, 247); assert.equal(state.contributions.length, 2);
  assert.ok(state.contributions.every(item => item.status === 'pending'));
  assert.equal(state.economy!.version, 2);
  assert.deepEqual(state.economy!.grants, []);
  const gold = resourceHistory(state, 'otto').filter(entry => entry.resource === 'gold');
  assert.equal(gold.reduce((sum, entry) => sum + entry.amount, 0), 2);
  assert.equal(gold.length, 2); // Two accepted historical contributions; no startup funding.
});

test('migration preserves active work, outcomes, custom contacts and notes without adding Gold', () => {
  const legacy = legacyState();
  legacy.profiles!.gianmichele = { phone: '+85212345678', email: 'custom@example.test' };
  legacy.enquiries.push({ ...legacy.enquiries[0], id: 'active-keep', status: 'draft', owner: 'gianmichele' });
  legacy.privateNotes!['outcome-1'] = { owner: 'otto', text: 'Private old note', updatedAt: now };
  const before = structuredClone(legacy);
  const migrated = upgradeDemoState(legacy);
  assert.deepEqual(legacy, before);
  for (const key of ['enquiries', 'outcomes', 'contributions', 'companies', 'ports', 'requests', 'drops', 'goals', 'audit', 'privateNotes', 'lostReasons'] as const) assert.deepEqual(migrated[key], before[key]);
  assert.deepEqual(migrated.profiles!.gianmichele, before.profiles!.gianmichele);
  assert.equal(migrated.profiles!.silvia.email, 'silvia@ecosystem.example');
  assert.equal(migrated.profiles!.filippo.email, 'filippo@ecosystem.example');
  assert.equal(teamResources(migrated, hk).gold, 2);
  assert.deepEqual(upgradeDemoState(JSON.parse(JSON.stringify(migrated))), migrated);
  const defaults = upgradeDemoState(legacyState());
  assert.equal(defaults.profiles!.gianmichele.phone, '+85200000005');
  assert.equal(defaults.profiles!.gianmichele.email, 'vincent@ecosystem.example');
});

test('former office members retain their own Gold without transferring it or changing commercial history', () => {
  const state = legacyState();
  state.contributions.push({ ...state.contributions[0], id: 'luca-accepted', author: 'luca', status: 'approved', reviewedAt: now });
  const before = structuredClone(state);
  const migrated = upgradeDemoState(state);
  assert.deepEqual(migrated.outcomes, before.outcomes);
  assert.deepEqual(migrated.contributions, before.contributions);
  assert.equal(teamResources(migrated, hk).gold, 2);
  assert.deepEqual(migrated.economy!.grants, []);
  assert.equal(personalResources(migrated, 'luca').gold, 1);
  const balance = teamResources(migrated, hk);
  migrated.contributions.push({ ...state.contributions[0], id: 'luca-new', author: 'luca', status: 'approved', reviewedAt: now });
  assert.deepEqual(teamResources(migrated, hk), balance);
  assert.deepEqual(upgradeDemoState(migrated).economy, migrated.economy);
});

test('fresh contribution economy remains stable across reload with no Gold replenishment', () => {
  const state = createSeedState();
  const resumed = upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(resumed.economy, { version: 2, grants: [] });
  assert.deepEqual(personalResources(resumed, 'otto'), personalResources(state, 'otto'));
});


test('approved contributions keep earning for Credit without adding resources to either office', () => {
  const credit = actors.find(actor => actor.id === 'elena')!, admin = actors.find(actor => actor.id === 'marco')!;
  let state = createSeedState();
  const hkBefore = teamResources(state, hk), italyBefore = teamResources(state, italy);
  state = applyAction(state, { type: 'submit-contribution', targetType: 'feedback', targetId: 'ecosystem', title: 'Credit workflow feedback', body: 'Keep the credit review conditions visible alongside the related enquiry.' }, credit, now);

  assert.equal(personalResources(state, credit.id).gold, 1);
  assert.equal(state.audit[0].detail, 'Published.');
  assert.deepEqual(teamResources(state, hk), hkBefore);
  assert.deepEqual(teamResources(state, italy), italyBefore);
});
