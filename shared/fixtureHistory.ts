import type { FixtureEtaKind, FixtureGrade, FixtureOptions } from './fixtureWorkflow.ts';

export const fixtureHistoryPageSize = 100;
export const fixtureHistoryYears = Array.from({ length: Math.max(2, new Date().getUTCFullYear() - 2023) }, (_, index) => 2025 + index);

export interface FixtureHistoryQuery {
  year: number;
  month: number;
  search: string;
  page: number;
  supplierOffice?: string;
  supplierTrader?: string;
  buyerOffice?: string;
  buyerTrader?: string;
  deleted?: true;
  missing?: true;
  view?: 'register';
}

export interface FixtureTraderFilter { id: string; name: string; office: string; code: string }

interface FixtureSummary {
  hsfo?: string | null;
  vlsfo?: string | null;
  lsmgo?: string | null;
  cancelled?: boolean;
  id: string;
  date: string;
  eta?: string | null;
  vessel: string;
  imo?: string | null;
  status?: 'pending' | 'confirmed';
  etaEnd?: string | null;
  canEdit?: boolean;
  deleted?: boolean;
}

export interface FixtureHistoryItem extends FixtureSummary {
  supplierTraderId: string;
  buyerTraderId: string;
  missingBuyPrice?: boolean;
}

export interface FixtureImportHold extends FixtureSummary {
  reviewHold: {
    field: 'supplier' | 'buyer_trader' | 'quantity';
    grade?: FixtureGrade;
    workbook: string;
    tab: number;
    row: number;
  };
}

export interface FixtureHistoryPage {
  items: (FixtureHistoryItem | FixtureImportHold)[];
  total: number;
  filters?: { supplier: FixtureTraderFilter[]; buyer: FixtureTraderFilter[]; canSeeDeleted: boolean };
}

export interface FixtureRegisterLine {
  grade: FixtureGrade;
  quantity: string;
  supplierId: string;
  accountId: string;
  price: string;
  barging: string;
  cancelled: boolean;
}

export interface FixtureRegisterFields {
  vessel: string;
  imo: string;
  date: string;
  eta: string | null;
  etaEnd: string | null;
  etaKind: FixtureEtaKind;
  etaReviewed: boolean;
  lines: FixtureRegisterLine[];
}

export interface FixtureRegisterEditor {
  version: string;
  item: FixtureSummary & { supplierTrader: string; supplierOfficeCode: string; buyerTrader: string; buyerOfficeCode: string;
    sourceReinstated?: boolean; cancellation?: { at: string; by: string } | null };
  fields: FixtureRegisterFields;
  canConfirm: boolean;
  canCancel: boolean;
  canReinstate: boolean;
  suppliers: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  reference: string | null;
  quantityReview: FixtureOptions['quantityReview'];
}

export type FixtureRegisterChange = { dataMode: 'live'; id: string; version: string } & (
  | { action: 'update' | 'complete'; fields: FixtureRegisterFields; quantityReviewed: boolean }
  | { action: 'delete' | 'restore' }
);
export type FixtureRegisterMutation = FixtureRegisterChange & { requestId: string };

export type FixtureCancellationChange = { dataMode: 'live'; id: string; action: 'cancel' | 'reinstate' } & (
  { version: string } | { expectedRevision: number }
);
export type FixtureCancellationMutation = FixtureCancellationChange & { requestId: string };
