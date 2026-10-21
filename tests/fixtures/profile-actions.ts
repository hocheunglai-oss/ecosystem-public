import type { Action, DemoState } from '../../src/lib/model';
import { buyerPrivateEntries, buyerSharedDraft, buyerSharedEntries } from '../../src/lib/buyerSharedLists';
let sequence = 0;
/** Exercise the same complete, revision-checked list payload as the current editor. */
export function competitionAction(state: DemoState, text: string, buyerId: string): Action {
  const baseEntries = buyerSharedDraft(buyerSharedEntries(state, 'competition', buyerId));
  return { type: 'save-buyer-shared-list', kind: 'competition', buyerId, baseEntries, entries: [{ id: `test-entry-${++sequence}`, text }, ...baseEntries] };
}
export function privateRemarkAction(state: DemoState, buyerId: string, owner: string, text: string): Action {
  const baseEntries = buyerSharedDraft(buyerPrivateEntries(state, buyerId, owner));
  return { type: 'save-buyer-private-list', buyerId, baseEntries, entries: text ? [{ id: baseEntries[0]?.id ?? `test-private-${++sequence}`, text }] : [] };
}
