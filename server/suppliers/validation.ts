import type { SupplierUpdate, SupplierContact, SupplierBarge, SupplierListQuery, SupplierInfo, SupplierCreate, SupplierArchive } from '../../shared/suppliers.ts';
import { supplierInfoKeys } from '../../shared/suppliers.ts';
import { supplierPortById } from '../../shared/supplierPorts.ts';
import { ApiError } from '../auth/validation.ts';
const invalid = ():never => {throw new ApiError(400,'Invalid supplier information.');};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))return invalid();return value as Record<string,unknown>;}
function text(value:unknown,max:number,min=0):string{if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))return invalid();return value.trim();}
function uuid(value:unknown):string{const v=text(value,36,36);if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v))return invalid();return v;}
function number(value:unknown,max:number):number{if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>max)return invalid();return value;}
function rows<T>(value:unknown,max:number,parse:(v:unknown)=>T):T[]{if(!Array.isArray(value)||value.length>max)return invalid();const out=value.map(parse),ids=out.map(x=>(x as {id:string}).id);if(new Set(ids).size!==ids.length)return invalid();return out;}
export function supplierUpdate(value:unknown):SupplierUpdate{
 const v=object(value,['requestId','id','revision','info','contacts','barges','legalName','shortName','background']),info=object(v.info,supplierInfoKeys);
 return {...(v.legalName===undefined?{}:{legalName:text(v.legalName,300,1)}),...(v.shortName===undefined?{}:{shortName:text(v.shortName,160,1)}),...(v.background===undefined?{}:{background:text(v.background,8000)}),requestId:uuid(v.requestId),id:uuid(v.id),revision:number(v.revision,2147483647),info:Object.fromEntries(supplierInfoKeys.map(key=>[key,text(info[key],2000)])) as SupplierInfo,
 contacts:rows<SupplierContact>(v.contacts,100,row=>{const c=object(row,['id','role','name','phone','email','sourceId']);if(!['sales','ops','general'].includes(String(c.role)))return invalid();if(![c.name,c.phone,c.email].some(value=>typeof value==='string'&&value.trim()))return invalid();return {id:text(c.id,100,1),role:c.role as SupplierContact['role'],name:text(c.name,300),phone:text(c.phone,500),email:text(c.email,500),sourceId:text(c.sourceId,160)};}),
 barges:rows<SupplierBarge>(v.barges,200,row=>{const b=object(row,['id','name','imo','grade','capacity','sourceId']);return {id:text(b.id,100,1),name:text(b.name,300,1),imo:text(b.imo,100),grade:text(b.grade,300),capacity:text(b.capacity,300),sourceId:text(b.sourceId,160)};})};
}
export function supplierListQuery(url:URL):SupplierListQuery {
 const allowed=['search','country','portId','grade','trader','page','limit'];
 if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length>1))return invalid();
 const numeric=(key:string,fallback:number,max:number)=>{const raw=url.searchParams.get(key);if(raw!==null&&!/^[1-9]\d*$/.test(raw))return invalid();return number(raw===null?fallback:Number(raw),max);};
 const portId=url.searchParams.get('portId');
 if(portId!==null&&!supplierPortById(portId))return invalid();
 return {search:text(url.searchParams.get('search')??'',160),country:text(url.searchParams.get('country')??'',2),...(portId?{portId}:{}),grade:text(url.searchParams.get('grade')??'',100),trader:text(url.searchParams.get('trader')??'',160),page:numeric('page',1,100000),limit:numeric('limit',50,100)};
}
export function supplierDetailId(url:URL):string{if([...url.searchParams.keys()].some(k=>k!=='id')||url.searchParams.getAll('id').length!==1)return invalid();return text(url.searchParams.get('id'),160,1);}

export function supplierCreate(value:unknown):SupplierCreate {
 const v=object(value,['requestId','legalName','shortName','portId','countryCode','countryName','portName','background','info','contacts','barges']);
 const port=supplierPortById(v.portId===undefined?'port-singapore':text(v.portId,160,1));
 if(!port||v.countryCode!==port.countryCode||v.countryName!==port.countryName||v.portName!==port.portName)return invalid();
 const parsed=supplierUpdate({requestId:v.requestId,id:'00000000-0000-4000-8000-000000000000',revision:1,info:v.info,contacts:v.contacts,barges:v.barges});
 return {requestId:parsed.requestId,legalName:text(v.legalName,300,1),shortName:text(v.shortName,160,1),...(v.portId===undefined?{}:{portId:port.id}),countryCode:port.countryCode,countryName:port.countryName,portName:port.portName,background:text(v.background,8000),info:parsed.info,contacts:parsed.contacts,barges:parsed.barges};
}
export function supplierArchive(value:unknown):SupplierArchive {const v=object(value,['requestId','id','revision']);return {requestId:uuid(v.requestId),id:uuid(v.id),revision:number(v.revision,2147483647)};}
