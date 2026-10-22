import { actors, type Contribution, type DemoState, type LocationPublication } from './model.ts';
import type { KnowledgeBlock, KnowledgeChange, KnowledgeTarget } from './knowledge.ts';
import { intelligenceFields, type IntelligenceKeyInfo } from './intelligenceFields.ts';
import { canonicalLocationTarget } from './locations.ts';

export type ContributionPeriod = '28d' | '7d' | 'month' | 'all';
export type ContributionStatusKey = 'inactive' | 'active' | 'outstanding';
export interface ContributionStatusDefinition {
  key: ContributionStatusKey;
  label: string;
  criteria: string;
}
export interface ContributionStatus extends ContributionStatusDefinition {
  next: {
    key: ContributionStatusKey;
    label: string;
    contributionsNeeded: number;
  } | null;
}

/** Recognition is independent: only contribution counts determine these tiers. */
export const contributionStatusRules: readonly ContributionStatusDefinition[] = [
  { key: 'inactive', label: 'INACTIVE', criteria: '0 CONTRIBUTIONS' },
  { key: 'active', label: 'ACTIVE', criteria: '1–10 CONTRIBUTIONS' },
  { key: 'outstanding', label: 'OUTSTANDING', criteria: '11+ CONTRIBUTIONS' },
];

export function contributionStatus(total: number): ContributionStatus {
  const index = total < 1 ? 0 : total <= 10 ? 1 : 2;
  const nextIndex = index + 1;
  return {
    ...contributionStatusRules[index],
    next: index === 2 ? null : {
      key: contributionStatusRules[nextIndex].key,
      label: contributionStatusRules[nextIndex].label,
      contributionsNeeded: index === 0 ? 1 : 11 - total,
    },
  };
}

/** Appearance-only examples; never write these values to contribution records. */
export const contributionPreviewCounts: Readonly<Record<ContributionStatusKey, number>> = {
  inactive: 0, active: 5, outstanding: 11,
};

export const contributionEncouragement: Readonly<Record<ContributionStatusKey, string>> = {
  inactive: 'MAKE YOUR FIRST CONTRIBUTION BY UPDATING OUR DATABASE OR SENDING FEEDBACK!',
  active: 'THANK YOU FOR YOUR CONTRIBUTIONS. KEEP SHARING WHAT YOU KNOW!',
  outstanding: 'OUTSTANDING WORK! THANK YOU FOR HELPING OUR TEAM STAY INFORMED.',
};

export interface ContributionActivityEntry {
  id: string;
  at: string;
  /** Actor ID, including when the latest editor has subsequently changed. */
  author: string;
  title: string;
  kind: string;
  /** Distinct profiles updated, never a multiplication of the contribution count. */
  recordCount: number;
  /** All original publications remain available for the detailed audit. */
  contributionIds: string[];
  /** Transport-only pagination metadata; pure grouping retains the complete IDs. */
  contributionIdsTotal?: number;
  contributionIdsNextCursor?: string | null;
}
export interface ContributionActivitySummary {
  total: number;
  previousTotal: number;
  delta: number;
  activeDays: number;
  hatsReceived: number;
  weeks: { label: string; start: string; end: string; count: number }[];
  entries: ContributionActivityEntry[];
  periodLabel: string;
}

