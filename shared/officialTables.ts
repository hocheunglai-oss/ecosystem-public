export const officialTableFeedId = 'mpa-singapore-alternative-fuels' as const;
export const officialFuelIds = ['lng', 'methanol', 'ammonia', 'ethanol'] as const;
export type OfficialFuelId = typeof officialFuelIds[number];
export interface OfficialTableRow {
  id: OfficialFuelId;
  fuel: string;
  position: string;
  sourceUrl: string;
  sourceTitle: string;
  publishedAt: string;
  checkedAt: string;
  evidenceHash: string;
}
export interface OfficialTableSnapshot {
  feedId: typeof officialTableFeedId;
  status: 'current' | 'stale' | 'unavailable';
  checkedAt: string | null;
  updatedAt: string | null;
  rows: OfficialTableRow[];
  message?: string;
}
export interface OfficialTableResult { snapshot: OfficialTableSnapshot }
