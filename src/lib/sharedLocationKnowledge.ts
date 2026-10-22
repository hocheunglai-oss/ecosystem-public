import type { Action, Actor, AuditEntry, Contribution, DemoState, Port, LocationPublication } from './model.ts';
import { applyAction } from './model.ts';
import { projectLocationPublication } from './contributionActivity.ts';
import { isAccessActor } from './accessActor.ts';
import { knowledgeDocument, validateKnowledge, type KnowledgeChange, type KnowledgeDocument, type KnowledgeRevision, type KnowledgeTarget } from './knowledge.ts';
import { intelligenceFields, validateIntelligenceKeyInfo } from './intelligenceFields.ts';
import { locationCountries, type LegacyLocationArea, type LocationCountry } from './locations.ts';
import { flattenLocationHierarchy } from './locationMigration.ts';
import { retireFictionalSupplierRecords } from './supplierRetirement.ts';

/** Only shared location data crosses this boundary. Private notes, buyers, hats,
 * commercial records, identities and prototype state never form part of it. */
export interface LocationSnapshot {
  schemaVersion: 1;
  ports: Port[];
  locationCountries: LocationCountry[];
  knowledgeRecords: Record<string, KnowledgeDocument>;
  knowledgeHistory: KnowledgeRevision[];
  contributions: Contribution[];
  /** Server-owned classification; imports never award historical publications. */
  historicalContributionIds: string[];
  legacyLocationAreas: LegacyLocationArea[];
  legacyPortAreaIds: Record<string, string>;
}
export type LocationAction = Extract<Action, { type: 'add-location' | 'save-knowledge' | 'suggest-knowledge' | 'manage-knowledge-tabs' | 'save-port-information' | 'save-extracted-knowledge' | 'submit-contribution' | 'review-contribution' }>;
export interface LocationConflict { target: KnowledgeTarget; reason: 'IDENTITY_CONFLICT' | 'RECORD_CONFLICT' | 'HISTORY_CONFLICT' | 'CONTRIBUTION_CONFLICT' | 'LEGACY_LINK_CONFLICT' }
export const LOCATION_SNAPSHOT_MAX_BYTES = 3_500_000;
export const LOCATION_DOCUMENT_MAX_BYTES = 1_400_000;
export const LOCATION_HISTORY_ENTRY_MAX_BYTES = 3_000_000;
export const LOCATION_CONTRIBUTION_MAX_BYTES = 3_000_000;
export const LOCATION_PUBLICATION_MAX_BYTES = 500_000;
const locationKinds = new Set(['port', 'country', 'area']);
const safeKey = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key);
const isLocationKey = (key: string) => /^(country|port|area):.+/.test(key);
const isLocationContribution = (value: Contribution) => locationKinds.has(value.targetType);
const fail = (): never => { throw new Error('The shared location data is invalid. Your existing information has not been replaced.'); };
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !safeKey(key) || keys && !keys.includes(key))) return fail();
  return input;
}
function text(value: unknown, maximum: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > maximum || nonempty && !value.trim() || /\u0000/.test(value)) return fail();
  return value;
}
const id = (value: unknown) => { const result = text(value, 160, true); if (!safeKey(result) || /[\u0000-\u001f\u007f]/.test(result)) return fail(); return result; };
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647) return fail(); return Number(value); }
function array<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] { if (!Array.isArray(value) || value.length > max) return fail(); return value.map(parse); }
function optional<T>(input: Record<string, unknown>, key: string, parse: (value: unknown) => T): T | undefined { return input[key] === undefined ? undefined : parse(input[key]); }
function date(value: unknown, empty = false): string { const result = text(value, 64, !empty); if (result && !Number.isFinite(Date.parse(result))) return fail(); return result; }
function unique<T>(values: T[], key: (item: T) => string) { const seen = new Set<string>(); for (const value of values) { const k = key(value); if (seen.has(k)) return fail(); seen.add(k); } return values; }
function bounded(value: unknown) { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LOCATION_SNAPSHOT_MAX_BYTES) throw new Error('This location archive is too large to publish in one update. Keep the browser archive for assisted migration.'); }
function update(value: unknown) { const input = object(value, ['updatedBy', 'updatedAt']); return { updatedBy: id(input.updatedBy), updatedAt: date(input.updatedAt) }; }
function target(value: unknown, archived = false): KnowledgeTarget {
  const input = object(value, ['kind', 'id']);
  if (input.kind !== 'country' && input.kind !== 'port' && !(archived && input.kind === 'area')) return fail();
  return { kind: input.kind, id: id(input.id) };
}
function document(value: unknown): KnowledgeDocument {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LOCATION_DOCUMENT_MAX_BYTES) throw new Error('This document is too large for one update. Keep the original and split its content into separate records.');
  const input = object(value, ['version', 'layoutVersion', 'supplierFixturesVersion', 'sections']);
  integer(input.version);
  // Validate exact serialized shapes before the existing domain validator. The
  // validator normalizes titles; preserve accepted historical bytes instead.
  const sections = array(input.sections, 58, value => {
    const section = object(value, ['id', 'title', 'role', 'blocks']); id(section.id); text(section.title, 150);
    array(section.blocks, 5100, value => {
      const block = object(value);
      const common = ['id', 'title', 'type', 'update', 'provenance'];
      if (!['text', 'file', 'table'].includes(String(block.type))) return fail();
      object(block, [...common, ...(block.type === 'text' ? ['text'] : block.type === 'file' ? ['url'] : ['columns', 'rows'])]);
      id(block.id); text(block.title, 150);
      if (block.update !== undefined) update(block.update);
      if (block.provenance !== undefined) object(block.provenance, ['source', 'evidence', 'date']);
      if (block.type === 'table') {
        array(block.columns, 30, value => { const column = object(value, ['id', 'name', 'width']); id(column.id); text(column.name, 150); });
        array(block.rows, 1000, value => { const row = object(value, ['id', 'cells', 'update']); id(row.id); array(row.cells, 30, value => text(value, 5000)); if (row.update !== undefined) update(row.update); });
      }
      return block;
    });
    return section;
  });
  // Old browser blocks could have empty headings. Keep those historical bytes;
  // current publication has its own title migration and stricter domain rules.
  const validation = structuredClone({ ...input, sections }) as unknown as KnowledgeDocument;
  for (const section of validation.sections) for (const block of section.blocks) if (!block.title.trim()) block.title = 'Information';
  validateKnowledge(validation);
  return structuredClone(input) as unknown as KnowledgeDocument;
}
function change(value: unknown, archived = false): KnowledgeChange {
  const input = object(value, ['target', 'baseVersion', 'baseDocument', 'document']);
  return { target: target(input.target, archived), baseVersion: integer(input.baseVersion), baseDocument: document(input.baseDocument), document: document(input.document) };
}
function intelligenceChange(value: unknown) {
  const input = object(value, ['portId', 'baseKeyInfo', 'keyInfo']);
  return { portId: id(input.portId), baseKeyInfo: validateIntelligenceKeyInfo(input.baseKeyInfo), keyInfo: validateIntelligenceKeyInfo(input.keyInfo) };
}
function port(value: unknown): Port {
  const input = object(value, ['id', 'name', 'country', 'code', 'timezone', 'leadTime', 'summary', 'notes', 'updatedAt', 'tags', 'intelligenceKeyInfo', 'intelligenceEntryUpdates']);
  const updates = optional(input, 'intelligenceEntryUpdates', value => {
    const entries = object(value, intelligenceFields.map(field => field.key));
    return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, update(value)]));
  });
  return { id: id(input.id), name: text(input.name, 150, true), country: text(input.country, 150, true), code: text(input.code, 100), timezone: text(input.timezone, 150),
    leadTime: text(input.leadTime, 5000), summary: text(input.summary, 30000), notes: array(input.notes, 1000, value => text(value, 30000)), updatedAt: date(input.updatedAt, true), tags: array(input.tags, 1000, value => text(value, 1000)),
    ...(input.intelligenceKeyInfo !== undefined ? { intelligenceKeyInfo: validateIntelligenceKeyInfo(input.intelligenceKeyInfo) } : {}), ...(updates ? { intelligenceEntryUpdates: updates } : {}) };
}
function country(value: unknown): LocationCountry { const input = object(value, ['id', 'name']); return { id: id(input.id), name: text(input.name, 150, true) }; }
function area(value: unknown): LegacyLocationArea { const input = object(value, ['id', 'name', 'country']); return { id: id(input.id), name: text(input.name, 150, true), country: text(input.country, 150, true) }; }
export function parseLocationRevision(value: unknown): KnowledgeRevision { return revision(value); }
function revision(value: unknown): KnowledgeRevision {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LOCATION_HISTORY_ENTRY_MAX_BYTES) return fail();
  const input = object(value, ['target', 'version', 'at', 'by', 'reason', 'source', 'before', 'after']);
  return { target: target(input.target, true), version: integer(input.version), at: date(input.at), by: id(input.by), reason: text(input.reason, 5000),
    ...(input.source !== undefined ? { source: text(input.source, 2048) } : {}), before: document(input.before), after: document(input.after) };
}
function contribution(value: unknown): Contribution {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LOCATION_CONTRIBUTION_MAX_BYTES) throw new Error('This contribution is too large for one update. Keep the original and split it into separate updates.');
  const input = object(value, ['id', 'targetType', 'targetId', 'title', 'body', 'author', 'createdAt', 'status', 'reviewer', 'reviewedAt', 'publication', 'publishedAt', 'knowledgeChange', 'tabChanges', 'extractionBatch', 'proposedKeyInfo', 'keyInfoBase', 'source', 'locationPublication']);
  const destination = target({ kind: input.targetType, id: input.targetId }, true);
  if (!['pending', 'approved', 'declined'].includes(String(input.status)) || input.publication !== undefined && input.publication !== 'direct') return fail();
  const result: Contribution = { id: id(input.id), targetType: destination.kind as 'country' | 'port' | 'area', targetId: destination.id, title: text(input.title, 10000), body: text(input.body, 30000), author: id(input.author), createdAt: date(input.createdAt), status: input.status as Contribution['status'] };
  if (input.reviewer !== undefined) result.reviewer = id(input.reviewer);
  if (input.reviewedAt !== undefined) result.reviewedAt = date(input.reviewedAt);
  if (input.publication !== undefined) result.publication = 'direct';
  if (input.publishedAt !== undefined) result.publishedAt = date(input.publishedAt);
  if (input.source !== undefined) result.source = text(input.source, 2048);
  if (input.knowledgeChange !== undefined) result.knowledgeChange = change(input.knowledgeChange, true);
  if (input.tabChanges !== undefined) result.tabChanges = array(input.tabChanges, 40, value => change(value, true));
  if (input.extractionBatch !== undefined) { const batch = object(input.extractionBatch, ['id', 'changes', 'intelligenceChanges']); result.extractionBatch = { id: id(batch.id), changes: array(batch.changes, 40, value => change(value, true)), intelligenceChanges: array(batch.intelligenceChanges, 40, intelligenceChange) }; }
  if (input.proposedKeyInfo !== undefined) result.proposedKeyInfo = validateIntelligenceKeyInfo(input.proposedKeyInfo);
  if (input.keyInfoBase !== undefined) result.keyInfoBase = validateIntelligenceKeyInfo(input.keyInfoBase);
  if (input.locationPublication !== undefined) {
    if (['knowledgeChange', 'tabChanges', 'extractionBatch', 'proposedKeyInfo', 'keyInfoBase'].some(key => input[key] !== undefined) || result.body) return fail();
    result.locationPublication = publicationProjection(input.locationPublication);
  }
  return result;
}

