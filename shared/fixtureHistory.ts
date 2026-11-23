export const fixtureHistoryPageSize = 50;
export const fixtureHistoryYears = [2025, 2026] as const;

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
}

export interface FixtureHistoryPage {
  items: FixtureHistoryItem[];
  total: number;
}
