import type { CommercialProduct } from './commercialEnquiries.ts';

export type FixtureGrade = CommercialProduct['grade'];
export const fixtureGrades = ['HSFO', 'VLSFO', 'LSMGO'] as const;
export type FixtureEtaKind = 'date' | 'range' | 'earliest';
export interface FixtureSchedule {
  date: string;
  eta: string;
  etaEnd: string | null;
  etaKind: FixtureEtaKind;
  etaReviewed: boolean;
}
export interface FixtureAssignment extends FixtureSchedule {
  id: string;
  revision: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'deleted';
  supplierTraderId: string;
  supplierTrader: string;
}
export interface FixtureSupplyLine {
  grade: FixtureGrade;
  quantity: number;
  supplierId: string;
  accountId: string;
  buyPrice: number;
}
export interface FixtureBooking extends FixtureAssignment {
  vessel: string;
  imo: string;
  reference: string;
  buyerTrader: string;
  confirmedAt: string | null;
  canConfirm: boolean;
  canCancel: boolean;
  cancellation: { at: string; by: string; reason: string } | null;
  requested: CommercialProduct[];
  lines: (FixtureSupplyLine & { supplier: string; supplierAvailable: boolean; account: string; barging?: string | null })[];
}
export interface FixtureOptions {
  traders: { id: string; name: string; office: string }[];
  accounts: { id: string; name: string }[];
  quantityReview: Record<FixtureGrade, { min: number; max: number }>;
}
type FixtureWrite = { dataMode: 'live'; requestId: string; expectedRevision: number };
export type AssignFixture = FixtureWrite & FixtureSchedule & { action: 'assign'; enquiryId: string; supplierTraderId: string };
export type ConfirmFixture = FixtureWrite & { action: 'confirm'; id: string; lines: FixtureSupplyLine[]; quantityReviewed: boolean };
export type CancelFixture = FixtureWrite & { action: 'cancel'; id: string; reason: string };
export type FixtureMutation = AssignFixture | ConfirmFixture | CancelFixture;

export function isFixtureDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:19|20)\d\d-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