function publicationProjection(value: unknown): LocationPublication {
  const input = object(value, ['version', 'eligible', 'kind', 'keys', 'records', 'fingerprint', 'keyInfoTransitions', 'batchId']);
  if (input.version !== 1 || typeof input.eligible !== 'boolean') return fail();
  const hash = (v: unknown) => { const result = text(v, 64, true); if (!/^[a-f0-9]{64}$/.test(result)) return fail(); return result; };
  const keys = array(input.keys, 10000, hash), records = array(input.records, 80, hash);
  const fingerprint = input.eligible ? hash(input.fingerprint) : text(input.fingerprint, 0);
  const keyInfoTransitions = array(input.keyInfoTransitions, 40, value => { const item = object(value, ['key', 'fingerprint']); return { key: hash(item.key), fingerprint: hash(item.fingerprint) }; });
  if (input.eligible && (!keys.length || !records.length) || !input.eligible && (keys.length || records.length || keyInfoTransitions.length)) return fail();
  return { version: 1, eligible: input.eligible, kind: text(input.kind, 40, true), keys, records, fingerprint, keyInfoTransitions,
    ...(input.batchId !== undefined ? { batchId: id(input.batchId) } : {}) };
}
/** Full proposal/history detail has its own endpoint; never accept projection facts as input to a review. */
export function parseLocationContribution(value: unknown): Contribution {
  const input = object(value), { historicalImport, ...detail } = input;
  if (historicalImport !== undefined && historicalImport !== true) return fail();
  const result = contribution(detail);
  return { ...result, ...(historicalImport === true ? { historicalImport: true as const } : {}) };
}
export interface LocationSeparation {
  snapshot: LocationSnapshot;
  history: KnowledgeRevision[];
  contributions: Contribution[];
  publications: Contribution[];
}
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Persist current documents independently of immutable before/after history and proposal bodies.
 * No earlier version is dropped: callers must atomically retain all returned archive records.
 * The read-only publication facts are also kept outside the current singleton/write payload.
 */
