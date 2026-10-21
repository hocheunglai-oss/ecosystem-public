export interface SupplierReport { id: string; supplierId: string; sourceId: string; fileName: string; size: number; sha256: string; documentDate: string; uploadedAt: string }
export interface SupplierReportAccess extends SupplierReport { objectPath: string }
export const supplierReportMaxBytes = 20 * 1024 * 1024;
