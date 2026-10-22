import type { Company, DemoState } from './model.ts';

export type BuyerSharedListKind = 'group' | 'team' | 'competition';
export interface BuyerSharedEntry {
  id: string; text: string; author: string; createdAt: string;
  updatedBy?: string; updatedAt?: string;
}
export interface BuyerSharedList { entries: BuyerSharedEntry[]; updatedBy: string; updatedAt: string }
export interface BuyerSharedDraftEntry { id: string; text: string }
export const buyerSharedListKey = (kind: BuyerSharedListKind, targetId: string) => JSON.stringify([kind, targetId]);

export function buyerSharedEntries(state: Pick<DemoState, 'contributions' | 'buyerSharedLists'>, kind: BuyerSharedListKind, targetId: string): BuyerSharedEntry[] {
  const saved = state.buyerSharedLists?.[buyerSharedListKey(kind, targetId)];
  if (saved) return saved.entries;
  return state.contributions.filter(entry => entry.targetType === (kind === 'group' ? 'buyer-group' : kind === 'team' ? 'buyer-team' : 'buyer-competition') && entry.targetId === targetId && entry.status === 'approved')
    .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))
    .map(entry => ({ id: entry.id, text: entry.body, author: entry.author, createdAt: entry.publishedAt ?? entry.createdAt }));
}

export const buyerSharedDraft = (entries: BuyerSharedDraftEntry[]) => entries.map(({ id, text }) => ({ id, text }));
export const sameBuyerSharedDraft = (a: BuyerSharedDraftEntry[], b: BuyerSharedDraftEntry[]) => JSON.stringify(buyerSharedDraft(a)) === JSON.stringify(buyerSharedDraft(b));

/** Existing customer-group notes remain visible until this buyer's team list is first saved. */
export function buyerTeamEntries(state: DemoState, buyer: Company): BuyerSharedEntry[] {
  if (state.buyerSharedLists?.[buyerSharedListKey('team', buyer.id)]) return buyerSharedEntries(state, 'team', buyer.id);
  const current = buyerSharedEntries(state, 'team', buyer.id);
  if (current.length) return current;
  return buyerSharedEntries(state, 'group', buyer.accountGroupId?.trim() || buyer.id);
}

/** Read only the current owner's list, including an existing single-note record. */
export function buyerPrivateEntries(state: DemoState, buyerId: string, owner: string): BuyerSharedEntry[] {
  const note = state.buyerPrivateRemarks?.[JSON.stringify([owner, buyerId])];
  if (!note || note.owner !== owner || note.buyerId !== buyerId) return [];
  return note.entries ?? (note.text ? [{ id: `private:${owner}:${buyerId}`, text: note.text, author: owner, createdAt: note.updatedAt }] : []);
}