export async function splitLocationSnapshot(value: LocationSnapshot, hash: (value: string) => Promise<string> | string = sha256): Promise<LocationSeparation> {
  const full = parseSnapshot(value, false), state = stateWithParsedSnapshot(emptyState(), full);
  for (const item of state.contributions) {
    if (item.status !== 'approved' || item.locationPublication || item.knowledgeChange || item.tabChanges || item.extractionBatch || item.proposedKeyInfo) continue;
    const key = `${item.targetType}:${item.targetId}`;
    if (!state.knowledgeRecords?.[key]) {
      const destination = { kind: item.targetType as 'country' | 'port' | 'area', id: item.targetId };
      state.knowledgeRecords ??= {};
      state.knowledgeRecords[key] = knowledgeDocument(state, destination);
    }
  }
  const records = state.contributions.filter(item => !item.locationPublication).map(item => structuredClone(item));
  const publications = await Promise.all(records.map(async item => {
    const { knowledgeChange: _change, tabChanges: _tabs, extractionBatch: _extraction, proposedKeyInfo: _proposed, keyInfoBase: _base, source: _source, ...metadata } = item;
    return { ...metadata, title: metadata.title.slice(0, 300), body: '', locationPublication: await projectLocationPublication(state, item, hash) };
  }));
  if (publications.some(item => new TextEncoder().encode(JSON.stringify(item)).byteLength > LOCATION_PUBLICATION_MAX_BYTES)) throw new Error('This contribution affects too many entries at once. Keep the original and split it into separate updates.');
  const snapshot = parseLocationSnapshot({ ...full, knowledgeRecords: state.knowledgeRecords ?? {}, knowledgeHistory: [], contributions: [], historicalContributionIds: [] });
  return { snapshot, history: full.knowledgeHistory, contributions: records, publications };
}
/** Only action-relevant full proposals are hydrated. Old documents are not loaded for an ordinary edit. */
export async function applyCurrentLocationAction(current: LocationSnapshot, input: unknown, actor: Actor, at: string,
  options: { contributions?: Contribution[]; hash?: (value: string) => Promise<string> | string } = {}): Promise<LocationSeparation & { audit: AuditEntry[] }> {
  const snapshot = parseLocationSnapshot(current);
  if (snapshot.knowledgeHistory.length || snapshot.contributions.length || snapshot.historicalContributionIds.length) throw new Error('Current location storage must exclude archived history.');
  const details = (options.contributions ?? []).map(parseLocationContribution);
  if (details.some(item => item.locationPublication)) throw new Error('Load the original contribution before reviewing it.');
  const state = stateWithParsedSnapshot(emptyState(), snapshot);
  state.contributions = details;
  const action = parseLocationAction(input);
  if (!isAccessActor(actor)) throw new Error('Sign in with an active account to update shared information.');
  if (action.type === 'review-contribution' && !details.some(item => item.id === action.id && ['country', 'port'].includes(item.targetType))) throw new Error('Load the original country or port contribution before reviewing it.');
  const next = applyAction(state, action, actor, date(at));
  return { ...await splitLocationSnapshot(snapshotFromState(next, false), options.hash), audit: next.audit };
}

