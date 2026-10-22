import { parseProductQuantity } from '../../shared/productQuantity.ts';
export { parseProductQuantity } from '../../shared/productQuantity.ts';
import { buyerPrivateEntries, buyerTeamEntries, buyerSharedEntries, buyerSharedListKey, sameBuyerSharedDraft, type BuyerSharedList, type BuyerSharedListKind, type BuyerSharedDraftEntry, type BuyerSharedEntry } from "./buyerSharedLists.ts";
import { feedbackPages, type FeedbackPage } from "../workspaceNavigation.ts";
import { checkKnowledgeChange, publishKnowledge, knowledgeSectionRole, sameKnowledge, knowledgeName, knowledgeKey, knowledgeDocument, type KnowledgeDocument, type KnowledgeChange, type KnowledgeRevision, type KnowledgeEntryUpdate } from './knowledge.ts';
import { resourceAmount, teamForActor, type EconomyState } from './economy.ts';
export * from './economy.ts';
import { buyerGroupKey } from './buyerProfile.ts';
import { normalizedBuyerCompetition } from './buyerCompetition.ts';
import { retiredSupplierIds } from './supplierRetirement.ts';
import { lostReasonsFor, type LostReason } from "./lostReasons.ts";
import { emptyIntelligenceKeyInfo, intelligenceChangeSummary, sameIntelligenceKeyInfo, validateIntelligenceKeyInfo, type IntelligenceKeyInfo } from './intelligenceFields.ts';
import { locationCountries, locationProfileTarget, profileCountryTarget, type LegacyLocationArea, type LocationCountry } from './locations.ts';
import { validateExtractedContentChange, type ExtractionIntelligenceChange } from './knowledgeExtraction.ts';
import { recordHat, type HatAward, type HatTarget } from './hats.ts';
import { uppercaseText } from './uppercase.ts';
import { validateCreditAttachments, type CreditAttachment } from './creditAttachments.ts';
import { creditRequestRecipients, exactBuyerDuplicates, possibleBuyerDuplicates, type CreditRequestInputFields, type CreditRecipient, type CreditNotification } from './creditWorkflow.ts';
import { effectiveCreditLimit, companyTradingBlockedReason, nextCustomerId, nextCreditRequestNumber, type TemporaryCredit, type CreditHistoryEntry } from './credit.ts';
import { isAccessActor } from './accessActor.ts';

export type Role = 'trader' | 'manager' | 'credit' | 'admin';

export interface UserProfile { phone: string; email: string }
export interface DemoContact extends UserProfile { owner: string; verified: boolean }

export interface Actor { id: string; name: string; role: Role; officeId?: string; officeName?: string; isAdmin?: boolean; isSpcTrader?: boolean; isManager?: boolean }
export interface Company {
  id: string; name: string; aliases: string[]; country: string; city: string;
  contact: string; email: string; status: 'approved' | 'pending'; limit: number;
  exposure: number; overdue: number; terms: string; reviewDate: string;
  sellingEntity: string; notes: string;
  accountGroupId?: string; accountGroupName?: string;
  approvedGroupCredit?: number; riskCategory?: string;
  creditStatus?: 'Active' | 'Suspended' | 'On hold' | 'Closed';
  creditRemarks?: string; activeCreditRemarkId?: string; lifecycle?: 'lead' | 'buyer';
  customerId?: string; personInChargeId?: string; office?: string; creditManagerId?: string;
  insuredCredit?: number; parentCompanyGuarantee?: boolean; riskRating?: number;
  registrationAddress?: string; tradingAddress?: string; tradingCountry?: string; creditUpdatedAt?: string;
  files?: { id: string; title: string; url: string }[];
  temporaryCredits?: TemporaryCredit[];
  category?: string; sectors?: string[]; counterpartyRoles?: string[]; companyTypes?: string[]; nextContact?: string;
  inChargeHistory?: { id: string; personId: string; office: string; from: string; to?: string }[];
}
export interface Port {
  id: string; name: string; country: string; code: string; timezone: string;
  leadTime: string; summary: string; notes: string[]; updatedAt: string; tags: string[];
  intelligenceKeyInfo?: IntelligenceKeyInfo;
  intelligenceEntryUpdates?: Partial<Record<keyof IntelligenceKeyInfo, KnowledgeEntryUpdate>>;
}
export interface CreditRequest extends CreditRequestInputFields {
  recipients?: CreditRecipient[];
  id: string; requestNumber?: string; companyId: string; enquiryId?: string; type: 'increase' | 'new-customer' | 'temporary';
  amount: number; reason: string; status: 'pending' | 'approved' | 'declined';
  requestedBy: string; requestedAt: string; requestedOffice?: string;
  priority?: 'normal' | 'urgent' | 'p1';
  expiresAt?: string; acknowledgedAt?: string; acknowledgedBy?: string; closedAt?: string;
  decision?: { by: string; at: string; note: string; amount: number; terms: string; expiresAt?: string; previousLimit?: number; resultingLimit?: number };
}
export type EnquiryGrade = 'HSFO' | 'VLSFO' | 'LSMGO';
export interface EnquiryProduct { grade: EnquiryGrade; quantityText: string }
export interface StemProduct {
  grade: string; quantityText: string; buyPrice: number;
  /** Optional for records saved before suppliers were assigned per grade. */
  supplierId?: string; supplierName?: string;
}
export interface BookedProduct { grade: string; quantity: number; price: number; margin: number }
export interface Enquiry {
  id: string; buyerId: string; portId: string; vessel: string; imo: string;
  eta: string; grade: string; quantity: number; price: number; margin: number;
  rawText: string; formattedText: string; status: 'draft' | 'sent' | 'fixture' | 'lost' | 'postponed' | 'cancelled';
  createdAt: string; owner: string;
  products?: EnquiryProduct[]; remarks?: string; vlsfoMaxRemarks?: string[]; rmk?: boolean;
  complianceChecked?: boolean; creditChecked?: boolean; creditConfirmations?: string[];
  sentAt?: string; lastAmendedAt?: string; postponedAt?: string; cancelledAt?: string;
  amendments?: { at: string; by: string; before: Omit<Enquiry, 'amendments'> }[];
}
export interface Outcome {
  id: string; enquiryId: string; kind: 'fixture' | 'lost'; buyerId: string;
  portId: string; vessel: string; grade: string; quantity: number; margin: number;
  price: number; bookedAt: string; owner: string; reason: string;
  products?: BookedProduct[];
  stemProducts?: StemProduct[];
  requestedProducts?: EnquiryProduct[];
  supplierId?: string; supplierName?: string;
  commercialStatus?: 'pending';
  payment?: { invoiceDate?: string; dueDate: string; paidDate?: string };
  stemNumber?: string;
  actualVolume?: { quantity: number; recordedAt: string; recordedBy: string };
  reasonId?: string; groupNote?: string;
  imo?: string;
  complianceChecked?: boolean; creditChecked?: boolean; checkedBy?: string; checkedAt?: string;
}
/** Server-authored compact facts. Full source/proposal bodies are fetched by ID. */
export interface LocationPublication {
  version: 1; eligible: boolean; kind: string;
  keys: string[]; records: string[]; fingerprint: string;
  keyInfoTransitions: { key: string; fingerprint: string }[];
  batchId?: string;
}
export interface Contribution {
  locationPublication?: LocationPublication;
  /** Retained browser history, imported without creating a new award. */
  historicalImport?: true;
  feedbackPage?: FeedbackPage;
  id: string; targetType: 'port' | 'country' | 'area' | 'company' | 'case-study' | 'feedback' | 'buyer-group' | 'buyer-team' | 'buyer-competition' | 'supplier'; targetId: string;
  title: string; body: string; author: string; createdAt: string;
  status: 'pending' | 'approved' | 'declined'; reviewer?: string; reviewedAt?: string;
  publication?: 'direct'; publishedAt?: string;
  knowledgeChange?: KnowledgeChange;
  tabChanges?: KnowledgeChange[];
  extractionBatch?: { id: string; changes: KnowledgeChange[]; intelligenceChanges: ExtractionIntelligenceChange[] };
  proposedKeyInfo?: IntelligenceKeyInfo; keyInfoBase?: IntelligenceKeyInfo; source?: string;
}
export interface AuditEntry {
  id: string; at: string; actor: string; role: Role; action: string; entity: string; detail: string;
}
export interface DropEntry {
  id: string; at: string; owner: string; amount: number; reason: string; key: string;
}
export interface Goal { owner: string; month: string; volume: number | null; profit: number | null }
export interface DemoState {
  version: 1; companies: Company[]; ports: Port[]; enquiries: Enquiry[];
  requests: CreditRequest[]; outcomes: Outcome[]; contributions: Contribution[];
  audit: AuditEntry[]; drops: DropEntry[]; goals: Goal[];
  enquiryCleanupVersion?: number;
  demoScenarioVersion?: number;
  knowledgeLayoutVersion?: number;
  knowledgeTabsVersion?: number;
  locationHierarchyVersion?: number;
  locationCountries?: LocationCountry[];
  /** Legacy serialized input only. Removed from active state by migration. */
  locationAreas?: LegacyLocationArea[];
  locationStructureVersion?: 1;
  legacyLocationAreas?: LegacyLocationArea[];
  legacyPortAreaIds?: Record<string, string>;
  knowledgeRecords?: Record<string, KnowledgeDocument>;
  supplierRetirementVersion?: 1;
  retiredSupplierKnowledge?: Record<string, KnowledgeDocument>;
  knowledgeHistory?: KnowledgeRevision[];
  lostReasons?: LostReason[];
  privateNotes?: Record<string, { owner: string; text: string; updatedAt: string }>;
  buyerSharedLists?: Record<string, BuyerSharedList>;
  buyerPrivateRemarks?: Record<string, { owner: string; buyerId: string; text: string; updatedAt: string; entries?: BuyerSharedEntry[] }>;
  profiles?: Record<string, UserProfile>;
  economy?: EconomyState;
  hats?: HatAward[];
  creditHistory?: CreditHistoryEntry[];
  creditNotifications?: CreditNotification[];
}

