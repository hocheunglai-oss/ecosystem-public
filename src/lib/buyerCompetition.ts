import { buyerSharedEntries } from './buyerSharedLists.ts';
import type { Contribution, DemoState } from './model.ts';

export const BUYER_COMPETITION_MAX_LENGTH = 10000;

export function validateBuyerCompetitionText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Competition is required.');
  if (value.length > BUYER_COMPETITION_MAX_LENGTH) throw new Error('Competition must be 10,000 characters or fewer.');
  return value.trim();
}

/** Comparison only: keep the trader's original spacing and line breaks in the saved entry. */
export function normalizedBuyerCompetition(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

/** Shared buyer-specific entries; group membership never broadens the target. */
export function buyerCompetitionEntries(state: Pick<DemoState, 'contributions' | 'buyerSharedLists'>, buyerId: string): Contribution[] {
  if (state.buyerSharedLists?.[JSON.stringify(['competition', buyerId])]) return buyerSharedEntries(state, 'competition', buyerId).map(entry => ({
    id: entry.id, targetType: 'buyer-competition', targetId: buyerId, title: 'Competition', body: entry.text,
    author: entry.updatedBy ?? entry.author, createdAt: entry.createdAt, publishedAt: entry.updatedAt ?? entry.createdAt, publication: 'direct', status: 'approved',
  }));
  const timestamp = (entry: Contribution) => {
    const time = Date.parse(entry.publishedAt ?? entry.createdAt);
    return Number.isFinite(time) ? time : 0;
  };
  return state.contributions.filter(entry => entry.targetType === 'buyer-competition' && entry.targetId === buyerId && entry.status === 'approved')
    .sort((a, b) => timestamp(b) - timestamp(a));
}
