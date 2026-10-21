import { projectPreviewUser, previewRoles } from '../../shared/rolePreview.ts';
import type { PreviewRole } from '../../shared/access.ts';
import type { AuthConfig } from './config.ts';
import type { AuthGateway } from './gateway.ts';
import { accountPrivacyNotice } from './privacy.ts';
import { ApiError, email, password, update, createUser, resetPassword, deleteUser, phoneChange, phoneChangeReview } from './validation.ts';

export async function handleAuth(request: Request, config: AuthConfig, gateway: AuthGateway): Promise<Response> {
  function response(data: unknown, status = 200) {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0',
      'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    for (const cookie of gateway.cookies) headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify(data), { status, headers });
  }
  try {
    const path = new URL(request.url).pathname;
    if (!['GET', 'POST'].includes(request.method)) return response({ message: 'Method not allowed.' }, 405);
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      const requestOrigin = request.headers.get('origin');
      if ((requestOrigin !== config.origin && (!config.deploymentOrigin || requestOrigin !== config.deploymentOrigin)) || request.headers.get('x-eco-request') !== '1' ||
          request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'Access denied.');
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON required.');
      const raw = await request.text();
      if (Buffer.byteLength(raw, 'utf8') > 8192) throw new ApiError(413, 'Request too large.');
      try { body = JSON.parse(raw); } catch { throw new ApiError(400, 'Invalid request.'); }
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError(400, 'Invalid request.');
    }
    // Read incoming identity/preview before any route can replace its cookie.
    const replacingSession = path === '/api/access/login' || path === '/api/access/activate';
    const incoming = replacingSession && !request.headers.get('cookie') ? null : await gateway.currentUser();
    const preview = incoming ? await gateway.getPreview() : null;
    if (preview && request.method === 'POST' && !['/api/access/preview', '/api/access/preview/end', '/api/access/logout'].includes(path)) {
      throw new ApiError(403, 'Preview is read only.');
    }
    if (path === '/api/access/login' && request.method === 'POST') {
      if (incoming) throw new ApiError(409, 'Sign out before signing in to another account.');
      const address = email(body.email), secret = password(body.password);
      await gateway.consumeLoginAttempt(address);
      await gateway.signIn(address, secret);
      const user = await gateway.currentUser();
      if (!user) { await gateway.signOut(); throw new ApiError(401, 'Email or password is incorrect.'); }
      return response({ user });
    }
    if (path === '/api/access/activate' && request.method === 'POST') {
      if (incoming) throw new ApiError(409, 'Sign out before using an activation link.');
      if (typeof body.tokenHash !== 'string' || !/^[a-f0-9]{32,256}$/i.test(body.tokenHash) || !['invite', 'recovery'].includes(String(body.type))) throw new ApiError(400, 'Invalid activation link.');
      await gateway.activate(body.tokenHash, password(body.password, true), body.type as 'invite' | 'recovery');
      const user = await gateway.currentUser();
      if (!user) throw new ApiError(401, 'Account access is not enabled.');
      return response({ user });
    }
    const user = incoming;
    if (path === '/api/access/session' && request.method === 'GET') return response(user ? { user, effectiveUser: projectPreviewUser(user, preview), preview } : {user:null}, user ? 200 : 401);
    if (path === '/api/access/logout' && request.method === 'POST') {
      await gateway.signOut(); return response({ user: null });
    }
    if (!user) throw new ApiError(401, 'Sign in required.');
    if (path === '/api/access/privacy' && request.method === 'GET') return response(accountPrivacyNotice);
    if (path === '/api/access/preview/end' && request.method === 'POST') {
      await gateway.setPreview(null);
      return response({user, effectiveUser:user, preview:null});
    }
    if (path === '/api/access/preview/options' && request.method === 'GET') {
      if (!user.isAdmin) throw new ApiError(403, 'Access denied.');
      return response(await gateway.previewOptions());
    }
    if (path === '/api/access/preview' && request.method === 'POST') {
      if (!user.isAdmin) throw new ApiError(403, 'Access denied.');
      if (!previewRoles.includes(body.role as PreviewRole) || typeof body.officeId !== 'string' || !body.officeId || body.officeId.length>80 ||
          Object.keys(body).some(key => !['role','officeId'].includes(key)) || (body.role==='credit' && body.officeId!=='CREDIT')) throw new ApiError(400,'Invalid preview.');
      const next = await gateway.setPreview({role:body.role as PreviewRole, officeId:body.officeId});
      return response({user, effectiveUser:projectPreviewUser(user,next), preview:next});
    }
    if (path === '/api/access/password-prompt' && request.method === 'POST') {
      await gateway.dismissPasswordPrompt();
      const refreshed = await gateway.currentUser();
      if (!refreshed || refreshed.id !== user.id) throw new ApiError(401, 'Sign in required.');
      return response({ user: refreshed });
    }
    if (path === '/api/access/password' && request.method === 'POST') {
      const currentPassword = password(body.currentPassword), newPassword = password(body.newPassword, true);
      if (currentPassword === newPassword) throw new ApiError(400, 'Choose a different password.');
      await gateway.consumeLoginAttempt(user.email);
      await gateway.changePassword(user, currentPassword, newPassword);
      const refreshed = await gateway.currentUser();
      if (!refreshed || refreshed.id !== user.id) throw new ApiError(401, 'Sign in required.');
      return response({ user: refreshed });
    }
    if (path === '/api/access/phone-requests' && request.method === 'GET') return response(await gateway.listPhoneRequests());
    if (path === '/api/access/phone-requests' && request.method === 'POST') {
      return response({ request: await gateway.requestPhoneChange(phoneChange(body)) });
    }
    if (!projectPreviewUser(user,preview).isAdmin) throw new ApiError(403, 'Access denied.');
    if (path === '/api/access/phone-requests/review' && request.method === 'POST') {
      return response({ request: await gateway.reviewPhoneChange(phoneChangeReview(body)) });
    }
    if (path === '/api/access/users/create' && request.method === 'POST') {
      const input = createUser(body);
      await gateway.consumeLoginAttempt(user.email);
      return response({ user: await gateway.createUser(user, input) });
    }
    if (path === '/api/access/users/reset-password' && request.method === 'POST') {
      const input = resetPassword(body);
      if (input.id === user.id) throw new ApiError(400, 'Use Change Password for your own account.');
      await gateway.consumeLoginAttempt(user.email);
      return response({ user: await gateway.resetUserPassword(user, input) });
    }
    if (path === '/api/access/users/delete' && request.method === 'POST') {
      const input = deleteUser(body);
      if (input.id === user.id) throw new ApiError(400, 'You cannot delete your own account.');
      await gateway.consumeLoginAttempt(user.email);
      return response(await gateway.deleteUser(user, input));
    }
    if (path === '/api/access/users' && request.method === 'GET') return response(await gateway.listUsers());
    if (path === '/api/access/users' && request.method === 'POST') return response({ user: await gateway.updateUser(update(body)) });
    return response({ message: 'Not found.' }, 404);
  } catch (error) {
    return response({ message: error instanceof ApiError ? error.message : 'Access service unavailable.',
      ...(error instanceof ApiError && (error.operationState === 'failed' || error.operationState === 'pending') ? {operationState: error.operationState} : {}) }, error instanceof ApiError ? error.status : 503);
  }
}
