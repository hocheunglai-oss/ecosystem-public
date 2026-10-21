/** Authenticated reference data. Never import business snapshots into browser bundles. */
export interface IntelligenceSupplier {
  id: string;
  name: string;
  companyId?: string;
  portIds: string[];
  grades: string[];
  paymentTerms?: string;
  qualityClaimBar?: string;
  supplierTrader?: string;
  foBdn?: string;
  goBdn?: string;
  bargeCount?: number;
  sourceUrl?: string;
  fixtureCount?: number;
  fixturePeriod?: string;
  recordedAt?: string;
}
export interface IntelligenceFixtureCount { supplierId: string; date: string; count: number }
export interface IntelligenceSnapshot {
  id: string;
  schemaVersion: 1;
  portId: string;
  recordedAt: string;
  supplierRecordedAt: string;
  periodStart: string;
  periodEnd: string;
  sourceUrl: string;
  supplierSourceUrl: string;
  suppliers: IntelligenceSupplier[];
  counts: IntelligenceFixtureCount[];
}
export type IntelligenceSnapshotResult = { available: false; snapshot: null } | { available: true; snapshot: IntelligenceSnapshot };
export type IntelligenceSnapshotInput = Omit<IntelligenceSnapshot, 'id' | 'suppliers'> & {
  suppliers: Omit<IntelligenceSupplier, 'fixtureCount' | 'fixturePeriod' | 'recordedAt'>[];
};
export interface IntelligenceImportInput {
  requestId: string;
  operatorId: string;
  expectedActiveId: string | null;
  sourceHash: string;
  snapshot: IntelligenceSnapshotInput;
}
export interface IntelligenceImportReceipt {
  snapshotId: string;
  previousSnapshotId: string | null;
  sourceHash: string;
  suppliers: number;
  counts: number;
}
