import { createHmac } from 'node:crypto';
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { createClient, isAuthSessionMissingError } from '@supabase/supabase-js';
import type { AccessOffice, AccessUser, UserAccessUpdate, UserAccessCreate, UserPasswordReset, UserAccessDelete, RolePreview, PreviewInput, PhoneChangeRequest, PhoneChangeInput, PhoneChangeReview } from '../../shared/access.ts';
import type { AuthConfig } from './config.ts';
import { ApiError, password } from './validation.ts';

// Persistent across browser restarts, renewed on token refresh. Browsers may clear
// cookies sooner; provider/admin revocation always takes precedence over this lifetime.
const authCookieMaxAge = 400 * 24 * 60 * 60;

export interface AuthGateway {
  cookies: string[];
  currentUser(): Promise<AccessUser | null>;
  getPreview(): Promise<RolePreview | null>;
  previewOptions(): Promise<{ offices: AccessOffice[] }>;
  setPreview(input: PreviewInput | null): Promise<RolePreview | null>;
  consumeLoginAttempt(email: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  listUsers(): Promise<{ users: AccessUser[]; offices: AccessOffice[] }>;
  updateUser(input: UserAccessUpdate): Promise<AccessUser>;
  createUser(actor: AccessUser, input: UserAccessCreate): Promise<AccessUser>;
  resetUserPassword(actor: AccessUser, input: UserPasswordReset): Promise<AccessUser>;
  deleteUser(actor: AccessUser, input: UserAccessDelete): Promise<{deletedUserId: string}>;
  listPhoneRequests(): Promise<{requests: PhoneChangeRequest[]}>;
  requestPhoneChange(input: PhoneChangeInput): Promise<PhoneChangeRequest>;
  reviewPhoneChange(input: PhoneChangeReview): Promise<PhoneChangeRequest>;
  activate(tokenHash: string, password: string, type: 'invite' | 'recovery'): Promise<void>;
  dismissPasswordPrompt(): Promise<AccessUser>;
  changePassword(user: AccessUser, currentPassword: string, newPassword: string): Promise<AccessUser>;
}

export function createAuthGateway(request: Request, config: AuthConfig): AuthGateway & { authenticatedRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> } {
  const cookies: string[] = [];
  let originSessionId: string | undefined;
  const client = createServerClient(config.supabaseUrl, config.publishableKey, {
    cookieOptions: { name: 'eco-auth', path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: authCookieMaxAge },
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('cookie') ?? '').filter((cookie): cookie is { name: string; value: string } => typeof cookie.value === 'string'),
      setAll: values => { for (const cookie of values) cookies.push(serializeCookieHeader(cookie.name, cookie.value,
        { ...cookie.options, path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies,
          maxAge: cookie.options.maxAge === 0 || cookie.value === '' ? 0 : authCookieMaxAge })); },
    },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) },
  });
  const admin = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) } });
  // Password proof has its own short-lived provider session and never writes browser cookies.
  const proof = createClient(config.supabaseUrl, config.publishableKey, {auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15_000)})}});
  async function releaseProof(): Promise<void> {
    try {
      const {error}=await proof.auth.signOut({scope:'local'});
      if(error) console.warn('ECO temporary password proof cleanup failed', {code:error.code});
    } catch { console.warn('ECO temporary password proof cleanup unavailable'); }
  }
  async function rpc<T>(name: string, args?: Record<string, unknown>, useProof = false): Promise<T> {
    const { data, error } = await (useProof ? proof : client).rpc(name, args);
    if (error) {
      if (error.code === '28000') throw new ApiError(401, 'Sign in again.');
      if (error.code === '42501') throw new ApiError(403, 'Access denied.');
      if (error.code === 'PT409') throw new ApiError(409, name.includes('phone') ? 'This phone request changed or another request is pending. Refresh and try again.' : 'This user changed. Reload and try again.');
      if (error.code === '22023' && name.includes('phone')) throw new ApiError(400, 'Enter a different valid international phone number.');
      if (error.code === '22023' || error.code === '23505') throw new ApiError(400, 'Invalid or duplicate user information.');
      if (error.code === '23514') throw new ApiError(400, 'This change would remove administrator access.');
      console.error('ECO access RPC failed', { operation: name, code: error.code });
      throw new ApiError(503, 'Access service unavailable.');
    }
    return data as T;
  }
  async function adminRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(name, args);
    if (error) {
      if (error.code === '28000') throw new ApiError(401, 'Sign in again.');
      if (error.code === '42501') throw new ApiError(403, 'Access denied.');
      if (error.code === 'PT409') throw new ApiError(409, 'This request or user changed. Reload and try again.');
      if (error.code === '22023' || error.code === '23505') throw new ApiError(400, 'Invalid or duplicate user information.');
      if (error.code === '23514') throw new ApiError(400, 'This change would remove administrator access.');
      throw new ApiError(503, 'The account operation could not be confirmed. Retry the same request.');
    }
    return data as T;
  }
  async function getPreview(): Promise<RolePreview | null> {
    const state = await rpc<{preview: RolePreview | null; sessionId: string}>('eco_preview_state');
    if (typeof state.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(state.sessionId)) throw new ApiError(401, 'Sign in again.');
    originSessionId ??= state.sessionId;
    return state.preview;
  }
  async function incomingSession(): Promise<string> {
    if (!originSessionId) await getPreview();
    return originSessionId!;
  }
  async function reauthenticate(address: string, secret: string) {
    return proof.auth.signInWithPassword({email:address,password:secret});
  }
  async function verifyAdministrator(actor: AccessUser, administratorPassword: string): Promise<string> {
    const { data, error } = await reauthenticate(actor.email, administratorPassword);
    if (error) throw new ApiError(400, 'Your administrator password is incorrect.');
    if (!data.session || data.user?.id !== actor.id) throw new ApiError(401, 'Sign in again.');
    const member = await rpc<AccessUser>('eco_current_user', undefined, true);
    if (member.id !== actor.id || !member.isAdmin) throw new ApiError(403, 'Access denied.');
    // Claims are read only from the successful provider response; the SQL service RPC
    // independently verifies this identity and live session before each operation.
    const claims = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString('utf8'));
    if (claims.sub !== actor.id || typeof claims.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.session_id)) throw new ApiError(401, 'Sign in again.');
    return claims.session_id;
  }
  async function administratorOperation(actor: AccessUser, value: UserAccessCreate | UserPasswordReset, kind: 'create-user' | 'reset-password'): Promise<AccessUser> {
    // The agreed initial password is provisioned as a server secret, never bundled
    // into browser code or accepted as a caller override. Existing users are unchanged.
    let newPassword: string;
    if (kind === 'create-user') {
      try { newPassword = password(config.newUserPassword, true); }
      catch { throw new ApiError(503, 'New user provisioning is not configured.'); }
    } else newPassword = (value as UserPasswordReset).newPassword;
    const incomingId = await incomingSession();
    try {
    const sessionId = await verifyAdministrator(actor, value.administratorPassword);
    const { requestId } = value;
    const input = kind === 'create-user' ? (() => {
      const v = value as UserAccessCreate;
      return { email: v.email, displayName: v.displayName, phone: v.phone, officeId: v.officeId,
        isAdmin: v.isAdmin, isManager: v.isManager, isSpcTrader: v.isSpcTrader, isActive: v.isActive };
    })() : { id: (value as UserPasswordReset).id, expectedRevision: (value as UserPasswordReset).expectedRevision };
    // A server-keyed request digest binds retries to the same payload. Passwords and
    // their reusable hashes are never written to the operation ledger or audit log.
    const fingerprint = createHmac('sha256', config.rateLimitSecret).update(JSON.stringify([kind, input, newPassword])).digest('hex');
    const common = { p_actor_id: actor.id, p_session_id: sessionId, p_request_id: requestId };
    const operation = await adminRpc<{ state: string; targetId: string; runProvider: boolean; user?: AccessUser }>('eco_begin_admin_operation_v2',
      { ...common, p_kind: kind, p_input: input, p_fingerprint: fingerprint, p_origin_session_id: incomingId });
    if (operation.state === 'complete' && operation.user) return operation.user;
    if (operation.state === 'failed') {
      const failed = new ApiError(400, 'This account operation did not complete. Review the details and start a new request.');
      failed.operationState = 'failed';
      throw failed;
    }
    try {
    const marker = kind === 'create-user' ? 'eco_access_create_request' : 'eco_access_reset_request';
    let providerConfirmed = false;
    if (operation.runProvider) {
      const result = kind === 'create-user'
        ? await admin.auth.admin.createUser({ id: operation.targetId, email: (value as UserAccessCreate).email,
          password: newPassword, email_confirm: true, app_metadata: { [marker]: requestId } })
        : await admin.auth.admin.updateUserById(operation.targetId, { password: newPassword, app_metadata: { [marker]: requestId } });
      providerConfirmed = !result.error && result.data.user?.id === operation.targetId && result.data.user.app_metadata?.[marker] === requestId;
      // Only definite provider rejection permits a new request. Network errors and
      // server failures are ambiguous: leave the operation pending and the target
      // blocked until its exact provider marker can be reconciled. Never retry a reset.
      if (result.error && result.error.status && result.error.status >= 400 && result.error.status < 500 && result.error.status !== 408 && result.error.status !== 409) {
        await adminRpc('eco_fail_admin_operation', common);
        const rejected = new ApiError(400, kind === 'create-user' ? 'User could not be added. Check the email and password requirements.' : 'Password could not be reset. Check the password requirements.');
        rejected.operationState = 'failed';
        throw rejected;
      }
    }
    if (!providerConfirmed) {
      const { data, error } = await admin.auth.admin.getUserById(operation.targetId);
      providerConfirmed = !error && data.user?.id === operation.targetId && data.user.app_metadata?.[marker] === requestId;
    }
    if (!providerConfirmed) throw new ApiError(503, 'The account operation is not confirmed. Retry the same request; if it remains pending, contact an administrator.');
    return await adminRpc<AccessUser>('eco_complete_admin_operation', common);
    } catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError(503, 'The account operation could not be confirmed. Retry the same request.');
      if (safe.operationState !== 'failed') safe.operationState = 'pending';
      throw safe;
    }
    } finally { await releaseProof(); }
  }
  async function finishOwnProviderChange(userId: string, address: string, requestId: string, newPassword: string): Promise<AccessUser> {
    // Supabase Admin password updates revoke ALL provider sessions. Establish a fresh
    // password-authenticated session, then release the original operation's fence.
    const { data, error } = await client.auth.signInWithPassword({ email: address, password: newPassword });
    if (error || !data.session || data.user?.id !== userId) throw new ApiError(503, 'Password changed, but sign-in could not be restored. Contact an administrator.');
    const claims = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString('utf8'));
    if (claims.sub !== userId || typeof claims.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.session_id)) throw new ApiError(503, 'Password changed, but sign-in could not be restored. Contact an administrator.');
    return adminRpc<AccessUser>('eco_complete_password_change_v2', {p_user_id:userId,p_request_id:requestId,p_session_id:claims.session_id});
  }
  return {
    async authenticatedRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(name, args);
      if (error) {
        if (error.code === '28000') throw new ApiError(401, 'Sign in again.');
        if (error.code === '42501') throw new ApiError(403, 'Access denied.');
        if (error.code === 'PT404') throw new ApiError(404, 'Record not found.');
        if (error.code === 'PT409') throw new ApiError(409, 'This record or request changed. Refresh and try again.');
        if (error.code === 'PT429') throw new ApiError(429, 'Too many requests. Try again shortly.');
        if (error.code === 'PT422' && ['eco_create_supplier','eco_update_supplier'].includes(name)) throw new ApiError(422, 'Select an active SPC trader.');
        if (['22023','22P02','22007','22008','23505','23514'].includes(error.code)) throw new ApiError(400, 'Invalid administration request.');
        console.error('ECO administration RPC failed', {operation:name,code:error.code});
        throw new ApiError(503, 'Administration service unavailable.');
      }
      return data as T;
    },
    cookies,
    getPreview,
    previewOptions: () => rpc('eco_preview_options'),
    setPreview: input => rpc('eco_set_preview', {p_role: input?.role ?? null, p_office_id: input?.officeId ?? null}),
    async currentUser() {
      const { data, error } = await client.auth.getUser();
      if (error) {
        // A provider outage is not a revoked session. Returning null here would
        // turn a temporary network/refresh failure into an application 401.
        const invalidSession = isAuthSessionMissingError(error) || [401, 403].includes(error.status ?? 0)
          || ['bad_jwt', 'session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'user_not_found', 'user_banned'].includes(error.code ?? '');
        if (invalidSession) return null;
        // The SDK can discard a cookie after a non-retryable refresh response
        // such as rate limiting. Keep the browser's refresh credential for a
        // later attempt unless the provider actually rejected the session.
        if (cookies.every(cookie => /(?:^|;\s*)Max-Age=0(?:;|$)/i.test(cookie))) cookies.length = 0;
        throw new ApiError(503, 'Session check unavailable. Try again.');
      }
      if (!data.user) return null;
      // This RPC additionally checks the live provider session, active membership and revocations.
      try { return await rpc<AccessUser>('eco_current_user'); }
      catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
    },
    async consumeLoginAttempt(email) {
      const bucket = createHmac('sha256', config.rateLimitSecret).update(email).digest('hex');
      const { data, error } = await admin.rpc('eco_consume_login_attempt', { p_bucket: bucket });
      if (error) throw new ApiError(503, 'Sign-in service unavailable.');
      if (data !== true) throw new ApiError(429, 'Too many attempts. Try again later.');
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        console.warn('ECO password sign-in rejected', { code: error.code });
        throw new ApiError(401, 'Email or password is incorrect.');
      }
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw new ApiError(503, 'Sign-out could not be confirmed. Try again.');
    },
    listUsers: () => rpc('eco_list_users'),
    listPhoneRequests: () => rpc('eco_list_phone_requests'),
    requestPhoneChange: input => rpc('eco_request_phone_change', {p_request_id: input.requestId, p_phone: input.phone}),
    reviewPhoneChange: input => rpc('eco_review_phone_change', {p_request_id: input.id, p_decision: input.decision}),
    updateUser: input => rpc('eco_update_user', { p_update: input }),
    createUser: (actor, input) => administratorOperation(actor, input, 'create-user'),
    resetUserPassword: (actor, input) => administratorOperation(actor, input, 'reset-password'),
    async deleteUser(actor, input) {
      const incomingId = await incomingSession();
      try {
        const sessionId = await verifyAdministrator(actor, input.administratorPassword);
        try {
          return await adminRpc<{deletedUserId: string}>('eco_delete_user', {
            p_actor_id: actor.id, p_session_id: sessionId, p_origin_session_id: incomingId,
            p_request_id: input.requestId, p_target_id: input.id, p_expected_revision: input.expectedRevision,
          });
        } catch (error) {
          // One SQL transaction commits deletion, audit, and revocation together.
          // An uncertain network response can safely replay this exact request ID.
          const safe = error instanceof ApiError ? error : new ApiError(503, 'The account operation could not be confirmed. Retry the same request.');
          if (safe.status >= 500) safe.operationState = 'pending';
          throw safe;
        }
      } finally { await releaseProof(); }
    },
    dismissPasswordPrompt: () => rpc('eco_dismiss_password_prompt'),
    async changePassword(user, currentPassword, newPassword) {
      const incomingId = await incomingSession();
      try {
      // Reauthenticate against the provider with the account taken from verified membership,
      // never an email or ID supplied by the form. A fresh session also satisfies secure password change.
      const { data, error } = await reauthenticate(user.email, currentPassword);
      if (error) throw new ApiError(400, 'Current password is incorrect.');
      if (!data.session || data.user?.id !== user.id) throw new ApiError(401, 'Sign in again.');
      const member = await rpc<AccessUser>('eco_current_user', undefined, true);
      if (member.id !== user.id) throw new ApiError(401, 'Sign in again.');
      // This token is the direct authenticated provider response, not unverified request input.
      const claims = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString('utf8'));
      if (claims.sub !== user.id || typeof claims.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.session_id)) {
        throw new ApiError(401, 'Sign in again.');
      }
      // Commit revocations before changing the provider credential. If finalization later
      // fails, previously issued app sessions remain blocked instead of being revived.
      const { error: beginError } = await admin.rpc('eco_begin_password_change_v3', { p_user_id: user.id, p_session_id: claims.session_id, p_origin_session_id: incomingId });
      if (beginError) throw new ApiError(beginError.code === '28000' ? 401 : beginError.code === '42501' ? 403 : beginError.code === 'PT409' ? 409 : 503, 'Password change could not start. Sign in again.');
      const { error: updateError } = await admin.auth.admin.updateUserById(user.id, { password: newPassword,
        app_metadata: { eco_access_change_request: claims.session_id } });
      if (updateError) {
        if (updateError.status && updateError.status >= 400 && updateError.status < 500 && ![408,409].includes(updateError.status)) {
          await adminRpc('eco_fail_password_change', { p_user_id: user.id, p_session_id: claims.session_id });
          throw new ApiError(400, 'Password could not be changed. Check the password requirements and try again.');
        }
        const { data: outcome } = await admin.auth.admin.getUserById(user.id);
        if (outcome.user?.app_metadata?.eco_access_change_request !== claims.session_id) throw new ApiError(503, 'Password change is pending confirmation. Contact an administrator before trying again.');
      }
      // Server-only finalization prevents clients from forging a successful password-change audit.
      // App revocations close the JWT validity window even before provider refresh sessions are removed.
      const changed = await finishOwnProviderChange(user.id, user.email, claims.session_id, newPassword);
      const { error: revokeError } = await client.auth.signOut({ scope: 'others' });
      if (revokeError) throw new ApiError(503, 'Password changed. Other ECO sessions are blocked; sign in again.');
      return changed as AccessUser;
      } finally { await releaseProof(); }
    },
    async activate(token_hash, password, type) {
      const { data, error } = await client.auth.verifyOtp({ token_hash, type });
      if (error || !data.session || !data.user) throw new ApiError(401, 'This activation link is invalid or expired.');
      const claims = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString('utf8'));
      if (claims.sub !== data.user.id || typeof claims.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.session_id)) throw new ApiError(401, 'This activation link is invalid or expired.');
      const common = { p_user_id: data.user.id, p_session_id: claims.session_id };
      await adminRpc('eco_begin_password_activation', common);
      const { error: updateError } = await admin.auth.admin.updateUserById(data.user.id, { password,
        app_metadata: { eco_access_change_request: claims.session_id } });
      if (updateError) {
        if (updateError.status && updateError.status >= 400 && updateError.status < 500 && ![408,409].includes(updateError.status)) {
          await adminRpc('eco_fail_password_change', common);
          throw new ApiError(400, 'Password could not be set. Check the password requirements or request a new link.');
        }
        const { data: outcome } = await admin.auth.admin.getUserById(data.user.id);
        if (outcome.user?.app_metadata?.eco_access_change_request !== claims.session_id) throw new ApiError(503, 'Password activation is pending confirmation. Contact an administrator.');
      }
      if (!data.user.email) throw new ApiError(503, 'Password activated, but account sign-in could not be restored. Contact an administrator.');
      await finishOwnProviderChange(data.user.id, data.user.email, claims.session_id, password);
    },
  };
}
