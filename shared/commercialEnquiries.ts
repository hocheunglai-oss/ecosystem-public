import type { ParserSnapshot } from './parserService.ts';

export type CommercialEnquiryStatus = 'draft' | 'confirmed';
export type CommercialEnquiryScope = 'mine' | 'singapore';
export interface CommercialProduct { grade: 'HSFO' | 'VLSFO' | 'LSMGO'; quantityText: string }
/** Immutable, client-reported parsing evidence; an inbox link is independently verified. */
export interface CommercialSource { rawText: string; parsed: ParserSnapshot | null; parserVersion: string | null; inboxId: string | null }
export interface CommercialReviewed {
  vessel: string; imo: string; eta: string; portId: string | null;
  buyerText: string | null; buyerId: null;
  products: CommercialProduct[]; remarks: string; rmk: boolean;
  viscosity: string[]; formattedText: string; warnings: string[];
}
export interface CommercialPort { id: string; countryCode: string; countryName: string; portName: string }
export interface CommercialQueue { status: 'awaiting_connection'; queuedAt: string }
/** Safe projection used by both lists; never contains source, buyer or private notes. */
export interface CommercialEnquirySummary {
  id: string; reference: string; ownerId: string; ownerName: string; revision: number;
  status: CommercialEnquiryStatus; vessel: string; imo: string; eta: string;
  products: CommercialProduct[]; port: CommercialPort | null; queue: CommercialQueue | null;
  createdAt: string; updatedAt: string; confirmedAt: string | null;
}
export interface CommercialEnquiry extends CommercialEnquirySummary { source: CommercialSource; reviewed: CommercialReviewed }
export interface CommercialEnquiryPage { items: CommercialEnquirySummary[]; nextCursor: string | null }
export interface CommercialEnquiryMutation {
  dataMode: 'live'; requestId: string; id: string; expectedRevision: number;
  action: 'save' | 'confirm'; source: CommercialSource; reviewed: CommercialReviewed;
}
export interface CommercialEnquiryMutationResult { requestId: string; item: CommercialEnquiry }
export type CommercialEnquiryQuery = { dataMode: 'live'; id: string } | { dataMode: 'live'; inboxId: string } | { dataMode: 'live'; scope: CommercialEnquiryScope; limit: number; cursor?: string };
