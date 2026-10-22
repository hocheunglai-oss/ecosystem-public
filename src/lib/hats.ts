import { canonicalTarget, knowledgeDocument, knowledgeEntryUpdateLookup, knowledgeKeyInfoUpdate, type KnowledgeEntryUpdate, type KnowledgeTarget } from './knowledge.ts';
import { intelligenceFields, type IntelligenceKeyInfo } from './intelligenceFields.ts';
import { actors, type DemoState } from './model.ts';

/** A stable entry identity: changing its author or content never creates another vote slot. */
export type HatTarget =
  | { kind: 'knowledge'; target: KnowledgeTarget; blockId: string; rowId?: string }
  | { kind: 'key-info'; portId: string; field: keyof IntelligenceKeyInfo };

export interface HatAward {
  id: string;
  target: HatTarget;
  targetKey: string;
  readerId: string;
  recipientId: string;
  awardedAt: string;
  /** Immutable attribution of the contribution originally endorsed. */
  update: KnowledgeEntryUpdate;
  documentVersion?: number;
  /** Undo retains the original award, so editing cannot transfer or multiply it. */
  undoneAt?: string;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 2048;
}

function knownContributor(state: Pick<DemoState, 'profiles'>, actorId: string): boolean {
  return actors.some(actor => actor.id === actorId) || Object.hasOwn(state.profiles ?? {}, actorId);
}

function canonicalHatTarget(state: DemoState, target: HatTarget): HatTarget {
  if (!target || typeof target !== 'object') throw new Error('Select valid information for Hats Off.');
  if (target.kind === 'key-info' && identifier(target.portId) && intelligenceFields.some(field => field.key === target.field)) {
    return { kind: 'key-info', portId: target.portId, field: target.field };
  }
  if (target.kind === 'knowledge' && target.target && ['country', 'area', 'port', 'company', 'supplier'].includes(target.target.kind)
    && identifier(target.target.id) && identifier(target.blockId) && (target.rowId === undefined || identifier(target.rowId))) {
    return { kind: 'knowledge', target: canonicalTarget(state, target.target), blockId: target.blockId,
      ...(target.rowId === undefined ? {} : { rowId: target.rowId }) };
  }
  throw new Error('Select valid information for Hats Off.');
}

export function hatTargetKey(state: DemoState, input: HatTarget): string {
  const target = canonicalHatTarget(state, input);
  return JSON.stringify(target.kind === 'key-info'
    ? ['key-info', target.portId, target.field]
    : ['knowledge', target.target.kind, target.target.id, target.blockId, target.rowId ?? null]);
}

function currentEntry(state: DemoState, target: HatTarget): { update: KnowledgeEntryUpdate; documentVersion?: number } | undefined {
  let update: KnowledgeEntryUpdate | undefined;
  let documentVersion: number | undefined;
  if (target.kind === 'key-info') {
    const port = state.ports.find(port => port.id === target.portId);
    if (!port || port.intelligenceKeyInfo?.[target.field] == null) return undefined;
    update = knowledgeKeyInfoUpdate(state, target.portId, target.field);
  } else {
    const document = knowledgeDocument(state, target.target);
    const block = document.sections.flatMap(section => section.blocks).find(block => block.id === target.blockId);
    if (!block || (target.rowId !== undefined && (block.type !== 'table' || !block.rows.some(row => row.id === target.rowId)))) return undefined;
    update = knowledgeEntryUpdateLookup(state, target.target, document)(target.blockId, target.rowId);
    documentVersion = document.version;
  }
  if (!update || !knownContributor(state, update.updatedBy)) return undefined;
  return { update, ...(documentVersion === undefined ? {} : { documentVersion }) };
}

/** Unknown legacy authors are not guessed, and deleted information cannot earn new Hats. */
export function hatRecipient(state: DemoState, target: HatTarget): KnowledgeEntryUpdate | undefined {
  try { return currentEntry(state, canonicalHatTarget(state, target))?.update; }
  catch { return undefined; }
}

export function hatForEntry(state: DemoState, target: HatTarget, readerId: string): HatAward | undefined {
  const key = hatTargetKey(state, target);
  return awardIndex(state).readers.get(readerId)?.get(key);
}

type AwardIndex = { readers: Map<string, Map<string, HatAward>>; active: HatAward[] };
const awardIndexes = new WeakMap<HatAward[], { profiles: DemoState['profiles']; index: AwardIndex }>();
const emptyAwards: HatAward[] = [];