export function contributionReward(_targetType: Contribution['targetType']): number { return 1; }

export const actors: Actor[] = [
  { id: 'otto', name: 'SAMPLE TRADER', role: 'trader' },
  { id: 'elena', name: 'SAMPLE CREDIT REVIEWER', role: 'credit' },
  { id: 'marco', name: 'SAMPLE ADMINISTRATOR', role: 'admin' },
  { id: 'luca', name: 'SAMPLE TRADER C', role: 'trader' },
  { id: 'gianmichele', name: 'SAMPLE MANAGER A', role: 'manager' },
  { id: 'silvia', name: 'SAMPLE MANAGER B', role: 'manager' },
  { id: 'filippo', name: 'SAMPLE TRADER B', role: 'trader' },
];

/** Local demo contact data only; no external address is verified or contacted. */
export const defaultProfiles: Record<string, UserProfile> = {
  otto: { phone: '+85200000001', email: 'otto@ecosystem.example' },
  elena: { phone: '+390000000002', email: 'joe@ecosystem.example' },
  marco: { phone: '+390000000003', email: 'guido@ecosystem.example' },
  luca: { phone: '+390000000004', email: 'luca@ecosystem.example' },
  gianmichele: { phone: '+85200000005', email: 'vincent@ecosystem.example' },
  silvia: { phone: '+390000000006', email: 'silvia@ecosystem.example' },
  filippo: { phone: '+390000000007', email: 'filippo@ecosystem.example' },
};

export function canTrade(actor: Actor): boolean {
  return actor.role === 'trader' || actor.role === 'manager';
}

export function isAdmin(actor: Actor): boolean { return actor.isAdmin === true || actor.role === 'admin'; }

export function profileFor(state: Pick<DemoState, 'profiles'>, actorId: string): UserProfile {
  if (!actors.some(actor => actor.id === actorId) && !state.profiles?.[actorId]) throw new Error('Select a valid demo profile.');
  return { ...(state.profiles?.[actorId] ?? defaultProfiles[actorId]) };
}

export function contactsFor(state: Pick<DemoState, 'profiles'>): DemoContact[] {
  return actors.map(actor => ({ owner: actor.id, ...profileFor(state, actor.id), verified: true }));
}

export function normalizeContact(channel: 'whatsapp' | 'email', sender: string): string {
  if (typeof sender !== 'string') return '';
  const value = sender.trim();
  if (channel === 'email') return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) ? value.toLowerCase() : '';
  if (!/^[+\d\s().-]+$/.test(value)) return '';
  const digits = value.replace(/\D/g, '').replace(/^00/, '');
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : '';
}

/** Explicit demo team assignment. Includes the manager's own trading activity. */
export function teamMembers(manager: Actor | string): Actor[] {
  const id = typeof manager === 'string' ? manager : manager.id;
  const person = actors.find(actor => actor.id === id && actor.role === 'manager');
  if (!person) return [];
  const ids = teamForActor(person)?.memberIds ?? [];
  return ids.flatMap(memberId => actors.filter(actor => actor.id === memberId && canTrade(actor)));
}

export function teamMonthlyStats(state: DemoState, managerId: string, month: string): { volume: number; profit: number; fixtures: number } {
  return teamMembers(managerId).reduce((total, member) => {
    const stats = monthlyStats(state, member.id, month);
    return { volume: money(total.volume + stats.volume), profit: money(total.profit + stats.profit), fixtures: total.fixtures + stats.fixtures };
  }, { volume: 0, profit: 0, fixtures: 0 });
}

export function teamDrops(state: DemoState, managerId: string): number {
  const members = new Set(teamMembers(managerId).map(actor => actor.id));
  return state.drops.filter(drop => members.has(drop.owner)).reduce((sum, drop) => sum + drop.amount, 0);
}

export type Action =
  | { type: 'set-hat'; target: HatTarget; expectedUpdate: KnowledgeEntryUpdate; active: boolean }
  | { type: 'add-location'; kind: 'country' | 'port'; name: string; country?: string }
  | { type: 'save-extracted-knowledge'; batchId: string; changes: KnowledgeChange[]; intelligenceChanges: ExtractionIntelligenceChange[]; source?: string; reason: string }
  | { type: 'manage-knowledge-tabs'; changes: KnowledgeChange[] }
  | { type: 'save-knowledge'; change: KnowledgeChange; reason: string; source?: string }
  | { type: 'suggest-knowledge'; change: KnowledgeChange; reason: string; source?: string }
  | { type: 'save-buyer-private-list'; buyerId: string; entries: BuyerSharedDraftEntry[]; baseEntries: BuyerSharedDraftEntry[] }
  | { type: 'save-buyer-shared-list'; kind: BuyerSharedListKind; buyerId: string; entries: BuyerSharedDraftEntry[]; baseEntries: BuyerSharedDraftEntry[] }
  | { type: 'save-buyer-credit-remarks'; buyerId: string; text: string }
  | { type: 'set-active-credit-remark'; buyerId: string; historyId: string }
  | { type: 'mark-credit-request-read'; id: string }
  | { type: 'record-actual-volume'; id: string; quantity: number }
  | { type: 'save-enquiry'; enquiry: Enquiry }
  | { type: 'confirm-enquiry' | 'send-enquiry'; id: string }
  | { type: 'amend-enquiry' | 'postpone-enquiry' | 'cancel-enquiry'; id: string }
  | { type: 'record-stem'; id: string; supplierId?: string; products: StemProduct[]; privateNote?: string; complianceChecked: boolean; creditChecked: boolean }
  | { type: 'record-loss'; id: string; reasonId: string; groupNote?: string; privateNote?: string }
  | { type: 'save-lost-reasons'; reasons: LostReason[] }
  | ({ type: 'request-credit'; companyId: string; enquiryId?: string; amount: number; reason: string; requestType: CreditRequest['type']; expiresAt?: string; priority?: CreditRequest['priority'] } & CreditRequestInputFields)
  | { type: 'acknowledge-credit'; id: string }
  | { type: 'decide-credit'; id: string; approve: boolean; amount: number; terms: string; note: string; expiresAt?: string }
  | { type: 'add-company'; company: Company; requestedLimit: number; reason: string; attachments?: CreditAttachment[]; duplicateConfirmed?: boolean; workflow?: 'p1'; nonPicConfirmed?: boolean }
  | { type: 'save-port-information'; portId: string; keyInfo: IntelligenceKeyInfo; baseKeyInfo: IntelligenceKeyInfo; change?: KnowledgeChange; reason: string }
  | { type: 'submit-contribution'; feedbackPageId?: string; targetType: Contribution['targetType']; targetId: string; title: string; body: string; proposedKeyInfo?: IntelligenceKeyInfo; baseKeyInfo?: IntelligenceKeyInfo; source?: string }
  | { type: 'review-contribution'; id: string; approve: boolean; note: string };

const reportingMonthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit',
});

/** Commercial reporting follows the Hong Kong calendar, independent of browser timezone. */
export function reportingMonth(date: Date | string): string {
  const parsed = typeof date === 'string' ? new Date(date) : date;
  if (!Number.isFinite(parsed.getTime())) throw new Error('The reporting date is invalid.');
  const parts = reportingMonthFormatter.formatToParts(parsed);
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
}

export function currentMonth(date = new Date()): string { return reportingMonth(date); }

export function uid(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

const money = (value: number): number => {
  if (!Number.isFinite(value)) throw new Error('Financial amounts must be finite numbers.');
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) throw new Error('Financial amount exceeds the supported precision.');
  return Math.round((value + Number.EPSILON) * 100) / 100;
};
export function availableCredit(company: Company, at: string | Date = new Date()): number { return money(effectiveCreditLimit(company, at) - company.exposure); }

