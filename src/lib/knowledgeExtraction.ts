import type { Action, DemoState } from './model';
import { checkKnowledgeChange, defaultKnowledgeTitle, knowledgeDocument, knowledgeSectionRole, sameKnowledge, validateKnowledge, validateKnowledgeProvenance, type KnowledgeBlock, type KnowledgeChange, type KnowledgeDocument } from './knowledge';
import { emptyIntelligenceKeyInfo, intelligenceFields, INTELLIGENCE_VALUE_MAX_LENGTH, sameIntelligenceKeyInfo, validateIntelligenceKeyInfo, type IntelligenceKeyInfo } from './intelligenceFields';
import { locationRecords } from './locations';

export type ExtractionField = keyof IntelligenceKeyInfo;
export interface ExtractionProposal {
  locationKey: string | null;
  locationName: string;
  section: string;
  title: string;
  kind: 'text' | 'table' | 'keyInfo';
  text: string;
  columns: string[];
  rows: string[][];
  field: ExtractionField | null;
  value: string | null;
  evidence: string;
  warning: string | null;
}
export interface ExtractionResponse { proposals: ExtractionProposal[]; warnings: string[] }
export interface ReviewProposal extends ExtractionProposal {
  id: string;
  selected: boolean;
  sectionId?: string;
  replaceBlockId?: string;
}
export interface ExtractionIntelligenceChange {
  portId: string;
  baseKeyInfo: IntelligenceKeyInfo;
  keyInfo: IntelligenceKeyInfo;
}
export interface ExtractionBatchMetadata { batchId: string; source?: string; sourceDate?: string; reason?: string }

