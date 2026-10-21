import type {AuthConfig} from '../auth/config.ts';
import type {AdministrationGateway} from '../admin/handler.ts';
import {ApiError} from '../auth/validation.ts';
import {canUseBuyerCredit,ECO_2_RELEASE_NOTICE} from '../../shared/ecoRelease.ts';
import {profileTabsQuery,profileTabsSave,profileTabDelete,profileTabsReorder} from './validation.ts';
export async function handleProfileTabs(request:Request,config:AuthConfig,gateway:AdministrationGateway):Promise<Response>{
 const respond=(value:unknown,status=200)=>{const headers=new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});for(const cookie of gateway.cookies)headers.append('Set-Cookie',cookie);return new Response(JSON.stringify(value),{status,headers});};
 try{
  if(!['GET','POST'].includes(request.method))throw new ApiError(405,'Method not allowed.');
  const url=new URL(request.url),actor=await gateway.currentUser();if(!actor?.isActive)throw new ApiError(401,'Sign in required.');
  if(request.method==='GET'&&url.pathname==='/api/profile-tabs/list'){
   const target=profileTabsQuery(url);
   if(target.kind==='buyer'&&!canUseBuyerCredit(actor,await gateway.getPreview()))throw new ApiError(403,ECO_2_RELEASE_NOTICE);
   return respond(await gateway.authenticatedRpc('eco_list_profile_tabs',{p_target:target}));
  }
  if(request.method==='POST'){
   const origin=request.headers.get('origin');if((origin!==config.origin&&(!config.deploymentOrigin||origin!==config.deploymentOrigin))||request.headers.get('x-eco-request')!=='1'||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'Access denied.');
   if(await gateway.getPreview())throw new ApiError(403,'Preview is read only.');
   if(url.search)throw new ApiError(400,'Invalid request.');
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new ApiError(415,'JSON required.');
   const raw=await request.text();if(Buffer.byteLength(raw)>262144)throw new ApiError(413,'Request too large.');let body:unknown;try{body=JSON.parse(raw);}catch{throw new ApiError(400,'Invalid request.');}
   const parsers={'/api/profile-tabs/save':{parse:profileTabsSave,rpc:'eco_save_profile_tabs'},'/api/profile-tabs/delete':{parse:profileTabDelete,rpc:'eco_delete_profile_tab'},'/api/profile-tabs/reorder':{parse:profileTabsReorder,rpc:'eco_reorder_profile_tabs'}};
   const route=parsers[url.pathname as keyof typeof parsers];if(!route)return respond({message:'Not found.'},404);const input=route.parse(body);
   if(input.target.kind==='buyer'&&!canUseBuyerCredit(actor))throw new ApiError(403,ECO_2_RELEASE_NOTICE);
   if(input.visibility==='shared'&&input.target.kind==='supplier'&&!actor.isAdmin&&!actor.isSpcTrader){const item=await gateway.authenticatedRpc('eco_supplier_detail',{p_id:input.target.id}) as {countryCode?:unknown}|null;if(!item||typeof item.countryCode!=='string'||!/^[A-Z]{2}$/.test(item.countryCode)||item.countryCode==='SG')throw new ApiError(403,'Access denied.');}
   return respond(await gateway.authenticatedRpc(route.rpc,{p_input:input}));
  }
  return respond({message:'Not found.'},404);
 }catch(error){return respond({message:error instanceof ApiError?error.message:'Profile tabs unavailable.'},error instanceof ApiError?error.status:503);}
}
