import { normalizeAccessPhone, type UserAccessUpdate, type UserAccessCreate, type UserPasswordReset, type UserAccessDelete, type PhoneChangeInput, type PhoneChangeReview } from '../../shared/access.ts';

export class ApiError extends Error {
  status: number;
  operationState?: 'failed' | 'pending';
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)) throw new ApiError(400, 'Enter a valid email.');
  return value.trim().toLowerCase();
}
export function password(value: unknown, newPassword = false): string {
  // Never trim, uppercase or otherwise change a password.
  if (typeof value !== 'string' || value.length < (newPassword ? 8 : 1) || Buffer.byteLength(value, 'utf8') > 72 ||
      (newPassword && (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)))) {
    throw new ApiError(400, newPassword ? 'Use at least 8 characters, including uppercase and lowercase letters and a number, and no more than 72 bytes.' : 'Enter your password.');
  }
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, 'Invalid user information.');
  return value.trim();
}
export function update(value: Record<string, unknown>): UserAccessUpdate {
  if (typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 ||
      !['isAdmin', 'isSpcTrader', 'isManager', 'isActive'].every(key => typeof value[key] === 'boolean')) throw new ApiError(400, 'Invalid user information.');
  const id = text(value.id, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, 'Invalid user information.');
  return { ...(Object.hasOwn(value, 'phone') ? {phone: contactPhone(value.phone)} : {}), id, expectedRevision: value.expectedRevision, displayName: text(value.displayName, 120), officeId: text(value.officeId, 80),
    isAdmin: value.isAdmin as boolean, isSpcTrader: value.isSpcTrader as boolean,
    isManager: value.isManager as boolean, isActive: value.isActive as boolean };
}

export function contactPhone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) throw new ApiError(400, 'Enter an international phone number beginning with +.');
  const normalized = normalizeAccessPhone(value);
  if (normalized !== '' && !/^\+[1-9][0-9]{6,14}$/.test(normalized)) throw new ApiError(400, 'Enter an international phone number beginning with +.');
  return normalized;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, 'Invalid request.');
  return value.toLowerCase();
}
export function phoneChange(value: Record<string, unknown>): PhoneChangeInput {
  if (Object.keys(value).some(key => !['requestId', 'phone'].includes(key))) throw new ApiError(400, 'Invalid request.');
  const phone = contactPhone(value.phone);
  if (!phone) throw new ApiError(400, 'Enter an international phone number beginning with +.');
  return { requestId: uuid(value.requestId), phone };
}
export function phoneChangeReview(value: Record<string, unknown>): PhoneChangeReview {
  if (Object.keys(value).some(key => !['id', 'decision'].includes(key)) || typeof value.decision !== 'string' || !['approve', 'decline'].includes(value.decision)) throw new ApiError(400, 'Invalid request.');
  return { id: uuid(value.id), decision: value.decision as 'approve' | 'decline' };
}
export function createUser(value: Record<string, unknown>): UserAccessCreate {
  if (!['isAdmin', 'isSpcTrader', 'isManager', 'isActive'].every(key => typeof value[key] === 'boolean')) throw new ApiError(400, 'Invalid user information.');
  return { requestId: uuid(value.requestId), email: email(value.email), displayName: text(value.displayName, 120),
    phone: contactPhone(value.phone ?? ''), officeId: text(value.officeId, 80),
    isAdmin: value.isAdmin as boolean, isSpcTrader: value.isSpcTrader as boolean,
    isManager: value.isManager as boolean, isActive: value.isActive as boolean,
    administratorPassword: password(value.administratorPassword) };
}
export function deleteUser(value: Record<string, unknown>): UserAccessDelete {
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new ApiError(400, 'Invalid user information.');
  return { requestId: uuid(value.requestId), id: uuid(value.id), expectedRevision: value.expectedRevision as number,
    administratorPassword: password(value.administratorPassword) };
}
export function resetPassword(value: Record<string, unknown>): UserPasswordReset {
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new ApiError(400, 'Invalid user information.');
  return { requestId: uuid(value.requestId), id: uuid(value.id), expectedRevision: value.expectedRevision as number,
    newPassword: password(value.newPassword, true), administratorPassword: password(value.administratorPassword) };
}
