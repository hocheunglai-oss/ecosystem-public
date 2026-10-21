import { createHash } from 'node:crypto';
import { ApiError } from '../auth/validation.ts';
import { isParserFields, PARSER_TEXT_LIMIT, PARSER_VERSION, type ParserFixInput, type ParserReportInput, type ParserScope, type ParserSnapshot, type ParserReviewInput, type ParserReviewIdentity } from '../../shared/parserService.ts';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(): never { throw new ApiError(400, 'Invalid parser request.'); }
function object(value: unknown, allowed: string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail(); return value as Record<string, unknown>; }
function uuid(value: unknown): string { return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : fail(); }
function text(value: unknown, maximum: number, required = true): string { return typeof value === 'string' && (!required || value.trim().length > 0) && Buffer.byteLength(value, 'utf8') <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : fail(); }
export function scope(value: Record<string, unknown>): ParserScope {
  if (value.dataMode !== 'live' && value.dataMode !== 'test') return fail();
  if (value.dataMode === 'test') return { dataMode: 'test', generation: uuid(value.generation) };
  if (value.generation !== undefined) return fail();
  return { dataMode: 'live' };
}
const commonKeys = ['requestId', 'rawText', 'sourceRevision', 'parserVersion', 'dataMode', 'generation'];
function common(value: Record<string, unknown>) {
  if (value.parserVersion !== PARSER_VERSION) throw new ApiError(409, 'Refresh ECO before using the parser.');
  return { requestId: uuid(value.requestId), rawText: text(value.rawText, PARSER_TEXT_LIMIT), sourceRevision: text(value.sourceRevision, 128), parserVersion: PARSER_VERSION, ...scope(value) };
}
export function fixInput(value: unknown): ParserFixInput & { sourceHash: string } {
  const input = object(value, [...commonKeys, 'current']);
  if (!isParserFields(input.current)) return fail();
  const result = { ...common(input), current: input.current };
  return { ...result, sourceHash: createHash('sha256').update(result.rawText, 'utf8').digest('hex') };
}
export function reportInput(value: unknown): ParserReportInput {
  const input = object(value, [...commonKeys, 'parsed', 'corrected', 'notes', 'aiRequestId', 'capture']);
  if (!isParserFields(input.parsed) || !isParserFields(input.corrected)) return fail();
  return { ...common(input), parsed: input.parsed, corrected: input.corrected, notes: text(input.notes, 2000, false), ...(input.aiRequestId === undefined ? {} : { aiRequestId: uuid(input.aiRequestId) }), ...(input.capture === undefined ? {} : { capture: capture(input.capture) }) };
}
export function reportQuery(url: URL) {
  const input = Object.fromEntries(url.searchParams);
  if ([...url.searchParams.keys()].length !== Object.keys(input).length || Object.keys(input).some(key => !['dataMode','generation','limit','cursor','stage','id','summary'].includes(key))) return fail();
  if (input.id !== undefined) { if (input.limit !== undefined || input.cursor !== undefined || input.stage !== undefined || input.summary !== undefined) return fail(); return { ...scope(input), id: uuid(input.id) }; }
  if (input.summary !== undefined && input.summary !== 'true') return fail();
  if (input.stage !== undefined && !['all','pending_user','pending_ai','reviewed'].includes(input.stage)) return fail();
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail();
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    const [timestamp, id, extra] = input.cursor.split('|');
    if (extra !== undefined || !/^\d{4}-\d\d-\d\d[T ]/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || !uuidPattern.test(id ?? '')) return fail();
    cursor = input.cursor;
  }
  return { ...scope(input), limit, ...(cursor ? { cursor } : {}), ...(input.stage ? { stage: input.stage } : {}), ...(input.summary ? { summary: true } : {}) };
}

export function snapshot(value: unknown): ParserSnapshot {
  const input = object(value, ['fields','standardText','warnings','rmk','viscosity']);
  if (!isParserFields(input.fields) || typeof input.rmk !== 'boolean' || !Array.isArray(input.warnings) || input.warnings.length > 100 || !Array.isArray(input.viscosity) || input.viscosity.length > 4 || input.viscosity.some(item => !['80cst min','80cst max','120cst max','180cst max'].includes(item))) return fail();
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 50000) return fail();
  return { fields: input.fields, standardText: text(input.standardText, 20000, false), warnings: input.warnings.map(item => text(item, 2000, false)), rmk: input.rmk, viscosity: input.viscosity as string[] };
}
function capture(value: unknown) {
  const input = object(value, ['original','submitted','originalRevision','parseOrigin','clientBuildFingerprint']);
  if (input.parseOrigin !== 'initial' && input.parseOrigin !== 'reparsed') return fail();
  return { original: snapshot(input.original), submitted: snapshot(input.submitted), originalRevision: text(input.originalRevision,128), parseOrigin: input.parseOrigin as 'initial' | 'reparsed', ...(input.clientBuildFingerprint === undefined ? {} : { clientBuildFingerprint: text(input.clientBuildFingerprint,128) }) };
}
export function reviewIdentity(value: unknown): ParserReviewIdentity {
  const input = object(value, ['requestId','reportId','expectedRevision','dataMode','generation']);
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || Number(input.expectedRevision) > 2147483647) return fail();
  return { ...scope(input), requestId: uuid(input.requestId), reportId: uuid(input.reportId), expectedRevision: Number(input.expectedRevision) };
}
export function reviewInput(value: unknown): ParserReviewInput {
  const input = object(value, ['requestId','reportId','expectedRevision','dataMode','generation','action','expected','notes','aiRequestId']);
  const { action, expected, notes, aiRequestId, ...identity } = input;
  const base = reviewIdentity(identity);
  if (action === 'approve' && aiRequestId === undefined) return { ...base, action, expected: snapshot(expected), notes: text(notes,2000,false) };
  if (action === 'complete' && expected === undefined && notes === undefined) return { ...base, action, aiRequestId: uuid(aiRequestId) };
  if ((action === 'replay' || action === 'reopen') && expected === undefined && notes === undefined && aiRequestId === undefined) return { ...base, action };
  return fail();
}