export function activeAccountTraders(state: DemoState, buyerId: string, owner: string, excludeEnquiryId?: string): { trader: Actor; enquiries: Enquiry[]; sameAccount: boolean }[] {
  const buyer = state.companies.find(company => company.id === buyerId);
  if (!buyer) return [];
  return actors.filter(trader => canTrade(trader) && trader.id !== owner).flatMap(trader => {
    const enquiries = state.enquiries.filter(enquiry => {
      if (enquiry.owner !== trader.id || enquiry.id === excludeEnquiryId || !['draft', 'sent', 'postponed'].includes(enquiry.status)) return false;
      const account = state.companies.find(company => company.id === enquiry.buyerId);
      return enquiry.buyerId === buyerId || Boolean(buyer.accountGroupId?.trim() && account?.accountGroupId === buyer.accountGroupId);
    });
    return enquiries.length ? [{ trader, enquiries, sameAccount: enquiries.some(enquiry => enquiry.buyerId === buyerId) }] : [];
  });
}

export function enquiryImoHistory(state: DemoState, imo: string, excludeEnquiryId?: string): { wins: Outcome[]; losses: Outcome[] } {
  const normalized = imo.trim();
  if (!/^\d{7}$/.test(normalized) || normalized.slice(0, 6).split('').reduce((sum, digit, index) => sum + Number(digit) * (7 - index), 0) % 10 !== Number(normalized[6])) return { wins: [], losses: [] };
  const matches = state.outcomes.filter(outcome => outcome.enquiryId !== excludeEnquiryId &&
    (outcome.imo || state.enquiries.find(enquiry => enquiry.id === outcome.enquiryId)?.imo)?.trim() === normalized)
    .sort((a, b) => Date.parse(b.bookedAt) - Date.parse(a.bookedAt));
  return { wins: matches.filter(outcome => outcome.kind === 'fixture'), losses: matches.filter(outcome => outcome.kind === 'lost') };
}


export function isPendingOutcome(outcome: Outcome): boolean {
  return outcome.commercialStatus === 'pending';
}

/** Display the entered quantities without inventing a midpoint or a settled total. */
export function outcomeQuantityText(outcome: Outcome): string {
  const requested = outcome.stemProducts?.length ? outcome.stemProducts : outcome.requestedProducts;
  return requested?.length ? requested.map(product => product.quantityText).join(' + ') : outcome.quantity.toLocaleString('en-US');
}

/** UI-only demo separation. A production service must enforce this ownership on the server. */
export function getOutcomePrivateNote(state: DemoState, outcomeId: string, actorId: string): string {
  const actor = actors.find(person => person.id === actorId && canTrade(person));
  const outcome = state.outcomes.find(item => item.id === outcomeId);
  const note = state.privateNotes?.[outcomeId];
  return actor && outcome?.owner === actor.id && note?.owner === actor.id ? note.text : '';
}

export function outcomeProfit(outcome: Outcome): number {
  if (isPendingOutcome(outcome)) return 0;
  return money(outcome.products?.length
    ? outcome.products.reduce((sum, product) => sum + product.quantity * product.margin, 0)
    : outcome.quantity * outcome.margin);
}

export function monthlyStats(state: DemoState, owner: string, month: string): { volume: number; profit: number; fixtures: number } {
  const fixtures = state.outcomes.filter(outcome => outcome.owner === owner && outcome.kind === 'fixture' && !isPendingOutcome(outcome) && reportingMonth(outcome.bookedAt) === month);
  return {
    volume: money(fixtures.reduce((sum, outcome) => sum + outcome.quantity, 0)),
    profit: money(fixtures.reduce((sum, outcome) => sum + outcomeProfit(outcome), 0)),
    fixtures: fixtures.length,
  };
}

