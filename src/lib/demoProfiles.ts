import type { DemoState } from './model';

/** Fictional commercial records; the stable IDs keep existing references intact. */
export const refreshedBuyerNames: Record<string, { previous: string; name: string }> = {
  meridian: { previous: 'Meridian Shipping Pte Ltd', name: 'Aster Ocean Navigation Pte Ltd' },
  bluewater: { previous: 'Bluewater Navigation Ltd', name: 'Beacon Strait Shipping Ltd' },
  harborlight: { previous: 'Harborlight Maritime SA', name: 'Cobalt Maritime SA' },
  'northern-star': { previous: 'Northern Star Carriers AS', name: 'Boreal Bulk Carriers AS' },
  'pacific-orbit': { previous: 'Pacific Orbit Lines KK', name: 'Koyo Pacific Lines KK' },
  'coral-route': { previous: 'Coral Route Shipping Ltd', name: 'Bracken Ocean Shipping Ltd' },
  'atlas-blue': { previous: 'Atlas Blue Maritime DMCC', name: 'Crescent Gulf Navigation DMCC' },
  'cape-union': { previous: 'Cape Union Navigation SA', name: 'Aster Chartering SA' },
  eastbridge: { previous: 'Eastbridge Ocean Transport Ltd', name: 'Lantern Bay Carriers Ltd' },
  aurelia: { previous: 'Aurelia Tanker Management SRL', name: 'Levante Tanker Management SRL' },
  'delta-horizon': { previous: 'Delta Horizon Shipping BV', name: 'Dune Coast Shipping BV' },
  southwind: { previous: 'Southwind Maritime Pty Ltd', name: 'Wattle Ocean Carriers Pty Ltd' },
  'ocean-verde': { previous: 'Ocean Verde Logistics SA', name: 'Sierra Azul Logistics SA' },
  straitlink: { previous: 'Straitlink Carriers Sdn Bhd', name: 'Selat Maritime Sdn Bhd' },
  seabright: { previous: 'Seabright Vessel Services Ltd', name: 'Helios Vessel Services Ltd' },
  novasea: { previous: 'Novasea Chartering Pte Ltd', name: 'Nacre Chartering Pte Ltd' },
};

/** Rename only exact known synthetic defaults. User-entered names and fields always win. */
export function refreshBuyerProfiles(state: DemoState, day: (offset: number) => string) {
  const owners = ['otto', 'otto', 'filippo', 'luca', 'gianmichele', 'silvia', 'otto', 'filippo', 'gianmichele', 'filippo', 'silvia', 'luca', 'filippo', 'gianmichele', 'silvia', 'otto'];
  for (const [index, [slug, names]] of Object.entries(refreshedBuyerNames).entries()) {
    const buyer = state.companies.find(company => company.id === `company-${slug}`);
    if (!buyer) continue;
    const unchangedName = buyer.name.toUpperCase() === names.previous.toUpperCase();
    if (unchangedName) {
      buyer.name = names.name;
      buyer.aliases = [...new Set([...buyer.aliases, names.previous, names.name.split(' ').slice(0, 2).join(' ')])];
    }
    // Existing user names are not assigned unrelated fictional identity data.
    if (!unchangedName && buyer.name.toUpperCase() !== names.name.toUpperCase()) continue;
    buyer.customerId ??= `ECO${20001 + index}`;
    buyer.personInChargeId ??= owners[index];
    buyer.office ??= ['otto', 'gianmichele', 'luca'].includes(owners[index]) ? 'HKG' : 'GOA';
    buyer.creditManagerId ??= 'elena';
    buyer.category ??= index % 3 === 0 ? 'STRATEGIC ACCOUNT' : 'REGULAR ACCOUNT';
    buyer.sectors ??= [index % 3 === 0 ? 'DRY BULK' : index % 3 === 1 ? 'CONTAINER' : 'TANKER'];
    buyer.counterpartyRoles ??= ['BUYER'];
    buyer.companyTypes ??= [index % 2 ? 'CHARTERER' : 'VESSEL OPERATOR'];
    buyer.inChargeHistory ??= [{ id: `demo-pic-${buyer.id}`, personId: owners[index], office: buyer.office, from: day(-210) }];
    buyer.insuredCredit ??= buyer.status === 'pending' || slug === 'coral-route' ? 0 : Math.round(buyer.limit * 0.6 / 50000) * 50000;
    buyer.parentCompanyGuarantee ??= ['meridian', 'cape-union', 'pacific-orbit'].includes(slug);
    buyer.riskRating ??= buyer.status === 'pending' ? 4 : buyer.overdue ? 3 : index % 3 === 0 ? 1 : 2;
    buyer.creditUpdatedAt ??= `${day(-42)}T08:30:00.000Z`;
    buyer.tradingCountry ??= buyer.country;
    if (slug === 'meridian') buyer.files ??= [{ id: 'demo-aster-profile', title: 'DEMO BUYER PROFILE', url: '/demo/aster-buyer-profile.txt' }];
    buyer.registrationAddress ??= `${18 + index * 3} DEMO MARITIME WALK, ${buyer.city.toUpperCase()}`;
    buyer.tradingAddress ??= `${42 + index} DEMO HARBOUR SQUARE, ${buyer.city.toUpperCase()}`;
    // Only refresh original demo contact strings, never edited contact details.
    if (buyer.contact === 'Demo Purchasing Team') buyer.contact = `${names.name.split(' ')[0].toUpperCase()} FLEET PURCHASING`;
    if (buyer.email === `purchasing@${slug}.example`) buyer.email = `purchasing@${names.name.split(' ')[0].toLowerCase()}.example`;
    if (['meridian', 'cape-union'].includes(slug) && (!buyer.accountGroupName || buyer.accountGroupName === 'MERIDIAN GROUP')) {
      buyer.accountGroupId ??= 'demo-meridian-group';
      buyer.accountGroupName = 'ASTER OCEAN GROUP';
      buyer.approvedGroupCredit ??= 3000000;
    }
    // These exact old synthetic values can be refreshed without touching user edits.
    if (slug === 'bluewater' && buyer.limit === 900000 && buyer.exposure === 780000 && buyer.overdue === 35000) buyer.exposure = 960000;
    if (slug === 'seabright' && (!buyer.creditStatus || buyer.creditStatus === 'Active') && buyer.limit === 700000 && buyer.exposure === 245000 && buyer.overdue === 0) {
      buyer.creditStatus = 'Suspended';
      if (!buyer.creditRemarks || buyer.creditRemarks === 'Demo: approved terms apply to the named buying entity. Check available credit before confirming a stem.') buyer.creditRemarks = 'DEMO: ACCOUNT SUSPENDED PENDING ANNUAL FINANCIALS. CREDIT DESK APPROVAL REQUIRED BEFORE FURTHER COMMITMENTS.';
    }
  }
}

