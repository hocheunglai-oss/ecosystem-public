import {ApiError} from '../auth/validation.ts';
import {attachmentMaxBytes,type SharedAttachmentScope} from '../../shared/attachments.ts';
const fail=():never=>{throw new ApiError(400,'Invalid attachment request.');};
export const uuid=(value:unknown):string=>typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():fail();
function object(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const v=value as Record<string,unknown>;
  if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))return fail();return v;
}
export function id(value:unknown):string {return typeof value==='string'&&value.length>0&&value.length<=300&&!/[\u0000-\u001f\u007f]/.test(value)?value:fail();}
function name(value:unknown):string {return typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=240&&!['.','..'].includes(value)&&!/[\u0000-\u001f\u007f/\\]/.test(value)?value:fail();}
export function scope(value:unknown):SharedAttachmentScope {
  const v=object(value,['target'],['section']),t=object(v.target,['kind','id']);
  if(!['country','port','supplier'].includes(String(t.kind)))return fail();
  const result:SharedAttachmentScope={target:{kind:t.kind as SharedAttachmentScope['target']['kind'],id:id(t.id)}};
  if(t.kind==='supplier')uuid(t.id);
  if(v.section!==undefined){const s=object(v.section,['id','name']);result.section={id:id(s.id),name:name(s.name)};}return result;
}
function revision(value:unknown):number{return Number.isSafeInteger(value)&&Number(value)>=0?Number(value):fail();}
export function prepare(value:unknown){
  const v=object(value,['requestId','item']),item=object(v.item,['id','folderId','scope','name','mime','size','sha256'],['legacy']);
  if(typeof item.mime!=='string'||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item.mime)||item.mime.length>150
    ||!Number.isSafeInteger(item.size)||Number(item.size)<0||Number(item.size)>attachmentMaxBytes||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))return fail();
  let legacy:Record<string,unknown>|undefined;
  if(item.legacy!==undefined){legacy=object(item.legacy,['createdBy','createdAt']);uuid(legacy.createdBy);if(typeof legacy.createdAt!=='string'||!Number.isFinite(Date.parse(legacy.createdAt)))return fail();}
  return {requestId:uuid(v.requestId),item:{id:id(item.id),folderId:id(item.folderId),scope:scope(item.scope),name:name(item.name),mime:item.mime,size:Number(item.size),sha256:item.sha256,...(legacy?{legacy}:{})}};
}
export function access(value:unknown){const v=object(value,['id']);return {id:id(v.id)};}
export function mutation(value:unknown){
  const v=object(value,['requestId','action','revision','record']);
  const base={requestId:uuid(v.requestId),action:String(v.action),revision:revision(v.revision)};
  if(v.action==='archive'){const r=object(v.record,['id']);return {...base,record:{id:id(r.id)}};}
  if(v.action==='folder'){
    const r=object(v.record,['id','parentId','name','scope']);
    return {...base,record:{id:id(r.id),parentId:id(r.parentId),name:name(r.name),scope:scope(r.scope)}};
  }
  if(v.action==='link'||v.action==='update'){
    const r=object(v.record,['id','folderId','name','scope'],v.action==='link'?['url','legacy']:[]);
    if(v.action==='link'){
      let link:URL;try{link=new URL(String(r.url));}catch{return fail();}
      if(!['http:','https:'].includes(link.protocol)||link.username||link.password||link.href.length>4096)return fail();
      if(r.legacy!==undefined){const l=object(r.legacy,['createdBy','createdAt']);uuid(l.createdBy);if(typeof l.createdAt!=='string'||!Number.isFinite(Date.parse(l.createdAt)))return fail();}
      return {...base,record:{id:id(r.id),folderId:id(r.folderId),name:name(r.name),scope:scope(r.scope),url:link.href,...(r.legacy?{legacy:r.legacy}:{})}};
    }
    return {...base,record:{id:id(r.id),folderId:id(r.folderId),name:name(r.name),scope:scope(r.scope)}};
  }return fail();
}