function required(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function number(value: number, label: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  if (minimum !== undefined && value < minimum) throw new Error(`${label} must be ${minimum === 0 ? 'zero or greater' : `at least ${minimum}`}.`);
  return value;
}

function positive(value: number, label: string): number {
  number(value, label, 0);
  if (value === 0) throw new Error(`${label} must be greater than zero.`);
  return value;
}

function permit(actor: Actor, roles: Role[]): void {
  const accessActor = isAccessActor(actor);
  // Saved prototype contact records are not an identity or permission source.
  if (!accessActor && !actors.some(known => known.id === actor.id && known.role === actor.role)) throw new Error('Select a valid demo role.');
  if (!roles.includes(actor.role) && !(accessActor && actor.isAdmin && roles.includes('admin'))) {
    throw new Error(`Your ${actor.role} role cannot perform this action.`);
  }
}

function companyById(state: DemoState, id: string): Company {
  const company = state.companies.find(item => item.id === id);
  if (!company) throw new Error('Choose a company from the company database.');
  return company;
}

function ownEnquiry(state: DemoState, id: string, actor: Actor): Enquiry {
  permit(actor, ['trader', 'manager']);
  const enquiry = state.enquiries.find(item => item.id === id);
  if (!enquiry) throw new Error('This enquiry could not be found.');
  if (enquiry.owner !== actor.id) throw new Error('Only the enquiry owner can change it.');
  return enquiry;
}

function audit(state: DemoState, actor: Actor, at: string, action: string, entity: string, detail: string): void {
  state.audit.unshift({ id: uid('audit'), at, actor: actor.name, role: actor.role, action, entity, detail });
}

function creditExpiry(value: string | undefined, at: string): string {
  if (!value || !Number.isFinite(new Date(value).getTime()) || new Date(value).getTime() <= new Date(at).getTime()) {
    throw new Error('Temporary credit requires an expiry after the approval date.');
  }
  return new Date(value).toISOString();
}

function creditNotifications(state: DemoState, request: CreditRequest, kind: CreditNotification['kind'], actorId: string, at: string): void {
  if (!request.workflow) return;
  state.creditNotifications ??= [];
  for (const recipient of request.recipients ?? []) {
    const id = `${request.id}:${kind}:${recipient.actorId}`;
    if (!state.creditNotifications.some(item => item.id === id)) state.creditNotifications.push({ id, requestId: request.id, recipientId: recipient.actorId, kind, createdAt: at, ...(recipient.actorId === actorId ? { readAt: at } : {}) });
  }
}

function createRequest(state: DemoState, actor: Actor, at: string, input: { companyId: string; enquiryId?: string; amount: number; reason: string; requestType: CreditRequest['type']; expiresAt?: string; priority?: CreditRequest['priority'] } & CreditRequestInputFields): CreditRequest {
  const company = companyById(state, input.companyId);
  const amount = positive(money(number(input.amount, 'Requested credit', 0)), 'Requested credit');
  const reason = input.workflow ? uppercaseText(required(input.reason, 'Credit request reason')) : required(input.reason, 'Credit request reason');
  if (input.workflow && !['urgent', 'p1'].includes(input.workflow)) throw new Error('Choose URGENT or P1.');
  if (input.amountBasis && !input.workflow) throw new Error('Choose a credit workflow for the amount basis.');
  if (input.workflow === 'urgent' && (input.requestType !== 'temporary' || input.amountBasis !== 'additional')) throw new Error('URGENT credit is an additional temporary overage.');
  if (input.workflow === 'p1' && (input.requestType === 'temporary' || input.amountBasis !== 'total')) throw new Error('P1 credit is an expected total credit limit.');
  if (input.workflow && company.personInChargeId && company.personInChargeId !== actor.id && input.nonPicConfirmed !== true) throw new Error('Confirm the buyer’s person in charge before sending this request.');
  const attachments = validateCreditAttachments(input.attachments);
  const voyage = input.voyage ? { vessel: uppercaseText(required(input.voyage.vessel, 'Vessel')), imo: required(input.voyage.imo, 'IMO'), portId: input.voyage.portId, portName: uppercaseText(required(input.voyage.portName, 'Port')), eta: uppercaseText(required(input.voyage.eta, 'ETA')) } : undefined;
  if (input.workflow === 'urgent' && !voyage) throw new Error('URGENT credit requires vessel, IMO, port and ETA.');
  if (voyage) {
    if (!/^\d{7}$/.test(voyage.imo)) throw new Error('Enter a seven-digit IMO.');
    if (voyage.vessel.length > 150 || voyage.portName.length > 150 || voyage.eta.length > 100) throw new Error('Voyage details are too long.');
    if (voyage.portId && !state.ports.some(port => port.id === voyage.portId)) throw new Error('Choose a valid port.');
  }
  if (!['increase', 'new-customer', 'temporary'].includes(input.requestType)) throw new Error('Choose a valid credit request type.');
  if (input.requestType === 'new-customer' && company.status !== 'pending') throw new Error('This customer is already approved. Request a limit increase instead.');
  if (input.requestType !== 'new-customer' && company.status !== 'approved') throw new Error('Complete new-customer approval before requesting an increase.');
  if (input.priority && !['normal', 'urgent', 'p1'].includes(input.priority)) throw new Error('Choose a valid request priority.');
  const expiresAt = input.requestType === 'temporary' ? creditExpiry(input.expiresAt, at) : undefined;
  if (state.requests.some(request => request.companyId === company.id && request.type === input.requestType && request.status === 'pending')) {
    throw new Error('A request of this type is already awaiting a decision for this company.');
  }
  if (input.enquiryId) {
    const enquiry = ownEnquiry(state, input.enquiryId, actor);
    if (enquiry.buyerId !== company.id) throw new Error('The linked enquiry belongs to a different buyer.');
  }
  const request: CreditRequest = {
    id: uid('credit'), requestNumber: nextCreditRequestNumber(state.requests, at), companyId: company.id, enquiryId: input.enquiryId,
    type: input.requestType, amount: money(amount), reason, status: 'pending',
    ...(input.workflow ? { workflow: input.workflow, amountBasis: input.amountBasis, nonPicConfirmed: input.nonPicConfirmed === true, recipients: creditRequestRecipients(state, actor, company) } : {}),
    ...(voyage ? { voyage } : {}), ...(attachments.length ? { attachments } : {}),
    requestedBy: actor.id, requestedAt: at, requestedOffice: teamForActor(actor)?.name, priority: input.priority ?? input.workflow ?? 'normal', ...(expiresAt ? { expiresAt } : {}),
  };
  state.requests.unshift(request);
  creditNotifications(state, request, 'requested', actor.id, at);
  audit(state, actor, at, 'Credit requested', company.name, `${request.type}; USD ${request.amount.toLocaleString('en-US')}; ${reason}`);
  return request;
}

function outcomeEnquiry(state: DemoState, id: string, actor: Actor): Enquiry {
  const enquiry = ownEnquiry(state, id, actor);
  if (enquiry.status !== 'sent') throw new Error('Confirm the enquiry before recording its outcome.');
  if (state.outcomes.some(outcome => outcome.enquiryId === enquiry.id)) throw new Error('This enquiry already has a recorded outcome.');
  if (!state.ports.some(port => port.id === enquiry.portId)) throw new Error('A valid port is required for the trading outcome.');
  return enquiry;
}

function normalizeQuantityText(input: string, grade: string): string {
  if (!parseProductQuantity(input)) throw new Error(`Enter a valid ${grade} quantity or range.`);
  return input.trim().replace(/\s*(?:MT|MTS|metric\s+tonnes?)$/i, '').trim()
    .replace(/\s*(?:[-–—−~/]|\bto\b)\s*/gi, '–');
}

function privateNote(state: DemoState, outcome: Outcome, value: string | undefined, now: string): void {
  if (value !== undefined && typeof value !== 'string') throw new Error('Private note must be text.');
  const text = value?.trim();
  if (text) {
    state.privateNotes ??= {};
    state.privateNotes[outcome.id] = { owner: outcome.owner, text, updatedAt: now };
  }
}

/** All changes affect an isolated demo state. No action calls a live service. */
export interface ActionReferences { suppliers?: readonly { id: string; name: string }[] }
export function applyAction(state: DemoState, action: Action, actor: Actor, now = new Date().toISOString(), references: ActionReferences = {}): DemoState {
  permit(actor, ['trader', 'manager', 'credit', 'admin']);
  if (!Number.isFinite(Date.parse(now))) throw new Error('The action date is invalid.');
  const next = structuredClone(state);
  switch (action.type) {
    case 'set-hat': {
      const hat = recordHat(next, action.target, action.expectedUpdate, action.active, actor.id, now, uid('hat'));
      if (!hat) return state;
      audit(next, actor, now, action.active ? 'Hats Off' : 'Hats Off removed', hat.targetKey,
        actors.find(person => person.id === hat.recipientId)?.name ?? hat.recipientId);
      return next;
    }
    case 'add-location': {
      const name = required(action.name, 'Location name').replace(/\s+/g, ' ');
      if (name.length > 150 || /[\u0000-\u001f\u007f]/.test(action.name)) throw new Error('Enter a location name of 150 characters or fewer.');
      const sameName = (value: string) => value.trim().toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US');
      if ('areaId' in action || !['country', 'port'].includes(action.kind)) throw new Error('Select a country or port.');
      if (action.kind === 'country') {
        if (action.country) throw new Error('A country cannot have a parent location.');
        if (locationCountries(next).some(country => sameName(country.name))) throw new Error('This country already exists.');
        next.locationCountries ??= [];
        next.locationCountries.push({ id: name, name });
      } else {
        const country = locationCountries(next).find(item => item.id === action.country || item.name === action.country);
        if (!country) throw new Error('Select a valid country.');
        if (action.kind === 'port') {
          if (next.ports.some(port => port.country === country.name && sameName(port.name))) throw new Error('This port already exists in the country.');
          next.ports.push({ id: uid('port'), name, country: country.name,
            code: '', timezone: '', leadTime: '', summary: '', notes: [], updatedAt: now, tags: [] });
        } else throw new Error('Select a country or port.');
      }
      audit(next, actor, now, 'Location added', name, action.kind);
      break;
    }
    case 'record-actual-volume': {
      permit(actor, ['trader', 'manager']);
      const outcome = next.outcomes.find(item => item.id === action.id);
      if (!outcome || outcome.kind !== 'fixture') throw new Error('Select a STEM record.');
      if (outcome.owner !== actor.id) throw new Error('Only the trader who recorded STEM can record actual volume.');
      const quantity = positive(resourceAmount(action.quantity, 'Actual volume'), 'Actual volume');
      if (outcome.actualVolume) {
        if (outcome.actualVolume.quantity !== quantity) throw new Error('Actual volume has already been recorded.');
        return next;
      }
      if (!isPendingOutcome(outcome)) throw new Error('This fixture already has an exact traded volume.');
      outcome.actualVolume = { quantity, recordedAt: now, recordedBy: actor.id };
      audit(next, actor, now, 'Actual volume recorded', outcome.vessel, `${quantity} MT.`);
      break;
    }
    case 'save-enquiry': {
      permit(actor, ['trader', 'manager']);
      const input = action.enquiry;
      required(input.id, 'Enquiry ID');
      if (input.owner !== actor.id) throw new Error('You can only save your own enquiries.');
      const previous = next.enquiries.find(item => item.id === input.id);
      if (previous) ownEnquiry(next, previous.id, actor);
      if (previous && previous.status !== 'draft') throw new Error('Only draft enquiries can be edited.');
      if (input.status !== 'draft') throw new Error('Save the enquiry as a draft before confirmation or recording an outcome.');
      number(input.quantity, 'Quantity', 0);
      number(input.price, 'Price', 0);
      number(input.margin, 'Margin');
      if (input.buyerId) companyById(next, input.buyerId);
      if (input.portId && !next.ports.some(port => port.id === input.portId)) throw new Error('Choose a port from the port database.');
      const enquiry = { ...structuredClone(input), owner: actor.id, createdAt: previous?.createdAt ?? now,
        complianceChecked: input.complianceChecked === true, creditChecked: input.creditChecked === true,
        creditConfirmations: Array.isArray(input.creditConfirmations) ? [...new Set(input.creditConfirmations.filter(id => typeof id === 'string'))] : [],
        amendments: previous?.amendments, sentAt: previous?.sentAt, lastAmendedAt: previous?.lastAmendedAt,
        postponedAt: previous?.postponedAt, cancelledAt: previous?.cancelledAt };
      if (previous) next.enquiries[next.enquiries.indexOf(previous)] = enquiry;
      else next.enquiries.unshift(enquiry);
      audit(next, actor, now, previous ? 'Enquiry updated' : 'Enquiry saved', enquiry.vessel || enquiry.id, 'Demo draft saved; buyer and port remain editable until confirmation.');
      break;
    }
    case 'confirm-enquiry':
    case 'send-enquiry': {
      const enquiry = ownEnquiry(next, action.id, actor);
      if (enquiry.status !== 'draft') throw new Error('Only a draft enquiry can be confirmed.');
      companyById(next, enquiry.buyerId);
      if (!next.ports.some(port => port.id === enquiry.portId)) throw new Error('Confirm the port.');
      required(enquiry.vessel, 'Vessel name');
      required(enquiry.eta, 'Delivery date');
      required(enquiry.formattedText, 'Formatted enquiry');
      if (enquiry.products?.length) {
        const grades = new Set<string>();
        for (const product of enquiry.products) {
          if (!['HSFO', 'VLSFO', 'LSMGO'].includes(product.grade) || grades.has(product.grade)) throw new Error('Confirm each product grade once.');
          grades.add(product.grade);
          if (!parseProductQuantity(product.quantityText)) throw new Error(`Confirm the ${product.grade} quantity in MT.`);
        }
      } else {
        required(enquiry.grade, 'Grade');
        positive(enquiry.quantity, 'Quantity');
      }
      enquiry.status = 'sent';
      enquiry.sentAt = now;
      delete enquiry.postponedAt;
      audit(next, actor, now, 'Enquiry confirmed (demo)', enquiry.vessel, `${enquiry.amendments?.length ? `Amendment ${enquiry.amendments.length}; ` : ''}confirmation recorded locally.`);
      break;
    }
    case 'amend-enquiry': {
      const enquiry = ownEnquiry(next, action.id, actor);
      if (!['sent', 'postponed'].includes(enquiry.status)) throw new Error('Only confirmed or postponed enquiries can be amended.');
      const { amendments, ...before } = structuredClone(enquiry);
      enquiry.amendments = [...(amendments ?? []), { at: now, by: actor.id, before }];
      enquiry.lastAmendedAt = now;
      enquiry.status = 'draft';
      enquiry.complianceChecked = false;
      enquiry.creditChecked = false;
      enquiry.creditConfirmations = [];
      audit(next, actor, now, 'Enquiry amendment started', enquiry.vessel, `Revision ${enquiry.amendments.length}; previous details retained.`);
      break;
    }
    case 'postpone-enquiry': {
      const enquiry = ownEnquiry(next, action.id, actor);
      if (enquiry.status !== 'sent') throw new Error('Only confirmed enquiries can be postponed.');
      enquiry.status = 'postponed';
      enquiry.postponedAt = now;
      audit(next, actor, now, 'Enquiry postponed', enquiry.vessel, 'No trading outcome or credit exposure recorded.');
      break;
    }
    case 'cancel-enquiry': {
      const enquiry = ownEnquiry(next, action.id, actor);
      if (!['draft', 'sent', 'postponed'].includes(enquiry.status)) throw new Error('Only open enquiries can be cancelled.');
      enquiry.status = 'cancelled';
      enquiry.cancelledAt = now;
      audit(next, actor, now, 'Enquiry cancelled', enquiry.vessel, 'Cancelled without a lost record or credit exposure.');
      break;
    }
    case 'record-stem': {
      const enquiry = outcomeEnquiry(next, action.id, actor);
      if (action.complianceChecked !== true || action.creditChecked !== true) throw new Error('Complete the compliance and credit checks before STEM.');
      const company = companyById(next, enquiry.buyerId);
      const blocked = companyTradingBlockedReason(company);
      if (blocked) throw new Error(blocked);
      if (!Array.isArray(action.products) || !action.products.length) throw new Error('Enter buy prices for every requested product.');
      const requested = enquiry.products?.length ? enquiry.products.map(product => product.grade) : [enquiry.grade];
      const grades = new Set<string>();
      const products = action.products.map(product => {
        if (!requested.includes(product.grade) || grades.has(product.grade)) throw new Error('STEM grades must match the enquiry.');
        grades.add(product.grade);
        // An explicitly cleared grade must not silently regain the old common supplier.
        const supplierId = product.supplierId !== undefined ? product.supplierId : action.supplierId;
        const supplier = !retiredSupplierIds.has(supplierId ?? '') && references.suppliers?.find(item => item.id === supplierId);
        if (!supplier) throw new Error(`Choose a supplier for ${product.grade}.`);
        return {
          grade: product.grade,
          quantityText: normalizeQuantityText(product.quantityText, product.grade),
          buyPrice: positive(money(positive(product.buyPrice, `${product.grade} buy price`)), `${product.grade} buy price`),
          supplierId: supplier.id,
          supplierName: supplier.name,
        };
      });
      if (grades.size !== requested.length) throw new Error('Enter buy prices for every requested product.');
      const estimatedPurchaseCost = money(products.reduce((total, product) => total + parseProductQuantity(product.quantityText)!.max * product.buyPrice, 0));
      if (availableCredit(company, now) < estimatedPurchaseCost) throw new Error(`Insufficient credit: USD ${availableCredit(company, now).toLocaleString('en-US')} available; estimated purchase cost USD ${estimatedPurchaseCost.toLocaleString('en-US')} at maximum quantities. Request additional credit first.`);
      const outcome: Outcome = {
        id: uid('outcome'), enquiryId: enquiry.id, kind: 'fixture',
        buyerId: enquiry.buyerId, portId: enquiry.portId, vessel: enquiry.vessel, imo: enquiry.imo,
        grade: products.map(product => product.grade).join(' + '), quantity: 0, price: 0, margin: 0,
        bookedAt: now, owner: actor.id, reason: '', stemProducts: products,
        ...(products.every(product => product.supplierId === products[0].supplierId)
          ? { supplierId: products[0].supplierId, supplierName: products[0].supplierName } : {}),
        commercialStatus: 'pending',
        complianceChecked: true, creditChecked: true, checkedBy: actor.id, checkedAt: now,
      };
      privateNote(next, outcome, action.privateNote, now);
      next.outcomes.unshift(outcome);
      enquiry.status = 'fixture';
      // The enquiry retains its original requested quantity; pending outcome totals remain zero.
      enquiry.price = 0;
      enquiry.margin = 0;
      audit(next, actor, now, 'STEM recorded', enquiry.vessel,
        `${products.map(product => `${product.grade}: ${product.supplierName}; ${product.quantityText} MT at USD ${product.buyPrice}/MT buy price`).join('; ')}. Commercial totals pending.`);
      break;
    }
    case 'record-loss': {
      const enquiry = outcomeEnquiry(next, action.id, actor);
      companyById(next, enquiry.buyerId);
      const reason = lostReasonsFor(next).find(item => item.id === action.reasonId && item.active);
      if (!reason) throw new Error('Choose an active lost reason.');
      if (action.groupNote !== undefined && typeof action.groupNote !== 'string') throw new Error('Group note must be text.');
      const outcome: Outcome = {
        id: uid('outcome'), enquiryId: enquiry.id, kind: 'lost',
        buyerId: enquiry.buyerId, portId: enquiry.portId, vessel: enquiry.vessel, imo: enquiry.imo,
        grade: enquiry.products?.map(product => product.grade).join(' + ') || enquiry.grade,
        quantity: enquiry.products?.length ? 0 : enquiry.quantity, price: 0, margin: 0,
        bookedAt: now, owner: actor.id, reason: reason.label, reasonId: reason.id,
        groupNote: action.groupNote?.trim() || '',
        ...(enquiry.products?.length ? { requestedProducts: enquiry.products.map(product => ({
          grade: product.grade, quantityText: normalizeQuantityText(product.quantityText, product.grade),
        })) } : {}),
      };
      privateNote(next, outcome, action.privateNote, now);
      next.outcomes.unshift(outcome);
      enquiry.status = 'lost';
      audit(next, actor, now, 'Lost enquiry recorded', enquiry.vessel, reason.label);
      break;
    }
    case 'save-lost-reasons': {
      permit(actor, ['admin']);
      if (!Array.isArray(action.reasons) || !action.reasons.length || action.reasons.length > 100) throw new Error('Provide between 1 and 100 lost reasons.');
      const ids = new Set<string>();
      const labels = new Set<string>();
      const reasons = action.reasons.map(reason => {
        const id = required(reason.id, 'Lost reason ID');
        const label = required(reason.label, 'Lost reason').replace(/\s+/g, ' ');
        if (label.length > 160) throw new Error('Lost reasons must be 160 characters or fewer.');
        if (ids.has(id) || labels.has(label.toLocaleLowerCase('en-US'))) throw new Error('Lost reasons must have unique IDs and labels.');
        if (typeof reason.active !== 'boolean') throw new Error('Choose whether each lost reason is active.');
        ids.add(id);
        labels.add(label.toLocaleLowerCase('en-US'));
        return { id, label, active: reason.active };
      });
      if (!reasons.some(reason => reason.active)) throw new Error('Keep at least one lost reason active.');
      next.lostReasons = reasons;
      audit(next, actor, now, 'Lost reasons updated', 'Settings', `${reasons.filter(reason => reason.active).length} active reasons; order and labels saved.`);
      break;
    }
    case 'request-credit': {
      permit(actor, ['trader', 'manager']);
      createRequest(next, actor, now, action);
      break;
    }
    case 'acknowledge-credit': {
      permit(actor, ['credit', 'admin']);
      const request = next.requests.find(item => item.id === action.id);
      if (!request) throw new Error('The credit request could not be found.');
      if (request.status !== 'pending') throw new Error('This credit request already has a recorded decision.');
      if (request.acknowledgedAt) break;
      request.acknowledgedAt = now;
      request.acknowledgedBy = actor.id;
      for (const notification of next.creditNotifications ?? []) if (notification.requestId === request.id && notification.recipientId === actor.id && !notification.readAt) notification.readAt = now;
      creditNotifications(next, request, 'acknowledged', actor.id, now);
      audit(next, actor, now, 'Credit request acknowledged', companyById(next, request.companyId).name, request.id);
      break;
    }
    case 'decide-credit': {
      permit(actor, ['credit', 'admin']);
      const request = next.requests.find(item => item.id === action.id);
      if (!request) throw new Error('The credit request could not be found.');
      if (request.status !== 'pending') throw new Error('This credit request already has a recorded decision.');
      const note = request.workflow ? uppercaseText(required(action.note, 'Decision reason')) : required(action.note, 'Decision reason');
      number(action.amount, 'Approved credit', 0);
      const company = companyById(next, request.companyId);
      const oldLimit = company.limit;
      const oldTerms = company.terms;
      const oldStatus = company.status;
      const amount = action.approve ? positive(money(action.amount), 'Approved credit') : 0;
      const terms = action.approve ? required(action.terms, 'Payment terms') : action.terms.trim();
      const expiresAt = action.approve && request.type === 'temporary' ? creditExpiry(action.expiresAt ?? request.expiresAt, now) : undefined;
      if (action.approve) {
        if (request.type === 'new-customer' && company.status !== 'pending') throw new Error('This customer has already been approved. Review the request before deciding.');
        if (request.type === 'temporary') {
          if (company.status !== 'approved') throw new Error('Complete new-customer approval before a temporary facility.');
          company.temporaryCredits ??= [];
          company.temporaryCredits.push({ id: uid('facility'), requestId: request.id, amount, startsAt: now, expiresAt: expiresAt!, approvedBy: actor.id, terms });
        } else {
          company.limit = money(number(request.type === 'increase' && request.amountBasis !== 'total' ? company.limit + amount : amount, 'Resulting credit limit', 0));
          company.terms = terms;
          if (request.type === 'new-customer') company.creditStatus = 'Active';
        }
        money(number(effectiveCreditLimit(company, now), 'Effective credit limit', 0));
        company.status = 'approved';
        company.lifecycle = 'buyer';
        company.reviewDate = now.slice(0, 10);
        company.creditUpdatedAt = now;
        next.creditHistory ??= [];
        next.creditHistory.unshift({ id: uid('credit-history'), companyId: company.id, effectiveAt: now, recordedAt: now, by: actor.id,
          type: request.type === 'temporary' ? 'temporary' : 'limit', summary: note,
          previousLimit: oldLimit, limit: request.type === 'temporary' ? amount : company.limit,
          terms, requestId: request.id, ...(expiresAt ? { expiresAt } : {}) });
      }
      request.status = action.approve ? 'approved' : 'declined';
      request.closedAt = now;
      for (const notification of next.creditNotifications ?? []) if (notification.requestId === request.id && notification.recipientId === actor.id && !notification.readAt) notification.readAt = now;
      creditNotifications(next, request, action.approve ? 'approved' : 'declined', actor.id, now);
      request.decision = { by: actor.id, at: now, note, amount, terms, previousLimit: oldLimit, resultingLimit: company.limit, ...(expiresAt ? { expiresAt } : {}) };
      audit(next, actor, now, action.approve ? 'Credit approved' : 'Credit declined', company.name,
        `${request.type}; requested USD ${request.amount}; approved USD ${amount}; limit USD ${oldLimit} → USD ${company.limit}; terms: ${oldTerms} → ${company.terms}; status: ${oldStatus} → ${company.status}; reason: ${note}`);
      break;
    }
    case 'add-company': {
      permit(actor, ['trader', 'manager']);
      const input = action.company;
      const name = required(input.name, 'Legal company name');
      required(input.id, 'Company ID');
      required(input.country, 'Country');
      required(input.sellingEntity, 'Selling entity');
      number(input.limit, 'Credit limit', 0);
      number(input.exposure, 'Exposure', 0);
      number(input.overdue, 'Overdue balance', 0);
      positive(action.requestedLimit, 'Requested initial credit');
      required(action.reason, 'Onboarding reason');
      if (next.companies.some(company => company.id === input.id) || exactBuyerDuplicates(next.companies, name, input.aliases).length) throw new Error('This company already exists. Open its record instead.');
      if (possibleBuyerDuplicates(next.companies, name, input.aliases).length && action.duplicateConfirmed !== true) throw new Error('Confirm this is a different legal buyer from the similar existing records.');
      const attachments = validateCreditAttachments(action.attachments);
      if (input.limit !== 0 || input.exposure !== 0 || input.overdue !== 0) throw new Error('A new customer starts with zero credit and exposure until reviewed.');
      const customerId = input.customerId?.trim().toUpperCase() || nextCustomerId(next.companies);
      if (next.companies.some(company => company.customerId?.trim().toUpperCase() === customerId)) throw new Error('This customer ID already exists.');
      const personInChargeId = input.personInChargeId || actor.id;
      const personInCharge = isAccessActor(actor) ? (personInChargeId === actor.id && canTrade(actor) ? actor : undefined) : actors.find(person => person.id === personInChargeId && canTrade(person));
      if (!personInCharge) throw new Error('Choose a valid person in charge.');
      const assignedTeam = teamForActor(personInCharge);
      const office = (isAccessActor(actor) ? actor.officeName || actor.officeId : input.office?.trim()) || (assignedTeam?.id === 'team-gianmichele' ? 'HKG' : assignedTeam?.id === 'team-italy' ? 'GOA' : 'UNASSIGNED');
      const company: Company = { ...structuredClone(input), name, customerId, personInChargeId, office,
        status: 'pending', lifecycle: 'lead', activeCreditRemarkId: undefined, creditStatus: undefined, limit: 0, exposure: 0, overdue: 0, temporaryCredits: [],
        creditUpdatedAt: undefined, approvedGroupCredit: undefined, insuredCredit: 0,
        inChargeHistory: [{ id: uid('assignment'), personId: personInChargeId, office, from: now }] };
      next.companies.unshift(company);
      audit(next, actor, now, 'Customer onboarding started', name, 'New legal entity created with pending status and no approved credit.');
      createRequest(next, actor, now, { companyId: company.id, amount: action.requestedLimit, reason: action.reason, requestType: 'new-customer', ...(action.workflow ? { workflow: 'p1', amountBasis: 'total', nonPicConfirmed: action.nonPicConfirmed } : {}), attachments });
      break;
    }
    case 'save-buyer-shared-list': {
      if (!['group', 'team', 'competition'].includes(action.kind)) throw new Error('Select a valid list.');
      if (action.kind === 'competition') permit(actor, ['trader', 'manager']);
      const buyer = companyById(next, action.buyerId);
      const targetId = action.kind === 'group' ? buyerGroupKey(buyer) : buyer.id;
      const current = action.kind === 'team' ? buyerTeamEntries(next, buyer) : buyerSharedEntries(next, action.kind, targetId);
      const label = action.kind === 'competition' ? 'Competition' : 'Team Remarks';
      const entries = validateBuyerListRevision(current, action.entries, action.baseEntries, actor.id, now, label);
      next.buyerSharedLists ??= {};
      next.buyerSharedLists[buyerSharedListKey(action.kind, targetId)] = { entries, updatedBy: actor.id, updatedAt: now };
      // Keep prior publications intact. Each real list revision has one reward ID.
      next.contributions.unshift({ id: uid('contribution'), targetType: action.kind === 'group' ? 'buyer-group' : action.kind === 'team' ? 'buyer-team' : 'buyer-competition', targetId,
        title: `${buyer.name} · ${label}`, body: entries.map(entry => entry.text).join('\n\n') || `${label} cleared`,
        author: actor.id, createdAt: now, publishedAt: now, publication: 'direct', status: 'approved' });
      audit(next, actor, now, `${label} updated`, buyer.name, 'List updated.');
      break;
    }
    case 'save-buyer-private-list': {
      companyById(next, action.buyerId);
      const current = buyerPrivateEntries(next, action.buyerId, actor.id);
      const entries = validateBuyerListRevision(current, action.entries, action.baseEntries, actor.id, now, 'Private Remarks');
      next.buyerPrivateRemarks ??= {};
      next.buyerPrivateRemarks[JSON.stringify([actor.id, action.buyerId])] = { owner: actor.id, buyerId: action.buyerId,
        text: entries.map(entry => entry.text).join('\n\n'), entries, updatedAt: now };
      // Private content and revisions never enter shared contributions or audit.
      break;
    }
    case 'save-buyer-credit-remarks': {
      permit(actor, ['credit', 'admin']);
      const company = companyById(next, action.buyerId);
      if (typeof action.text !== 'string' || action.text.length > 10000) throw new Error('Credit Remarks must be 10,000 characters or fewer.');
      const text = action.text.trim();
      if (company.activeCreditRemarkId && text === company.creditRemarks) break;
      const entry: CreditHistoryEntry = { id: uid('credit-remark'), companyId: company.id, effectiveAt: now, recordedAt: now, by: actor.id, type: 'remark', summary: text };
      next.creditHistory ??= [];
      next.creditHistory.unshift(entry);
      company.creditRemarks = text;
      company.activeCreditRemarkId = entry.id;
      audit(next, actor, now, 'Credit Remarks updated', company.name, company.creditRemarks || 'Cleared');
      break;
    }
    case 'set-active-credit-remark': {
      permit(actor, ['credit', 'admin']);
      const company = companyById(next, action.buyerId);
      const entry = next.creditHistory?.find(item => item.id === action.historyId && item.companyId === company.id && item.type === 'remark');
      if (!entry) throw new Error('Choose a credit remark from this buyer’s history.');
      if (company.activeCreditRemarkId === entry.id) break;
      company.activeCreditRemarkId = entry.id;
      company.creditRemarks = entry.summary;
      audit(next, actor, now, 'Active Credit Remark selected', company.name, entry.id);
      break;
    }
    case 'mark-credit-request-read': {
      if (!next.requests.some(request => request.id === action.id)) throw new Error('The credit request could not be found.');
      for (const notification of next.creditNotifications ?? []) if (notification.requestId === action.id && notification.recipientId === actor.id && !notification.readAt) notification.readAt = now;
      break;
    }
    case 'save-extracted-knowledge': {
      if (typeof action.batchId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action.batchId)) throw new Error('The update reference is invalid.');
      if (next.contributions.some(item => item.extractionBatch?.id === action.batchId)) throw new Error('This update has already been published.');
      if (!Array.isArray(action.changes) || !Array.isArray(action.intelligenceChanges) || action.changes.length > 40 || action.intelligenceChanges.length > 40 || !(action.changes.length + action.intelligenceChanges.length)) throw new Error('Select information to update.');
      const reason = required(action.reason, 'Reason');
      if (reason.length > 5000 || (action.source !== undefined && (typeof action.source !== 'string' || action.source.length > 2048))) throw new Error('Reason or source is too long.');
      const source = action.source?.trim();
      const targets = new Set<string>();
      // Validate the complete batch against the same state before changing any record.
      const changes = action.changes.map(input => {
        if (!input?.target || !['country', 'port'].includes(input.target.kind)) throw new Error('Select a country or port.');
        const change = checkKnowledgeChange(next, input);
        const key = knowledgeKey(next, change.target);
        if (targets.has(key)) throw new Error('Combine updates for the same location.');
        targets.add(key);
        validateExtractedContentChange(change, change.target.kind === 'port' && action.intelligenceChanges.some(item => item?.portId === change.target.id));
        return change;
      });
      const ports = new Set<string>();
      const intelligenceChanges = action.intelligenceChanges.map(input => {
        const port = next.ports.find(item => item.id === input?.portId);
        if (!port) throw new Error('Select a valid port.');
        if (ports.has(port.id)) throw new Error('Combine Key Info updates for the same port.');
        ports.add(port.id);
        const before = port.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
        const baseKeyInfo = validateIntelligenceKeyInfo(input.baseKeyInfo);
        const keyInfo = validateIntelligenceKeyInfo(input.keyInfo);
        if (!sameIntelligenceKeyInfo(before, baseKeyInfo)) throw new Error('Key Info changed. Extract again and check the update before publishing.');
        if (sameIntelligenceKeyInfo(before, keyInfo)) throw new Error('No Key Info changes to save.');
        return { portId: port.id, baseKeyInfo, keyInfo };
      });
      for (const change of changes) publishKnowledge(next, change, actor.id, now, reason, source);
      for (const change of intelligenceChanges) {
        const port = next.ports.find(item => item.id === change.portId)!;
        stampKeyInfo(port, change.keyInfo, actor.id, now);
        port.intelligenceKeyInfo = change.keyInfo;
        port.updatedAt = now;
      }
      const first = changes[0]?.target ?? { kind: 'port' as const, id: intelligenceChanges[0].portId };
      const names = [...new Set([...changes.map(change => knowledgeName(next, change.target)), ...intelligenceChanges.map(change => knowledgeName(next, { kind: 'port', id: change.portId }))])];
      next.contributions.unshift({ id: uid('contribution'), targetType: first.kind, targetId: first.id, title: names.join(' · '), body: reason, source, author: actor.id, createdAt: now, publishedAt: now, publication: 'direct', status: 'approved', extractionBatch: { id: action.batchId, changes, intelligenceChanges } });
      audit(next, actor, now, 'Extracted information updated', names.join(' · '), `${reason}; contribution recorded.`);
      break;
    }
    case 'manage-knowledge-tabs': {
      if (!Array.isArray(action.changes) || !action.changes.length || action.changes.length > 40) throw new Error('Select tabs to update.');
      if (action.changes.some(change => change?.target?.kind === 'supplier') && action.changes.length !== 1) throw new Error('Manage one supplier profile at a time.');
      const targets = new Set<string>();
      const changes = action.changes.map(input => {
        if (!input?.target || !['country', 'port', 'supplier'].includes(input.target.kind)) throw new Error('Select a country, port or supplier.');
        const change = checkKnowledgeChange(next, input, input.target.kind !== 'supplier'), key = knowledgeKey(next, change.target);
        if (targets.has(key)) throw new Error('Combine tab updates for the same location.');
        targets.add(key);
        for (const section of change.document.sections) {
          const previous = change.baseDocument.sections.find(item => item.id === section.id);
          if (previous ? !sameKnowledge({ version: 0, sections: [{ ...previous, title: section.title }] }, { version: 0, sections: [section] }) : section.blocks.length > 0)
            throw new Error('Manage Tabs can add, rename, remove or reorder tabs. Edit information separately.');
        }
        return change;
      });
      const projected = new Map(changes.map(change => [knowledgeKey(next, change.target), change.document]));
      for (const change of changes) {
        if (change.target.kind === 'supplier') continue;
        const profile = locationProfileTarget(next, change.target), country = profileCountryTarget(next, profile);
        const documents = [profile, ...(country ? [country] : [])].map(target => projected.get(knowledgeKey(next, target)) ?? knowledgeDocument(next, target));
        if (!documents.some(document => document.sections.length)) throw new Error('Keep at least one tab.');
      }
      for (const change of changes) publishKnowledge(next, change, actor.id, now, 'Manage Tabs', undefined, true);
      const first = changes[0].target;
      const names = [...new Set(changes.map(change => knowledgeName(next, change.target)))];
      next.contributions.unshift({ id: uid('contribution'), targetType: first.kind, targetId: first.id, title: names.join(' · '), body: 'Manage Tabs', author: actor.id, createdAt: now, publishedAt: now, publication: 'direct', status: 'approved', tabChanges: changes });
      audit(next, actor, now, 'Tabs updated', names.join(' · '), 'Manage Tabs.');
      break;
    }
    case 'save-knowledge':
    case 'suggest-knowledge': {
      const change = checkKnowledgeChange(next, action.change);
      const reason = required(action.reason, 'Reason');
      if (reason.length > 5000 || (action.source !== undefined && (typeof action.source !== 'string' || action.source.length > 2048))) throw new Error('Reason or source is too long.');
      const name = knowledgeName(next, change.target);
      publishKnowledge(next, change, actor.id, now, reason, action.source);
      next.contributions.unshift({ id: uid('contribution'), targetType: change.target.kind, targetId: change.target.id, title: name, body: reason, source: action.source, author: actor.id, createdAt: now, publishedAt: now, publication: 'direct', status: 'approved', knowledgeChange: change });
      audit(next, actor, now, 'Information updated', name, `${reason}; contribution recorded.`);
      break;
    }
    case 'save-port-information': {
      const port = next.ports.find(item => item.id === action.portId);
      if (!port) throw new Error('Select a valid port.');
      const keyInfo = validateIntelligenceKeyInfo(action.keyInfo);
      const before = port.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
      if (!sameIntelligenceKeyInfo(before, validateIntelligenceKeyInfo(action.baseKeyInfo))) throw new Error('Key Info changed. Reopen the editor before saving.');
      const change = action.change ? checkKnowledgeChange(next, action.change) : undefined;
      if (change && (change.target.kind !== 'port' || change.target.id !== port.id)) throw new Error('Select the same port for this update.');
      const changed = !sameIntelligenceKeyInfo(before, keyInfo);
      if (!changed && !change) throw new Error('No changes to save.');
      const reason = required(action.reason, 'Reason');
      if (reason.length > 5000) throw new Error('Reason is too long.');
      // Validate both drafts before either is published; one tab save earns one contribution.
      if (change) publishKnowledge(next, change, actor.id, now, reason);
      if (changed) { stampKeyInfo(port, keyInfo, actor.id, now); port.intelligenceKeyInfo = keyInfo; port.updatedAt = now; }
      next.contributions.unshift({ id: uid('contribution'), targetType: 'port', targetId: port.id, title: port.name, body: reason, author: actor.id, createdAt: now, publishedAt: now, publication: 'direct', status: 'approved', knowledgeChange: change, ...(changed ? { proposedKeyInfo: keyInfo, keyInfoBase: before } : {}) });
      audit(next, actor, now, 'Information updated', port.name, `${reason}; contribution recorded.`);
      break;
    }
    case 'submit-contribution': {
      if (action.targetType === 'buyer-competition') throw new Error('Add Competition through the buyer profile.');
      let feedbackPage: FeedbackPage | undefined;
      if (action.feedbackPageId !== undefined) {
        if (action.targetType !== 'feedback') throw new Error('Page selection is only available for feedback.');
        const page = feedbackPages.find(page => page.id === action.feedbackPageId);
        if (!page) throw new Error('Select a valid feedback page.');
        // Save the current label with the stable ID so old feedback remains readable after a rename.
        feedbackPage = { ...page };
      }
      const title = required(action.title, 'Contribution title');
      const body = required(action.body, 'Contribution details');
      const proposedKeyInfo = action.proposedKeyInfo === undefined ? undefined : validateIntelligenceKeyInfo(action.proposedKeyInfo);
      if (proposedKeyInfo && action.targetType !== 'port') throw new Error('Key Info amendments must concern a port.');
      if (!proposedKeyInfo && body.length < 30) throw new Error('Add at least 30 characters of useful detail for the update.');
      if (action.source !== undefined && typeof action.source !== 'string') throw new Error('Source must be text.');
      const source = action.source?.trim();
      if (action.targetType === 'port' && !next.ports.some(port => port.id === action.targetId)) throw new Error('Select the port this update concerns.');
      if (action.targetType === 'country' && !locationCountries(next).some(country => country.id === action.targetId)) throw new Error('Select a valid country.');
      if (action.targetType === 'area') throw new Error('This information record is archived. Select its country or port.');
      if (action.targetType === 'company') companyById(next, action.targetId);
      if (action.targetType === 'buyer-group' && !next.companies.some(company => buyerGroupKey(company) === action.targetId)) throw new Error('Select a valid buyer group.');
      if (action.targetType === 'feedback' && action.targetId !== 'ecosystem') throw new Error('Select a valid feedback target.');
      if (!['port', 'country', 'company', 'case-study', 'feedback', 'buyer-group'].includes(action.targetType)) throw new Error('Choose a valid contribution type.');
      let keyInfoBase: IntelligenceKeyInfo | undefined;
      if (proposedKeyInfo) {
        const before = next.ports.find(port => port.id === action.targetId)!.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
        if (action.baseKeyInfo !== undefined && !sameIntelligenceKeyInfo(before, validateIntelligenceKeyInfo(action.baseKeyInfo))) throw new Error('Key Info changed. Reopen the editor before submitting.');
        keyInfoBase = { ...before };
        if (sameIntelligenceKeyInfo(before, proposedKeyInfo)) throw new Error('No Key Info changes to submit.');

      } else if (next.contributions.some(item => !item.proposedKeyInfo && item.targetType === action.targetType && item.targetId === action.targetId && item.status === 'approved' && item.body.trim().toLowerCase() === body.toLowerCase())) throw new Error('This information has already been submitted.');
      next.contributions.unshift({ id: uid('contribution'), targetType: action.targetType, targetId: action.targetId,
        title, body, author: actor.id, createdAt: now, publishedAt: now, publication: 'direct', status: 'approved',
        ...(proposedKeyInfo ? { proposedKeyInfo, keyInfoBase } : {}), ...(source ? { source } : {}),
        ...(feedbackPage ? { feedbackPage } : {}) });
      publishContribution(next, next.contributions[0], actor, now);
      audit(next, actor, now, proposedKeyInfo ? 'Key Info updated' : action.targetType === 'feedback' ? 'Feedback submitted' : 'Knowledge submitted', title,
        'Published.');
      break;
    }
    case 'review-contribution': {
      permit(actor, ['admin']);
      const contribution = next.contributions.find(item => item.id === action.id);
      if (!contribution) throw new Error('The contribution could not be found.');
      if (contribution.status !== 'pending') throw new Error('This contribution has already been reviewed.');
      if (contribution.targetType === 'buyer-competition') throw new Error('Competition entries are published directly.');
      if (contribution.author === actor.id) throw new Error('Contributions require an independent reviewer; you cannot review your own submission.');
      const note = required(action.note, 'Review reason');
      contribution.status = action.approve ? 'approved' : 'declined';
      contribution.reviewer = actor.id;
      contribution.reviewedAt = now;
      let keyInfoChanges = '';
      if (action.approve) keyInfoChanges = publishContribution(next, contribution, actor, now, note);
      audit(next, actor, now, `${contribution.targetType === 'feedback' ? 'Feedback' : 'Knowledge'} ${action.approve ? 'approved' : 'declined'}`, contribution.title,
        `${note}${keyInfoChanges ? `; ${keyInfoChanges}` : ''}${contribution.source ? `; Source: ${contribution.source}` : ''}`);
      break;
    }
    default: throw new Error('This demo action is not supported.');
  }
  return next;
}

