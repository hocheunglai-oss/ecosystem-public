import type { AccessUser, RolePreview } from './access.ts';

export const ECO_2_RELEASE_NOTICE = 'UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0';

/** Release availability is separate from permissions. It never grants any writes. */
export function canUseBuyerCredit(user: Pick<AccessUser, 'isAdmin' | 'isActive' | 'activated'> | null | undefined, preview: RolePreview | null = null): boolean {
  return Boolean(user?.isAdmin && user.isActive && user.activated && (!preview || preview.role === 'admin'));
}

export function isBuyerCreditWorkspace(id: string): boolean {
  return id === 'counterparties' || id === 'credit-request';
}

export function isBuyerKnowledgeTarget(kind: string): boolean {
  return ['buyer', 'company', 'buyer-group', 'buyer-team', 'buyer-competition'].includes(kind);
}

export function isBuyerCreditModal(spec: { type: string; targetType?: string }): boolean {
  return ['credit', 'decision', 'company'].includes(spec.type) || spec.type === 'contribute' && isBuyerKnowledgeTarget(spec.targetType ?? '');
}
