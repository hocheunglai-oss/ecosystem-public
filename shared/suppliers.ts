/** Shared supplier identity. Singapore directory and profile always reference the same UUID. */
export const supplierContractVersion = 1 as const;
export const supplierInfoKeys = ['paymentTerms','qualityClaimBar','supplierTrader','availableGrade','foBdn','goBdn'] as const;
export type SupplierInfo = Record<typeof supplierInfoKeys[number], string>;
export interface SupplierSource { id:string; type:'mpa'|'spc'|'infospectrum'|'website'|'user'; title:string; url:string; documentDate:string; retrievedAt:string; page?:string; reference?:string }
export interface SupplierContact { id:string; role:'sales'|'ops'|'general'; name:string; phone:string; email:string; sourceId:string }
export interface SupplierBarge { id:string; name:string; imo:string; grade:string; capacity:string; sourceId:string }
export interface SupplierFact { label:string; value:string; sourceId:string }
export interface SupplierImportRecord {
 id:string; legacyIds:string[]; sourceKey:string; legalName:string; shortName:string; aliases:string[];
 countryCode:string; countryName:string; portName:string; nameStatus:'verified'|'needs-review'; legalNameSourceId:string|null;
 info:SupplierInfo; contacts:SupplierContact[]; barges:SupplierBarge[]; facts:SupplierFact[]; sources:SupplierSource[];
}
export interface SupplierRecord extends SupplierImportRecord { revision:number; updatedAt:string; background?:string }
export type SupplierSummary = Omit<SupplierRecord,'contacts'|'barges'|'facts'|'sources'> & {contactCount:number;bargeCount:number};
export interface SupplierListQuery {search:string;country:string;grade:string;trader:string;page:number;limit:number;portId?:string}
export interface SupplierPage {items:SupplierSummary[];page:number;pageSize:number;total:number}
export interface SupplierUpdate {requestId:string;id:string;revision:number;info:SupplierInfo;contacts:SupplierContact[];barges:SupplierBarge[];legalName?:string;shortName?:string;background?:string}
/** Operator import is service-role-only; it has no HTTP/browser route. Existing records are preserved. */
export interface SupplierImport {requestId:string;operatorId:string;sourceHash:string;records:SupplierImportRecord[]}
export interface SupplierImportResult {batchId:string;inserted:number;preserved:number;items:{id:string;sourceKey:string;status:'inserted'|'preserved'}[]}
export interface SupplierEnrichment {requestId:string;operatorId:string;id:string;revision:number;legalName:string;nameStatus:SupplierRecord['nameStatus'];legalNameSourceId:string|null;facts:SupplierFact[];sources:SupplierSource[]}

export interface SupplierCreate {requestId:string;legalName:string;shortName:string;portId?:string;countryCode:string;countryName:string;portName:string;background:string;info:SupplierInfo;contacts:SupplierContact[];barges:SupplierBarge[]}
export interface SupplierArchive {requestId:string;id:string;revision:number}
export interface SupplierArchiveResult {id:string;revision:number;archivedAt:string}
