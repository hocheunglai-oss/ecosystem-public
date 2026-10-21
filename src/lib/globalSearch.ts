import type { Actor, DemoState } from './model';
import { canTrade } from './model';
import { locationProfileTarget, locationRecords } from './locations';
import { supplierName, supplierShortName } from './supplierPresentation';
import type { SupplierSummary } from '../../shared/suppliers';
import type { IncomingEnquiry } from '../inbox';
import type { ModalSpec } from '../types';
import type { WorkspaceId, WorkspaceNavigationContext } from '../workspaceNavigation';

export interface GlobalSearchRecord {
  id: string;
  category: 'Buyer' | 'Supplier' | 'Country' | 'Port' | 'Enquiry' | 'Fixture' | 'Lost Record';
  title: string;
  detail: string;
  text: string;
  workspace?: WorkspaceId;
  context?: WorkspaceNavigationContext;
  modal?: ModalSpec;
  incomingId?: string;
}
const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

/** Index public directories and shared outcomes, but only the current trader's active work. */
export function globalSearchRecords(state: DemoState, actor: Actor, incoming: IncomingEnquiry[], suppliers: readonly SupplierSummary[] = [], buyerCreditAvailable = false): GlobalSearchRecord[] {
  const buyers = new Map(state.companies.map(buyer => [buyer.id, buyer]));
  const ports = new Map(state.ports.map(port => [port.id, port]));
  const records: GlobalSearchRecord[] = (buyerCreditAvailable ? state.companies : []).map(buyer => ({
    id: `buyer:${buyer.id}`, category: 'Buyer', title: buyer.name,
    detail: [buyer.customerId, buyer.office, buyer.accountGroupName].filter(Boolean).join(' · '),
    text: [buyer.name, buyer.customerId, buyer.accountGroupName, ...buyer.aliases].join(' '),
    workspace: 'counterparties', context: { buyerId: buyer.id },
  }));
  for (const supplier of suppliers) records.push({
    id: `supplier:${supplier.id}`, category: 'Supplier', title: supplierName(supplier),
    detail: [supplierShortName(supplier), supplier.countryName, supplier.portName].join(' · '),
    text: [supplierName(supplier), supplierShortName(supplier), supplier.legalName, supplier.shortName, ...supplier.aliases, supplier.info.availableGrade, supplier.countryName, supplier.portName].join(' '),
    workspace: 'suppliers', context: { supplierId: supplier.id, fromSearch: true },
  });
  const locations = locationRecords(state);
  const locationsByKey = new Map(locations.map(location => [location.key, location]));
  const locationResults = new Map<string, GlobalSearchRecord>();
  for (const location of locations) {
    const target = locationProfileTarget(state, location.target);
    const key = `${target.kind}:${target.id}`;
    const profile = locationsByKey.get(key) ?? location;
    const text = [location.name, location.path, location.kind === 'port' ? ports.get(location.target.id)?.code : ''].join(' ');
    const existing = locationResults.get(key);
    if (existing) existing.text += ` ${text}`;
    else locationResults.set(key, {
      id: profile.key, category: profile.kind === 'port' ? 'Port' : 'Country', title: profile.name,
      detail: profile.path, text, workspace: 'ports',
      context: profile.kind === 'port' ? { portId: profile.target.id } : { country: profile.target.id },
    });
  }
  records.push(...locationResults.values());
  const outcomeIds = new Set(state.outcomes.map(outcome => outcome.enquiryId));
  const enquiryIds = new Set(state.enquiries.map(enquiry => enquiry.id));
  for (const enquiry of state.enquiries) {
    if (outcomeIds.has(enquiry.id) || !canTrade(actor) || enquiry.owner !== actor.id) continue;
    const buyer = buyers.get(enquiry.buyerId)?.name ?? '';
    const port = ports.get(enquiry.portId)?.name ?? '';
    records.push({ id: `enquiry:${enquiry.id}`, category: 'Enquiry', title: enquiry.vessel || 'Enquiry', detail: [enquiry.imo, buyer, port, enquiry.eta].filter(Boolean).join(' · '), text: [enquiry.vessel, enquiry.imo, buyer, port, enquiry.id].join(' '), workspace: 'enquiry', context: { enquiryId: enquiry.id } });
  }
  for (const outcome of state.outcomes) {
    if (!enquiryIds.has(outcome.enquiryId)) continue;
    const buyer = buyers.get(outcome.buyerId)?.name ?? '';
    const port = ports.get(outcome.portId)?.name ?? '';
    records.push({ id: `outcome:${outcome.id}`, category: outcome.kind === 'fixture' ? 'Fixture' : 'Lost Record', title: outcome.vessel || 'Vessel', detail: [outcome.stemNumber, outcome.imo, buyer, port].filter(Boolean).join(' · '), text: [outcome.vessel, outcome.imo, outcome.stemNumber, buyer, port].join(' '), modal: { type: 'enquiry-detail', id: outcome.enquiryId } });
  }
  for (const item of incoming) {
    if (!canTrade(actor) || item.owner !== actor.id || item.dismissed || (item.enquiryId && enquiryIds.has(item.enquiryId))) continue;
    const vessel = item.rawText.match(/^Vessel:\s*(.+)$/im)?.[1] ?? 'Incoming enquiry';
    const buyer = item.rawText.match(/^Buyer:\s*(.+)$/im)?.[1] ?? '';
    records.push({ id: `incoming:${item.id}`, category: 'Enquiry', title: vessel, detail: [buyer, item.channel].filter(Boolean).join(' · '), text: item.rawText, workspace: 'enquiry', incomingId: item.id });
  }
  return records.map(record => ({ ...record, text: normalized(record.text) }));
}

export function queryGlobalSearch(records: GlobalSearchRecord[], query: string, limit = 20) {
  const needle = normalized(query);
  if (!needle) return [];
  const terms = needle.split(' ');
  const categoryOrder = { Buyer: 0, Supplier: 1, Country: 2, Port: 3, Enquiry: 4, Fixture: 5, 'Lost Record': 6 };
  return records.filter(record => terms.every(term => record.text.includes(term)))
    .map(record => ({ record, score: normalized(record.title) === needle ? 0 : normalized(record.title).startsWith(needle) ? 1 : 2 }))
    .sort((a, b) => a.score - b.score || categoryOrder[a.record.category] - categoryOrder[b.record.category] || a.record.title.localeCompare(b.record.title) || a.record.id.localeCompare(b.record.id))
    .slice(0, limit).map(({ record }) => record);
}
