import type { FixtureEtaKind } from './fixtureWorkflow.ts';

export const fixtureHistoryPageSize = 50;
export const fixtureHistoryYears = Array.from({ length: Math.max(2, new Date().getUTCFullYear() - 2023) }, (_, index) => 2025 + index);

export interface FixtureHistoryQuery {
  year: number;
  month: number;
  search: string;
  page: number;
}

export interface FixtureHistoryItem {
  id: string;
  date: string;
  supplierTrader: string;
  supplierOffice: string;
  buyerTrader: string;
  buyerOffice: string;
  account: string | null;
  eta: string | null;
  vessel: string;
  imo: string | null;
  hsfo: string | null;
  vlsfo: string | null;
  lsmgo: string | null;
  supplierId: string;
  supplier: string;
  supplierAvailable: boolean;
  price: string | null;
  barging: string | null;
  status?: 'pending' | 'confirmed';
  etaEnd?: string | null;
  etaKind?: FixtureEtaKind;
}

export interface FixtureHistoryPage {
  items: FixtureHistoryItem[];
  total: number;
}