/** Published state is immutable. Profile changes invalidate attribution eligibility without changing award history. */
function awardIndex(state: Pick<DemoState, 'hats' | 'profiles'>): AwardIndex {
  const hats = state.hats ?? emptyAwards;
  const cached = awardIndexes.get(hats);
  if (cached && cached.profiles === state.profiles) return cached.index;
  const readers = new Map<string, Map<string, HatAward>>(), active: HatAward[] = [];
  const knownActors = new Set([...actors.map(actor => actor.id), ...Object.keys(state.profiles ?? {})]);
  for (const hat of hats) {
    const entries = readers.get(hat.readerId) ?? new Map<string, HatAward>();
    // Retained undo records own their slot too; duplicate restored records never inflate counts.
    if (entries.has(hat.targetKey)) continue;
    entries.set(hat.targetKey, hat);
    readers.set(hat.readerId, entries);
    if (!hat.undoneAt && hat.readerId !== hat.recipientId && knownActors.has(hat.readerId) && knownActors.has(hat.recipientId)) active.push(hat);
  }
  const result = { readers, active };
  awardIndexes.set(hats, { profiles: state.profiles, index: result });
  return result;
}

export function hatCount(state: Pick<DemoState, 'hats' | 'profiles'>, recipientId: string): number {
  return awardIndex(state).active.filter(hat => hat.recipientId === recipientId).length;
}

/** Recent recognition uses the same eligible, deduplicated awards as the count and ranking. */
export function recentHatsReceived(state: Pick<DemoState, 'hats' | 'profiles'>, recipientId: string, limit = 5): HatAward[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5;
  return awardIndex(state).active
    .filter(hat => hat.recipientId === recipientId && Number.isFinite(Date.parse(hat.awardedAt)))
    .sort((a, b) => Date.parse(b.awardedAt) - Date.parse(a.awardedAt) || a.id.localeCompare(b.id, 'en'))
    .slice(0, count);
}

export function hatRanking(state: Pick<DemoState, 'hats' | 'profiles'>): { actorId: string; count: number; uniqueReaders: number }[] {
  const counts = new Map<string, { count: number; readers: Set<string> }>();
  for (const hat of awardIndex(state).active) {
    const entry = counts.get(hat.recipientId) ?? { count: 0, readers: new Set<string>() };
    entry.count++;
    entry.readers.add(hat.readerId);
    counts.set(hat.recipientId, entry);
  }
  return [...counts].map(([actorId, value]) => ({ actorId, count: value.count, uniqueReaders: value.readers.size }))
    .sort((a, b) => b.count - a.count || b.uniqueReaders - a.uniqueReaders || a.actorId.localeCompare(b.actorId, 'en'));
}

/** Mutates only applyAction's cloned state. Never changes Gold or contribution ownership. */
export function recordHat(state: DemoState, input: HatTarget, expectedUpdate: KnowledgeEntryUpdate, active: boolean,
  readerId: string, at: string, id: string): HatAward | undefined {
  if (typeof active !== 'boolean') throw new Error('Select a valid Hats Off action.');
  if (!knownContributor(state, readerId)) throw new Error('This user is not available for Hats Off.');
  const target = canonicalHatTarget(state, input), targetKey = hatTargetKey(state, target);
  const existing = state.hats?.find(hat => hat.readerId === readerId && hat.targetKey === targetKey);
  if (!active) {
    if (!existing || existing.undoneAt) return undefined;
    existing.undoneAt = at;
    return existing;
  }
  // Replayed clicks are harmless, even if the author subsequently changed.
  if (existing && !existing.undoneAt) return undefined;
  const current = currentEntry(state, target);
  if (!current) throw new Error('This information has no contributor available for Hats Off.');
  if (!expectedUpdate || current.update.updatedBy !== expectedUpdate.updatedBy || current.update.updatedAt !== expectedUpdate.updatedAt) {
    throw new Error('This information has changed. Refresh it before giving Hats Off.');
  }
  if (current.update.updatedBy === readerId) throw new Error('You cannot give yourself Hats Off.');
  if (existing) {
    if (existing.recipientId !== current.update.updatedBy) throw new Error('This entry already received your Hat. It cannot be transferred to another contributor.');
    delete existing.undoneAt;
    return existing;
  }
  const hat: HatAward = { id, target, targetKey, readerId, recipientId: current.update.updatedBy, awardedAt: at,
    update: { ...current.update }, ...(current.documentVersion === undefined ? {} : { documentVersion: current.documentVersion }) };
  state.hats ??= [];
  state.hats.push(hat);
  return hat;
}
