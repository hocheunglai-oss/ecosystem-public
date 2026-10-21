import type { InboxPage, InboxMutationResult } from '../../shared/inbox.ts';
import type { AdministrationGateway } from '../admin/handler.ts';
import type { AuthConfig } from '../auth/config.ts';
import { ApiError } from '../auth/validation.ts';
import { inboxMutation, inboxQuery } from './validation.ts';

export async function handleInbox(request: Request, config: AuthConfig, gateway: AdministrationGateway): Promise<Response> {
  const respond = (value: unknown, status = 200) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    for (const cookie of gateway.cookies) headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify(value), { status, headers });
  };
  try {
    if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
    const url = new URL(request.url);
    if (url.pathname !== '/api/enquiries/inbox') throw new ApiError(404, 'Not found.');
    if (request.headers.get('x-eco-data-mode') !== 'live') throw new ApiError(403, 'Switch to LIVE to use the shared inbox.');
    let input;
    if (request.method === 'POST') {
      if (url.search) throw new ApiError(400, 'Invalid inbox query.');
      const origin = request.headers.get('origin');
      if ((origin !== config.origin && (!config.deploymentOrigin || origin !== config.deploymentOrigin)) || request.headers.get('x-eco-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'Access denied.');
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON required.');
      const raw = await request.text();
      if (Buffer.byteLength(raw, 'utf8') > 4096) throw new ApiError(413, 'Request too large.');
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new ApiError(400, 'Invalid inbox request.'); }
      input = inboxMutation(body);
    }
    const query = request.method === 'GET' ? inboxQuery(url) : null;
    const user = await gateway.currentUser();
    if (!user?.isActive || !user.activated) throw new ApiError(401, 'Sign in required.');
    const preview = await gateway.getPreview();
    if (preview) {
      if (request.method === 'POST') throw new ApiError(403, 'Preview is read only.');
      return respond({ items: [], nextCursor: null, unreadCount: 0 } satisfies InboxPage);
    }
    return respond(request.method === 'GET'
      ? await gateway.authenticatedRpc<InboxPage>('eco_list_enquiry_inbox', { p_query: query })
      : await gateway.authenticatedRpc<InboxMutationResult>('eco_mutate_enquiry_inbox', { p_input: input }));
  } catch (error) {
    return respond({ message: error instanceof ApiError ? error.message : 'Inbox unavailable.' }, error instanceof ApiError ? error.status : 503);
  }
}
