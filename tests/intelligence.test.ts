import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticIntelligence } from './fixtures/intelligence.mjs';
import type { IntelligenceSnapshot } from '../shared/intelligence';
import { createSeedState } from '../src/lib/seed';
import { getLocationIntelligence, getSupplierIntelligence, rankIntelligenceSuppliers, fixtureCountsInPeriod } from '../src/lib/intelligence';

test('fixture ranking uses last-12-month counts for the selected delivery port and stable ties', () => {
  const profile = (syntheticIntelligence() as IntelligenceSnapshot).suppliers[0];
  const inputs = [
    { ...profile, id: 'z', name: 'Zeta', fixtureCount: 4 },
    { ...profile, id: 'a', name: 'Alpha', fixtureCount: 4 },
    { ...profile, id: 'leader', name: 'Leader', fixtureCount: 20 },
    { ...profile, id: 'other-port', name: 'Other port', portIds: ['port-hong-kong'], fixtureCount: 1000 },
    { ...profile, id: 'unknown', name: 'Unknown', fixtureCount: undefined },
  ];
  const before = structuredClone(inputs);
  assert.deepEqual(rankIntelligenceSuppliers(inputs, 'port-singapore').map(item => item.id), ['leader', 'a', 'z']);
  assert.deepEqual(inputs, before, 'Ranking cannot reorder the shared directory');
  assert.equal(rankIntelligenceSuppliers(inputs.slice(0, 2), 'port-singapore').length, 2);
});

test('authenticated synthetic snapshot preserves IDs, counts and top-ten selection', () => {
  const snapshot = syntheticIntelligence() as IntelligenceSnapshot;
  const before = structuredClone(snapshot);
  const brief = getSupplierIntelligence('port-singapore', snapshot);
  assert.equal(brief.supplierCount, snapshot.suppliers.length);
  assert.equal(brief.suppliers.length, 10);
  assert.deepEqual(brief.suppliers.slice(0, 2).map(item => [item.id, item.fixtureCount]), [['synthetic-supplier-12', 11], ['synthetic-supplier-11', 10]]);
  assert.equal(brief.rankingLabel, 'Last 12 months');
  assert.equal(brief.rankingAsOf, snapshot.periodEnd);
  assert.deepEqual(snapshot, before);
});

test('unprovisioned data is unavailable, never a fabricated zero ranking', () => {
  const brief = getSupplierIntelligence('port-singapore');
  assert.equal(brief.supplierCount, null);
  assert.deepEqual(brief.suppliers, []);
  assert.equal(brief.rankingAsOf, null);
});

test('missing delivery-port coverage stays unknown', () => {
  const brief = getSupplierIntelligence('port-hong-kong', syntheticIntelligence() as IntelligenceSnapshot);
  assert.equal(brief.supplierCount, null);
  assert.equal(brief.suppliers.length, 0);
});

test('supplier counts exclude dates outside the requested 12-month window', () => {
  const result = fixtureCountsInPeriod([
    {key:'EXAMPLE',date:'2025-10-02',count:100},
    {key:'EXAMPLE',date:'2025-10-03',count:2},
    {key:'example',date:'2026-10-02',count:3},
    {key:'EXAMPLE',date:'2026-10-03',count:100},
  ],'2025-10-03','2026-10-02');
  assert.equal(result.get('example'),5);
});

test('location briefing preserves unknown commercial statuses and shares combined port/country records', () => {
  const state = createSeedState();
  for (const id of ['port-singapore', 'port-hong-kong']) {
    const port = state.ports.find(item => item.id === id)!;
    const brief = getLocationIntelligence({...port,intelligenceKeyInfo:undefined});
    assert.equal(brief.mergedLocation, true);
    assert.deepEqual(Object.values(brief.keyInfo), [null, null, null, null]);
  }
  const rotterdam = getLocationIntelligence(state.ports.find(item => item.id === 'port-rotterdam')!);
  assert.equal(rotterdam.mergedLocation, false);
  assert.equal(rotterdam.refineries.length, 0);
  const singapore = getLocationIntelligence(state.ports[0]);
  assert.equal(singapore.refineries.length, 3);

});


test('a non-annual imported period is not labelled as twelve months', () => {
  const snapshot = syntheticIntelligence() as IntelligenceSnapshot;
  snapshot.periodStart = '2026-01-01';
  for (const supplier of snapshot.suppliers) supplier.fixturePeriod = '2026-01-01 – 2026-01-14';
  assert.equal(getSupplierIntelligence(snapshot.portId, snapshot).rankingLabel, '2026-01-01 – 2026-01-14');
  snapshot.suppliers = [];
  assert.equal(getSupplierIntelligence(snapshot.portId, snapshot).rankingLabel, '2026-01-01 – 2026-01-14');
});
