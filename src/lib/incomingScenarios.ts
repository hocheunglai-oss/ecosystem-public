import type { DemoState, Enquiry, EnquiryProduct } from './model';

export const incomingScenarios = [
  { id: 'normal', label: 'Normal enquiry' },
  { id: 'insufficient-credit', label: 'Insufficient credit' },
  { id: 'same-enquiry', label: 'Same enquiry · another trader' },
  { id: 'same-account', label: 'Same account · another trader' },
  { id: 'unknown-port', label: 'Unknown port' },
  { id: 'unknown-buyer', label: 'Unknown buyer' },
  { id: 'suspended-buyer', label: 'Suspended buyer' },
  { id: 'overdue-payment', label: 'Overdue payment' },
  { id: 'multi-grade', label: 'Three grades · split suppliers' },
  { id: 'pending-credit', label: 'Buyer awaiting credit approval' },
] as const;
export type IncomingScenarioId = typeof incomingScenarios[number]['id'];
const DAY = 86_400_000;
const date = (now: Date, offset: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(now.getTime() + offset * DAY)).toUpperCase();

export function incomingScenarioText(state: Pick<DemoState, 'companies' | 'ports' | 'enquiries'>, scenario: IncomingScenarioId, now = new Date(), owner = 'otto'): string {
  const choices: Record<IncomingScenarioId, { buyer: string; port: string; vessel: string; imo: string; products?: EnquiryProduct[]; remarks?: string }> = {
    normal: { buyer: 'meridian', port: 'singapore', vessel: 'ASTER HORIZON', imo: '9319466' },
    'insufficient-credit': { buyer: 'bluewater', port: 'hong-kong', vessel: 'BEACON STRAIT', imo: '9876543', remarks: 'URGENT LIFTING. CREDIT APPROVAL REQUIRED BEFORE STEM.' },
    'same-enquiry': { buyer: 'northern-star', port: 'rotterdam', vessel: 'BOREAL VENTURE', imo: '9319466' },
    'same-account': { buyer: 'eastbridge', port: 'singapore', vessel: 'LANTERN DAWN', imo: '9876543' },
    'unknown-port': { buyer: 'meridian', port: '', vessel: 'ASTER VOYAGER', imo: '9876543' },
    'unknown-buyer': { buyer: '', port: 'singapore', vessel: 'PELORUS DAWN', imo: '9319466' },
    'suspended-buyer': { buyer: 'seabright', port: 'gibraltar', vessel: 'HELIOS CROWN', imo: '9876543' },
    'overdue-payment': { buyer: 'atlas-blue', port: 'fujairah', vessel: 'CRESCENT PEARL', imo: '9319466' },
    'multi-grade': { buyer: 'pacific-orbit', port: 'singapore', vessel: 'KOYO SAPPHIRE', imo: '9876543', products: [{ grade: 'HSFO', quantityText: '400' }, { grade: 'VLSFO', quantityText: '600' }, { grade: 'LSMGO', quantityText: '80' }], remarks: 'SEPARATE SUPPLIERS ACCEPTABLE FOR EACH GRADE. COQ REQUIRED.' },
    'pending-credit': { buyer: 'novasea', port: 'singapore', vessel: 'NACRE PIONEER', imo: '9319466' },
  };
  const chosen = choices[scenario];
  if (!chosen) throw new Error('Select a valid demo scenario.');
  const buyer = state.companies.find(item => item.id === `company-${chosen.buyer}`);
  const port = state.ports.find(item => item.id === `port-${chosen.port}`);
  const peer = scenario === 'same-enquiry' ? state.enquiries.find(item => item.buyerId === buyer?.id && item.owner !== owner && item.id.startsWith('demo-v2-peer-') && ['draft', 'sent'].includes(item.status)) : undefined;
  const products = peer?.products ?? chosen.products ?? [{ grade: 'VLSFO', quantityText: '500' }, { grade: 'LSMGO', quantityText: '60' }];
  const buyerName = buyer?.name ?? (scenario === 'unknown-buyer' ? 'PELORUS NEW VENTURES PTE LTD' : 'UNMATCHED DEMO BUYER');
  const portName = port?.name ?? (scenario === 'unknown-port' ? 'Puerto Brisa' : 'UNMATCHED DEMO PORT');
  return [
    `Buyer: ${buyerName}`, `Vessel: ${peer?.vessel ?? chosen.vessel}`, `IMO: ${peer?.imo ?? chosen.imo}`,
    `Port: ${portName}`, `ETA: ${peer?.eta ?? `${date(now, 3)} - ${date(now, 5)}`}`,
    ...products.map(product => `${product.grade}: ${product.quantityText} MT`),
    `Remarks: ${chosen.remarks ?? 'COQ REQUIRED'}`,
  ].join('\n');
}

/** Counterpart examples are ordinary enquiries; owner and account rules remain unchanged. */
export function seedScenarioPeers(state: DemoState, now = new Date()) {
  for (const buyerSlug of ['northern-star', 'eastbridge']) {
    const buyer = state.companies.find(item => item.id === `company-${buyerSlug}`);
    const port = state.ports.find(item => item.id === (buyerSlug === 'northern-star' ? 'port-rotterdam' : 'port-singapore'));
    if (!buyer || !port) continue;
    for (const owner of ['luca', 'filippo']) {
      const id = `demo-v2-peer-${buyerSlug}-${owner}`;
      if (state.enquiries.some(item => item.id === id)) continue;
      const vessel = buyerSlug === 'northern-star' ? 'BOREAL VENTURE' : owner === 'luca' ? 'LANTERN CREST' : 'LANTERN TIDE';
      const products: EnquiryProduct[] = [{ grade: 'VLSFO', quantityText: '500' }, { grade: 'LSMGO', quantityText: '60' }];
      const enquiry: Enquiry = { id, buyerId: buyer.id, portId: port.id, vessel, imo: buyerSlug === 'northern-star' ? '9319466' : '9765433', eta: `${date(now, 3)} - ${date(now, 5)}`, grade: 'VLSFO', quantity: 0, price: 0, margin: 0, products, owner, status: 'sent', createdAt: new Date(now.getTime() - DAY).toISOString(), sentAt: new Date(now.getTime() - DAY).toISOString(), rawText: '', formattedText: '' };
      enquiry.rawText = [`Buyer: ${buyer.name}`, `Vessel: ${vessel}`, `IMO: ${enquiry.imo}`, `Port: ${port.name}`, `ETA: ${enquiry.eta}`, 'VLSFO: 500 MT', 'LSMGO: 60 MT'].join('\n');
      enquiry.formattedText = `${vessel} / ${port.name} / ${enquiry.eta} / VLSFO 500 MT / LSMGO 60 MT`;
      state.enquiries.push(enquiry);
    }
  }
}
