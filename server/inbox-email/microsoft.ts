import { constants, randomUUID, sign } from 'node:crypto';
import { EmailSyncError, type EmailConfig } from './config.ts';

export type Fetcher = typeof fetch;
export function clientAssertion(config:EmailConfig, now=Date.now(), nonce=randomUUID()):string {
  const seconds=Math.floor(now/1000);
  const header={alg:'PS256',typ:'JWT','x5t#S256':Buffer.from(config.certificateSha256,'hex').toString('base64url')};
  const payload={aud:`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,iss:config.clientId,sub:config.clientId,jti:nonce,nbf:seconds-30,iat:seconds,exp:seconds+300};
  const unsigned=[header,payload].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${unsigned}.${sign('sha256',Buffer.from(unsigned),{key:config.privateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString('base64url')}`;
}
export function retryAfterSeconds(value:string|null, now=Date.now()):number {
  const parsed=value && /^\d+$/.test(value)?Number(value):value?(Date.parse(value)-now)/1000:60;
  return Number.isFinite(parsed)?Math.max(1,Math.min(86400,Math.ceil(Number(parsed)))):60;
}
export async function boundedJson(response:Response, limit:number):Promise<Record<string,unknown>> {
  if (Number(response.headers.get('content-length') ?? 0)>limit) {await response.body?.cancel();throw new EmailSyncError('response_oversized');}
  if (!response.body) throw new EmailSyncError('provider_error');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try { for (;;) {const value=await reader.read();if(value.done)break;size+=value.value.byteLength;if(size>limit){await reader.cancel();throw new EmailSyncError('response_oversized');}chunks.push(value.value);} }
  finally {reader.releaseLock();}
  try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value || typeof value!=='object'||Array.isArray(value))throw new Error('shape');return value;}
  catch {throw new EmailSyncError('provider_error');}
}
function identifier(value:unknown):string {if(typeof value!=='string'||!value||value.length>1024||/[\x00-\x20\x7f]/.test(value))throw new EmailSyncError('provider_error');return value;}
export function deltaUrl(config:Pick<EmailConfig,'mailboxId'>,folderId:string,cursor?:string|null):string {
  const user=config.mailboxId;const folder=encodeURIComponent(identifier(folderId));
  const base=`https://graph.microsoft.com/v1.0/users/${user}/mailFolders/${folder}/messages/delta`;
  if (!cursor) return `${base}?$select=id,receivedDateTime&$top=10`;
  if (cursor.length>8000 || /[\x00-\x20\\]/.test(cursor)) throw new EmailSyncError('cursor_invalid');
  let url:URL;try {url=new URL(cursor);}catch{throw new EmailSyncError('cursor_invalid');}
  const paths=new Set<string>();
  // Graph leaves base64 padding literal in quoted folder keys on actual delta links.
  // Both spellings still match the exact verified Inbox ID; never normalize the whole path.
  const quotedFolder=folder.replace(/%3D/gi,'=');
  for(const u of [`users/${user}`,`users('${user}')`])for(const keyword of ['mailFolders','mailfolders'])for(const f of [`${keyword}/${folder}`,`${keyword}('${folder}')`,`${keyword}('${quotedFolder}')`])paths.add(`/v1.0/${u}/${f}/messages/delta`);
  const entries=[...url.searchParams.entries()];const keys=entries.map(([key])=>key.toLowerCase());
  const tokens=entries.filter(([key])=>['$skiptoken','$deltatoken'].includes(key.toLowerCase()));
  const safeQuery=new Set(keys).size===keys.length&&tokens.length===1&&tokens[0][1].length>0&&entries.every(([key,value])=>{
    if(['$skiptoken','$deltatoken'].includes(key.toLowerCase()))return true;
    if(key.toLowerCase()==='$select')return value.split(',').sort().join(',')==='id,receivedDateTime';
    return key.toLowerCase()==='$top'&&value==='10';
  });
  if(url.origin!=='https://graph.microsoft.com'||url.username||url.password||url.hash||!paths.has(url.pathname)||!safeQuery)throw new EmailSyncError('cursor_invalid');
  return cursor;
}
export type AttachmentDisposition = 'none' | 'inline-images' | 'unsupported';
const MAX_INLINE_IMAGES = 10;
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
const MAX_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Classify a complete metadata-only page. No attachment content is fetched, rendered or retained. */
export function classifyAttachmentMetadata(result:Record<string,unknown>):AttachmentDisposition {
  if (!Array.isArray(result.value) || result.value.length > MAX_INLINE_IMAGES ||
      Object.hasOwn(result, '@odata.nextLink') || Object.hasOwn(result, '@odata.deltaLink')) return 'unsupported';
  const ids = new Set<string>(); let total = 0;
  for (const value of result.value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unsupported';
    const attachment = value as Record<string,unknown>;
    if (typeof attachment['@odata.type'] !== 'string' || !['#microsoft.graph.fileAttachment', 'microsoft.graph.fileAttachment'].includes(attachment['@odata.type']) ||
        typeof attachment.id !== 'string' || !attachment.id || attachment.id.length > 1024 || /[\x00-\x20\x7f]/.test(attachment.id) || ids.has(attachment.id) ||
        attachment.isInline !== true || typeof attachment.contentType !== 'string' || !INLINE_IMAGE_TYPES.has(attachment.contentType.toLowerCase()) ||
        typeof attachment.size !== 'number' || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_INLINE_IMAGE_BYTES ||
        Object.hasOwn(attachment, 'contentBytes') || Object.hasOwn(attachment, 'item')) return 'unsupported';
    total += attachment.size; if (total > MAX_INLINE_TOTAL_BYTES) return 'unsupported';
    ids.add(attachment.id);
  }
  return result.value.length ? 'inline-images' : 'none';
}
export interface GraphApi {
  folder():Promise<string>;
  delta(folderId:string,cursor:string|null):Promise<Record<string,unknown>>;
  metadata(id:string):Promise<Record<string,unknown>>;
  attachments(id:string):Promise<AttachmentDisposition>;
  body(id:string):Promise<Record<string,unknown>>;
}
export function microsoftGraph(config:EmailConfig, fetcher:Fetcher=fetch, now=Date.now, deadline=now()+40000):GraphApi {
  let token:string|undefined;
  async function request(url:string, init:RequestInit, limit:number, messageRequest=false):Promise<Record<string,unknown>> {
    const remaining=deadline-now();if(remaining<=0)throw new EmailSyncError('deadline');
    try {
      const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(Math.min(8000,remaining))});
      if(!response.ok){await response.body?.cancel();throw new EmailSyncError(messageRequest&&response.status===404?'message_unavailable':'provider_error',retryAfterSeconds(response.headers.get('retry-after'),now()));}
      return await boundedJson(response,limit);
    }catch(error){if(error instanceof EmailSyncError)throw error;throw new EmailSyncError('provider_error');}
  }
  async function accessToken():Promise<string> {
    if(token)return token;
    const form=new URLSearchParams({client_id:config.clientId,scope:'https://graph.microsoft.com/.default',grant_type:'client_credentials',client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:clientAssertion(config,now())});
    const result=await request(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()},32768);
    if(typeof result.access_token!=='string'||!result.access_token||result.access_token.length>16384||/\s/.test(result.access_token)||result.token_type!=='Bearer'||typeof result.expires_in!=='number'||result.expires_in<60)throw new EmailSyncError('provider_error');
    token=result.access_token;return token;
  }
  async function get(path:string,limit=65536,messageRequest=false) {
    return request(`https://graph.microsoft.com${path}`,{method:'GET',headers:{Authorization:`Bearer ${await accessToken()}`,Accept:'application/json',Prefer:'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=10'}},limit,messageRequest);
  }
  const message=(id:string)=>`/v1.0/users/${config.mailboxId}/messages/${encodeURIComponent(identifier(id))}`;
  return {
    async folder(){const result=await get(`/v1.0/users/${config.mailboxId}/mailFolders/inbox?$select=id`);return identifier(result.id);},
    async delta(folder,cursor){const url=deltaUrl(config,folder,cursor);return get(url.slice('https://graph.microsoft.com'.length),131072);},
    metadata:id=>get(`${message(id)}?$select=id,receivedDateTime,sender,from,internetMessageHeaders,hasAttachments`,65536,true),
    async attachments(id){
      // Ask for one overflow item, but never follow another page or request file/item contents.
      const result=await get(`${message(id)}/attachments?$select=id,isInline,contentType,size&$top=${MAX_INLINE_IMAGES+1}`,65536,true);
      return classifyAttachmentMetadata(result);
    },
    body:id=>get(`${message(id)}?$select=id,body,subject`,150000,true),
  };
}
