import { createHash, randomUUID } from 'node:crypto';
import { EMAIL_IDENTITY_NAMESPACE, EMAIL_PROVIDER, EmailSyncError, UUID, type EmailConfig } from './config.ts';
import { deltaUrl, type GraphApi } from './microsoft.ts';

export interface EmailStore { rpc<T>(name:string,input:Record<string,unknown>):Promise<T> }
export interface SourceLease {sourceId:string;leaseToken:string;cursor:string|null;cutoverAt:string;leaseExpiresAt:string;provider:string;accountId:string;destinationId:string;identityNamespace:string}
interface Receipt {id:string;status:'accepted'|'quarantined';duplicate:boolean}
export interface SyncResult {pages:number;accepted:number;quarantined:number;duplicates:number;more:boolean}
function record(value:unknown):Record<string,unknown> {return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function address(value:unknown):string {const raw=record(record(value).emailAddress).address;return typeof raw==='string'&&raw.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(raw)?raw.toLowerCase():'';}
/** Requires operator-proven Exchange header stripping/tenant provenance, not a From-domain heuristic. */
export function trustedSender(metadata:Record<string,unknown>,tenantId:string):{identity:string;verified:boolean} {
  const sender=address(metadata.sender);const from=address(metadata.from);
  const headers=metadata.internetMessageHeaders;
  if(!Array.isArray(headers)||headers.length>200)return {identity:sender,verified:false};
  const single=(name:string)=>{const matches=headers.filter(h=>typeof record(h).name==='string'&&(record(h).name as string).toLowerCase()===name);return matches.length===1&&typeof record(matches[0]).value==='string'?(record(matches[0]).value as string).trim():'';};
  const verified=Boolean(sender&&sender===from&&single('x-ms-exchange-organization-authas').toLowerCase()==='internal'&&single('x-ms-exchange-crosstenant-id').toLowerCase()===tenantId.toLowerCase());
  return {identity:sender,verified};
}
function messageIdentity(item:unknown):{id:string;receivedAt:string}|null {
  const value=record(item);if(value['@removed'])return null;
  if(typeof value.id!=='string'||!value.id||value.id.length>1024||typeof value.receivedDateTime!=='string'||!Number.isFinite(Date.parse(value.receivedDateTime)))throw new EmailSyncError('provider_error');
  return {id:value.id,receivedAt:new Date(value.receivedDateTime).toISOString()};
}
export async function pollEmail(config:EmailConfig,store:EmailStore,graph:GraphApi,options:{now?:()=>number;deadline?:number;requestId?:string}={}):Promise<SyncResult> {
  const now=options.now??Date.now;const deadline=options.deadline??now()+40000;
  const lease=await store.rpc<SourceLease>('eco_claim_inbox_source',{sourceId:config.sourceId,requestId:options.requestId??randomUUID()});
  let errorCode:'configuration_error'|'provider_error'|'identity_unavailable'|undefined;let retryAfterSeconds=60;
  try {
    if(lease.sourceId!==config.sourceId||!UUID.test(lease.leaseToken)||lease.provider!==EMAIL_PROVIDER||lease.accountId!==config.tenantId||lease.destinationId!==config.mailboxId||lease.identityNamespace!==EMAIL_IDENTITY_NAMESPACE||!Number.isFinite(Date.parse(lease.cutoverAt))||Date.parse(lease.cutoverAt)>now()||Date.parse(lease.leaseExpiresAt)<=now()||(lease.cursor!==null&&typeof lease.cursor!=='string'))throw new EmailSyncError('configuration_error');
    const folder=await graph.folder();let cursor=lease.cursor;deltaUrl(config,folder,cursor);
    const result:SyncResult={pages:0,accepted:0,quarantined:0,duplicates:0,more:false};
    for(let pageNumber=0;pageNumber<3;pageNumber++) {
      if(now()>=deadline)throw new EmailSyncError('deadline');
      const page=await graph.delta(folder,cursor);if(!Array.isArray(page.value)||page.value.length>100)throw new EmailSyncError('provider_error');
      const next=page['@odata.nextLink'];const delta=page['@odata.deltaLink'];
      if(Boolean(next)===Boolean(delta)||typeof(next??delta)!=='string')throw new EmailSyncError('provider_error');
      const nextCursor=deltaUrl(config,folder,(next??delta) as string);const receiptIds:string[]=[];
      for(const item of page.value) {
        if(now()>=deadline)throw new EmailSyncError('deadline');
        const identity=messageIdentity(item);if(!identity||Date.parse(identity.receivedAt)<Date.parse(lease.cutoverAt))continue;
        const existing=await store.rpc<{id:string;status:string}|null>('eco_get_inbox_receipt',{sourceId:config.sourceId,leaseToken:lease.leaseToken,messageId:identity.id});
        if(existing){if(!UUID.test(existing.id)||!['accepted','quarantined'].includes(existing.status))throw new EmailSyncError('provider_error');receiptIds.push(existing.id);result.duplicates++;continue;}
        const input:Record<string,unknown>={sourceId:config.sourceId,leaseToken:lease.leaseToken,provider:EMAIL_PROVIDER,accountId:config.tenantId,destinationId:config.mailboxId,messageId:identity.id,senderIdentity:'',identityNamespace:EMAIL_IDENTITY_NAMESPACE,identityVerified:false,rawText:'',receivedAt:identity.receivedAt};
        try {
          const metadata=await graph.metadata(identity.id);
          if(metadata.id!==identity.id||new Date(String(metadata.receivedDateTime)).toISOString()!==identity.receivedAt)throw new EmailSyncError('provider_error');
          const sender=trustedSender(metadata,config.tenantId);input.senderIdentity=sender.identity;
          if(sender.verified) {
            const binding=await store.rpc<{approved:boolean}>('eco_resolve_inbox_sender',{sourceId:config.sourceId,leaseToken:lease.leaseToken,senderIdentity:sender.identity,identityNamespace:EMAIL_IDENTITY_NAMESPACE});
            input.identityVerified=binding.approved===true;
            if(binding.approved===true) {
              // Graph's hasAttachments excludes inline images; true means substantive attachments.
              if(metadata.hasAttachments!==false||await graph.attachments(identity.id)==='unsupported')input.quarantineReason='unsupported_attachment';
              else {
                const bodyResponse=await graph.body(identity.id);const body=record(bodyResponse.body);
                if(bodyResponse.id!==identity.id)throw new EmailSyncError('provider_error');
                if(typeof body.content!=='string'||body.contentType!=='text')input.quarantineReason='unsupported_body';
                else if(Buffer.byteLength(body.content,'utf8')>20000)input.quarantineReason='oversized';
                else if(!body.content.trim()||/[\p{Cc}\uD800-\uDFFF]/u.test(body.content.replace(/[\r\n\t]/g,'')))input.quarantineReason='malformed_message';
                else {input.rawText=body.content;if(typeof bodyResponse.subject==='string'&&Buffer.byteLength(bodyResponse.subject,'utf8')<=1000&&!/[\p{Cc}\uD800-\uDFFF]/u.test(bodyResponse.subject))input.subject=bodyResponse.subject;}
                if(typeof body.content==='string')input.contentHash=createHash('sha256').update(body.content).digest('hex');
              }
            }
          }
        }catch(error){if(error instanceof EmailSyncError&&['response_oversized','message_unavailable'].includes(error.code))input.quarantineReason=error.code==='response_oversized'?'oversized':'message_unavailable';else throw error;}
        const receipt=await store.rpc<Receipt>('eco_ingest_enquiry',input);
        if(!UUID.test(receipt.id)||!['accepted','quarantined'].includes(receipt.status)||typeof receipt.duplicate!=='boolean')throw new EmailSyncError('provider_error');
        receiptIds.push(receipt.id);if(receipt.duplicate)result.duplicates++;else result[receipt.status]++;
      }
      if(now()>=deadline)throw new EmailSyncError('deadline');
      const saved=await store.rpc<{cursor:string}>('eco_checkpoint_inbox_source',{sourceId:config.sourceId,leaseToken:lease.leaseToken,expectedCursor:cursor,cursor:nextCursor,receiptIds});
      if(saved.cursor!==nextCursor)throw new EmailSyncError('provider_error');
      cursor=nextCursor;result.pages++;result.more=Boolean(next);if(!next)break;
    }
    return result;
  }catch(error){retryAfterSeconds=error instanceof EmailSyncError?error.retryAfter:60;errorCode=error instanceof EmailSyncError&&['configuration_error','identity_unavailable'].includes(error.code)?error.code as 'configuration_error'|'identity_unavailable':'provider_error';throw error;}
  finally {try {await store.rpc('eco_release_inbox_source',{sourceId:config.sourceId,leaseToken:lease.leaseToken,...errorCode?{errorCode,retryAfterSeconds}:{}});}catch{/* A stale fence cannot release a successor; expiry provides recovery. */}}
}
