import type { AccessUser } from '../../shared/access';
import { canUseBuyerCredit, ECO_2_RELEASE_NOTICE, isBuyerKnowledgeTarget } from '../../shared/ecoRelease';
import type { Action, DemoState } from './model';

/** Gate unfinished local buyer/credit mutations before any record is changed. */
export function isBuyerCreditAction(action: Action, state: Pick<DemoState, 'contributions'>): boolean {
  switch (action.type) {
    case 'request-credit': case 'acknowledge-credit': case 'decide-credit': case 'add-company':
    case 'save-buyer-private-list': case 'save-buyer-private-remark': case 'save-buyer-shared-list':
    case 'add-buyer-competition': case 'save-buyer-credit-remarks': case 'set-active-credit-remark': case 'mark-credit-request-read':
      return true;
    case 'save-knowledge': case 'suggest-knowledge': return isBuyerKnowledgeTarget(action.change.target.kind);
    case 'manage-knowledge-tabs': case 'save-extracted-knowledge': return action.changes.some(change => isBuyerKnowledgeTarget(change.target.kind));
    case 'submit-contribution': return isBuyerKnowledgeTarget(action.targetType);
    case 'review-contribution': return isBuyerKnowledgeTarget(state.contributions.find(item => item.id === action.id)?.targetType ?? '');
    case 'set-hat': return action.target.kind === 'knowledge' && isBuyerKnowledgeTarget(action.target.target.kind);
    default: return false;
  }
}

export function assertReleaseActionAvailable(action: Action, state: Pick<DemoState, 'contributions'>, user: AccessUser | null | undefined): void {
  if (isBuyerCreditAction(action, state) && !canUseBuyerCredit(user)) throw new Error(ECO_2_RELEASE_NOTICE);
}
