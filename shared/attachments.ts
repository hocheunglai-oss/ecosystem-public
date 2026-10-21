import type { AccessUser } from './access.ts';

export const attachmentMaxBytes = 50 * 1024 * 1024;
export const attachmentRequestBytes = 16 * 1024;
export const profileAttachmentPath = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$/;
export interface SharedAttachmentScope { target: { kind: 'country'|'port'|'supplier'; id: string }; section?: {id:string;name:string} }
export interface SharedAttachmentItem {
  id:string; folderId:string; scope:SharedAttachmentScope; name:string; type:'file'|'link'; mime:string; size:number;
  createdAt:string; createdBy:string; url?:string; revision:number; sha256?:string;
}
export interface SharedAttachmentFolder {id:string;parentId:string;name:string;scope:SharedAttachmentScope;custom:true;revision:number}
export interface SharedAttachmentCatalog {items:SharedAttachmentItem[];folders:SharedAttachmentFolder[];retainedIds?:string[];targetKeys?:string[]}
export interface AttachmentAccess {
  actorId:string; sessionId:string; aal:string; uploadId:string; objectPath:string; item:SharedAttachmentItem;
  expectedSha256:string; state:'pending'|'active';
}
export function isSharedAttachmentScope(scope:unknown):scope is SharedAttachmentScope {
  if(!scope || typeof scope!=='object') return false;
  const target=(scope as SharedAttachmentScope).target;
  return Boolean(target && ['country','port','supplier'].includes(target.kind) && typeof target.id==='string' && target.id.length);
}
/** UI hint only. The database rechecks membership, canonical target and supplier country. */
export function canWriteSharedAttachment(user:Pick<AccessUser,'isActive'|'isAdmin'|'isSpcTrader'>|null,scope:unknown,supplierCountryCode?:string):boolean {
  return Boolean(user?.isActive && isSharedAttachmentScope(scope) && (scope.target.kind!=='supplier'
    || supplierCountryCode && (supplierCountryCode!=='SG' || user.isAdmin || user.isSpcTrader)));
}