/** Adds only missing demo lifecycle records; existing requests and decisions remain unchanged. */
export function enrichCreditRecords(state: DemoState, day: (offset: number) => string, now = new Date()) {
  state.creditHistory ??= [];
  const legacyRequest = state.requests.find(request => request.id === 'credit-001');
  if (legacyRequest) legacyRequest.requestNumber ??= `CR-${now.getUTCFullYear()}-0001`;
  const at = (offset: number, hour = 8) => {
    const planned = `${day(offset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    return Date.parse(planned) > now.getTime() ? now.toISOString() : planned;
  };
  const recognized = (buyer: DemoState['companies'][number]) => {
    const names = refreshedBuyerNames[buyer.id.replace(/^company-/, '')];
    return Boolean(names && buyer.name.toUpperCase() === names.name.toUpperCase());
  };
  const addHistory = (item: NonNullable<DemoState['creditHistory']>[number]) => {
    if (!state.creditHistory!.some(record => record.id === item.id)) state.creditHistory!.push(item);
  };
  for (const buyer of state.companies.filter(company => recognized(company) && company.status === 'approved')) {
    const id = `demo-v2-credit-${buyer.id}`;
    addHistory({ id: `${id}-limit`, companyId: buyer.id, effectiveAt: at(-42), recordedAt: at(-42, 9), by: 'elena', type: 'limit', summary: 'ANNUAL CREDIT REVIEW COMPLETED', previousLimit: Math.round(buyer.limit * 0.75), limit: buyer.limit, terms: buyer.terms, ...(buyer.id === 'company-meridian' ? { requestId: 'demo-v2-request-aster-approved' } : {}) });
    addHistory({ id: `${id}-terms`, companyId: buyer.id, effectiveAt: at(-160), recordedAt: at(-160, 9), by: 'marco', type: 'terms', summary: 'PAYMENT TERMS CONFIRMED FOR THE NAMED BUYING ENTITY', terms: buyer.terms });
    if (buyer.creditStatus === 'Suspended') addHistory({ id: `${id}-suspended`, companyId: buyer.id, effectiveAt: at(-3), recordedAt: at(-3), by: 'elena', type: 'status', summary: 'ACCOUNT SUSPENDED: UPDATED FINANCIALS REQUIRED' });
  }
  const aster = state.companies.find(buyer => buyer.id === 'company-meridian' && recognized(buyer));
  const asterPreviousLimit = aster ? Math.round(aster.limit * 0.75) : 1350000;
  const asterResultingLimit = aster?.limit ?? 1800000;
  const asterIncrease = asterResultingLimit - asterPreviousLimit;
  const requests: DemoState['requests'] = [
    { id: 'demo-v2-request-aster-approved', companyId: 'company-meridian', type: 'increase', amount: asterIncrease, reason: 'ANNUAL REVIEW: HIGHER MONTHLY LIFTINGS AND STABLE COLLECTIONS.', status: 'approved', requestedBy: 'otto', requestedAt: at(-44), acknowledgedAt: at(-44, 9), acknowledgedBy: 'elena', closedAt: at(-42), decision: { by: 'elena', at: at(-42), note: 'LIMIT APPROVED WITH EXISTING PAYMENT TERMS.', amount: asterIncrease, terms: aster?.terms ?? '30 days', previousLimit: asterPreviousLimit, resultingLimit: asterResultingLimit } },
    { id: 'demo-v2-request-beacon', companyId: 'company-bluewater', type: 'temporary', amount: 250000, reason: 'TEMPORARY HEADROOM FOR BEACON STRAIT: TWO SCHEDULED LIFTINGS. COLLECTION CONFIRMATION PENDING.', status: 'pending', requestedBy: 'otto', requestedAt: at(-1), priority: 'p1', acknowledgedAt: at(-1, 9), acknowledgedBy: 'elena', expiresAt: `${day(14)}T23:59:59.000Z` },
    { id: 'demo-v2-request-nacre', companyId: 'company-novasea', type: 'new-customer', amount: 400000, reason: 'NEW BUYER ONBOARDING FOR FIRST SINGAPORE LIFTING; REFERENCES RECEIVED.', status: 'pending', requestedBy: 'otto', requestedAt: at(0) },
    { id: 'demo-v2-request-crescent-declined', companyId: 'company-atlas-blue', type: 'increase', amount: 1500000, reason: 'PROPOSED PERMANENT LIMIT INCREASE FOR GULF VOYAGES.', status: 'declined', requestedBy: 'otto', requestedAt: at(-12), acknowledgedAt: at(-12, 9), acknowledgedBy: 'elena', closedAt: at(-11), decision: { by: 'elena', at: at(-11), note: 'CLEAR OVERDUE INVOICES BEFORE RECONSIDERATION.', amount: 0, terms: '30 days' } },
    { id: 'demo-v2-request-cobalt-active', companyId: 'company-harborlight', type: 'temporary', amount: 200000, reason: 'TWO VOYAGES OVERLAP BEFORE SCHEDULED COLLECTION.', status: 'approved', requestedBy: 'filippo', requestedAt: at(-4), acknowledgedAt: at(-4, 9), acknowledgedBy: 'elena', closedAt: at(-3), expiresAt: `${day(10)}T23:59:59.000Z`, decision: { by: 'elena', at: at(-3), note: 'TEMPORARY FACILITY VALID UNTIL COLLECTION.', amount: 200000, terms: '30 days', expiresAt: `${day(10)}T23:59:59.000Z` } },
    { id: 'demo-v2-request-koyo-expired', companyId: 'company-pacific-orbit', type: 'temporary', amount: 200000, reason: 'ONE VOYAGE TEMPORARY HEADROOM FOR KOYO PACIFIC.', status: 'approved', requestedBy: 'gianmichele', requestedAt: at(-24), acknowledgedAt: at(-24, 9), acknowledgedBy: 'elena', closedAt: at(-23), expiresAt: `${day(-8)}T23:59:59.000Z`, decision: { by: 'elena', at: at(-23), note: 'TEMPORARY FACILITY EXPIRES AFTER THE VOYAGE.', amount: 200000, terms: '30 days', expiresAt: `${day(-8)}T23:59:59.000Z` } },
  ];
  for (const [index, request] of requests.entries()) {
    const incomingId = request.id === 'demo-v2-request-beacon' ? 'demo-v1-incoming-1' : request.id === 'demo-v2-request-nacre' ? 'demo-v1-incoming-2' : undefined;
    const enquiry = state.enquiries.find(item => item.id === incomingId && item.buyerId === request.companyId);
    if (enquiry) request.enquiryId = enquiry.id;
    request.requestNumber = `CR-${now.getUTCFullYear()}-${String(index + 2).padStart(4, '0')}`;
    if (state.companies.some(buyer => buyer.id === request.companyId && recognized(buyer)) && !state.requests.some(record => record.id === request.id)) state.requests.push(request);
  }
  const cobalt = state.companies.find(buyer => buyer.id === 'company-harborlight' && recognized(buyer));
  if (cobalt && !cobalt.temporaryCredits?.some(item => item.id === 'demo-v2-facility-cobalt')) {
    cobalt.temporaryCredits ??= [];
    cobalt.temporaryCredits.push({ id: 'demo-v2-facility-cobalt', requestId: 'demo-v2-request-cobalt-active', amount: 200000, startsAt: at(-3), expiresAt: `${day(10)}T23:59:59.000Z`, approvedBy: 'elena' });
  }
  if (cobalt) addHistory({ id: 'demo-v2-history-cobalt-temporary', companyId: 'company-harborlight', effectiveAt: at(-3), recordedAt: at(-3), by: 'elena', type: 'temporary', summary: 'TEMPORARY FACILITY VALID UNTIL COLLECTION', limit: 200000, requestId: 'demo-v2-request-cobalt-active', expiresAt: `${day(10)}T23:59:59.000Z` });
  if (state.companies.some(buyer => buyer.id === 'company-pacific-orbit' && recognized(buyer))) addHistory({ id: 'demo-v2-history-koyo-temporary', companyId: 'company-pacific-orbit', effectiveAt: at(-23), recordedAt: at(-23), by: 'elena', type: 'temporary', summary: 'ONE-VOYAGE TEMPORARY FACILITY APPROVED; NOW EXPIRED', limit: 200000, requestId: 'demo-v2-request-koyo-expired', expiresAt: `${day(-8)}T23:59:59.000Z` });
}

/** Complete only the seven original, untouched synthetic examples; user fixtures are excluded. */
export function refreshLegacyDemoRecords(state: DemoState, now = new Date()) {
  const samples = [
    ['MERIDIAN QUEST', 'ASTER QUEST', 'company-meridian', 1400, 575, 18],
    ['NORTH STAR II', 'BOREAL NORTH', 'company-northern-star', 1100, 550, 14],
    ['PACIFIC ORBIT', 'KOYO PACIFIC', 'company-pacific-orbit', 1800, 605, 17],
    ['AURELIA BAY', 'LEVANTE BAY', 'company-aurelia', 900, 560, 20],
    ['CORAL ATLAS', 'BRACKEN ATLAS', 'company-coral-route', 800, 615, 15],
    ['CAPE NOVA', 'ASTER NOVA', 'company-cape-union', 1200, 590, 16],
    ['SOUTHWIND DAWN', 'WATTLE DAWN', 'company-southwind', 500, 580, 13],
  ] as const;
  for (const [index, [oldVessel, vessel, buyerId, quantity, price, margin]] of samples.entries()) {
    const outcome = state.outcomes.find(item => item.id === `outcome-${index + 1}` && item.enquiryId === `enquiry-closed-${index + 1}`);
    const enquiry = state.enquiries.find(item => item.id === `enquiry-closed-${index + 1}`);
    if (!outcome || !enquiry || outcome.buyerId !== buyerId || outcome.quantity !== quantity || outcome.price !== price || outcome.margin !== margin || outcome.owner !== 'otto' || outcome.actualVolume || outcome.payment || outcome.stemProducts || outcome.products || enquiry.amendments?.length || ![oldVessel, vessel].includes(outcome.vessel as typeof oldVessel | typeof vessel) || enquiry.vessel !== outcome.vessel) continue;
    outcome.vessel = vessel;
    enquiry.vessel = vessel;
    enquiry.rawText = enquiry.rawText.replace(oldVessel, vessel);
    enquiry.formattedText = enquiry.formattedText.replace(oldVessel, vessel);
    const oldBuyer = refreshedBuyerNames[buyerId.replace(/^company-/, '')]?.previous;
    const buyerName = state.companies.find(buyer => buyer.id === buyerId)?.name;
    if (oldBuyer && buyerName) {
      const refreshBuyerLine = (value: string) => value.split('\n').map(line => line.toUpperCase() === `BUYER: ${oldBuyer.toUpperCase()}` ? `BUYER: ${buyerName}` : line).join('\n');
      enquiry.rawText = refreshBuyerLine(enquiry.rawText);
      enquiry.formattedText = refreshBuyerLine(enquiry.formattedText);
    }
    enquiry.sentAt ??= enquiry.createdAt;
    outcome.stemNumber ??= `ECO-${new Date(outcome.bookedAt).getUTCFullYear()}-${String(index + 1).padStart(4, '0')}`;
    if (outcome.kind !== 'fixture') continue;
    const invoiceDate = outcome.bookedAt.slice(0, 10);
    const days = Number.parseInt(state.companies.find(buyer => buyer.id === buyerId)?.terms ?? '30', 10) || 30;
    const due = Date.parse(`${invoiceDate}T00:00:00Z`) + days * 86_400_000;
    const paid = due - 2 * 86_400_000;
    outcome.payment = { invoiceDate, dueDate: new Date(due).toISOString().slice(0, 10), ...(paid <= now.getTime() ? { paidDate: new Date(paid).toISOString().slice(0, 10) } : {}) };
  }
}
