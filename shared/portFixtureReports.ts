export interface PortFixtureQuery {
  view: 'prices' | 'ranking' | 'statistics';
  portId: string;
  search: string;
  page: number;
}

export interface PortFixturePrices {
  items: { id: string; date: string; supplier: string; vessel: string; grade: string; quantity: string; price: number | null; recordedPrice: string | null }[];
  total: number;
  pageSize: number;
}

export interface PortFixtureRanking {
  items: { id: string; name: string; grades: string[]; fixtures: number }[];
  supplierCount: number;
  through: string;
  personal: boolean;
}

interface Point { label: string; value: number }
interface HitRate { label: string; enquiries: number; fixtures: number }

export interface SpcStatistics {
  year: number;
  through: string;
  monthly: { month: number; current: number; previous: number }[];
  estimated: boolean;
  cancelled: number;
  volumeBySupplier: Point[];
  fixturesBySupplier: Point[];
  volumeByOffice: Point[];
  fixturesByOffice: Point[];
  bySupplierTrader: Point[];
  enquiries: number;
  byBuyerOffice: HitRate[];
  byBuyerTrader: HitRate[];
}

export interface PortFixtureReports {
  prices: PortFixturePrices;
  ranking: PortFixtureRanking;
  statistics: SpcStatistics;
}
