import type { IncomingMessage, ServerResponse } from 'node:http';
import { authConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { handleAdministration, type AdministrationServices } from './handler.ts';
import { collectSystemHealth, monitoringEvidence } from './health.ts';
import { getSystemInformation } from './system.ts';
import type { DatabaseHealthEvidence, MonitorEvidenceRecord } from '../../shared/system.ts';
export async function serveAdministration(req: IncomingMessage & {body?: unknown},res: ServerResponse,environment=process.env,services?: AdministrationServices) {
  res.setHeader('Cache-Control','private, no-store'); res.setHeader('Content-Type','application/json'); res.setHeader('X-Content-Type-Options','nosniff');
  try {
    const config = authConfig(environment), headers = new Headers();
    for(const [key,value] of Object.entries(req.headers)) if(value) headers.set(key,Array.isArray(value)?value.join(', '):value);
    let body: string | undefined;
    if(req.method !== 'GET' && req.method !== 'HEAD') {
      if(req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else { const chunks: Buffer[] = []; let size=0; for await (const chunk of req) { const b=Buffer.from(chunk);size+=b.length;if(size>32768){res.statusCode=413;res.end(JSON.stringify({message:'Request too large.'}));return;}chunks.push(b); } body=Buffer.concat(chunks).toString('utf8'); }
      if(Buffer.byteLength(body ?? '', 'utf8')>32768){res.statusCode=413;res.end(JSON.stringify({message:'Request too large.'}));return;}
    }
    const request = new Request(new URL(req.url ?? '/',config.origin),{method:req.method,headers,body});
    const response = await handleAdministration(request,config,createAuthGateway(request,config),services ?? {
      health: gateway => collectSystemHealth(() => gateway.authenticatedRpc<DatabaseHealthEvidence>('eco_admin_health'),
        async () => monitoringEvidence((await gateway.authenticatedRpc<{items:MonitorEvidenceRecord[]}>('eco_admin_evidence')).items),
        () => gateway.authenticatedRpc('eco_inbox_health')),
      system: async () => getSystemInformation(environment),
    });
    res.statusCode=response.status;response.headers.forEach((v,k)=>{if(k!=='set-cookie')res.setHeader(k,v);});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.end(await response.text());
  } catch {res.statusCode=503;res.end(JSON.stringify({message:'Administration service unavailable.'}));}
}
