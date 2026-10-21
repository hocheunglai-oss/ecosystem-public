import type { IntelligenceSnapshotResult } from '../../shared/intelligence';

/** The authenticated API is the only source; malformed/absent data never becomes a zero ranking. */
export async function loadIntelligenceSnapshot(signal?: AbortSignal): Promise<IntelligenceSnapshotResult> {
  const response = await fetch('/api/intelligence/snapshot', {
    credentials: 'same-origin', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Fixture data unavailable');
  const result = await response.json() as IntelligenceSnapshotResult;
  if (result?.available === false && result.snapshot === null) return result;
  const snapshot = result?.snapshot;
  if (result?.available !== true || !snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.id !== 'string'
    || typeof snapshot.portId !== 'string' || typeof snapshot.periodEnd !== 'string'
    || !Array.isArray(snapshot.suppliers) || !Array.isArray(snapshot.counts)
    || !snapshot.suppliers.every(supplier => supplier && typeof supplier.id === 'string' && typeof supplier.name === 'string'
      && Array.isArray(supplier.portIds) && supplier.portIds.every(id => typeof id === 'string')
      && Array.isArray(supplier.grades) && supplier.grades.every(grade => typeof grade === 'string')
      && Number.isSafeInteger(supplier.fixtureCount) && supplier.fixtureCount! >= 0)) throw new Error('Fixture data unavailable');
  return result;
}
