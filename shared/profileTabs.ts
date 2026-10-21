/** Private collections are always scoped to the authenticated owner, never to a supplied user ID. */
export type ProfileKind = 'supplier'|'buyer'|'country'|'port';
export interface ProfileTarget {kind:ProfileKind;id:string}
export type ProfileTabVisibility = 'shared'|'private';
export const supplierBuiltinTabs = ['information','contacts','barges','sources'] as const;
export interface ProfileTab {id:string;title:string;visibility:ProfileTabVisibility;builtin?:typeof supplierBuiltinTabs[number];content?:string}
export interface ProfileTabScope {revision:number;tabs:ProfileTab[]}
export interface ProfileTabCollection {target:ProfileTarget;shared:ProfileTabScope;private:ProfileTabScope}
export interface ProfileTabWrite {requestId:string;target:ProfileTarget;visibility:ProfileTabVisibility;revision:number}
export interface ProfileTabsSave extends ProfileTabWrite {tabs:ProfileTab[]}
export interface ProfileTabDelete extends ProfileTabWrite {id:string}
export interface ProfileTabsReorder extends ProfileTabWrite {ids:string[]}