// Compatibility only: these exact values identify source blocks written by the former dropdown
// extractor before it assigned stable field IDs. They never constrain current input or extraction.
const legacyKeyInfoSourceValues: Record<ExtractionField, readonly string[]> = {
  qualityClaim: ['All', 'Possible', 'No'], isoSpecs: ['All', 'Subject enquiry', 'No'],
  sampleLocation: ["Vessel's manifold", 'Barge manifold'], debunkering: ['Common', 'Possible but Hard', 'No'],
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The extracted information is invalid.');
  return value as Record<string, unknown>;
}
function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} is invalid or too long.`);
  return value;
}
function nullable(value: unknown, max: number, label: string): string | null {
  return value === null ? null : bounded(value, max, label);
}
function parseProposal(value: unknown): ExtractionProposal {
  const item = record(value);
  if (!['text', 'table', 'keyInfo'].includes(String(item.kind))) throw new Error('The extracted information type is invalid.');
  if (!Array.isArray(item.columns) || item.columns.length > 30 || !Array.isArray(item.rows) || item.rows.length > 200) throw new Error('The extracted table is too large.');
  const columns = item.columns.map(column => bounded(column, 150, 'Column'));
  const rows = item.rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error('Each extracted row must match its columns.');
    return row.map(cell => bounded(cell, 5000, 'Cell'));
  });
  const field = nullable(item.field, 50, 'Key Info field');
  if (field !== null && !intelligenceFields.some(option => option.key === field)) throw new Error('The extracted Key Info field is invalid.');
  const proposal: ExtractionProposal = {
    locationKey: nullable(item.locationKey, 250, 'Location'),
    locationName: bounded(item.locationName, 250, 'Location name'),
    section: bounded(item.section, 150, 'Section'),
    title: bounded(item.title, 150, 'Title'),
    kind: item.kind as ExtractionProposal['kind'],
    text: bounded(item.text, 30000, 'Information'), columns, rows,
    field: field as ExtractionField | null,
    value: nullable(item.value, INTELLIGENCE_VALUE_MAX_LENGTH, 'Key Info value'),
    evidence: bounded(item.evidence, 6000, 'Source excerpt'),
    warning: nullable(item.warning, 2000, 'Warning'),
  };
  if (!proposal.evidence.trim()) throw new Error('The extracted information needs a source excerpt.');
  if (proposal.kind === 'text' && !proposal.text.trim()) throw new Error('The extracted information is empty.');
  if (proposal.kind === 'table' && (!columns.length || !rows.length || columns.some(column => !column.trim()) || !rows.some(row => row.some(cell => cell.trim())))) throw new Error('The extracted table needs columns and information.');
  if (proposal.kind === 'keyInfo') {
    if (proposal.field === null || proposal.value === null || !proposal.value.trim()) throw new Error('Enter a Key Info field and value.');
    validateIntelligenceKeyInfo({ ...emptyIntelligenceKeyInfo(), [proposal.field]: proposal.value });
  }
  return proposal;
}

/** Responses remain untrusted input, even when the service uses a strict output schema. */
export function parseExtractionResponse(value: unknown): ExtractionResponse {
  const response = record(value);
  if (!Array.isArray(response.proposals) || response.proposals.length > 40 || !Array.isArray(response.warnings) || response.warnings.length > 30) throw new Error('The extracted information is invalid or too large.');
  const result = { proposals: response.proposals.map(parseProposal), warnings: response.warnings.map(warning => bounded(warning, 2000, 'Warning')) };
  if (JSON.stringify(result).length > 500000) throw new Error('The extracted information is too large.');
  return result;
}

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
/** IDs, headings, and source metadata cannot turn duplicate content into another rewarded update. */
export function extractionBlockFingerprint(block: KnowledgeBlock): string {
  if (block.type === 'text') return `text:${normalized(block.text)}`;
  if (block.type === 'file') return `file:${normalized(block.url)}`;
  return JSON.stringify(['table', block.columns.map(column => normalized(column.name)), block.rows.map(row => row.cells.map(normalized))]);
}
function fingerprints(document: KnowledgeDocument) {
  const counts = new Map<string, number>();
  for (const block of document.sections.flatMap(section => section.blocks)) {
    const key = extractionBlockFingerprint(block);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
export function validateExtractedContentChange(change: KnowledgeChange, allowSourceRefresh = false): void {
  const before = fingerprints(change.baseDocument), after = fingerprints(change.document);
  let contentChanged = false;
  for (const block of change.document.sections.flatMap(section => section.blocks)) {
    const fingerprint = extractionBlockFingerprint(block);
    if ((after.get(fingerprint) ?? 0) <= (before.get(fingerprint) ?? 0)) continue;
    if ((block.type === 'text' && !block.text.trim()) || (block.type === 'table' && !block.rows.some(row => row.cells.some(cell => cell.trim())))) throw new Error('Enter information to update.');
  }
  for (const [fingerprint, count] of after) {
    if (count > 1 && count > (before.get(fingerprint) ?? 0)) throw new Error('This information already exists. Remove the duplicate update.');
    if (count !== (before.get(fingerprint) ?? 0)) contentChanged = true;
  }
  if (!contentChanged && !allowSourceRefresh) throw new Error('No new information to update.');
}

/** Build against the snapshot taken before extraction; publication rejects concurrent changes. */
export function buildExtractionBatch(snapshot: DemoState, proposals: ReviewProposal[], metadata: ExtractionBatchMetadata): Extract<Action, { type: 'save-extracted-knowledge' }> {
  if (!Array.isArray(proposals) || proposals.length > 40) throw new Error('Select up to 40 updates.');
  const selected = proposals.filter(proposal => proposal.selected);
  if (!selected.length) throw new Error('Select information to update.');
  const records = locationRecords(snapshot);
  const documents = new Map<string, KnowledgeChange>();
  const intelligence = new Map<string, ExtractionIntelligenceChange>();
  const reviewedFields = new Set<string>();
  const replacements = new Set<string>();
  const proposalIds = new Set<string>();
  let sequence = 0;
  const makeId = () => `extract-${metadata.batchId}-${++sequence}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(metadata.batchId)) throw new Error('The update reference is invalid.');
  for (const draft of selected) {
    const proposal = parseProposal(draft);
    const isKeyInfo = proposal.kind === 'keyInfo';
    const sectionId = isKeyInfo ? undefined : draft.sectionId;
    let replaceBlockId = isKeyInfo ? undefined : draft.replaceBlockId;
    if (!draft.id || proposalIds.has(draft.id)) throw new Error('Each extracted item must have a unique reference.');
    proposalIds.add(draft.id);
    const destination = records.find(item => item.key === proposal.locationKey);
    if (!destination) throw new Error('Select a country or port for every update.');
    const provenance = validateKnowledgeProvenance({ source: metadata.source ?? '', evidence: proposal.evidence, ...(metadata.sourceDate ? { date: metadata.sourceDate } : {}) });
    if (proposal.kind === 'keyInfo') {
      if (destination.kind !== 'port') throw new Error('Key Info belongs to a port. Select the relevant port.');
      const key = `${destination.key}:${proposal.field}`;
      if (reviewedFields.has(key)) throw new Error('Keep one update for each Key Info field.');
      reviewedFields.add(key);
      const before = snapshot.ports.find(port => port.id === destination.target.id)!.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
      const change = intelligence.get(destination.key) ?? { portId: destination.target.id, baseKeyInfo: structuredClone(before), keyInfo: structuredClone(before) };
      if (before[proposal.field!] === proposal.value) throw new Error('This Key Info already matches. Remove the unchanged update.');
      change.keyInfo = validateIntelligenceKeyInfo({ ...change.keyInfo, [proposal.field!]: proposal.value });
      intelligence.set(destination.key, change);
      // Keep the exact supporting quote in the port's versioned information history too.
      proposal.kind = 'text';
      proposal.section = 'Port Information';
      proposal.title = intelligenceFields.find(field => field.key === proposal.field)!.label;
      proposal.text = `${proposal.title}: ${proposal.value}`;
    }
    let change = documents.get(destination.key);
    if (!change) {
      const base = knowledgeDocument(snapshot, destination.target);
      change = { target: destination.target, baseVersion: base.version, baseDocument: structuredClone(base), document: structuredClone(base) };
      documents.set(destination.key, change);
    }
    let section = isKeyInfo ? (change.document.sections.find(item => knowledgeSectionRole(item) === 'port-information') ?? change.document.sections.find(item => knowledgeSectionRole(item) !== 'price-history')) : sectionId ? change.document.sections.find(item => item.id === sectionId) : change.document.sections.find(item => normalized(item.title) === normalized(proposal.section || 'General Information'));
    if (isKeyInfo && !section) throw new Error('Add a tab before updating information.');
    if (sectionId && !section) throw new Error('Select a valid information section.');
    if (!section) {
      section = { id: makeId(), title: proposal.section.trim() || 'General Information', blocks: [] };
      change.document.sections.push(section);
    }
    if (isKeyInfo) {
      // Each field keeps its current source here; earlier sources remain in document History.
      // The fallback recognises source blocks created before stable field IDs were introduced.
      const values = legacyKeyInfoSourceValues[proposal.field!];
      const sourceBlocks = section.blocks.filter(block => block.type === 'text' && block.provenance &&
        (block.id === `keyinfo-source-${proposal.field}` || (block.title === proposal.title && values.some(value => block.text === `${proposal.title}: ${value}`))));
      const currentSource = sourceBlocks.at(-1);
      if (currentSource) {
        replaceBlockId = currentSource.id;
        const oldSourceIds = new Set(sourceBlocks.slice(0, -1).map(block => block.id));
        section.blocks = section.blocks.filter(block => !oldSourceIds.has(block.id));
      }
    }
    const blockTitle = proposal.title.trim() || defaultKnowledgeTitle(section.title, Math.max(0, replaceBlockId ? section.blocks.findIndex(block => block.id === replaceBlockId) : section.blocks.length));
    const block: KnowledgeBlock = proposal.kind === 'table' ? {
      id: makeId(), title: blockTitle, type: 'table', provenance,
      columns: proposal.columns.map(name => ({ id: makeId(), name: name.trim() })),
      rows: proposal.rows.map(cells => ({ id: makeId(), cells: cells.map(cell => cell.trim()) })),
    } : { id: isKeyInfo ? `keyinfo-source-${proposal.field}` : makeId(), title: blockTitle, type: 'text', text: proposal.text.trim(), provenance };
    const existing = change.document.sections.flatMap(item => item.blocks);
    if (existing.some(item => item.id !== replaceBlockId && extractionBlockFingerprint(item) === extractionBlockFingerprint(block))) throw new Error('This information already exists. Remove the duplicate update.');
    if (replaceBlockId) {
      const previous = section.blocks.findIndex(item => item.id === replaceBlockId);
      const key = `${destination.key}:${replaceBlockId}`;
      if (previous < 0 || replacements.has(key)) throw new Error('Select a valid information block to replace.');
      if (!isKeyInfo && extractionBlockFingerprint(section.blocks[previous]) === extractionBlockFingerprint(block)) throw new Error('No new information to update.');
      replacements.add(key);
      section.blocks[previous] = { ...block, id: replaceBlockId };
    } else section.blocks.push(block);
  }
  const changes = [...documents.entries()].map(([key, change]) => [key, { ...change, document: validateKnowledge(change.document) }] as const).filter(([key, change]) => !intelligence.has(key) || !sameKnowledge(change.baseDocument, change.document)).map(([key, change]) => {
    const checked = checkKnowledgeChange(snapshot, change);
    validateExtractedContentChange(checked, intelligence.has(key));
    return checked;
  });
  const intelligenceChanges = [...intelligence.values()];
  if (!changes.length && !intelligenceChanges.some(change => !sameIntelligenceKeyInfo(change.baseKeyInfo, change.keyInfo))) throw new Error('No new information to update.');
  return { type: 'save-extracted-knowledge', batchId: metadata.batchId, changes, intelligenceChanges, source: metadata.source?.trim(), reason: metadata.reason?.trim() || 'Updated from pasted information' };
}
