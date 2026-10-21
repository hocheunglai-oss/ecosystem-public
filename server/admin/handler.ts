import { projectPreviewUser } from '../../shared/rolePreview.ts';
import type { AuthConfig } from '../auth/config.ts';
import type { AuthGateway } from '../auth/gateway.ts';
import { ApiError } from '../auth/validation.ts';
import { feedbackCreate, feedbackTriage, importBegin, importTransition, importRetry, listQuery } from './validation.ts';
export interface AdministrationGateway extends Pick<AuthGateway, 'cookies' | 'currentUser' | 'getPreview'> {
  authenticatedRpc<T>(name: string, args?: Record<string, unknown>): Promise<T>;
}
export interface AdministrationServices { health(gateway: AdministrationGateway): Promise<unknown>; system(gateway: AdministrationGateway): Promise<unknown> }
export async function handleAdministration(request: Request, config: AuthConfig, gateway: AdministrationGateway, services?: AdministrationServices): Promise<Response> {
  const respond = (data: unknown,status=200) => { const headers = new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}); for(const cookie of gateway.cookies) headers.append('Set-Cookie',cookie); return new Response(JSON.stringify(data),{status,headers}); };
  try {
    if (!['GET','POST'].includes(request.method)) throw new ApiError(405,'Method not allowed.');
    const url = new URL(request.url), path = url.pathname;
    let body: Record<string,unknown> = {};
    if(request.method === 'POST') {
      const origin = request.headers.get('origin');
      if((origin !== config.origin && (!config.deploymentOrigin || origin !== config.deploymentOrigin)) || request.headers.get('x-eco-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403,'Access denied.');
      if(request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415,'JSON required.');
      const raw = await request.text(); if(Buffer.byteLength(raw,'utf8') > 32768) throw new ApiError(413,'Request too large.');
      try {body = JSON.parse(raw);} catch {throw new ApiError(400,'Invalid request.');}
      if(!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400,'Invalid request.');
    }
    const user = await gateway.currentUser(); if(!user) throw new ApiError(401,'Sign in required.');
    const preview = await gateway.getPreview();
    if(preview && request.method === 'POST') throw new ApiError(403,'Preview is read only.');
    const isAdmin = projectPreviewUser(user,preview).isAdmin;
    const call = <T>(name: string, args?: Record<string,unknown>) => gateway.authenticatedRpc<T>(name,args);
    if(path === '/api/admin/feedback/contributions' && request.method === 'GET') {
      const period = url.searchParams.get('period') ?? '7d';
      if(!['7d','28d','month','all'].includes(period) || [...url.searchParams.keys()].some(k=>k!=='period')) throw new ApiError(400,'Invalid period.');
      return respond(await call('eco_feedback_contributions',{p_period:period}));
    }
    if(path === '/api/admin/feedback' && request.method === 'GET') return respond(await call('eco_list_feedback',{p_query:listQuery(url)}));
    if(path === '/api/admin/feedback' && request.method === 'POST') return respond({item:await call('eco_create_feedback',{p_input:feedbackCreate(body)})});
    if(path === '/api/admin/imports' && request.method === 'GET') return respond(await call('eco_list_imports',{p_query:listQuery(url)}));
    if(path === '/api/admin/imports/begin' && request.method === 'POST') return respond({item:await call('eco_begin_import',{p_input:importBegin(body)})});
    if(path === '/api/admin/imports/transition' && request.method === 'POST') return respond({item:await call('eco_transition_import',{p_input:importTransition(body)})});
    if(path === '/api/admin/imports/retry' && request.method === 'POST') return respond({item:await call('eco_retry_import',{p_input:importRetry(body)})});
    if(!isAdmin) throw new ApiError(403,'Access denied.');
    if(path === '/api/admin/feedback/triage' && request.method === 'POST') return respond({item:await call('eco_triage_feedback',{p_input:feedbackTriage(body)})});
    if(path === '/api/admin/audit' && request.method === 'GET') return respond(await call('eco_list_audit',{p_query:listQuery(url)}));
    if(['/api/admin/health','/api/admin/system-health'].includes(path) && request.method === 'GET' && services) return respond(await services.health(gateway));
    if(['/api/admin/system','/api/admin/system-information'].includes(path) && request.method === 'GET' && services) return respond(await services.system(gateway));
    return respond({message:'Not found.'},404);
  } catch(error) { return respond({message:error instanceof ApiError ? error.message : 'Administration service unavailable.'},error instanceof ApiError ? error.status : 503); }
}