const DAY = 86_400_000, HKT = 8 * 3_600_000;
const legacyActorIds = actors.map(actor => actor.id);
const knownKinds = new Set<Contribution['targetType']>(['port', 'country', 'area', 'company', 'supplier', 'case-study', 'feedback', 'buyer-group', 'buyer-team', 'buyer-competition']);
const normalize = (text: string | null | undefined) => (text ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const dayStart = (at: number) => Math.floor((at + HKT) / DAY) * DAY - HKT;
const dayKey = (at: number) => new Date(at + HKT).toISOString().slice(0, 10);
const iso = (at: number) => new Date(at).toISOString();
const actorSet = (ids: string | string[], knownActors: Set<string>) => new Set((Array.isArray(ids) ? ids : [ids]).filter(id => knownActors.has(id)));
/** The caller may provide IDs from its authenticated roster. A UUID-shaped author alone is not evidence of a known user. */
const actorDirectory = (state: DemoState, directoryIds: readonly string[]) => new Set([...legacyActorIds, ...Object.keys(state.profiles ?? {}), ...directoryIds]);

function timestamp(now: Date | number): number {
  const at = Number(now);
  if (!Number.isFinite(at)) throw new Error('Select a valid activity date.');
  return at;
}

/** Ignore visual layout, order, widths and attribution stamps when assessing an edit. */
function blockContent(block: KnowledgeBlock): string {
  // An empty card or table scaffold is layout setup, even if its compulsory title is present.
  if (block.type === 'text' && !normalize(block.text)) return '';
  if (block.type === 'file' && !block.url.trim()) return '';
  if (block.type === 'table' && !block.rows.some(row => row.cells.some(cell => normalize(cell)))) return '';
  const common = [block.type, normalize(block.title), normalize(block.provenance?.source), normalize(block.provenance?.evidence), normalize(block.provenance?.date)];
  if (block.type === 'text') return JSON.stringify([...common, normalize(block.text)]);
  if (block.type === 'file') return JSON.stringify([...common, block.url.trim()]);
  const columns = block.columns.map((column, index) => ({ id: column.id, name: normalize(column.name), index })).sort((a, b) => a.id.localeCompare(b.id));
  const rows = block.rows.map(row => [row.id, columns.map(column => normalize(row.cells[column.index]))]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([...common, columns.map(column => [column.id, column.name]), rows]);
}

type Difference = { key: string; before: string; after: string };
function recordKey(state: DemoState, target: KnowledgeTarget): string {
  const canonical = canonicalLocationTarget(state, target);
  return `${canonical.kind}:${canonical.id}`;
}
function knowledgeDifferences(state: DemoState, change: KnowledgeChange): Difference[] {
  const before = new Map(change.baseDocument.sections.flatMap(section => section.blocks).map(block => [block.id, blockContent(block)]));
  const after = new Map(change.document.sections.flatMap(section => section.blocks).map(block => [block.id, blockContent(block)]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(id => (before.get(id) ?? '') === (after.get(id) ?? '') ? [] : [{
    key: `${recordKey(state, change.target)}:block:${id}`, before: before.get(id) ?? '', after: after.get(id) ?? '',
  }]);
}
function keyInfoDifferences(portId: string, before: IntelligenceKeyInfo | undefined, after: IntelligenceKeyInfo): Difference[] {
  return intelligenceFields.flatMap(({ key }) => normalize(before?.[key]) === normalize(after[key]) ? [] : [{
    key: `port:${portId}:key-info:${key}`, before: normalize(before?.[key]), after: normalize(after[key]),
  }]);
}

interface Publication extends ContributionActivityEntry {
  keys: string[];
  records: string[];
  fingerprint: string;
  keyInfoTransitions: { key: string; fingerprint: string }[];
}
function publication(state: DemoState, contribution: Contribution, knownActors: Set<string>): Publication | undefined {
  // Tab organisation is useful maintenance, but does not add information.
  if (contribution.historicalImport || contribution.status !== 'approved' || !knownActors.has(contribution.author) || !knownKinds.has(contribution.targetType) || contribution.tabChanges) return undefined;
  if (contribution.locationPublication) {
    const p = contribution.locationPublication;
    if (!p.eligible) return undefined;
    const at = contribution.publishedAt ?? contribution.reviewedAt ?? contribution.createdAt;
    if (!Number.isFinite(Date.parse(at))) return undefined;
    return { id: contribution.id, at: iso(Date.parse(at)), author: contribution.author, title: contribution.title,
      kind: p.kind, recordCount: p.records.length, contributionIds: [contribution.id], keys: p.keys, records: p.records,
      fingerprint: p.fingerprint, keyInfoTransitions: p.keyInfoTransitions };
  }
  const at = contribution.publishedAt ?? contribution.reviewedAt ?? contribution.createdAt;
  if (!Number.isFinite(Date.parse(at))) return undefined;
  let differences: Difference[] = [], keys: string[] = [], records: string[] = [];
  const documentVersions: [string, number][] = [], keyInfoTransitions: Publication['keyInfoTransitions'] = [];
  let kind: string = contribution.targetType;
  if (contribution.extractionBatch) {
    const batch = contribution.extractionBatch;
    for (const change of batch.changes) {
      const edits = knowledgeDifferences(state, change);
      if (edits.length) {
        records.push(recordKey(state, change.target));
        documentVersions.push([recordKey(state, change.target), change.baseVersion]);
      }
      differences.push(...edits);
    }
    for (const change of batch.intelligenceChanges) {
      const edits = keyInfoDifferences(change.portId, change.baseKeyInfo, change.keyInfo);
      if (edits.length) {
        records.push(`port:${change.portId}`);
        keyInfoTransitions.push({ key: `port:${change.portId}`, fingerprint: JSON.stringify(edits) });
      }
      differences.push(...edits);
    }
    if (!differences.length) return undefined;
    kind = 'ai-import';
    keys = [`ai-import:${batch.id}`];
  } else if (contribution.knowledgeChange) {
    const documentEdits = knowledgeDifferences(state, contribution.knowledgeChange);
    const keyInfoEdits = contribution.proposedKeyInfo ? keyInfoDifferences(contribution.targetId, contribution.keyInfoBase, contribution.proposedKeyInfo) : [];
    differences = [...documentEdits, ...keyInfoEdits];
    if (!differences.length) return undefined;
    keys = [...documentEdits.map(change => change.key), ...(keyInfoEdits.length ? [`port:${contribution.targetId}:key-info`] : [])];
    records = [recordKey(state, contribution.knowledgeChange.target)];
    if (documentEdits.length) documentVersions.push([records[0], contribution.knowledgeChange.baseVersion]);
    if (keyInfoEdits.length) keyInfoTransitions.push({ key: `port:${contribution.targetId}`, fingerprint: JSON.stringify(keyInfoEdits) });
  } else if (contribution.proposedKeyInfo) {
    differences = keyInfoDifferences(contribution.targetId, contribution.keyInfoBase, contribution.proposedKeyInfo);
    if (!differences.length) return undefined;
    // One Key Info editor has four fields, not four separate opportunities to count a save.
    keys = [`port:${contribution.targetId}:key-info`];
    records = [`port:${contribution.targetId}`];
    keyInfoTransitions.push({ key: records[0], fingerprint: JSON.stringify(differences) });
    kind = 'key-info';
  } else {
    if (!normalize(contribution.body)) return undefined;
    records = [contribution.targetType === 'country' ? recordKey(state, { kind: 'country', id: contribution.targetId }) : `${contribution.targetType}:${contribution.targetId}`];
    keys = [`${records[0]}:topic:${normalize(contribution.title)}`];
  }
  const fingerprint = differences.length
    ? JSON.stringify([differences.sort((a, b) => a.key.localeCompare(b.key)), documentVersions.sort(([a], [b]) => a.localeCompare(b))])
    : JSON.stringify([records[0], normalize(contribution.body)]);
  records = [...new Set(records)];
  return { id: contribution.id, at: iso(Date.parse(at)), author: contribution.author, title: contribution.title,
    kind, recordCount: records.length, contributionIds: [contribution.id], keys, records, fingerprint, keyInfoTransitions };
}

/** Produce bounded content-independent facts without changing the grouping algorithm.
 * Hashing is injected by the server (SHA-256); no raw diff/body travels in a fact.
 * Compute before stripping the full contribution or importing its historical marker.
 */
export async function projectLocationPublication(state: DemoState, contribution: Contribution, hash: (value: string) => Promise<string> | string): Promise<LocationPublication> {
  if (contribution.locationPublication) return structuredClone(contribution.locationPublication);
  const item = publication(state, contribution, new Set([contribution.author]));
  if (!item) return { version: 1, eligible: false, kind: contribution.targetType, keys: [], records: [], fingerprint: '', keyInfoTransitions: [] };
  const hashed = async (value: string) => { const result = await hash(value); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('A SHA-256 publication fingerprint is required.'); return result; };
  return { version: 1, eligible: true, kind: item.kind, keys: await Promise.all(item.keys.map(hashed)), records: await Promise.all(item.records.map(hashed)),
    fingerprint: await hashed(item.fingerprint), keyInfoTransitions: await Promise.all(item.keyInfoTransitions.map(async t => ({ key: await hashed(t.key), fingerprint: await hashed(t.fingerprint) }))),
    ...(contribution.extractionBatch ? { batchId: contribution.extractionBatch.id } : {}) };
}

/** Read the immutable publications, never the old Gold amounts or starter grants.
 * Hong Kong calendar days group repeat saves to the same entry by the same author.
 * A multi-entry save is one contribution; overlapping saves that day remain one.
 * AI imports remain one batch, with the distinct updated profile count alongside.
 */
export function contributionHistory(state: DemoState, actorIds: string | string[], now: Date | number = new Date(), directoryIds: readonly string[] = []): ContributionActivityEntry[] {
  const knownActors = actorDirectory(state, directoryIds), selected = actorSet(actorIds, knownActors), cutoff = timestamp(now), publications: Publication[] = [];
  const ids = new Set<string>(), fingerprints = new Map<string, Publication>(), batches = new Map<string, Publication>();
  const keyInfoSequence = new Map<string, { fingerprint: string; epoch: number }>();
  const publicationTime = (item: Contribution) => Date.parse(item.publishedAt ?? item.reviewedAt ?? item.createdAt);
  const sorted = state.contributions.filter(item => Number.isFinite(publicationTime(item)))
    .sort((a, b) => publicationTime(a) - publicationTime(b) || a.id.localeCompare(b.id));
  for (const contribution of sorted) {
    if (ids.has(contribution.id)) continue;
    const item = publication(state, contribution, knownActors);
    if (!item || Date.parse(item.at) > cutoff) continue;
    ids.add(contribution.id);
    const batchId = contribution.locationPublication?.batchId ?? contribution.extractionBatch?.id;
    const repeatedBatch = batchId ? batches.get(batchId) : undefined;
    if (repeatedBatch) {
      repeatedBatch.contributionIds.push(contribution.id);
      continue;
    }
    // Knowledge documents have immutable versions. Key Info does not, so distinguish
    // recurring A→B updates by observing intervening transitions from every author.
    // Repeated IDs/batches above cannot advance this sequence or refresh old activity.
    const transitions = item.keyInfoTransitions.map(transition => {
      const previous = keyInfoSequence.get(transition.key);
      return { ...transition, epoch: previous?.fingerprint === transition.fingerprint ? previous.epoch : (previous?.epoch ?? 0) + 1 };
    });
    const fingerprint = JSON.stringify([item.author, item.fingerprint, transitions.map(({ key, epoch }) => [key, epoch]).sort(([a], [b]) => String(a).localeCompare(String(b)))]);
    const duplicate = fingerprints.get(fingerprint);
    if (duplicate) {
      // Keep the audit link without moving an old contribution into a newer activity window.
      duplicate.contributionIds.push(contribution.id);
      if (batchId) batches.set(batchId, duplicate);
      continue;
    }
    fingerprints.set(fingerprint, item);
    if (batchId) batches.set(batchId, item);
    for (const transition of transitions) keyInfoSequence.set(transition.key, transition);
    if (selected.has(contribution.author)) publications.push(item);
  }
  const existingContributionIds = new Set(state.contributions.map(item => item.id)), legacyKeys = new Set<string>();
  for (const drop of state.drops) {
    if (!selected.has(drop.owner) || drop.amount <= 0 || !Number.isFinite(Date.parse(drop.at)) || Date.parse(drop.at) > cutoff || legacyKeys.has(drop.key)) continue;
    const historicalSeed = ['seed:case-study', 'seed:company-update'].includes(drop.key);
    const historicalId = drop.key.startsWith('contribution:') ? drop.key.slice('contribution:'.length) : '';
    if (!historicalSeed && (!historicalId || existingContributionIds.has(historicalId))) continue;
    legacyKeys.add(drop.key);
    publications.push({ id: `legacy:${drop.key}`, at: iso(Date.parse(drop.at)), author: drop.owner, title: drop.reason,
      kind: drop.key === 'seed:case-study' ? 'case-study' : drop.key === 'seed:company-update' ? 'company' : 'legacy',
      recordCount: 1, contributionIds: historicalId ? [historicalId] : [], keys: [`legacy:${drop.key}`], records: [`legacy:${drop.key}`], fingerprint: drop.key, keyInfoTransitions: [] });
  }

  const grouped: Publication[] = [];
  for (const item of publications.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const matches = grouped.filter(group => group.author === item.author && dayKey(Date.parse(group.at)) === dayKey(Date.parse(item.at)) && group.keys.some(key => item.keys.includes(key)));
    if (!matches.length) { grouped.push({ ...item }); continue; }
    // A save may touch two existing groups. Merge all connected entries, not only the first.
    const merged = { ...item,
      keys: [...new Set([...item.keys, ...matches.flatMap(group => group.keys)])],
      records: [...new Set([...item.records, ...matches.flatMap(group => group.records)])],
      contributionIds: [...new Set([...matches.flatMap(group => group.contributionIds), ...item.contributionIds])],
    };
    merged.id = matches[0].id;
    merged.recordCount = merged.records.length;
    for (const match of matches) grouped.splice(grouped.indexOf(match), 1);
    grouped.push(merged);
  }
  return grouped.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .map(({ keys: _keys, records: _records, fingerprint: _fingerprint, keyInfoTransitions: _keyInfoTransitions, ...entry }) => entry);
}

function periodRange(period: ContributionPeriod, now: number) {
  const end = now + 1, today = dayStart(now);
  if (period === 'all') return { start: -Infinity, end, previousStart: 0, previousEnd: 0, label: 'ALL TIME' };
  if (period === 'month') {
    const local = new Date(now + HKT);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - HKT;
    const previousStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - HKT;
    return { start, end, previousStart, previousEnd: Math.min(start, previousStart + end - start), label: 'THIS MONTH' };
  }
  const days = period === '7d' ? 7 : 28, start = today - (days - 1) * DAY;
  return { start, end, previousStart: start - days * DAY, previousEnd: end - days * DAY, label: `LAST ${days} DAYS` };
}

function receivedHats(state: DemoState, selected: Set<string>, start: number, end: number, knownActors: Set<string>): number {
  const slots = new Set<string>();
  let total = 0;
  for (const hat of state.hats ?? []) {
    const awarded = Date.parse(hat.awardedAt);
    if (!Number.isFinite(awarded) || awarded >= end) continue;
    const key = JSON.stringify([hat.readerId, hat.targetKey]);
    if (slots.has(key)) continue;
    slots.add(key);
    const undone = hat.undoneAt ? Date.parse(hat.undoneAt) : undefined;
    if ((undone !== undefined && (!Number.isFinite(undone) || undone < end)) || awarded < start
      || !selected.has(hat.recipientId) || !knownActors.has(hat.readerId) || hat.recipientId === hat.readerId) continue;
    total++;
  }
  return total;
}

/** Last 7/28 days include today in HKT. Comparison ends at the same elapsed time
 * in the preceding window. Month-to-date uses the equivalent part of last month,
 * capped at that month's end. All-time has no invented comparison period.
 */
export function contributionActivity(state: DemoState, actorIds: string | string[], period: ContributionPeriod = '28d', now: Date | number = new Date(), directoryIds: readonly string[] = []): ContributionActivitySummary {
  const at = timestamp(now), knownActors = actorDirectory(state, directoryIds), selected = actorSet(actorIds, knownActors), history = contributionHistory(state, [...selected], at, directoryIds);
  const range = periodRange(period, at);
  const entries = history.filter(entry => Date.parse(entry.at) >= range.start && Date.parse(entry.at) < range.end);
  const previousTotal = period === 'all' ? 0 : history.filter(entry => Date.parse(entry.at) >= range.previousStart && Date.parse(entry.at) < range.previousEnd).length;
  const chartStart = period === 'all' ? dayStart(at) - 27 * DAY : range.start;
  const interval = period === '7d' ? DAY : 7 * DAY;
  const weeks: ContributionActivitySummary['weeks'] = [];
  const dateLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Hong_Kong' });
  for (let start = chartStart; start < range.end; start += interval) {
    const end = Math.min(start + interval, range.end);
    weeks.push({ label: dateLabel.format(new Date(start)).toUpperCase(), start: iso(start), end: iso(end),
      count: history.filter(entry => Date.parse(entry.at) >= start && Date.parse(entry.at) < end).length });
  }
  return { total: entries.length, previousTotal, delta: period === 'all' ? 0 : entries.length - previousTotal,
    activeDays: new Set(entries.map(entry => dayKey(Date.parse(entry.at)))).size,
    hatsReceived: receivedHats(state, selected, range.start, range.end, knownActors), weeks, entries, periodLabel: range.label };
}


export interface SharedLocationActivityPage {
  summary: ContributionActivitySummary;
  nextCursor: string | null;
  /** Exact Hong Kong calendar dates for the complete selected period, not just this page. */
  activeDates: string[];
}
/** Location publications are separate from local/non-location activity. Remote totals
 * cover every page; displayed entries contain only pages already loaded by the caller.
 * Hats remain on their existing independently verified path.
 */
export function mergeLocationActivity(local: ContributionActivitySummary, remote: Pick<SharedLocationActivityPage, 'summary' | 'activeDates'> | null): ContributionActivitySummary {
  if (!remote) return local;
  const value = remote.summary;
  const activeDates = new Set([...remote.activeDates, ...local.entries.map(entry => dayKey(Date.parse(entry.at)))]);
  const entries = [...local.entries, ...value.entries].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const remoteWeeks = new Map(value.weeks.map(week => [week.start, week]));
  const weeks = local.weeks.map(week => ({ ...week, count: week.count + (remoteWeeks.get(week.start)?.count ?? 0) }));
  for (const week of value.weeks) if (!local.weeks.some(item => item.start === week.start)) weeks.push(week);
  return { ...local, total: local.total + value.total, previousTotal: local.previousTotal + value.previousTotal,
    delta: local.delta + value.delta, activeDays: activeDates.size, hatsReceived: local.hatsReceived,
    weeks: weeks.sort((a, b) => a.start.localeCompare(b.start)), entries };
}
