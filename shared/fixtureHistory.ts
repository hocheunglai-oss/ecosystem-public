import type { FixtureEtaKind, FixtureGrade, FixtureOptions } from './fixtureWorkflow.ts';

export const fixtureHistoryPageSize = 50;
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
}

export interface FixtureTraderFilter { id: string; name: string; office: string; code: string }

export interface FixtureHistorySupplyRow {
  account: string | null;
  hsfo: string | null;
  vlsfo: string | null;
  lsmgo: string | null;
  supplierId: string;
  supplier: string;
  supplierAvailable: boolean;
  price: string | null;
  barging: string | null;
  cancelled?: boolean;
}

export interface FixtureHistoryItem extends FixtureHistorySupplyRow {
  id: string;
  date: string;
  supplierTrader: string;
  supplierOffice: string;
  supplierOfficeCode?: string;
  buyerTrader: string;
  buyerOffice: string;
  buyerOfficeCode?: string;
  eta: string | null;
  vessel: string;
  imo: string | null;
  supplyRows?: FixtureHistorySupplyRow[];
  status?: 'pending' | 'confirmed';
  etaEnd?: string | null;
  etaKind?: FixtureEtaKind;
  canEdit?: boolean;
  deleted?: boolean;
  cancellation?: { at: string; by: string; reason: string } | null;
}

export interface FixtureHistoryPage {
  items: FixtureHistoryItem[];
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
  item: FixtureHistoryItem;
  fields: FixtureRegisterFields;
  canConfirm: boolean;
  canCancel: boolean;
  suppliers: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  reference: string | null;
  quantityReview: FixtureOptions['quantityReview'];
}

export type FixtureRegisterChange = { dataMode: 'live'; id: string; version: string } & (
  | { action: 'update' | 'complete'; fields: FixtureRegisterFields; quantityReviewed: boolean }
  | { action: 'void'; reason: string }
  | { action: 'delete' | 'restore' }
);
export type FixtureRegisterMutation = FixtureRegisterChange & { requestId: string };
