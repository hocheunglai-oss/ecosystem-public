import type { AuthConfig } from '../auth/config.ts';
import type { AdministrationGateway } from '../admin/handler.ts';
import { ApiError } from '../auth/validation.ts';
import { supplierDetailId, supplierListQuery, supplierUpdate, supplierCreate, supplierArchive } from './validation.ts';
export async function handleSuppliers(request:Request,config:AuthConfig,gateway:AdministrationGateway):Promise<Response>{
 const respond=(data:unknown,status=200)=>{const headers=new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});for(const cookie of gateway.cookies)headers.append('Set-Cookie',cookie);return new Response(JSON.stringify(data),{status,headers});};
 try{
  if(!['GET','POST'].includes(request.method))throw new ApiError(405,'Method not allowed.');
  const url=new URL(request.url);let body:unknown;
  if(request.method==='POST'){
   const origin=request.headers.get('origin');if((origin!==config.origin&&(!config.deploymentOrigin||origin!==config.deploymentOrigin))||request.headers.get('x-eco-request')!=='1'||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'Access denied.');
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new ApiError(415,'JSON required.');
   const raw=await request.text();if(Buffer.byteLength(raw)>262144)throw new ApiError(413,'Request too large.');try{body=JSON.parse(raw);}catch{throw new ApiError(400,'Invalid request.');}
  }
  const actor=await gateway.currentUser();if(!actor?.isActive)throw new ApiError(401,'Sign in required.');
  if(request.method==='POST'&&await gateway.getPreview())throw new ApiError(403,'Preview is read only.');
  if(url.pathname==='/api/suppliers/pic-options'&&request.method==='GET'){if(url.search)throw new ApiError(400,'Invalid request.');return respond(await gateway.authenticatedRpc('eco_supplier_pic_options'));}
  if(url.pathname==='/api/suppliers/list'&&request.method==='GET')return respond(await gateway.authenticatedRpc('eco_list_suppliers',{p_query:supplierListQuery(url)}));
  if(url.pathname==='/api/suppliers/detail'&&request.method==='GET'){const item=await gateway.authenticatedRpc('eco_supplier_detail',{p_id:supplierDetailId(url)});if(!item)throw new ApiError(404,'Supplier not found.');return respond({item});}
  const checkWrite=async(id:string)=>{if(actor.isAdmin||actor.isSpcTrader)return;const item=await gateway.authenticatedRpc('eco_supplier_detail',{p_id:id}) as {countryCode?:unknown}|null;if(!item)return; /* The DB validates missing/archived IDs and can replay a committed archive receipt. */ if(typeof item.countryCode!=='string'||!/^[A-Z]{2}$/.test(item.countryCode)||item.countryCode==='SG')throw new ApiError(403,'Access denied.');};
  if(url.pathname==='/api/suppliers/create'&&request.method==='POST'){if(url.search)throw new ApiError(400,'Invalid request.');const input=supplierCreate(body);if(input.countryCode==='SG'&&!actor.isAdmin&&!actor.isSpcTrader)throw new ApiError(403,'Access denied.');return respond({item:await gateway.authenticatedRpc('eco_create_supplier',{p_input:input})});}
  if(url.pathname==='/api/suppliers/archive'&&request.method==='POST'){if(url.search)throw new ApiError(400,'Invalid request.');const input=supplierArchive(body);await checkWrite(input.id);return respond(await gateway.authenticatedRpc('eco_archive_supplier',{p_input:input}));}
  if(url.pathname==='/api/suppliers/update'&&request.method==='POST'){if(url.search)throw new ApiError(400,'Invalid request.');const input=supplierUpdate(body);await checkWrite(input.id);return respond({item:await gateway.authenticatedRpc('eco_update_supplier',{p_input:input})});}
  return respond({message:'Not found.'},404);
 }catch(error){return respond({message:error instanceof ApiError?error.message:'Supplier service unavailable.'},error instanceof ApiError?error.status:503);}
}
