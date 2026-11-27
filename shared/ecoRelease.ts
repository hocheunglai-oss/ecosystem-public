import type { AccessUser, RolePreview } from './access.ts';

export const ECO_VERSION_LABEL = 'ECO 1.0';
export const ECO_2_RELEASE_NOTICE = 'COMING IN ECO 2.0';
export const ECO_STAGE_ONE_PORT_ID = 'port-singapore';

/** Release availability is separate from permissions. It never grants any writes. */
export function canUseBuyerCredit(user: AccessUser | null | undefined, preview: RolePreview | null = null, developerMode = false): boolean {
  return Boolean(developerMode && !preview && user?.isAdmin && user.isActive && user.activated && user.capabilities?.testWorkspace === true);
}

export function isBuyerCreditWorkspace(id: string): boolean {
  return id === 'counterparties' || id === 'credit-request';
}

export function isBuyerKnowledgeTarget(kind: string): boolean {
  return ['buyer', 'company', 'buyer-group', 'buyer-team', 'buyer-competition'].includes(kind);
}

export function isBuyerCreditModal(spec: { type: string }): boolean {
  return ['credit', 'decision', 'company'].includes(spec.type);
}
