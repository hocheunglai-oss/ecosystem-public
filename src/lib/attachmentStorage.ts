import {assertLiveDataWritable,isTestWorkspace} from './testWorkspaceGuard';
import {useTestWorkspace} from '../TestWorkspace';
import {useAccess} from '../auth';
import {useEffect,useSyncExternalStore} from 'react';
import type {AccessUser} from '../../shared/access';
import {attachmentMaxBytes,isSharedAttachmentScope,type SharedAttachmentCatalog} from '../../shared/attachments';
import {ecoConnections} from '../../config/ecoConnections';
import type {AttachmentCatalog,AttachmentFolder,AttachmentItem} from './attachments';
import {decodeAttachmentBytes,encodeAttachmentBytes} from './attachmentBytes';
import {assertPreviewWritable} from './previewGuard';
export {isSharedAttachmentScope,canWriteSharedAttachment} from '../../shared/attachments';

type Snapshot=AttachmentCatalog&{ready:boolean;error:string;localImportSummary:LocalAttachmentSummary};
export interface LocalAttachmentSummary {eligible:number;unassigned:number;unsupported:number;missing:number;oversized:number;imported:number}
const emptySummary=():LocalAttachmentSummary=>({eligible:0,unassigned:0,unsupported:0,missing:0,oversized:0,imported:0});
const empty:Snapshot={items:[],folders:[],ready:true,error:'',localImportSummary:emptySummary()};
let snapshot:Snapshot=empty,actor:AccessUser|null=null,generation=0,initialization:Promise<void>|undefined;
let shared:AttachmentCatalog&{retainedIds?:string[];targetKeys?:string[]}={items:[],folders:[]},legacy:AttachmentCatalog={items:[],folders:[]};
const listeners=new Set<()=>void>();
let legacyChannel:BroadcastChannel|undefined;
const publish=(value:Snapshot)=>{snapshot=value;listeners.forEach(fn=>fn());};
function ensure(expected=actor?.id):AccessUser{assertLiveDataWritable();if(!actor?.id||actor.id!==expected)throw Error('Sign in again before changing attachments.');return actor;}
function writable(expected=actor?.id){assertPreviewWritable();return ensure(expected);}
const databaseCache=new Map<string,Promise<IDBDatabase>>();
function database(name:string,stores:string[]):Promise<IDBDatabase>{
 let value=databaseCache.get(name);if(!value){value=new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{for(const store of stores)request.result.createObjectStore(store,{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>{databaseCache.delete(name);reject(Error('Browser attachment archive unavailable.'));};});databaseCache.set(name,value);}return value;
}
const legacyDB=()=>database('ecosystem.attachments.v1',['items','folders','blobs']);
const stagedDB=()=>database('ecosystem.attachments.shared-stage.v1',['entries']);
async function readAll<T>(db:IDBDatabase,store:string):Promise<T[]>{return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Browser attachment archive unavailable.'));});}
async function oldBlob(id:string):Promise<Blob|undefined>{const db=await legacyDB();return new Promise((resolve,reject)=>{const r=db.transaction('blobs','readonly').objectStore('blobs').get(id);r.onsuccess=()=>resolve(decodeAttachmentBytes(r.result));r.onerror=()=>reject(Error('Browser attachment archive unavailable.'));});}
interface Staged {id:string;actorId:string;item:AttachmentItem;bytes?:ArrayBuffer;mime?:string}
let stage:Staged[]=[];
async function stageOriginal(item:AttachmentItem,blob:Blob|undefined,owner:string){
 const data=blob?await encodeAttachmentBytes(blob):{},db=await stagedDB();writable(owner);
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite');tx.objectStore('entries').put({id:`${owner}:${item.id}`,actorId:owner,item:{...item,createdBy:owner},...data});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(Error('The original file could not be preserved in this browser.'));});
}
async function request<T>(route:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const owner=ensure().id;if(body!==undefined&&route!=='download')writable(owner);
 const response=await fetch(`/api/attachments/${route}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'X-Eco-Data-Mode':'live',...(body===undefined?{}:{'Content-Type':'application/json','X-Eco-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(route==='complete'?170000:20000)]):AbortSignal.timeout(route==='complete'?170000:20000)});
 const result=await response.json().catch(()=>({message:'Attachment service unavailable.'}));ensure(owner);
 if(!response.ok)throw Object.assign(Error(result.message??'Attachment service unavailable.'),{status:response.status});return result;
}
function localOwned():AttachmentItem[]{
 const map=new Map(legacy.items.filter(item=>item.createdBy===actor?.id).map(item=>[item.id,item]));
 for(const entry of stage)if(entry.actorId===actor?.id)map.set(entry.item.id,entry.item);return [...map.values()];
}
export async function inspectLocalAttachments(user?:Pick<AccessUser,'id'>):Promise<LocalAttachmentSummary>{
 const owner=ensure(user?.id??actor?.id).id,result=emptySummary(),present=new Set([...shared.items.map(item=>item.id),...(shared.retainedIds??[])]);
 result.unassigned=legacy.items.filter(item=>item.createdBy!==owner).length;
 for(const item of localOwned()){
  if(present.has(item.id)){result.imported++;continue;}
  if(!isSharedAttachmentScope(item.scope)||item.legacy||!shared.targetKeys?.includes(`${item.scope.target.kind}:${item.scope.target.id}`)){result.unsupported++;continue;}
  if(item.type==='file'){const blob=await localBlob(item.id);if(!blob){result.missing++;continue;}if(blob.size>attachmentMaxBytes){result.oversized++;continue;}}
  result.eligible++;
 }return result;
}
async function load(expected=actor?.id){
 const current=ensure(expected),ownGeneration=generation;
 const [cloud,oldItems,oldFolders,staged]=await Promise.all([request<SharedAttachmentCatalog>('list'),legacyDB().then(db=>readAll<AttachmentItem>(db,'items')),legacyDB().then(db=>readAll<AttachmentFolder>(db,'folders')),stagedDB().then(db=>readAll<Staged>(db,'entries'))]);
 if(ownGeneration!==generation||actor?.id!==current.id)return;
 shared=cloud;legacy={items:oldItems,folders:oldFolders};stage=staged.filter(entry=>entry.actorId===current.id);
 const summary=await inspectLocalAttachments(current);if(ownGeneration!==generation)return;
 const ids=new Set([...shared.items.map(item=>item.id),...(shared.retainedIds??[])]),local=localOwned().filter(item=>!ids.has(item.id)).map(item=>({...item,localOnly:true}));
 const folders=new Map(shared.folders.map(folder=>[folder.id,folder]));
 // Only expose legacy folders required by this user's own files, never empty unowned folders.
 for(const item of local){let id:string|null=item.folderId;const seen=new Set<string>();while(id&&!seen.has(id)){seen.add(id);const folder=legacy.folders.find(f=>f.id===id);if(!folder)break;if(!folders.has(id))folders.set(id,{...folder,localOnly:true});id=folder.parentId;}}
 publish({items:[...shared.items,...local],folders:[...folders.values()],ready:true,error:'',localImportSummary:summary});
}
export function initializeAttachments():Promise<void>{if(isTestWorkspace()||!actor)return Promise.resolve();if(!legacyChannel&&typeof BroadcastChannel!=='undefined'){legacyChannel=new BroadcastChannel('ecosystem.attachments.v1');legacyChannel.onmessage=()=>{if(actor&&!isTestWorkspace())void load().catch(error=>publish({...snapshot,error:error.message}));};}const version=generation;initialization??=load().catch(error=>{if(version===generation)publish({...snapshot,ready:true,error:error.message});}).finally(()=>{if(version===generation)initialization=undefined;});return initialization;}
export async function refreshAttachments(){const owner=ensure().id;await load(owner);}
export function useAttachmentCatalog():Snapshot{
 const {dataMode}=useTestWorkspace(),{realUser}=useAccess(),key=`${dataMode}:${realUser?.id??''}`;
 useEffect(()=>{const next=dataMode==='live'?realUser:null;if(actor?.id!==next?.id){actor=next;generation++;initialization=undefined;shared={items:[],folders:[]};legacy={items:[],folders:[]};stage=[];publish({...empty,ready:!next});}else actor=next;if(next)void initializeAttachments();},[key]);
 const current=useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>snapshot);
 return dataMode==='test'||!realUser||actor?.id!==realUser.id?empty:current;
}
async function localBlob(id:string):Promise<Blob|undefined>{const entry=stage.find(row=>row.actorId===actor?.id&&row.item.id===id);if(entry)return decodeAttachmentBytes(entry);return legacy.items.some(item=>item.id===id&&item.createdBy===actor?.id)?oldBlob(id):undefined;}
async function digest(blob:Blob):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function requestId(payload:unknown,owner:string):Promise<string>{
 const key=`eco.attachments.requests.${owner}`,fingerprint=await digest(new Blob([JSON.stringify(payload)]));writable(owner);
 let saved:Record<string,string>={};try{saved=JSON.parse(localStorage.getItem(key)??'{}');}catch{}
 if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
 const id=saved[fingerprint]??crypto.randomUUID();saved[fingerprint]=id;localStorage.setItem(key,JSON.stringify(saved));return id;
}
async function uploadOne(item:AttachmentItem,blob:Blob|undefined){
 const owner=writable().id;if(!isSharedAttachmentScope(item.scope)||item.legacy)throw Error('This browser archive cannot be published to a shared profile.');
 if(item.type==='link'){
  const payload={action:'link',revision:0,record:{id:item.id,folderId:item.folderId,scope:item.scope,name:item.name,url:item.url,legacy:{createdBy:owner,createdAt:item.createdAt}}};
  await request('mutate',{...payload,requestId:await requestId(payload,owner)});return;
 }
 if(!blob||blob.size>attachmentMaxBytes)throw Error('The original file is missing or exceeds 50 MB. It remains in the browser archive.');
 const mime=blob.type||'application/octet-stream',payload={item:{id:item.id,folderId:item.folderId,scope:item.scope,name:item.name,mime,size:blob.size,sha256:await digest(blob),legacy:{createdBy:owner,createdAt:item.createdAt}}};
 const reserved=await request<{id:string;url:string}>('prepare',{...payload,requestId:await requestId(payload,owner)});
 writable(owner);
 // An earlier uncertain upload may already exist. Verify before attempting a non-overwriting PUT.
 try{await request('complete',{id:item.id});return;}catch(error){if(![404,409,503].includes((error as {status:number}).status))throw error;}
 const url=new URL(reserved.url);if(url.origin!==`https://${ecoConnections.supabaseProjectRef}.supabase.co`||!url.pathname.startsWith(`/storage/v1/object/upload/sign/${ecoConnections.profileAttachmentsBucket}/`)||url.username||url.password||url.hash||[...url.searchParams.keys()].join(',')!=='token')throw Error('Upload target unavailable.');
 const response=await fetch(url.href,{method:'PUT',body:await blob.arrayBuffer(),credentials:'omit',redirect:'error',headers:{'Content-Type':mime,'x-upsert':'false','cache-control':'max-age=0'},signal:AbortSignal.timeout(120000)});
 writable(owner);
 // The signed capability cannot replace an object; final verification decides whether an uncertain PUT succeeded.
 if(!response.ok&&response.status!==400&&response.status!==409)throw Error('Upload did not finish. The original file remains in this browser.');
 await request('complete',{id:item.id});
}
export async function addAttachmentItems(entries:{item:AttachmentItem;blob?:Blob}[]):Promise<void>{
 const owner=writable().id;
 try{for(const entry of entries){if(!isSharedAttachmentScope(entry.item.scope))throw Error('Select an active country, port or supplier profile.');await stageOriginal(entry.item,entry.blob,owner);}for(const entry of entries)await uploadOne(entry.item,entry.blob);}finally{await load(owner);}
}
export async function saveAttachmentFolder(folder:AttachmentFolder):Promise<void>{
 const owner=writable().id;if(!isSharedAttachmentScope(folder.scope)||!folder.parentId)throw Error('Select a shared profile folder.');
 const payload={action:'folder',revision:shared.folders.find(f=>f.id===folder.id)?.revision??0,record:{id:folder.id,parentId:folder.parentId,name:folder.name,scope:folder.scope}};
 await request('mutate',{...payload,requestId:await requestId(payload,owner)});await load(owner);
}
export async function updateAttachmentItem(item:AttachmentItem):Promise<void>{
 const owner=writable().id,current=shared.items.find(i=>i.id===item.id);if(!current)throw Error('Import your browser attachment before editing it.');
 const payload={action:'update',revision:current.revision,record:{id:item.id,folderId:item.folderId,name:item.name,scope:item.scope}};
 await request('mutate',{...payload,requestId:await requestId(payload,owner)});await load(owner);
}
export async function deleteAttachmentItem(id:string):Promise<void>{
 const owner=writable().id,current=shared.items.find(i=>i.id===id);if(!current)throw Error('The browser original is retained. Import it before changing shared records.');
 const payload={action:'archive',revision:current.revision,record:{id}};await request('mutate',{...payload,requestId:await requestId(payload,owner)});await load(owner);
}
export async function attachmentBlob(id:string):Promise<Blob>{
 const owner=ensure().id;if(!shared.items.some(item=>item.id===id)){const blob=await localBlob(id);ensure(owner);if(blob)return blob;throw Error('The original file is unavailable in this browser.');}
 const access=await request<{url:string;size:number;sha256:string;mime:string}>('download',{id});
 const url=new URL(access.url);if(url.origin!==`https://${ecoConnections.supabaseProjectRef}.supabase.co`||!url.pathname.startsWith(`/storage/v1/object/sign/${ecoConnections.profileAttachmentsBucket}/`)||url.username||url.password||url.hash)throw Error('Download unavailable.');
 const response=await fetch(url.href,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Download unavailable.');
 if(!response.body||!Number.isSafeInteger(access.size)||access.size<0||access.size>attachmentMaxBytes)throw Error('Download unavailable.');const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>access.size||size>attachmentMaxBytes)throw Error('The downloaded file exceeds its verified size.');chunks.push(new Uint8Array(part.value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}const blob=new Blob(chunks,{type:access.mime});ensure(owner);if(blob.size!==access.size||await digest(blob)!==access.sha256)throw Error('The downloaded file did not pass verification.');return blob;
}
export async function importOwnedLocalAttachments(user?:Pick<AccessUser,'id'>):Promise<LocalAttachmentSummary>{
 const owner=writable(user?.id??actor?.id).id;await load(owner);
 const originals=localOwned().filter(item=>isSharedAttachmentScope(item.scope)&&shared.targetKeys?.includes(`${item.scope.target.kind}:${item.scope.target.id}`)&&!item.legacy&&!shared.items.some(s=>s.id===item.id)&&!shared.retainedIds?.includes(item.id));
 const doneFolders=new Set(shared.folders.map(f=>f.id));
 async function importFolder(id:string,seen=new Set<string>()){
  if(doneFolders.has(id))return;if(seen.has(id))throw Error('Browser folder hierarchy needs review.');seen.add(id);
  const folder=legacy.folders.find(f=>f.id===id);if(!folder)return;
  if(!folder.scope||!isSharedAttachmentScope(folder.scope)||!folder.parentId)throw Error('Browser folder target needs review.');
  await importFolder(folder.parentId,seen);await saveAttachmentFolder(folder);doneFolders.add(id);
 }
 try{for(const item of originals){const blob=item.type==='file'?await localBlob(item.id):undefined;if(item.type==='file'&&(!blob||blob.size>attachmentMaxBytes))continue;await importFolder(item.folderId);await uploadOne(item,blob);}}finally{await load(owner);}
 return snapshot.localImportSummary;
}
