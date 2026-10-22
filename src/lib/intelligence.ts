import type { IntelligenceSnapshot, IntelligenceSupplier } from '../../shared/intelligence.ts';
export type { IntelligenceSupplier } from '../../shared/intelligence.ts';
import type { Port, DemoState } from './model.ts';
import { emptyIntelligenceKeyInfo } from './intelligenceFields.ts';
export type { IntelligenceKeyInfo } from './intelligenceFields.ts';

export interface RefineryInfo {
  name: string;
  location: string;
  capacity: string;
  sourceUrl?: string;
}

// Capacity is operator nameplate capacity, not a promise of bunker availability.
// ExxonMobil covers both Singapore refinery sites.
export const singaporeRefineries: RefineryInfo[] = [
  { name: 'ExxonMobil', location: 'Jurong + Jurong Island', capacity: '592,000 bpd combined', sourceUrl: 'https://corporate.exxonmobil.com/locations/singapore/our-operations' },
  { name: 'Aster Bukom', location: 'Pulau Bukom', capacity: '300,000 bpd', sourceUrl: 'https://www.aster.com.sg/about-us/aster-operations' },
  { name: 'SRC', location: 'Jurong Island', capacity: '290,000 bpd', sourceUrl: 'https://src.com.sg/about-us/' },
];

// Legacy fixture keys, verified against SPC's canonical supplier aliases.
const supplierSnapshotKey = (key: string) => ({eastpac:'eastpec',globalmarinetransportation:'globalmarinetransport'}[key.toLowerCase()] || key.toLowerCase());
export function fixtureCountsInPeriod(rows: {key: string; date: string; count: number}[], start: string, end: string) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.date >= start && row.date <= end && Number.isInteger(row.count) && row.count >= 0) counts.set(supplierSnapshotKey(row.key), (counts.get(supplierSnapshotKey(row.key)) || 0) + row.count);
  }
  return counts;
}
export function getLocationIntelligence(port: Port, knowledge?: DemoState['knowledgeRecords']) {
  const document = knowledge?.[`port:${port.id}`];
  const refineryTable = document?.sections.find(s=>s.role==='refineries' || (document.layoutVersion !== 2 && s.id==='refineries'))?.blocks.find(b=>b.type==='table');
  const editedRefineries = refineryTable?.type==='table' ? refineryTable.rows.map(row=>{
    const value=(id:string,label:string)=>row.cells[refineryTable.columns.findIndex(c=>c.id===id||c.name.toLowerCase()===label)]||'';
    return {name:value('refinery-data-c0','name'),location:value('refinery-data-c1','location'),capacity:value('refinery-data-c2','capacity')};
  }).filter(r=>r.name||r.location||r.capacity) : [];

  const mergedLocation = ['port-singapore', 'port-hong-kong'].includes(port.id) || port.name === port.country;
  return {
    keyInfo: port.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo(),
    refineries: document ? editedRefineries : port.id === 'port-singapore' ? singaporeRefineries : [],
    mergedLocation,
    countryName: port.id === 'port-hong-kong' ? 'Hong Kong' : port.country,
  };
}

/** SPC records describe Singapore delivery. ACCT is the trader's office, not the delivery port. */
export function rankIntelligenceSuppliers(suppliers: IntelligenceSupplier[], portId: string) {
  return suppliers
    .filter(supplier => supplier.portIds.includes(portId) && Number.isInteger(supplier.fixtureCount) && supplier.fixtureCount! >= 0)
    .sort((a, b) => b.fixtureCount! - a.fixtureCount! || a.name.localeCompare(b.name, 'en'));
}

/** Reference data is supplied only by the authenticated service; absence stays unknown. */
export function getSupplierIntelligence(portId: string, snapshot?: IntelligenceSnapshot | null) {
  const covered = Boolean(snapshot && portId === snapshot.portId);
  const ranked = covered && snapshot ? rankIntelligenceSuppliers(snapshot.suppliers, portId) : [];
  return {
    suppliers: ranked.slice(0, 10),
    supplierCount: covered ? ranked.length : null,
    rankingLabel: snapshot?.suppliers[0]?.fixturePeriod ?? (snapshot ? `${snapshot.periodStart} – ${snapshot.periodEnd}` : ''),
    rankingAsOf: snapshot?.periodEnd ?? null,
    sourceUrl: snapshot?.sourceUrl ?? null,
    recordedAt: snapshot?.recordedAt ?? null,
  };
}
