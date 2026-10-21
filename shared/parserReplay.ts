import { formatEnquiry, parseEnquiry } from '../src/lib/parser.ts';
import { parseEnquiryWorksheetGuess } from '../src/vendor/fcuno/lib/enquiryWorksheetParser.ts';
import { isParserFields, parserFieldKeys, type ParserFields } from './parserService.ts';

export interface ParserReplaySnapshot {
  fields: ParserFields;
  rmk: boolean;
  viscosity: string[];
  warnings: string[];
  standardText: string;
}
export interface ParserReplayProvenance {
  reportId: string;
  reportRevision: number;
  sourceRevision: string;
  sourceHash: string;
  parserVersion: string;
  buildFingerprint: string;
  originalRevision?: string;
  parseOrigin?: 'initial' | 'reparsed';
}
export interface ParserReplayExecution { parserVersion: string; buildFingerprint: string }
export interface ParserReplayInput {
  rawText: string;
  expected: ParserReplaySnapshot | null;
  /** Set only after the caller validates the complete stored capture, never from client proof claims. */
  captureComplete: boolean;
  provenance: ParserReplayProvenance;
}
export type ParserReplayDifference = keyof ParserFields | 'rmk' | 'viscosity' | 'warnings' | 'standardText';
export interface ParserReplayResult {
  status: 'matched' | 'different' | 'legacy-unverified';
  actual: ParserReplaySnapshot;
  differences: ParserReplayDifference[];
  directorySensitiveDifferences: ('buyerText' | 'portText')[];
  provenance: ParserReplayProvenance;
  executedWith: ParserReplayExecution;
}
const viscosityOptions = new Set(['80cst min', '80cst max', '120cst max', '180cst max']);
const textKey = (value: string) => value.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ').toLowerCase();
const listKey = (values: string[]) => JSON.stringify([...new Set(values.map(textKey))].sort());
const sourceCautions = (warnings: string[]) => warnings.filter(warning => /^WARNING:/i.test(warning.trim()));

export function isParserReplaySnapshot(value: unknown): value is ParserReplaySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return isParserFields(item.fields) && typeof item.rmk === 'boolean'
    && Array.isArray(item.viscosity) && item.viscosity.length <= 4 && item.viscosity.every(option => typeof option === 'string' && viscosityOptions.has(option))
    && Array.isArray(item.warnings) && item.warnings.length <= 100 && item.warnings.every(warning => typeof warning === 'string' && warning.length <= 2000)
    && typeof item.standardText === 'string' && item.standardText.length <= 20000;
}

/** Raw text only: no expected fields, directory aliases, human spec switches, AI output or current-date hint. */
export function rawParserSnapshot(rawText: string): ParserReplaySnapshot {
  const parsed = parseEnquiry(rawText, [], []);
  // The adapter deliberately returns a directory ID only when a supplied directory resolves it.
  // Recover the same pinned core's source port guess without feeding it a corrected directory name.
  const source = String(rawText || '').replace(/[–—−]/g, '-').replace(/\r\n?/g, '\n');
  const guessed = parseEnquiryWorksheetGuess(source, { detectBuyer: true, portNames: [] });
  const fields: ParserFields = {
    vessel: parsed.vessel, imo: parsed.imo,
    buyerText: parsed.warnings.some(warning => warning.startsWith('Several companies match')) ? '' : parsed.buyerText,
    portText: parsed.warnings.some(warning => warning.startsWith('Several delivery ports')) ? '' : guessed.port || '',
    eta: parsed.eta, hsfo: parsed.hsfo, vlsfo: parsed.vlsfo, lsmgo: parsed.lsmgo, remarks: parsed.remarks,
  };
  const viscosity = [...parsed.vlsfoMaxRemarks];
  return {
    fields, rmk: parsed.rmk, viscosity, warnings: sourceCautions(parsed.warnings),
    standardText: formatEnquiry({ ...fields, buyerName: fields.buyerText, portName: fields.portText, rmk: parsed.rmk, vlsfoMaxRemarks: viscosity }),
  };
}

/** A match proves this raw replay matches the approved expectation, not that AI ran or a build was deployed. */
export function replayParserCase(input: ParserReplayInput, execution: ParserReplayExecution): ParserReplayResult {
  if (!execution.parserVersion?.trim() || !execution.buildFingerprint?.trim()) throw new Error('Trusted parser execution identity is required.');
  const actual = rawParserSnapshot(input.rawText);
  const base = { actual, provenance: { ...input.provenance }, executedWith: { ...execution } };
  if (!input.captureComplete || !isParserReplaySnapshot(input.expected) || !input.provenance.parserVersion?.trim()
    || !input.provenance.buildFingerprint?.trim() || !input.provenance.sourceHash?.trim()) {
    return { ...base, status: 'legacy-unverified', differences: [], directorySensitiveDifferences: [] };
  }
  const expected = input.expected;
  const differences: ParserReplayDifference[] = parserFieldKeys.filter(field => textKey(actual.fields[field]) !== textKey(expected.fields[field]));
  if (actual.rmk !== expected.rmk) differences.push('rmk');
  if (listKey(actual.viscosity) !== listKey(expected.viscosity)) differences.push('viscosity');
  if (listKey(actual.warnings) !== listKey(sourceCautions(expected.warnings))) differences.push('warnings');
  if (textKey(actual.standardText) !== textKey(expected.standardText)) differences.push('standardText');
  return {
    ...base, status: differences.length ? 'different' : 'matched', differences,
    directorySensitiveDifferences: differences.filter((field): field is 'buyerText' | 'portText' => field === 'buyerText' || field === 'portText'),
  };
}