function stampKeyInfo(port: Port, after: IntelligenceKeyInfo, by: string, at: string) {
  const before = port.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
  for (const field of Object.keys(after) as (keyof IntelligenceKeyInfo)[]) {
    if (before[field] === after[field]) continue;
    port.intelligenceEntryUpdates ??= {};
    port.intelligenceEntryUpdates[field] = { updatedBy: by, updatedAt: at };
  }
}

function publishContribution(next: DemoState, contribution: Contribution, actor: Actor, now: string, note = contribution.body): string {
  // Materialize the pre-publication document before legacy notes are changed so every
  // direct/reviewed contribution receives an entry revision, including the first one.
  if (!contribution.knowledgeChange && !contribution.proposedKeyInfo && ['port', 'country', 'area', 'company'].includes(contribution.targetType)) {
    const target = { kind: contribution.targetType as 'port' | 'country' | 'area' | 'company', id: contribution.targetId };
    const key = knowledgeKey(next, target);
    if (!next.knowledgeRecords?.[key]) {
      const document = knowledgeDocument({ ...next, contributions: next.contributions.filter(item => item.id !== contribution.id) }, target);
      next.knowledgeRecords ??= {};
      next.knowledgeRecords[key] = document;
    }
  }
  let keyInfoChanges = '';
  if (contribution.proposedKeyInfo !== undefined && contribution.targetType !== 'port') throw new Error('Key Info amendments must concern a port.');
  if (contribution.knowledgeChange) {
    if (contribution.knowledgeChange.target.kind !== contribution.targetType || contribution.knowledgeChange.target.id !== contribution.targetId) throw new Error('The amendment target does not match.');
    publishKnowledge(next, contribution.knowledgeChange, actor.id, now, note, contribution.source);
  } else if (contribution.targetType === 'port') {
    const port = next.ports.find(item => item.id === contribution.targetId);
    if (!port) throw new Error('The contribution target port no longer exists.');
    if (contribution.proposedKeyInfo !== undefined) {
      const proposed = validateIntelligenceKeyInfo(contribution.proposedKeyInfo);
      const before = port.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
      if (contribution.keyInfoBase === undefined || !sameIntelligenceKeyInfo(before, validateIntelligenceKeyInfo(contribution.keyInfoBase))) throw new Error('Key Info changed after this amendment was submitted. Decline it and request a new amendment.');
      if (sameIntelligenceKeyInfo(before, proposed)) throw new Error('This amendment already matches the current Key Info.');
      keyInfoChanges = intelligenceChangeSummary(before, proposed);
      stampKeyInfo(port, proposed, actor.id, now);
      port.intelligenceKeyInfo = proposed;
    } else port.notes.push(contribution.body);
    port.updatedAt = now;
  } else if (contribution.targetType === 'buyer-group' && !next.companies.some(company => buyerGroupKey(company) === contribution.targetId)) {
    throw new Error('The buyer group no longer exists.');
  } else if (contribution.targetType === 'buyer-group') {
    const list = next.buyerSharedLists?.[buyerSharedListKey('group', contribution.targetId)];
    if (list) { list.entries.unshift({ id: contribution.id, text: contribution.body, author: contribution.author, createdAt: contribution.createdAt }); list.updatedBy = actor.id; list.updatedAt = now; }
  } else if (contribution.targetType === 'company') {
    const company = companyById(next, contribution.targetId);
    company.notes = `${company.notes}${company.notes ? '\n\n' : ''}${contribution.body}`;
  } else if (contribution.targetType === 'country' && !locationCountries(next).some(country => country.id === contribution.targetId)) {
    throw new Error('The contribution target country no longer exists.');
  } else if (contribution.targetType === 'area') {
    throw new Error('This information record is archived. Select its country or port.');
  }
  if (!contribution.knowledgeChange && !contribution.proposedKeyInfo && ['port', 'country', 'area', 'company'].includes(contribution.targetType)) {
    const target = { kind: contribution.targetType as 'port' | 'country' | 'area' | 'company', id: contribution.targetId };
    if (next.knowledgeRecords?.[knowledgeKey(next, target)]) {
      const base = knowledgeDocument(next, target), document = structuredClone(base);
      const section = document.sections.find(section => knowledgeSectionRole(section) === "trader-remarks") ?? document.sections.find(section => knowledgeSectionRole(section) !== "price-history");
      if (!section) throw new Error('Add a tab before updating information.');
      section.blocks.push({ id: uid('block'), type: 'text', title: contribution.title, text: contribution.body });
      publishKnowledge(next, { target, baseVersion: base.version, baseDocument: base, document }, actor.id, now, note, contribution.source);
    }
  }
  return keyInfoChanges;
}

