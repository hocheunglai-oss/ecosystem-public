/** Narrow parser contract: no account directory, financial values or application credentials. */
export const PARSER_VERSION = 'eco-fcuno-2026-10-15-v2';
export const PARSER_TEXT_LIMIT = 20_000;
export const parserFieldKeys = ['vessel', 'imo', 'buyerText', 'portText', 'eta', 'hsfo', 'vlsfo', 'lsmgo', 'remarks'] as const;
export type ParserField = typeof parserFieldKeys[number];
export type ParserFields = Record<ParserField, string>;
export const parserFieldLabels: Record<ParserField, string> = { vessel: 'VESSEL', imo: 'IMO', buyerText: 'BUYER', portText: 'PORT', eta: 'ETA', hsfo: 'HSFO', vlsfo: 'VLSFO', lsmgo: 'LSMGO', remarks: 'REMARKS' };
export type ParserScope = { dataMode: 'live' | 'test'; generation?: string };
export interface ParserFixInput extends ParserScope { requestId: string; rawText: string; sourceRevision: string; parserVersion: string; current: ParserFields }
export interface ParserSuggestion { field: ParserField; value: string; evidence: string }
export interface ParserFixResult { requestId: string; sourceHash: string; sourceRevision: string; parserVersion: string; model: string; suggestions: ParserSuggestion[]; warnings: string[] }
export interface ParserSnapshot { fields: ParserFields; standardText: string; warnings: string[]; rmk: boolean; viscosity: string[] }
export interface ParserCapture { original: ParserSnapshot; submitted: ParserSnapshot; originalRevision: string; parseOrigin: 'initial' | 'reparsed'; clientBuildFingerprint?: string }
export interface ParserReportInput extends ParserScope { requestId: string; rawText: string; sourceRevision: string; parserVersion: string; parsed: ParserFields; corrected: ParserFields; aiRequestId?: string; notes: string; capture?: ParserCapture }
export type ParserReviewStage = 'pending_user' | 'pending_ai' | 'reviewed';
export interface ParserReviewAnalysis { requestId: string; reportId: string; revision: number; model: string; diagnosis: string; proposedFix: string; regressionExamples: { rawText: string; reason: string }[]; warnings: string[] }
export interface ParserReviewHistory { id: string; revision: number; action: string; actor: string; createdAt: string; data: Record<string, unknown> }
export interface ParserOriginalAi { requestId: string; state: 'pending' | 'complete' | 'failed'; input: ParserFixInput; result: ParserFixResult | null; errorCode: string | null }
export interface ParserWorkflow { revision: number; stage: ParserReviewStage; expected: ParserSnapshot | null; notes: string; aiReview: ParserReviewAnalysis | null; replay: import('./parserReplay.ts').ParserReplayResult | null }
export interface ParserReviewIdentity extends ParserScope { requestId: string; reportId: string; expectedRevision: number }
export type ParserReviewInput = ParserReviewIdentity & ({ action: 'approve'; expected: ParserSnapshot; notes: string } | { action: 'complete'; aiRequestId: string } | { action: 'replay' | 'reopen' });
export interface ParserReportDetail extends ParserReport { sourceHash: string; buildFingerprint: string | null; workflow: ParserWorkflow; originalAi: ParserOriginalAi | null; history: ParserReviewHistory[] }
export interface ParserReport extends ParserReportInput { id: string; createdAt: string; createdBy: string }
export interface ParserReportSummary { id: string; createdAt: string; createdBy: string; dataMode: 'live' | 'test'; parsed: ParserFields; corrected: ParserFields; workflow: Pick<ParserWorkflow, 'revision' | 'stage'> }
export interface ParserReportPage { items: ParserReportSummary[]; nextCursor: string | null }
export const emptyParserFields = (): ParserFields => Object.fromEntries(parserFieldKeys.map(key => [key, ''])) as ParserFields;
export function isParserFields(value: unknown): value is ParserFields {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === parserFieldKeys.length &&
    parserFieldKeys.every(key => typeof (value as ParserFields)[key] === 'string' && (value as ParserFields)[key].length <= (key === 'remarks' ? 3000 : 500) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test((value as ParserFields)[key])));
}
/** A proposal can only touch unchanged, non-manual fields from its exact source revision. */
export function applicableSuggestions(result: ParserFixResult, sourceRevision: string, before: ParserFields, current: ParserFields, manual: ReadonlySet<ParserField>): ParserSuggestion[] {
  if (result.sourceRevision !== sourceRevision) return [];
  return result.suggestions.filter(item => parserFieldKeys.includes(item.field) && !manual.has(item.field) && current[item.field] === before[item.field] && item.value !== current[item.field]);
}
