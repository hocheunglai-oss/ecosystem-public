import type { CommercialEnquiryMutation, CommercialEnquiryQuery, CommercialProduct } from '../../shared/commercialEnquiries.ts';
import { parseProductQuantity } from '../../shared/productQuantity.ts';
import { supplierPortById } from '../../shared/supplierPorts.ts';
import { snapshot } from '../parser/validation.ts';
import { ApiError } from '../auth/validation.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const viscosity = ['80cst min', '80cst max', '120cst max', '180cst max'];
function fail(): never { throw new ApiError(400, 'Invalid enquiry request.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, min = 0): string {
  return typeof value === 'string' && value.trim().length >= min && Buffer.byteLength(value, 'utf8') <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : fail();
}
function uuid(value: unknown): string { return typeof value === 'string' && UUID.test(value) ? value : fail(); }
function warnings(value: unknown): string[] { if (!Array.isArray(value) || value.length > 100) return fail(); return value.map(item => text(item, 2000)); }
export function commercialMutation(value: unknown): CommercialEnquiryMutation {
  const v = object(value, ['dataMode','requestId','id','expectedRevision','action','source','reviewed']);
  if (v.dataMode !== 'live') throw new ApiError(403, 'Switch to LIVE to save shared enquiries.');
  if (!Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 0 || Number(v.expectedRevision) > 2147483646 || !['save','confirm'].includes(String(v.action))) return fail();
  const source = object(v.source, ['rawText','parsed','parserVersion','inboxId']);
  const r = object(v.reviewed, ['vessel','imo','eta','portId','buyerText','buyerId','products','remarks','rmk','viscosity','formattedText','warnings']);
  if (r.portId !== null && !supplierPortById(text(r.portId, 100, 1))) return fail();
  if (r.buyerId !== null || typeof r.rmk !== 'boolean' || !Array.isArray(r.viscosity) || r.viscosity.length > 4 || new Set(r.viscosity).size !== r.viscosity.length || r.viscosity.some(item => !viscosity.includes(item))) return fail();
  if (!Array.isArray(r.products) || r.products.length > 3) return fail();
  const products = r.products.map(item => {
    const p = object(item, ['grade','quantityText']);
    if (!['HSFO','VLSFO','LSMGO'].includes(String(p.grade))) return fail();
    return {grade:p.grade as CommercialProduct['grade'],quantityText:text(p.quantityText,100)};
  });
  if (new Set(products.map(p => p.grade)).size !== products.length) return fail();
  const reviewed = {vessel:text(r.vessel,500),imo:text(r.imo,50),eta:text(r.eta,500),portId:r.portId as string|null,buyerId:null,
    buyerText:r.buyerText === null ? null : text(r.buyerText,500),products,remarks:text(r.remarks,3000),rmk:r.rmk,
    viscosity:r.viscosity as string[],formattedText:text(r.formattedText,20000),warnings:warnings(r.warnings)};
  if (v.action === 'confirm') {
    if (!reviewed.portId || !reviewed.vessel.trim() || !reviewed.eta.trim() || !reviewed.formattedText.trim() || !products.length || (reviewed.imo && !/^[0-9]{7}$/.test(reviewed.imo))) return fail();
    for (const p of products) {
      const quantity = parseProductQuantity(p.quantityText);
      if (!quantity || quantity.max > 1_000_000) return fail();
    }
  }
  return {dataMode:'live',requestId:uuid(v.requestId),id:uuid(v.id),expectedRevision:Number(v.expectedRevision),action:v.action as 'save'|'confirm',
    source:{rawText:text(source.rawText,20000),parsed:source.parsed === null ? null : snapshot(source.parsed),
      parserVersion:source.parserVersion === null ? null : text(source.parserVersion,128,1),inboxId:source.inboxId === null ? null : uuid(source.inboxId)},reviewed};
}
export function commercialQuery(url: URL): CommercialEnquiryQuery {
  const q = Object.fromEntries(url.searchParams);
  if (url.searchParams.size !== Object.keys(q).length || Object.keys(q).some(key => !['id','inboxId','scope','limit','cursor'].includes(key))) return fail();
  if (q.id !== undefined) { if (Object.keys(q).length !== 1) return fail(); return {dataMode:'live',id:uuid(q.id)}; }
  if (q.inboxId !== undefined) { if (Object.keys(q).length !== 1) return fail(); return {dataMode:'live',inboxId:uuid(q.inboxId)}; }
  const scope = q.scope ?? 'mine', limit = q.limit === undefined ? 25 : Number(q.limit);
  if (!['mine','singapore'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 50 || (q.limit !== undefined && !/^[1-9][0-9]?$/.test(q.limit))) return fail();
  if (q.cursor !== undefined) {
    const [stamp,id,extra] = q.cursor.split('|');
    if (q.cursor.length > 100 || extra !== undefined || !/^\d{4}-\d\d-\d\d[T ]/.test(stamp) || !Number.isFinite(Date.parse(stamp)) || !UUID.test(id ?? '')) return fail();
  }
  return {dataMode:'live',scope:scope as 'mine'|'singapore',limit,...(q.cursor ? {cursor:q.cursor} : {})};
}