export function parseLocationSnapshot(value: unknown): LocationSnapshot { return parseSnapshot(value, true); }
function parseSnapshot(value: unknown, enforceTotal: boolean): LocationSnapshot {
  if (enforceTotal) bounded(value);
  const input = object(value, ['schemaVersion', 'ports', 'locationCountries', 'knowledgeRecords', 'knowledgeHistory', 'contributions', 'historicalContributionIds', 'legacyLocationAreas', 'legacyPortAreaIds']);
  if (input.schemaVersion !== 1) return fail();
  const records = object(input.knowledgeRecords), links = object(input.legacyPortAreaIds);
  for (const key of Object.keys(records)) { if (!isLocationKey(key)) return fail(); id(key.slice(key.indexOf(':') + 1)); }
  const parsedContributions = unique(array(input.contributions, 20000, contribution), item => item.id);
  const historicalContributionIds = unique(array(input.historicalContributionIds ?? [], 20000, id), value => value);
  if (historicalContributionIds.some(key => !parsedContributions.some(item => item.id === key))) return fail();
  return { schemaVersion: 1, ports: unique(array(input.ports, 10000, port), item => item.id), locationCountries: unique(array(input.locationCountries, 1000, country), item => item.id),
    knowledgeRecords: Object.fromEntries(Object.entries(records).map(([key, value]) => [key, document(value)])),
    knowledgeHistory: array(input.knowledgeHistory, 20000, revision), contributions: parsedContributions, historicalContributionIds,
    legacyLocationAreas: unique(array(input.legacyLocationAreas, 10000, area), item => item.id), legacyPortAreaIds: Object.fromEntries(Object.entries(links).map(([key, value]) => [id(key), id(value)])) };
}

