import type { AdministrationGateway } from '../admin/handler.ts';
import type { AuthConfig } from '../auth/config.ts';
import { ApiError } from '../auth/validation.ts';
import { commercialMutation, commercialQuery } from './validation.ts';
import { fixtureMutation, fixtureQuery } from './fixtures.ts';

export async function handleCommercialEnquiries(request: Request, config: AuthConfig, gateway: AdministrationGateway): Promise<Response> {
  const respond = (data: unknown, status = 200) => {
    const headers = new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    for (const cookie of gateway.cookies) headers.append('Set-Cookie',cookie);
    return new Response(JSON.stringify(data),{status,headers});
  };
  try {
    if (!['GET','POST'].includes(request.method)) throw new ApiError(405,'Method not allowed.');
    const url = new URL(request.url);
    const fixtures = url.pathname === '/api/enquiries/fixtures';
    if (!fixtures && url.pathname !== '/api/enquiries/records') throw new ApiError(404,'Not found.');
    if (request.headers.get('x-eco-data-mode') !== 'live') throw new ApiError(403,'Switch to LIVE to use shared enquiries.');
    let input;
    if (request.method === 'POST') {
      if (url.search) throw new ApiError(400,'Invalid enquiry query.');
      const origin = request.headers.get('origin');
      if ((origin !== config.origin && origin !== config.deploymentOrigin) || request.headers.get('x-eco-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403,'Access denied.');
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415,'JSON required.');
      const raw = await request.text();
      if (Buffer.byteLength(raw,'utf8') > 131072) throw new ApiError(413,'Request too large.');
      try { input = JSON.parse(raw); } catch { throw new ApiError(400,'Invalid enquiry request.'); }
      input = fixtures ? fixtureMutation(input) : commercialMutation(input);
    }
    const query = request.method === 'GET' ? fixtures ? fixtureQuery(url) : commercialQuery(url) : null;
    const actor = await gateway.currentUser();
    if (!actor?.isActive || !actor.activated) throw new ApiError(401,'Sign in required.');
    if (await gateway.getPreview()) throw new ApiError(403,'Shared enquiries are unavailable in preview.');
    if (query && 'scope' in query && query.scope === 'singapore' && !actor.isAdmin && !actor.isSpcTrader) throw new ApiError(403,'Access denied.');
    if (fixtures) return respond(await gateway.authenticatedRpc(query ? 'eco_get_fixtures' : 'eco_mutate_fixture', query ? {p_query:query} : {p_input:input}));
    return respond(await gateway.authenticatedRpc(query ? 'eco_get_commercial_enquiries' : 'eco_mutate_commercial_enquiry', query ? {p_query:query} : {p_input:input}));
  } catch (error) {
    return respond({message:error instanceof ApiError ? error.message : 'Enquiry service unavailable.'},error instanceof ApiError ? error.status : 503);
  }
}
