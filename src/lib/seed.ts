import { flattenLocationHierarchy } from './locationMigration';
import { retireFictionalSupplierRecords } from './supplierRetirement';
import { demoKnowledgeSections, enrichDemoKnowledge } from "./knowledgeDemo";
import { needsKnowledgeTitles, withDefaultKnowledgeSections, withRequiredKnowledgeTitles, type KnowledgeTarget } from "./knowledge";
import { currentMonth, defaultProfiles, type Company, type DemoState, type Enquiry, type Outcome, type Port } from './model';
import { migrateContributionEconomy } from './economy';
import { defaultLostReasons } from './lostReasons';
import { locationCountries } from './locations';
import { initializeCreditRemarkHistory, needsCreditRemarkHistory } from './credit';

import { enrichDemoScenario, DEMO_SCENARIO_VERSION } from './demoScenario';

const SELLER = 'ECOSYSTEM Marine Energy (Demo)';
const NOTICE = 'Illustrative demo information; not verified operational or navigation guidance.';

/** Synthetic names, credit positions and trading records. All emails use reserved .example domains. */
export function createSeedState(): DemoState {
  const now = new Date();
  const month = currentMonth(now);
  const today = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', day: '2-digit' }).format(now));
  const day = (value: number, hour = 9) => {
    const planned = `${month}-${String(Math.min(value, today)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    return Date.parse(planned) > now.getTime() ? now.toISOString() : planned;
  };
  const prior = new Date();
  prior.setDate(1);
  prior.setMonth(prior.getMonth() - 1);
  const previousMonth = currentMonth(prior);
  const companies: Company[] = [
    ['meridian', 'Meridian Shipping Pte Ltd', ['Meridian', 'Meridian Shipping'], 'Singapore', 'Singapore', 1800000, 610000, 0, '30 days', 'Regional dry-bulk buyer. Demo contact prefers a concise enquiry with vessel and delivery window.'],
    ['bluewater', 'Bluewater Navigation Ltd', ['Bluewater', 'Bluewater Navigation'], 'Hong Kong', 'Hong Kong', 900000, 780000, 35000, '30 days', 'Demonstration of constrained credit headroom. Existing exposure includes the overdue balance; do not add it twice.'],
    ['harborlight', 'Harborlight Maritime SA', ['Harborlight'], 'Greece', 'Piraeus', 1200000, 315000, 0, '30 days', 'Mixed-fleet buyer with Mediterranean enquiries.'],
    ['northern-star', 'Northern Star Carriers AS', ['Northern Star'], 'Norway', 'Bergen', 1400000, 525000, 0, '21 days', 'Regular European liftings.'],
    ['pacific-orbit', 'Pacific Orbit Lines KK', ['Pacific Orbit'], 'Japan', 'Tokyo', 1600000, 480000, 0, '30 days', 'Pacific services; confirm the buying entity for each vessel.'],
    ['coral-route', 'Coral Route Shipping Ltd', ['Coral Route'], 'United Kingdom', 'London', 750000, 255000, 0, '21 days', 'Customer information is entirely synthetic for this demonstration.'],
    ['atlas-blue', 'Atlas Blue Maritime DMCC', ['Atlas Blue'], 'United Arab Emirates', 'Dubai', 1100000, 465000, 20000, '30 days', 'Demo regional buyer; overdue amount is included in exposure.'],
    ['cape-union', 'Cape Union Navigation SA', ['Cape Union'], 'Switzerland', 'Geneva', 1250000, 345000, 0, '30 days', 'Fleet purchasing team coordinates several vessel managers.'],
    ['eastbridge', 'Eastbridge Ocean Transport Ltd', ['Eastbridge'], 'Hong Kong', 'Hong Kong', 1000000, 420000, 0, '30 days', 'Confirm legal entity when a broker places an enquiry.'],
    ['aurelia', 'Aurelia Tanker Management SRL', ['Aurelia'], 'Italy', 'Genoa', 1300000, 455000, 0, '30 days', 'Tanker fleet account used to illustrate customer knowledge.'],
    ['delta-horizon', 'Delta Horizon Shipping BV', ['Delta Horizon'], 'Netherlands', 'Rotterdam', 800000, 210000, 0, '21 days', 'North European enquiries.'],
    ['southwind', 'Southwind Maritime Pty Ltd', ['Southwind'], 'Australia', 'Perth', 650000, 135000, 0, '14 days', 'Regional buyer demonstration record.'],
    ['ocean-verde', 'Ocean Verde Logistics SA', ['Ocean Verde'], 'Spain', 'Valencia', 950000, 280000, 0, '30 days', 'Synthetic fleet account.'],
    ['straitlink', 'Straitlink Carriers Sdn Bhd', ['Straitlink'], 'Malaysia', 'Kuala Lumpur', 600000, 155000, 0, '21 days', 'Southeast Asian regional enquiries.'],
    ['seabright', 'Seabright Vessel Services Ltd', ['Seabright'], 'Cyprus', 'Limassol', 700000, 245000, 0, '30 days', 'Verify whether the vessel manager or owner is the contractual buyer.'],
    ['novasea', 'Novasea Chartering Pte Ltd', ['Novasea'], 'Singapore', 'Singapore', 0, 0, 0, 'Pending review', 'New customer awaiting credit onboarding. No approved trading limit.'],
  ].map(row => {
    const [slug, name, aliases, country, city, limit, exposure, overdue, terms, notes] = row as [string, string, string[], string, string, number, number, number, string, string];
    return { id: `company-${slug}`, name, aliases, country, city,
      contact: 'Demo Purchasing Team', email: `purchasing@${slug}.example`,
      status: slug === 'novasea' ? 'pending' : 'approved', limit, exposure, overdue,
      terms, reviewDate: `${month}-01`, sellingEntity: SELLER, notes };
  });

  const ports: Port[] = [
    ['singapore', 'Singapore', 'Singapore', 'SGSIN', 'UTC+8', '24–48h · demo', 'Regional hub for the Asia desk.', ['Confirm the delivery window and buyer entity before requesting a quote.', 'Record operational observations with a source and review date.'], ['Hub', 'VLSFO', 'LSMGO']],
    ['hong-kong', 'Hong Kong', 'Hong Kong', 'HKHKG', 'UTC+8', '24–48h · demo', 'Home-base knowledge for the Hong Kong desk.', ['Request an agent update when the vessel schedule changes.', 'The demo has no live weather, availability or restrictions feed.'], ['Asia', 'VLSFO']],
    ['rotterdam', 'Rotterdam', 'Netherlands', 'NLRTM', 'UTC+1 / +2 DST', '48h · demo', 'European desk reference port.', ['Confirm the specification and delivery location with the supplier.', 'Knowledge cards are examples and require review before real use.'], ['Europe', 'Hub', 'LSMGO']],
    ['fujairah', 'Fujairah', 'United Arab Emirates', 'AEFJR', 'UTC+4', '24–48h · demo', 'Middle East enquiries and desk handovers.', ['Capture the agreed delivery window in the enquiry.', 'Supplier confirmation is required for each operation.'], ['Middle East', 'VLSFO']],
    ['busan', 'Busan', 'South Korea', 'KRPUS', 'UTC+9', '48h · demo', 'Northeast Asia customer knowledge.', ['Check the agent contact and vessel reference before quoting.', 'Log changed local information as a reviewed contribution.'], ['Asia', 'LSMGO']],
    ['tokyo', 'Tokyo', 'Japan', 'JPTYO', 'UTC+9', '48–72h · demo', 'Shared context for the Tokyo desk.', ['Confirm the exact port or terminal in the original enquiry.', 'Review supplier terms for each enquiry.'], ['Asia', 'Tokyo desk']],
    ['ho-chi-minh', 'Ho Chi Minh City', 'Vietnam', 'VNSGN', 'UTC+7', '48h · demo', 'Shared knowledge for the Vietnam desk.', ['Different delivery locations must be confirmed with the buyer.', 'Include a clear grade and quantity in MT.'], ['Asia', 'Vietnam desk']],
    ['gibraltar', 'Gibraltar', 'Gibraltar', 'GIGIB', 'UTC+1 / +2 DST', '24–48h · demo', 'Mediterranean gateway reference.', ['Keep the delivery window current when a vessel schedule moves.', 'No live berth, weather or operational advice is provided.'], ['Mediterranean', 'Transit']],
  ].map(row => {
    const [slug, name, country, code, timezone, leadTime, summary, notes, tags] = row as [string, string, string, string, string, string, string, string[], string[]];
    return { id: `port-${slug}`, name, country, code, timezone, leadTime, summary: `${summary} ${NOTICE}`, notes, tags, updatedAt: day(18) };
  });

  const makeEnquiry = (id: string, buyer: string, port: string, vessel: string, quantity: number, price: number, margin: number, status: Enquiry['status'], createdAt = day(22)): Enquiry => {
    const company = companies.find(item => item.id === `company-${buyer}`)!;
    const location = ports.find(item => item.id === `port-${port}`)!;
    const eta = `${month}-28`;
    const rawText = `Good day, please quote MV ${vessel}\nBuyer: ${company.name}\nPort: ${location.name}\nETA: ${eta}\nVLSFO 0.5% ${quantity} MT\nPlease advise best price and availability.`;
    return { id, buyerId: company.id, portId: location.id, vessel, imo: '', eta, grade: 'VLSFO 0.5%', quantity, price, margin, rawText,
      formattedText: `${vessel}\n${location.name.toUpperCase()} · ${eta}\nVLSFO 0.5% — ${quantity.toLocaleString('en-US')} MT\nBUYER: ${company.name}`, status, createdAt, owner: 'otto' };
  };
  const enquiries: Enquiry[] = [];
  const completed: [string, string, string, number, number, number, Outcome['kind'], string, string][] = [
    ['meridian', 'singapore', 'MERIDIAN QUEST', 1400, 575, 18, 'fixture', day(3), 'Booked on agreed terms.'],
    ['northern-star', 'rotterdam', 'NORTH STAR II', 1100, 550, 14, 'fixture', day(7), 'Repeat customer lifting.'],
    ['pacific-orbit', 'busan', 'PACIFIC ORBIT', 1800, 605, 17, 'fixture', day(12), 'Booked volume contributes to this month.'],
    ['aurelia', 'fujairah', 'AURELIA BAY', 900, 560, 20, 'fixture', day(18), 'Supplier window confirmed in demo.'],
    ['coral-route', 'hong-kong', 'CORAL ATLAS', 800, 615, 15, 'lost', day(20), 'Price — competing quote was more competitive.'],
    ['cape-union', 'singapore', 'CAPE NOVA', 1200, 590, 16, 'fixture', `${previousMonth}-19T10:00:00.000Z`, 'Previous-month fixture; excluded from current progress.'],
    ['southwind', 'gibraltar', 'SOUTHWIND DAWN', 500, 580, 13, 'lost', `${previousMonth}-23T10:00:00.000Z`, 'Schedule — vessel changed its port call.'],
  ];
  const outcomes: Outcome[] = completed.map(([buyer, port, vessel, quantity, price, margin, kind, bookedAt, reason], index) => {
    const enquiry = makeEnquiry(`enquiry-closed-${index + 1}`, buyer, port, vessel, quantity, price, margin, kind, bookedAt);
    enquiries.push(enquiry);
    return { id: `outcome-${index + 1}`, enquiryId: enquiry.id, kind, buyerId: enquiry.buyerId,
      portId: enquiry.portId, vessel, grade: enquiry.grade, quantity, margin, price, bookedAt, owner: 'otto', reason };
  });

  return upgradeDemoState({
    version: 1, companies, ports, enquiries, outcomes,
    requests: [{ id: 'credit-001', companyId: 'company-bluewater', type: 'increase',
      amount: 350000, reason: 'Additional headroom requested for BEACON STRAIT, 500 MT in Hong Kong. Permanent limit increase requested for the demo.',
      status: 'pending', requestedBy: 'otto', requestedAt: day(23, 10) }],
    contributions: [
      { id: 'contribution-001', targetType: 'port', targetId: 'port-singapore', title: 'Singapore: clearer desk handovers',
        body: 'Include the latest buyer-confirmed delivery window and the agent contact in each desk handover. This is a proposed internal workflow improvement for review.',
        author: 'otto', createdAt: day(22, 11), status: 'pending' },
      { id: 'contribution-002', targetType: 'case-study', targetId: 'case-credit-early', title: 'Check credit before a tight delivery window',
        body: 'In this illustrative case, an early credit check exposed a shortfall while there was still time for review. The proposed lesson is to link credit requests to the original enquiry and keep the decision visible to the next desk.',
        author: 'otto', createdAt: day(23, 8), status: 'pending' },
    ],
    audit: [
      { id: 'audit-seed-3', at: day(23, 10), actor: 'SAMPLE TRADER', role: 'trader', action: 'Credit requested', entity: 'Beacon Strait Shipping Ltd', detail: 'Demo request: USD 350,000 permanent limit increase for BEACON STRAIT.' },
      { id: 'audit-seed-2', at: day(22, 11), actor: 'SAMPLE TRADER', role: 'trader', action: 'Knowledge submitted', entity: 'Singapore: clearer desk handovers', detail: 'Awaiting independent management review.' },
      { id: 'audit-seed-1', at: day(1), actor: 'SAMPLE ADMINISTRATOR', role: 'admin', action: 'Demo workspace prepared', entity: 'ECOSYSTEM', detail: 'Synthetic company, credit and trading records. No live systems connected.' },
    ],
    drops: [
      { id: 'drop-seed-2', at: day(15), owner: 'otto', amount: 50, reason: 'Accepted case study: structured lost reasons (demo history)', key: 'seed:case-study' },
      { id: 'drop-seed-1', at: day(10), owner: 'otto', amount: 20, reason: 'Accepted customer knowledge update (demo history)', key: 'seed:company-update' },
    ],
    goals: [{ owner: 'otto', month, volume: 9000, profit: 120000 }],
  });
}

/** Clear the previous active demo once; later enquiries and incoming work must survive reload. */
export function upgradeDemoState(input: DemoState): DemoState {
  input = flattenLocationHierarchy(retireFictionalSupplierRecords(input));
  const needsDemoRefresh = (input.demoScenarioVersion ?? 0) < DEMO_SCENARIO_VERSION;
  const needsCleanup = (input.enquiryCleanupVersion ?? 0) < 2;
  const needsSupplierTabs = Object.entries(input.knowledgeRecords ?? {}).some(([key, document]) => key.startsWith('supplier:') && (document.layoutVersion !== 2 || document.supplierFixturesVersion !== 1));
  const needsTitles = Object.values(input.knowledgeRecords ?? {}).some(needsKnowledgeTitles);
  if (!needsCreditRemarkHistory(input) && !needsTitles && !needsSupplierTabs && input.knowledgeTabsVersion === 2 && input.locationHierarchyVersion === 1 && input.knowledgeLayoutVersion === 1 && (input.demoScenarioVersion ?? 0) >= DEMO_SCENARIO_VERSION && !needsCleanup && input.lostReasons && input.privateNotes && input.economy?.version === 2 && Object.keys(defaultProfiles).every(id => input.profiles?.[id])) return input;
  const state = structuredClone(input);
  if (state.knowledgeLayoutVersion !== 1) {
    for (const port of state.ports) {
      const doc = state.knowledgeRecords?.[`port:${port.id}`];
      if (!doc) continue;
      const additions = demoKnowledgeSections(state, port.id).filter(s => !doc.sections.some(existing=>existing.id===s.id || existing.title===s.title));
      if(additions.length){doc.sections.push(...additions);doc.version++;}
    }
    state.knowledgeLayoutVersion = 1;
  }
  state.lostReasons ??= structuredClone(defaultLostReasons);
  state.privateNotes ??= {};
  state.profiles = { ...structuredClone(defaultProfiles), ...state.profiles };
  // Keep edits to either contact field; only replace the old synthetic defaults.
  if (state.profiles.gianmichele.phone === '+390000000005') state.profiles.gianmichele.phone = defaultProfiles.gianmichele.phone;
  if (state.profiles.gianmichele.email === 'gianmichele@ecosystem.example') state.profiles.gianmichele.email = defaultProfiles.gianmichele.email;
  if (!needsCleanup) {
    enrichDemoScenario(state);
    migrateContributionEconomy(state);
    upgradeLocationHierarchy(state);
    upgradeKnowledgeTabs(state);
    if (needsDemoRefresh) enrichDemoKnowledge(state);
    upgradeKnowledgeTitles(state);
    initializeCreditRemarkHistory(state);
    return state;
  }
  const historicalIds = new Set(state.outcomes.map((outcome) => outcome.enquiryId));
  state.enquiries = state.enquiries.filter((enquiry) => historicalIds.has(enquiry.id));
  const retainedIds = new Set(state.enquiries.map((enquiry) => enquiry.id));
  for (const request of state.requests) {
    if (request.enquiryId && !retainedIds.has(request.enquiryId)) delete request.enquiryId;
  }
  for (const member of state.companies.filter((item) =>
    ["company-meridian", "company-cape-union"].includes(item.id),
  )) {
    member.accountGroupId ??= "demo-meridian-group";
    member.accountGroupName ??= "MERIDIAN GROUP";
  }
  // Historic wins/losses stay financially unchanged; these demo voyages share an IMO.
  for (const id of ["enquiry-closed-1", "enquiry-closed-5"]) {
    const enquiry = state.enquiries.find((item) => item.id === id);
    if (enquiry && !enquiry.imo) enquiry.imo = "9876543";
  }
  state.enquiryCleanupVersion = 2;
  enrichDemoScenario(state);
  migrateContributionEconomy(state);
  upgradeLocationHierarchy(state);
  upgradeKnowledgeTabs(state);
  if (needsDemoRefresh) enrichDemoKnowledge(state);
  upgradeKnowledgeTitles(state);
  initializeCreditRemarkHistory(state);
  return state;
}

function upgradeKnowledgeTitles(state: DemoState) {
  for (const [key, document] of Object.entries(state.knowledgeRecords ?? {})) {
    const separator = key.indexOf(':');
    const target = { kind: key.slice(0, separator) as KnowledgeTarget['kind'], id: key.slice(separator + 1) };
    state.knowledgeRecords![key] = withRequiredKnowledgeTitles(state, target, document);
  }
}

/** Empty hierarchy examples are added after commercial demo data, without new operations. */
function upgradeLocationHierarchy(state: DemoState) {
  if (state.locationHierarchyVersion !== 1) {
    state.locationCountries = locationCountries(state);
    if (!state.locationCountries.some(country => country.name === 'Japan')) state.locationCountries.push({ id: 'Japan', name: 'Japan' });
    for (const [id, name] of [['port-chiba', 'Chiba'], ['port-tokyo', 'Tokyo'], ['port-yokohama', 'Yokohama'], ['port-osaka', 'Osaka']] as const) {
      if (state.ports.some(port => port.id === id || (port.country === 'Japan' && port.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US')))) continue;
      state.ports.push({ id, name, country: 'Japan', code: '', timezone: '', leadTime: '', summary: '', notes: [], updatedAt: '', tags: [] });
    }
    state.locationHierarchyVersion = 1;
  }
}

/** Layout-only migration retains original records, block IDs, versions and revision history. */
function upgradeKnowledgeTabs(state: DemoState) {
  if (state.knowledgeTabsVersion === 2) {
    for (const [key, document] of Object.entries(state.knowledgeRecords ?? {})) {
      if (key.startsWith('supplier:') && (document.layoutVersion !== 2 || document.supplierFixturesVersion !== 1)) state.knowledgeRecords![key] = withDefaultKnowledgeSections(document, 'supplier');
    }
    return;
  }
  for (const [key, document] of Object.entries(state.knowledgeRecords ?? {})) {
    const kind = key.slice(0, key.indexOf(':')) as KnowledgeTarget['kind'];
    state.knowledgeRecords![key] = withDefaultKnowledgeSections(document, kind);
  }
  const hongKong = state.ports.find(port => port.id === 'port-hong-kong');
  if (hongKong) hongKong.country = 'Hong Kong';
  state.locationCountries = locationCountries(state);
  state.knowledgeTabsVersion = 2;
}
