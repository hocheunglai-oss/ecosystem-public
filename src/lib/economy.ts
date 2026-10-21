import { actors, type Actor, type DemoState } from './model';

export interface Team { id: string; name: string; managerId: string; memberIds: string[] }
const officeTeams: readonly Team[] = [
  { id: 'team-gianmichele', name: 'Hong Kong', managerId: 'gianmichele', memberIds: ['gianmichele', 'otto'] },
  { id: 'team-italy', name: 'Italy', managerId: 'silvia', memberIds: ['silvia', 'filippo'] },
];
export interface DemoResourceGrant extends ResourceEntry { teamId: string; source: 'demo' | 'migration' }
export interface EconomyState { version: 2; grants?: DemoResourceGrant[] }
export interface ResourceEntry {
  id: string; at: string; owner: string; resource: 'gold'; amount: number; reason: string; key: string;
}
export interface ResourceBalance { gold: number }
export interface TeamResources extends ResourceBalance { earnedGold: number }

export function offices(): Team[] { return officeTeams.map(team => ({ ...team, memberIds: [...team.memberIds] })); }

export function teamById(id: string): Team | undefined {
  const team = officeTeams.find(item => item.id === id);
  return team && { ...team, memberIds: [...team.memberIds] };
}
export function teamForActor(actor: Actor | string): Team | undefined {
  if (typeof actor === 'object' && actor.officeId) return {
    id: actor.officeId, name: actor.officeName ?? actor.officeId,
    managerId: actor.isManager ? actor.id : '', memberIds: [actor.id],
  };
  const id = typeof actor === 'string' ? actor : actor.id;
  const team = officeTeams.find(item => item.memberIds.includes(id));
  return team ? teamById(team.id) : undefined;
}

/** Preserve the precision of operational quantities and existing Gold records. */
export function resourceAmount(value: number, label = 'Amount'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1_000_000) {
    throw new Error(`${label} must be a finite, non-negative amount within the supported precision.`);
  }
  const scaled = value * 1_000_000;
  if (Math.abs(Math.round(scaled) - scaled) > 0.00001) throw new Error(`${label} supports up to six decimal places.`);
  return Math.round(scaled) / 1_000_000;
}
const sumAmounts = (values: number[]): number => resourceAmount(values.reduce((sum, value) => sum + Math.round(resourceAmount(value) * 1_000_000), 0) / 1_000_000);

/** Legacy Gold ledger retained for saved-state compatibility only. The current UI uses contributionActivity. */
function recordedResourceHistory(state: DemoState, actorId: string): ResourceEntry[] {
  const entries = new Map<string, ResourceEntry>();
  for (const contribution of state.contributions) {
    if (contribution.author !== actorId || contribution.status !== 'approved') continue;
    const key = `gold:contribution:${contribution.id}`;
    if (!entries.has(key)) entries.set(key, { id: key, key, at: contribution.publishedAt ?? contribution.reviewedAt ?? contribution.createdAt,
      owner: actorId, resource: 'gold', amount: 1, reason: contribution.title });
  }
  for (const drop of state.drops) {
    if (drop.owner !== actorId || drop.amount <= 0) continue;
    // These two seed records each document one accepted contribution, not 50 / 20 Gold.
    const historicalSeed = ['seed:case-study', 'seed:company-update'].includes(drop.key);
    const historicContribution = drop.key.startsWith('contribution:') &&
      !state.contributions.some(contribution => contribution.id === drop.key.slice('contribution:'.length));
    if (!historicalSeed && !historicContribution) continue;
    const key = `gold:${drop.key}`;
    if (!entries.has(key)) entries.set(key, { id: key, key, at: drop.at, owner: actorId, resource: 'gold', amount: 1, reason: drop.reason });
  }
  for (const grant of state.economy?.grants ?? []) {
    if (grant.resource === 'gold' && grant.owner === actorId && !entries.has(grant.key)) entries.set(grant.key, { ...grant });
  }
  return [...entries.values()].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}
export function resourceHistory(state: DemoState, actorId: string): ResourceEntry[] {
  return actors.some(actor => actor.id === actorId) ? recordedResourceHistory(state, actorId) : [];
}
export function personalResources(state: DemoState, actorId: string): ResourceBalance {
  return { gold: sumAmounts(resourceHistory(state, actorId).map(entry => entry.amount)) };
}
export function teamResources(state: DemoState, teamId: string): TeamResources {
  const team = teamById(teamId);
  const earnedGold = sumAmounts(team?.memberIds.map(id => personalResources(state, id).gold) ?? []);
  return { gold: earnedGold, earnedGold };
}

/** Retire transport state while preserving any Gold already saved by existing users. */
export function migrateContributionEconomy(state: DemoState): void {
  state.economy = {
    version: 2,
    grants: (state.economy?.grants ?? []).filter(grant => grant.resource === 'gold').map(grant => ({ ...grant })),
  };
}