/** Seed geography only. This module never imports testWorkspace or seed.ts. */
export function initialLocationSnapshot(): LocationSnapshot {
  const references = [
    ['singapore', 'Singapore', 'Singapore', 'SGSIN', 'Asia/Singapore'], ['hong-kong', 'Hong Kong', 'Hong Kong', 'HKHKG', 'Asia/Hong_Kong'],
    ['rotterdam', 'Rotterdam', 'Netherlands', 'NLRTM', 'Europe/Amsterdam'], ['fujairah', 'Fujairah', 'United Arab Emirates', 'AEFJR', 'Asia/Dubai'],
    ['busan', 'Busan', 'South Korea', 'KRPUS', 'Asia/Seoul'], ['tokyo', 'Tokyo', 'Japan', 'JPTYO', 'Asia/Tokyo'], ['chiba', 'Chiba', 'Japan', '', 'Asia/Tokyo'],
    ['yokohama', 'Yokohama', 'Japan', '', 'Asia/Tokyo'], ['osaka', 'Osaka', 'Japan', '', 'Asia/Tokyo'], ['ho-chi-minh', 'Ho Chi Minh City', 'Vietnam', 'VNSGN', 'Asia/Ho_Chi_Minh'],
    ['gibraltar', 'Gibraltar', 'Gibraltar', 'GIGIB', 'Europe/Gibraltar'],
  ];
  const ports = references.map(([suffix, name, country, code, timezone]) => ({ id: `port-${suffix}`, name, country, code, timezone, leadTime: '', summary: '', notes: [], tags: [], updatedAt: '' }));
  return { schemaVersion: 1, ports, locationCountries: [...new Set(ports.map(port => port.country))].map(name => ({ id: name, name })), knowledgeRecords: {}, knowledgeHistory: [], contributions: [], historicalContributionIds: [], legacyLocationAreas: [], legacyPortAreaIds: {} };
}
function emptyState(): DemoState { return { version: 1, companies: [], ports: [], enquiries: [], requests: [], outcomes: [], contributions: [], audit: [], drops: [], goals: [] }; }
export function locationSnapshotFromState(state: DemoState): LocationSnapshot { return snapshotFromState(state, true); }
function snapshotFromState(state: DemoState, enforceTotal: boolean): LocationSnapshot {
  if (state.demoScenarioVersion !== undefined) throw new Error('Test workspace information cannot be published as shared location data.');
  const flat = flattenLocationHierarchy(state);
  return parseSnapshot({ schemaVersion: 1, ports: flat.ports, locationCountries: locationCountries(flat), knowledgeRecords: Object.fromEntries(Object.entries(flat.knowledgeRecords ?? {}).filter(([key]) => isLocationKey(key))),
    knowledgeHistory: (flat.knowledgeHistory ?? []).filter(item => locationKinds.has(item.target.kind)),
    contributions: flat.contributions.filter(isLocationContribution).map(item => { const { historicalImport: _historical, ...original } = item as Contribution & { historicalImport?: true }; return original; }),
    historicalContributionIds: flat.contributions.filter(item => isLocationContribution(item) && (item as Contribution & { historicalImport?: true }).historicalImport === true).map(item => item.id),
    legacyLocationAreas: flat.legacyLocationAreas ?? [], legacyPortAreaIds: flat.legacyPortAreaIds ?? {} }, enforceTotal);
}
export function locationStateWithSnapshot(local: DemoState, value: LocationSnapshot): DemoState {
  return stateWithParsedSnapshot(local, parseLocationSnapshot(value));
}
function stateWithParsedSnapshot(local: DemoState, snapshot: LocationSnapshot): DemoState {
  const archivedLocationIds = new Set(local.contributions.filter(isLocationContribution).map(item => item.id));
  return {  ...local, drops: local.drops.filter(drop => !drop.key.startsWith('contribution:') || !archivedLocationIds.has(drop.key.slice('contribution:'.length))), ports: snapshot.ports, locationCountries: snapshot.locationCountries, locationStructureVersion: 1, locationAreas: undefined,
    knowledgeRecords: { ...Object.fromEntries(Object.entries(local.knowledgeRecords ?? {}).filter(([key]) => !isLocationKey(key))), ...snapshot.knowledgeRecords },
    knowledgeHistory: [...snapshot.knowledgeHistory, ...(local.knowledgeHistory ?? []).filter(item => !locationKinds.has(item.target.kind))],
    contributions: [...snapshot.contributions.map(item => snapshot.historicalContributionIds.includes(item.id) ? { ...item, historicalImport: true as const } : item), ...local.contributions.filter(item => !isLocationContribution(item))], legacyLocationAreas: snapshot.legacyLocationAreas, legacyPortAreaIds: snapshot.legacyPortAreaIds };
}
export function parseLocationAction(value: unknown): LocationAction {
  bounded(value);
  const input = object(value), type = input.type;
  const shapes: Record<string, string[]> = {
    'add-location': ['type', 'kind', 'name', 'country'], 'save-knowledge': ['type', 'change', 'reason', 'source'], 'suggest-knowledge': ['type', 'change', 'reason', 'source'],
    'manage-knowledge-tabs': ['type', 'changes'], 'save-port-information': ['type', 'portId', 'keyInfo', 'baseKeyInfo', 'change', 'reason'],
    'save-extracted-knowledge': ['type', 'batchId', 'changes', 'intelligenceChanges', 'source', 'reason'],
    'submit-contribution': ['type', 'targetType', 'targetId', 'title', 'body', 'proposedKeyInfo', 'baseKeyInfo', 'source'], 'review-contribution': ['type', 'id', 'approve', 'note'],
  };
  if (typeof type !== 'string' || !Object.hasOwn(shapes, type)) return fail();
  object(input, shapes[type]);
  const required: Record<string, string[]> = {
    'add-location': ['kind', 'name'], 'save-knowledge': ['change', 'reason'], 'suggest-knowledge': ['change', 'reason'],
    'manage-knowledge-tabs': ['changes'], 'save-port-information': ['portId', 'keyInfo', 'baseKeyInfo', 'reason'],
    'save-extracted-knowledge': ['batchId', 'changes', 'intelligenceChanges', 'reason'],
    'submit-contribution': ['targetType', 'targetId', 'title', 'body'], 'review-contribution': ['id', 'approve', 'note'],
  };
  if (required[type].some(key => input[key] === undefined)) return fail();
  if (input.change !== undefined) change(input.change);
  if (input.changes !== undefined) array(input.changes, 40, value => change(value));
  if (input.intelligenceChanges !== undefined) array(input.intelligenceChanges, 40, intelligenceChange);
  if (input.portId !== undefined) id(input.portId);
  for (const key of ['keyInfo', 'baseKeyInfo', 'proposedKeyInfo']) if (input[key] !== undefined) validateIntelligenceKeyInfo(input[key]);
  for (const key of ['reason', 'note']) if (input[key] !== undefined) text(input[key], 5000);
  if (input.source !== undefined) text(input.source, 2048);
  if (type === 'submit-contribution') { target({ kind: input.targetType, id: input.targetId }); text(input.title, 150, true); text(input.body, 30000, true); }
  if (type === 'review-contribution') { id(input.id); if (typeof input.approve !== 'boolean') return fail(); }
  if (type === 'add-location') { if (!['country', 'port'].includes(String(input.kind))) return fail(); text(input.name, 150, true); if (input.country !== undefined) id(input.country); }
  return structuredClone(input) as unknown as LocationAction;
}
export function applyLocationAction(value: LocationSnapshot, input: unknown, actor: Actor, at: string): { snapshot: LocationSnapshot; audit: AuditEntry[]; contributions: Contribution[] } {
  if (!isAccessActor(actor)) throw new Error('Sign in with an active account to update shared information.');
  const snapshot = parseLocationSnapshot(value), action = parseLocationAction(input), state = locationStateWithSnapshot(emptyState(), snapshot);
  if (action.type === 'review-contribution') {
    const previous = state.contributions.find(item => item.id === action.id);
    if (!previous || !['country', 'port'].includes(previous.targetType)) throw new Error('Select an active country or port contribution.');
  }
  const next = applyAction(state, action, actor, date(at));
  return { snapshot: locationSnapshotFromState(next), audit: next.audit, contributions: next.contributions.filter(item => !snapshot.contributions.some(previous => previous.id === item.id)) };
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (first: unknown, second: unknown) => stable(first) === stable(second);
/** Identical keys in different transport order have the same migration digest. */
export function canonicalLocationSnapshotJson(snapshot: LocationSnapshot): string { return stable(parseLocationSnapshot(snapshot)); }
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
function referencePort(value: Port): boolean {
  return !value.summary && !value.leadTime && !value.notes.length && !value.tags.length && !value.updatedAt &&
    (!value.intelligenceKeyInfo || Object.values(value.intelligenceKeyInfo).every(item => item === null)) && !Object.keys(value.intelligenceEntryUpdates ?? {}).length;
}
/** Apply the established retirement policy only to the imported current view.
 * Raw browser bytes and immutable before/after records remain untouched. A legacy
 * retirement marker cannot make a stale imported table active again. */
function retiredImportView(snapshot: LocationSnapshot): LocationSnapshot {
  const retired = retireFictionalSupplierRecords({ ...emptyState(), knowledgeRecords: snapshot.knowledgeRecords });
  return { ...snapshot, knowledgeRecords: retired.knowledgeRecords ?? {} };
}
/** Import is an all-or-nothing merge. Timestamps and browser versions are not a
 * global ordering and never authorize replacement of different server content. */
export function mergeLegacyLocationSnapshot(current: LocationSnapshot, legacy: LocationSnapshot): { snapshot: LocationSnapshot; conflicts: LocationConflict[] } { return mergeLocationSnapshots(current, legacy, true); }
function mergeLocationSnapshots(current: LocationSnapshot, legacy: LocationSnapshot, enforceTotal: boolean): { snapshot: LocationSnapshot; conflicts: LocationConflict[] } {
  const original = parseSnapshot(current, enforceTotal), incoming = retiredImportView(parseLocationSnapshot(legacy));
  if (incoming.contributions.some(item => item.locationPublication)) throw new Error('Import the original contribution archive, not a summary.');
  const merged = structuredClone(original), conflicts: LocationConflict[] = [];
  const conflict = (target: KnowledgeTarget, reason: LocationConflict['reason']) => { if (!conflicts.some(item => equal(item.target, target) && item.reason === reason)) conflicts.push({ target, reason }); };
  for (const item of incoming.locationCountries) {
    const previous = merged.locationCountries.find(value => value.id === item.id), alias = merged.locationCountries.find(value => normalized(value.name) === normalized(item.name) && value.id !== item.id);
    if (alias || previous && !equal(previous, item)) conflict({ kind: 'country', id: item.id }, 'IDENTITY_CONFLICT');
    else if (!previous) merged.locationCountries.push(item);
  }
  for (const item of incoming.ports) {
    const index = merged.ports.findIndex(value => value.id === item.id), previous = merged.ports[index];
    const alias = merged.ports.find(value => value.id !== item.id && normalized(value.country) === normalized(item.country) && normalized(value.name) === normalized(item.name));
    const sameIdentity = previous && ['id', 'name', 'country', 'code', 'timezone'].every(key => equal(previous[key as keyof Port], item[key as keyof Port]));
    if (alias || previous && !sameIdentity) conflict({ kind: 'port', id: item.id }, 'IDENTITY_CONFLICT');
    else if (!previous) merged.ports.push(item);
    else if (!equal(previous, item)) {
      if (referencePort(previous)) merged.ports[index] = item;
      else if (!referencePort(item)) conflict({ kind: 'port', id: item.id }, 'RECORD_CONFLICT');
    }
  }
  for (const [key, value] of Object.entries(incoming.knowledgeRecords)) {
    const previous = merged.knowledgeRecords[key], [kind, ...rest] = key.split(':');
    if (previous && !equal(previous, value)) conflict({ kind: kind as KnowledgeTarget['kind'], id: rest.join(':') }, 'RECORD_CONFLICT');
    else if (!previous) merged.knowledgeRecords[key] = value;
  }
  for (const item of incoming.knowledgeHistory) {
    const previous = merged.knowledgeHistory.find(value => equal(value.target, item.target) && value.version === item.version);
    if (previous && !equal(previous, item)) conflict(item.target, 'HISTORY_CONFLICT');
    else if (!previous) merged.knowledgeHistory.push(item);
  }
  for (const item of incoming.contributions) {
    const previous = merged.contributions.find(value => value.id === item.id);
    if (previous && !equal(previous, item)) conflict({ kind: item.targetType as KnowledgeTarget['kind'], id: item.targetId }, 'CONTRIBUTION_CONFLICT');
    else if (!previous) { merged.contributions.push(item); merged.historicalContributionIds.push(item.id); }
  }
  for (const item of incoming.legacyLocationAreas) {
    const previous = merged.legacyLocationAreas.find(value => value.id === item.id);
    if (previous && !equal(previous, item)) conflict({ kind: 'area', id: item.id }, 'IDENTITY_CONFLICT');
    else if (!previous) merged.legacyLocationAreas.push(item);
  }
  for (const [key, value] of Object.entries(incoming.legacyPortAreaIds)) {
    if (merged.legacyPortAreaIds[key] !== undefined && merged.legacyPortAreaIds[key] !== value) conflict({ kind: 'port', id: key }, 'LEGACY_LINK_CONFLICT');
    else merged.legacyPortAreaIds[key] = value;
  }
  return { snapshot: conflicts.length ? original : parseSnapshot(merged, enforceTotal), conflicts };
}

/** The database separately checks all incoming history keys against immutable retained rows.
 * Existing full contribution details for incoming IDs preserve historical classification.
 */
export async function mergeCurrentLocationSnapshot(current: LocationSnapshot, incoming: LocationSnapshot,
  options: { contributions?: Contribution[]; history?: KnowledgeRevision[]; hash?: (value: string) => Promise<string> | string } = {}): Promise<LocationSeparation & { conflicts: LocationConflict[] }> {
  const parsed = parseLocationSnapshot(current);
  if (parsed.knowledgeHistory.length || parsed.contributions.length || parsed.historicalContributionIds.length) throw new Error('Current location storage must exclude archived history.');
  const details = (options.contributions ?? []).map(parseLocationContribution);
  if (details.some(item => item.locationPublication)) throw new Error('Load the original archive for conflict review.');
  const hydrated = { ...parsed, knowledgeHistory: options.history ?? [], contributions: details.map(item => { const { historicalImport: _historical, ...detail } = item; return detail; }), historicalContributionIds: details.filter(item => item.historicalImport).map(item => item.id) };
  const result = mergeLocationSnapshots(hydrated, incoming, false);
  if (result.conflicts.length) return { snapshot: parsed, history: [], contributions: [], publications: [], conflicts: result.conflicts };
  return { ...await splitLocationSnapshot(result.snapshot, options.hash), conflicts: [] };
}

/** Caller retains the exact raw local archive BEFORE offering an explicit import.
 * Never searches other accounts, old generic prototype keys or test namespaces. */
export function readLegacyLocationCandidate(input: { ownerId: string; namespace: string; raw: string | null }): { snapshot: LocationSnapshot; candidateCount: number } | null {
  id(input.ownerId);
  if (input.namespace !== `ecosystem.live.v1:${encodeURIComponent(input.ownerId)}`) throw new Error('Select your own live workspace archive.');
  if (input.raw === null) return null;
  const state = object(JSON.parse(input.raw));
  if (state.version !== 1 || state.demoScenarioVersion !== undefined || !['companies', 'ports', 'enquiries', 'requests', 'outcomes', 'contributions', 'audit', 'drops', 'goals'].every(key => Array.isArray(state[key]))) throw new Error('This archive is not an eligible live workspace.');
  const snapshot = retiredImportView(locationSnapshotFromState(state as unknown as DemoState)), initial = initialLocationSnapshot();
  const stateForDefaults = locationStateWithSnapshot(emptyState(), snapshot);
  const candidateCount = snapshot.ports.filter(item => !initial.ports.some(value => equal(value, item))).length + snapshot.locationCountries.filter(item => !initial.locationCountries.some(value => equal(value, item))).length +
    Object.entries(snapshot.knowledgeRecords).filter(([key, value]) => {
      if (value.version > 0 || key.startsWith('area:')) return true;
      const [kind, ...parts] = key.split(':');
      try { return !equal(value, knowledgeDocument({ ...stateForDefaults, knowledgeRecords: {} }, { kind: kind as 'country' | 'port', id: parts.join(':') })); } catch { return true; }
    }).length + snapshot.knowledgeHistory.length + snapshot.contributions.length + snapshot.legacyLocationAreas.length + Object.keys(snapshot.legacyPortAreaIds).length;
  return candidateCount ? { snapshot, candidateCount } : null;
}
