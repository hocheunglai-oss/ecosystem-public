/** Invented ranking data only. Never substitute a production export in browser/unit fixtures. */
export function syntheticIntelligence() {
  const suppliers = Array.from({ length: 12 }, (_, index) => ({
    id: `synthetic-supplier-${index + 1}`, name: `SYNTHETIC SUPPLIER ${String(index + 1).padStart(2, '0')}`,
    portIds: ['port-singapore'], grades: index % 2 ? ['HSFO', 'VLSFO'] : ['VLSFO', 'LSMGO'],
    fixtureCount: index, fixturePeriod: 'Last 12 months', recordedAt: '2026-01-15T00:00:00Z',
  }));
  return { id: '10000000-0000-4000-8000-000000000099', schemaVersion: 1, portId: 'port-singapore',
    recordedAt: '2026-01-15T00:00:00Z', supplierRecordedAt: '2026-01-14T00:00:00Z',
    periodStart: '2025-01-15', periodEnd: '2026-01-14', sourceUrl: 'https://example.test/fixtures', supplierSourceUrl: 'https://example.test/suppliers',
    suppliers, counts: suppliers.map(supplier => ({ supplierId: supplier.id, date: '2026-01-14', count: supplier.fixtureCount })),
  };
}
export async function installIntelligence(context, snapshot = syntheticIntelligence()) {
  await context.route('**/api/intelligence/snapshot', route => route.fulfill({ json: { available: snapshot !== null, snapshot } }));
}
