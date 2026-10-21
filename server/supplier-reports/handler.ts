import type { AuthConfig } from '../auth/config.ts';
import type { AdministrationGateway } from '../admin/handler.ts';
import type { SupplierReportAccess } from '../../shared/supplierReports.ts';
import { ApiError } from '../auth/validation.ts';
import {ecoConnections} from '../../config/ecoConnections.ts';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function reportId(value: unknown): string { if(typeof value !== 'string' || !uuid.test(value)) throw new ApiError(400,'Invalid report.'); return value.toLowerCase(); }
export interface ReportStorage { sign(path: string, fileName: string): Promise<string> }
export async function handleSupplierReports(request: Request, config: AuthConfig, gateway: AdministrationGateway, storage: ReportStorage): Promise<Response> {
 const respond=(data:unknown,status=200)=>{ const headers=new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}); for(const cookie of gateway.cookies)headers.append('Set-Cookie',cookie);return new Response(JSON.stringify(data),{status,headers}); };
 try {
  const url=new URL(request.url);
  if(!['GET','POST'].includes(request.method))throw new ApiError(405,'Method not allowed.');
  const user=await gateway.currentUser();
  if(!user?.isActive)throw new ApiError(401,'Sign in required.');
  if(url.pathname==='/api/supplier-reports/list' && request.method==='GET') {
   if([...url.searchParams.keys()].some(k=>k!=='supplierId') || url.searchParams.getAll('supplierId').length!==1)throw new ApiError(400,'Invalid request.');
   return respond({items:await gateway.authenticatedRpc('eco_list_supplier_reports',{p_supplier_id:reportId(url.searchParams.get('supplierId'))})});
  }
  if(url.pathname==='/api/supplier-reports/download' && request.method==='POST') {
   const origin=request.headers.get('origin');
   if((origin!==config.origin && (!config.deploymentOrigin||origin!==config.deploymentOrigin))||request.headers.get('x-eco-request')!=='1'||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'Access denied.');
   if(url.search||request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new ApiError(400,'Invalid request.');
   const raw=await request.text();if(Buffer.byteLength(raw)>1024)throw new ApiError(413,'Request too large.');
   let value:unknown;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'Invalid request.');}
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='id')throw new ApiError(400,'Invalid request.');
   const item=await gateway.authenticatedRpc<SupplierReportAccess|null>('eco_supplier_report_access',{p_id:reportId((value as {id:unknown}).id)});
   if(!item)throw new ApiError(404,'Report not found.');
   if(item.id!==reportId((value as {id:unknown}).id)||item.objectPath!==`${reportId(item.supplierId)}/${reportId(item.id)}/${item.sha256}.pdf` || !/^[a-f0-9]{64}$/.test(item.sha256))throw new ApiError(503,'Report unavailable.');
   const signed=await storage.sign(item.objectPath,item.fileName);const signedUrl=new URL(signed);
   if(signedUrl.origin!==config.supabaseUrl||signedUrl.pathname!==`/storage/v1/object/sign/${ecoConnections.supplierReportsBucket}/${item.objectPath}`||!signedUrl.searchParams.get('token'))throw new ApiError(503,'Report unavailable.');
   return respond({url:signedUrl.toString(),expiresAt:new Date(Date.now()+60000).toISOString()});
  }
  return respond({message:'Not found.'},404);
 } catch(error) { return respond({message:error instanceof ApiError?error.message:'Report service unavailable.'},error instanceof ApiError?error.status:503); }
}
