import { isResourceId, type ResourceId } from './catalog';

export type Permission = 'none' | 'view' | 'edit';
export type Scope = 'own' | 'office' | 'all';
export interface Grant { permission: Permission; scope: Scope }

/** Loaded from trusted server storage, never from a browser persona or role claim. */
export interface Membership {
  id: string;
  issuer: string;
  subject: string;
  active: boolean;
  revision: number;
  officeId: string | null;
  administrator: boolean;
  grants: Partial<Record<ResourceId, Grant>>;
}

/** Fresh, server-verified identity state. Never a browser-supplied role claim. */
export interface IdentityState {
  issuer: string;
  subject: string;
  active: boolean;
  revision: number;
  credentialRevision: number;
  revokedBeforeMs: number;
  checkedAtMs: number;
}

/** A session already authenticated by the server's session adapter. Not a JWT payload. */
export interface ServerSession {
  membershipId: string;
  issuer: string;
  subject: string;
  membershipRevision: number;
  identityRevision: number;
  credentialRevision: number;
  authenticatedAtMs: number;
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}

export interface AccessContext {
  session: ServerSession | null;
  membership: Membership | null;
  identity: IdentityState | null;
  expectedIssuer: string;
  nowMs: number;
  maxIdentityAgeMs: number;
}

export interface AccessRequest {
  resource: string;
  action: 'view' | 'edit';
  /** Server-loaded ownership. Omit for global resources; scoped access then fails closed. */
  record?: { ownerMembershipId: string | null; officeId: string | null };
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'identity-unavailable' | 'session-invalid' | 'forbidden' };

function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function revision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Authorization only: this does not verify a cookie, OIDC token, signature or database state.
 * The API must resolve fresh trusted records before calling it, and enforce scoped list queries.
 * Membership changes must increment revision atomically with the change and audit event.
 */
export function decideAccess(context: AccessContext, request: AccessRequest): AccessDecision {
  const { session, membership, identity, nowMs, maxIdentityAgeMs, expectedIssuer } = context;
  if (!session) return { allowed: false, reason: 'unauthenticated' };
  if (!timestamp(nowMs) || !Number.isSafeInteger(maxIdentityAgeMs) || maxIdentityAgeMs < 0 || !expectedIssuer) {
    return { allowed: false, reason: 'session-invalid' };
  }
  if (!identity || !timestamp(identity.checkedAtMs) || identity.checkedAtMs > nowMs ||
      nowMs - identity.checkedAtMs > maxIdentityAgeMs) {
    return { allowed: false, reason: 'identity-unavailable' };
  }
  if (!membership || membership.active !== true || identity.active !== true ||
      !membership.id || !membership.subject ||
      session.membershipId !== membership.id ||
      session.issuer !== expectedIssuer || membership.issuer !== expectedIssuer || identity.issuer !== expectedIssuer ||
      session.subject !== membership.subject || identity.subject !== membership.subject ||
      !revision(membership.revision) || !revision(identity.revision) || !revision(identity.credentialRevision) ||
      session.membershipRevision !== membership.revision || session.identityRevision !== identity.revision ||
      session.credentialRevision !== identity.credentialRevision ||
      session.revokedAtMs !== null ||
      !timestamp(session.authenticatedAtMs) || !timestamp(session.issuedAtMs) || !timestamp(session.expiresAtMs) ||
      session.authenticatedAtMs > session.issuedAtMs || session.issuedAtMs > nowMs ||
      session.expiresAtMs <= session.issuedAtMs || session.expiresAtMs <= nowMs ||
      !timestamp(identity.revokedBeforeMs) || session.authenticatedAtMs <= identity.revokedBeforeMs) {
    return { allowed: false, reason: 'session-invalid' };
  }
  if (!isResourceId(request.resource) || (request.action !== 'view' && request.action !== 'edit')) {
    return { allowed: false, reason: 'forbidden' };
  }
  // Prototype properties cannot act as grants. Absence is always denial, including for admins.
  const grant = Object.hasOwn(membership.grants, request.resource) ? membership.grants[request.resource] : undefined;
  if (!grant || (grant.permission !== 'view' && grant.permission !== 'edit') ||
      (request.action === 'edit' && grant.permission !== 'edit') ||
      !['own', 'office', 'all'].includes(grant.scope)) {
    return { allowed: false, reason: 'forbidden' };
  }
  if (request.resource === 'user-management' && (membership.administrator !== true || grant.scope !== 'all')) {
    return { allowed: false, reason: 'forbidden' };
  }
  // Audit records are append-only server events, never edited through a page permission.
  if (request.resource === 'audit-log' && request.action === 'edit') return { allowed: false, reason: 'forbidden' };
  if (grant.scope === 'own' && (!request.record || request.record.ownerMembershipId !== membership.id)) {
    return { allowed: false, reason: 'forbidden' };
  }
  if (grant.scope === 'office' && (!membership.officeId || !request.record || request.record.officeId !== membership.officeId)) {
    return { allowed: false, reason: 'forbidden' };
  }
  return { allowed: true };
}
