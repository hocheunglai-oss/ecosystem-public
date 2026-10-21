import type { Action, Contribution } from './model';
import type { KnowledgeRevision, KnowledgeTarget } from './knowledge';
import type { ContributionActivitySummary, ContributionPeriod } from './contributionActivity';
import { parseLocationSnapshot, parseLocationContribution, parseLocationRevision, type LocationSnapshot } from './sharedLocationKnowledge';
import { assertPreviewWritable } from './previewGuard';
import { assertLiveDataWritable } from './testWorkspaceGuard';

export interface LocationKnowledgeEnvelope {
  revision: number;
  snapshot: LocationSnapshot;
  ack?: { requestId: string; committedRevision: number };
  importedSources?: { digest: string; importedBy?: string; importedAt?: string; requestId?: string }[];
}
export interface LocationHistoryPage { items: KnowledgeRevision[]; nextCursor: string | null; total: number }
export interface LocationActivityPage { summary: ContributionActivitySummary; nextCursor: string | null; activeDates: string[]; byActor?: Record<string, { summary: ContributionActivitySummary; activeDates: string[] }> }
export interface LocationContributionPage { items: Contribution[]; nextCursor: string | null; total: number }
export type LocationKnowledgeWrite = {
  requestId: string; revision: number; dataMode: 'live';
} & ({ action: Action } | { snapshot: LocationSnapshot });

async function request<T>(path: string, body?: LocationKnowledgeWrite, signal?: AbortSignal): Promise<T> {
  if (body) { assertPreviewWritable(); assertLiveDataWritable(); }
  const response = await fetch(`/api/location-knowledge/${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Eco-Data-Mode': 'live', ...(body ? { 'Content-Type': 'application/json', 'X-Eco-Request': '1' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => ({ message: 'Shared country and port data unavailable.' }));
  if (!response.ok) throw Object.assign(new Error(value.message ?? 'Shared country and port data unavailable.'), { status: response.status });
  return value;
}
async function envelope(path: string, body?: LocationKnowledgeWrite, signal?: AbortSignal) {
  const value = await request<LocationKnowledgeEnvelope>(path, body, signal);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.snapshot || value.snapshot.schemaVersion !== 1)
    throw new Error('Shared country and port data unavailable.');
  if (body && (value.ack?.requestId !== body.requestId || !Number.isSafeInteger(value.ack.committedRevision) || value.ack.committedRevision < 1 || value.ack.committedRevision > value.revision))
    throw new Error('Save could not be confirmed. Retry the same save.');
  return { ...value, snapshot: parseLocationSnapshot(value.snapshot) };
}
const query = (values: Record<string, string | undefined>) => new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
const fail = (): never => { throw new Error('Shared country and port data unavailable.'); };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const cursor = (value: unknown): value is string | null => value === null || typeof value === 'string' && value.length > 0 && value.length <= 200;
const dates = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item));
function summary(value: ContributionActivitySummary) {
  if (!value || !count(value.total) || !count(value.previousTotal) || !Number.isSafeInteger(value.delta) || !count(value.activeDays) || !count(value.hatsReceived) || typeof value.periodLabel !== 'string' || !Array.isArray(value.entries) || !Array.isArray(value.weeks)) fail();
  if (value.entries.some(item => !item || typeof item.id !== 'string' || typeof item.author !== 'string' || typeof item.title !== 'string' || typeof item.kind !== 'string' || !Number.isFinite(Date.parse(item.at)) || !count(item.recordCount) || !Array.isArray(item.contributionIds) || item.contributionIds.some(id => typeof id !== 'string') || item.contributionIdsTotal !== undefined && !count(item.contributionIdsTotal) || item.contributionIdsNextCursor !== undefined && !cursor(item.contributionIdsNextCursor))) fail();
  if (value.weeks.some(item => !item || typeof item.label !== 'string' || !Number.isFinite(Date.parse(item.start)) || !Number.isFinite(Date.parse(item.end)) || !count(item.count))) fail();
  return value;
}
function activityPage(value: LocationActivityPage) {
  if (!value || !cursor(value.nextCursor) || !dates(value.activeDates)) fail();
  summary(value.summary);
  if (value.byActor !== undefined) {
    if (!value.byActor || typeof value.byActor !== 'object' || Array.isArray(value.byActor)) fail();
    for (const item of Object.values(value.byActor)) { if (!item || !dates(item.activeDates)) fail(); summary(item.summary); }
  }
  return value;
}
export const locationKnowledgeApi = {
  list: (signal?: AbortSignal) => envelope('list', undefined, signal),
  write: (input: LocationKnowledgeWrite) => envelope('action' in input ? 'mutate' : 'migrate', input),
  history: async (targets: KnowledgeTarget[], after?: string, signal?: AbortSignal) => {
    const page = await request<LocationHistoryPage>(`history?${query({ targets: JSON.stringify(targets), cursor: after })}`, undefined, signal);
    if (!page || !Array.isArray(page.items) || !cursor(page.nextCursor) || !count(page.total)) fail();
    return { ...page, items: page.items.map(parseLocationRevision) };
  },
  contribution: async (id: string, signal?: AbortSignal) => {
    const value = await request<{ item: Contribution }>(`contribution?${query({ id })}`, undefined, signal);
    const item = parseLocationContribution(value?.item); if (item.id !== id) fail(); return { item };
  },
  contributions: async (status: string, after?: string, signal?: AbortSignal) => {
    const page = await request<LocationContributionPage>(`contributions?${query({ status, cursor: after })}`, undefined, signal);
    if (!page || !Array.isArray(page.items) || !cursor(page.nextCursor) || !count(page.total)) fail();
    return { ...page, items: page.items.map(parseLocationContribution) };
  },
  activityIds: async (entryId: string, actor: string, period: ContributionPeriod, after?: string, signal?: AbortSignal) => {
    const page = await request<{ ids: string[]; total: number; nextCursor: string | null }>(`activity-ids?${query({ entryId, actor, period, cursor: after })}`, undefined, signal);
    if (!page || !Array.isArray(page.ids) || page.ids.some(id => typeof id !== 'string') || !cursor(page.nextCursor) || !count(page.total)) fail(); return page;
  },
  activity: async (actors: string[], period: ContributionPeriod, after?: string, signal?: AbortSignal) => activityPage(await request<LocationActivityPage>(`activity?${query({ actors: JSON.stringify(actors), period, cursor: after })}`, undefined, signal)),
};
