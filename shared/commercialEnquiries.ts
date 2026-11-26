import type { ParserSnapshot } from './parserService.ts';
import type { FixtureAssignment } from './fixtureWorkflow.ts';

export type CommercialEnquiryStatus = 'draft' | 'confirmed';
export type CommercialEnquiryScope = 'mine' | 'singapore' | 'workbench' | 'lost';
export type CommercialEnquiryOutcome = 'postponed' | 'lost' | 'cancelled';
export const buyerLostReasons = [
  'MINIMUM MARGIN', 'CREDIT OR PAYMENT TERMS', 'COVERAGE (SUPPLIER NOT COVERED)',
  'COVERAGE (LIMITED BY CUSTOMER)', 'NOT TIMELY OFFERED', 'DOUBLE TRADING', 'T&C', 'UNKNOWN',
] as const;
export type BuyerLostReason = typeof buyerLostReasons[number];
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
export const deliveryStates = ['queued', 'claimed', 'sending', 'sent', 'manual_review'] as const;
export interface CommercialQueue { status: 'awaiting_connection'; queuedAt: string; delivery?: typeof deliveryStates[number] }
export function deliveryLabel(queue: CommercialQueue): string {
  if (!queue.delivery) return 'Awaiting connection';
  if (queue.delivery === 'sent') return 'Sent to WhatsApp';
  if (queue.delivery === 'manual_review') return 'Delivery needs review';
  return queue.delivery === 'queued' ? 'Queued for WhatsApp' : 'Sending to WhatsApp';
}
/** Safe projection used by both lists; never contains source, buyer or private notes. */
export interface CommercialEnquirySummary {
  id: string; reference: string; ownerId: string; ownerName: string; revision: number;
  status: CommercialEnquiryStatus; vessel: string; imo: string; eta: string;
  products: CommercialProduct[]; port: CommercialPort | null; queue: CommercialQueue | null;
  createdAt: string; updatedAt: string; confirmedAt: string | null;
  fixture?: FixtureAssignment;
  outcome?: CommercialEnquiryOutcome;
  lostReason?: BuyerLostReason;
}
export interface CommercialEnquiry extends CommercialEnquirySummary { source: CommercialSource; reviewed: CommercialReviewed; workingText?: string }
export interface CommercialEnquiryPage { items: CommercialEnquirySummary[]; nextCursor: string | null }
export interface CommercialEnquiryMutation {
  dataMode: 'live'; requestId: string; id: string; expectedRevision: number;
  action: 'save' | 'confirm' | 'amend' | 'reoffer'; source: CommercialSource; reviewed: CommercialReviewed;
  workingText?: string;
}
export type CommercialEnquiryDecision = Pick<CommercialEnquiryMutation, 'id' | 'requestId' | 'dataMode' | 'expectedRevision'> &
  ({ action: 'cancel' | 'postpone' } | { action: 'lost'; lostReason: BuyerLostReason });
export interface CommercialEnquiryMutationResult { requestId: string; item: CommercialEnquiry }
export type CommercialEnquiryQuery = { dataMode: 'live'; id: string } | { dataMode: 'live'; inboxId: string } | { dataMode: 'live'; scope: CommercialEnquiryScope; limit: number; cursor?: string };
