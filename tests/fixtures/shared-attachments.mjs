import {createHash,randomUUID} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';
const {handleAttachments,ApiError,ecoConnections}=await tsImport('./shared-attachments-runtime.ts',import.meta.url);
const origin=`https://${ecoConnections.supabaseProjectRef}.supabase.co`,bucket=ecoConnections.profileAttachmentsBucket;
/** Isolated browser transport fixture uses the real HTTP handler and byte verifier. */
export async function installSharedAttachments(context,{user,preview=()=>null}={}){
 if(typeof user!=='function')throw Error('Provide an explicit synthetic session.');
 const items=new Map(),folders=new Map(),uploads=new Map(),receipts=new Map(),retained=new Set();
 const fixture={items,folders,uploads,requests:[],putCount:0,failPrepareResponseOnce:false,corruptUploadOnce:false};
 const copy=v=>structuredClone(v),fail=(status,message)=>{throw new ApiError(status,message);};
 async function rpc(name,args={}){
  const actor=user();if(!actor?.isActive||!actor.activated)fail(401,'Sign in required.');
  if(name==='eco_list_profile_attachments')return{items:[...items.values()].map(copy),folders:[...folders.values()].map(copy),retainedIds:[...retained],targetKeys:['country:Singapore','port:port-singapore','country:Hong Kong','port:port-hong-kong']};
  if(name==='eco_access_profile_attachment'){
   const upload=uploads.get(args.p_id),record=items.get(args.p_id);
   if(!upload||args.p_upload&&upload.actorId!==actor.id||!args.p_upload&&!record)fail(404,'Attachment not found.');
   return{actorId:actor.id,sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',aal:'aal1',uploadId:upload.uploadId,objectPath:upload.objectPath,item:record??upload.item,expectedSha256:upload.item.sha256,state:record?'active':'pending'};
  }
  if(preview())fail(403,'Preview is read only.');
  const input=args.p_input,key=`${actor.id}:${input.requestId}`,fingerprint=JSON.stringify({name,input});
  if(receipts.has(key)){const old=receipts.get(key);if(old.fingerprint!==fingerprint)fail(409,'Request conflict.');return copy(old.result);}
  let result;
  if(name==='eco_prepare_profile_attachment'){
   if(uploads.has(input.item.id)||items.has(input.item.id)||retained.has(input.item.id))fail(409,'Record conflict.');
   const upload={uploadId:randomUUID(),actorId:actor.id,item:copy(input.item),objectPath:`${randomUUID()}/${randomUUID()}.bin`,version:'fixture-v1',objectId:randomUUID()};uploads.set(input.item.id,upload);result={id:input.item.id,uploadId:upload.uploadId,objectPath:upload.objectPath};
  }else if(name==='eco_mutate_profile_attachment'){
   const r=input.record,old=input.action==='folder'?folders.get(r.id):items.get(r.id);if((old?.revision??0)!==input.revision)fail(409,'Revision conflict.');
   if(input.action==='archive'){items.delete(r.id);retained.add(r.id);result={id:r.id,archived:true};}
   else if(input.action==='folder'){result={...r,custom:true,revision:input.revision+1};folders.set(r.id,result);}
   else{result={...old,...r,revision:input.revision+1,...(input.action==='link'?{type:'link',size:0,mime:'text/uri-list',createdBy:actor.id,createdAt:new Date().toISOString()}:{} )};items.set(r.id,result);}
  }else throw Error('Unknown synthetic RPC');
  receipts.set(key,{fingerprint,result:copy(result)});return result;
 }
 function byPath(path){const value=[...uploads.values()].find(u=>u.objectPath===path);if(!value)fail(404,'Attachment not found.');return value;}
 const storage={
  async info(path){const value=byPath(path);if(!value.bytes)fail(404,'Upload pending.');return{id:value.objectId,name:path,bucketId:bucket,size:value.bytes.length,contentType:value.mime,version:value.version};},
  async upload(path){return`${origin}/storage/v1/object/upload/sign/${bucket}/${path}?token=synthetic`;},
  async sign(path,seconds,fileName){return`${origin}/storage/v1/object/sign/${bucket}/${path}?token=synthetic${fileName?'&download='+encodeURIComponent(fileName):''}`;},
  async fetch(url){const path=new URL(url).pathname.split(`/${bucket}/`)[1],u=byPath(path);return new Response(u.bytes,{headers:{'content-type':u.mime,'content-length':String(u.bytes.length)}});},
  async complete(input){const u=[...uploads.values()].find(v=>v.uploadId===input.uploadId);if(!u||u.actorId!==user()?.id)fail(403,'Access denied.');if(items.has(u.item.id))return copy(items.get(u.item.id));const value={...u.item,type:'file',createdBy:u.actorId,createdAt:new Date().toISOString(),revision:1,sha256:input.verified.sha256};items.set(value.id,value);return value;}
 };
 await context.route(`${origin}/storage/v1/object/**`,async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.split(`/${bucket}/`)[1],u=[...uploads.values()].find(v=>v.objectPath===path);
  const headers={'access-control-allow-origin':request.headers().origin??'*','access-control-allow-methods':'GET,PUT,OPTIONS','access-control-allow-headers':'content-type,x-upsert,cache-control'};
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(!u||url.searchParams.get('token')!=='synthetic')return route.fulfill({status:404,headers});
  if(request.method()==='PUT'){
   fixture.putCount++;if(u.bytes)return route.fulfill({status:409,json:{message:'Already exists.'},headers});
   u.bytes=request.postDataBuffer()??Buffer.alloc(0);if(fixture.corruptUploadOnce&&u.bytes.length){fixture.corruptUploadOnce=false;u.bytes=Buffer.from(u.bytes);u.bytes[0]^=255;}u.mime=request.headers()['content-type'];return route.fulfill({status:200,json:{Key:u.objectPath},headers});
  }
  if(!u.bytes)return route.fulfill({status:404,headers});
  return route.fulfill({status:200,body:u.bytes,headers:{...headers,'content-type':u.mime,'content-length':String(u.bytes.length)}});
 });
 await context.route('**/api/attachments/**',async route=>{
  const req=route.request(),request=new Request(req.url(),{method:req.method(),headers:req.headers(),body:req.method()==='GET'?undefined:req.postData()});
  fixture.requests.push({route:new URL(req.url()).pathname,body:req.method()==='GET'?undefined:req.postDataJSON()});
  const config={origin:new URL(req.url()).origin,supabaseUrl:origin};
  const response=await handleAttachments(request,config,{cookies:[],currentUser:async()=>user(),getPreview:async()=>preview(),authenticatedRpc:rpc},storage);
  if(fixture.failPrepareResponseOnce&&new URL(req.url()).pathname.endsWith('/prepare')&&response.status===200){fixture.failPrepareResponseOnce=false;return route.fulfill({status:503,json:{message:'Synthetic uncertain response.'}});}
  return route.fulfill({status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers)});
 });
 fixture.sha256=id=>{const u=uploads.get(id);return u?.bytes&&createHash('sha256').update(u.bytes).digest('hex');};
 return fixture;
}