function validateBuyerListRevision(current: BuyerSharedEntry[], draft: BuyerSharedDraftEntry[], baseEntries: BuyerSharedDraftEntry[], owner: string, now: string, label: string): BuyerSharedEntry[] {
  if (!Array.isArray(baseEntries) || !sameBuyerSharedDraft(baseEntries, current)) throw new Error('This list changed. Reopen Update before saving.');
  if (!Array.isArray(draft) || draft.length > 100) throw new Error('A list can contain up to 100 entries.');
  const ids = new Set<string>(), texts = new Set<string>();
  const entries = draft.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 || ids.has(entry.id)) throw new Error('Each list entry needs a unique ID.');
    ids.add(entry.id);
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 10000) throw new Error(`${label} entries must contain 1 to 10,000 characters.`);
    const text = entry.text.trim();
    const normalized = normalizedBuyerCompetition(text);
    if (texts.has(normalized)) throw new Error('This list contains duplicate entries.');
    texts.add(normalized);
    const previous = current.find(item => item.id === entry.id);
    return previous ? { ...previous, text, ...(previous.text !== text ? { updatedBy: owner, updatedAt: now } : {}) }
      : { id: entry.id, text, author: owner, createdAt: now };
  });
  if (sameBuyerSharedDraft(current, entries)) throw new Error('No list changes to save.');
  // Changing only case or whitespace is not a new contribution.
  if (JSON.stringify(current.map(entry => normalizedBuyerCompetition(entry.text))) === JSON.stringify(entries.map(entry => normalizedBuyerCompetition(entry.text)))) throw new Error('No list changes to save.');
  return entries;
}
