export interface AccessUser {
  id: string;
  email: string;
  displayName: string;
  phone?: string;
  officeId: string;
  officeName: string;
  isAdmin: boolean;
  isSpcTrader: boolean;
  isManager: boolean;
  isActive: boolean;
  activated: boolean;
  passwordChangeSuggested: boolean;
  revision: number;
  /** Current-session capabilities returned by authenticated SQL; absent means denied. */
  capabilities?: { appearancePreview: boolean; testWorkspace: boolean };
}
export interface AccessOffice { id: string; name: string }
export interface UserAccessUpdate {
  id: string;
  expectedRevision: number;
  displayName: string;
  phone?: string;
  officeId: string;
  isAdmin: boolean;
  isSpcTrader: boolean;
  isManager: boolean;
  isActive: boolean;
}

export interface UserAccessCreate {
  requestId: string;
  email: string;
  displayName: string;
  phone: string;
  officeId: string;
  isAdmin: boolean;
  isManager: boolean;
  isSpcTrader: boolean;
  isActive: boolean;
  administratorPassword: string;
}
export interface UserAccessDelete {
  requestId: string;
  id: string;
  expectedRevision: number;
  administratorPassword: string;
}
/** Remove phone formatting only; letters, extra + signs and extensions still fail validation. */
export function normalizeAccessPhone(value: string): string {
  return value.trim().replace(/[\s().\p{Dash_Punctuation}]/gu, '');
}
export interface UserPasswordReset {
  requestId: string;
  id: string;
  expectedRevision: number;
  newPassword: string;
  administratorPassword: string;
}

export type PreviewRole = 'admin' | 'trader' | 'spc-trader' | 'manager' | 'credit';
export interface RolePreview { role: PreviewRole; officeId: string; officeName: string; readOnly: true }
export interface PreviewInput { role: PreviewRole; officeId: string }
export interface AccessSession { user: AccessUser; effectiveUser: AccessUser; preview: RolePreview | null }

export type PhoneChangeStatus = 'pending' | 'approved' | 'declined' | 'superseded';
export interface PhoneChangeRequest {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  officeName: string;
  currentPhone: string;
  requestedPhone: string;
  status: PhoneChangeStatus;
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}
export interface PhoneChangeInput { requestId: string; phone: string }
export interface PhoneChangeReview { id: string; decision: 'approve' | 'decline' }
