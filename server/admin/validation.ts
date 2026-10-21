import type { AdminListQuery, FeedbackCreate, FeedbackTriage, ImportBegin, ImportRetry, ImportTransition } from '../../shared/admin.ts';
import { feedbackCategories, feedbackStatuses, feedbackPriorities, importKinds, importOutcomeStatuses } from '../../shared/admin.ts';
import { ApiError } from '../auth/validation.ts';
const invalid = () => new ApiError(400, 'Invalid administration request.');
export function uuid(v: unknown): string { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw invalid(); return v.toLowerCase(); }
function text(v: unknown, max: number, empty = false): string { if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) || (!empty && !v.trim())) throw invalid(); return v.trim(); }
function keys(v: Record<string, unknown>, allowed: string[]) { if (Object.keys(v).some(k => !allowed.includes(k))) throw invalid(); }
function choice<T extends string>(v: unknown, options: readonly T[]): T { if (!options.includes(v as T)) throw invalid(); return v as T; }
function revision(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 2147483646) throw invalid(); return Number(v); }
export function feedbackCreate(v: Record<string, unknown>): FeedbackCreate {
  keys(v, ['requestId','title','description','category','pagePath']); const pagePath = text(v.pagePath ?? '', 200, true);
  if (pagePath && (!pagePath.startsWith('/') || pagePath.startsWith('//') || /[?#\\\s]/.test(pagePath))) throw invalid();
  return {requestId:uuid(v.requestId),title:text(v.title,160),description:text(v.description,6000),category:choice(v.category,feedbackCategories),pagePath};
}
export function feedbackTriage(v: Record<string, unknown>): FeedbackTriage {
  keys(v, ['requestId','id','expectedRevision','status','priority','assigneeId','resolution']);
  const status = choice(v.status,feedbackStatuses); const resolution = text(v.resolution,2000,true);
  if (['resolved','closed'].includes(status) && !resolution) throw new ApiError(400, 'Enter a resolution before closing feedback.');
  return {requestId:uuid(v.requestId),id:uuid(v.id),expectedRevision:revision(v.expectedRevision),status,priority:choice(v.priority,feedbackPriorities),assigneeId:v.assigneeId === null ? null : uuid(v.assigneeId),resolution};
}
export function importBegin(v: Record<string, unknown>): ImportBegin {
  keys(v,['requestId','kind','sourceName','sourceType','retryOf','expectedRevision']);
  if ((v.retryOf === undefined) !== (v.expectedRevision === undefined)) throw invalid();
  const sourceName = text(v.sourceName,180), sourceType = text(v.sourceType,80);
  // Only a filename/label and MIME/parser type; source bodies, URLs, tokens and file paths are not retained.
  if (/[\\/]/.test(sourceName) || /(?:https?:|token=|password=)/i.test(sourceName) || !/^[\w.+/-]+$/.test(sourceType)) throw invalid();
  return {requestId:uuid(v.requestId),kind:choice(v.kind,importKinds),sourceName,sourceType,...(v.retryOf ? {retryOf:uuid(v.retryOf),expectedRevision:revision(v.expectedRevision)} : {})};
}
export function importTransition(v: Record<string, unknown>): ImportTransition {
  keys(v,['requestId','id','expectedRevision','status','warningCount','errorCode','summary']);
  if (!Number.isSafeInteger(v.warningCount) || Number(v.warningCount) < 0 || Number(v.warningCount) > 10000) throw invalid();
  const errorCode = text(v.errorCode ?? '',80,true); if (errorCode && !/^[A-Z0-9_-]+$/.test(errorCode)) throw invalid();
  return {requestId:uuid(v.requestId),id:uuid(v.id),expectedRevision:revision(v.expectedRevision),status:choice(v.status,importOutcomeStatuses),warningCount:Number(v.warningCount),errorCode,summary:text(v.summary ?? '',500,true)};
}
export function importRetry(v: Record<string, unknown>): ImportRetry { keys(v,['requestId','id','expectedRevision']); return {requestId:uuid(v.requestId),id:uuid(v.id),expectedRevision:revision(v.expectedRevision)}; }
export function listQuery(url: URL): Required<AdminListQuery> {
  if ([...url.searchParams.keys()].some(k => !['search','status','cursor','limit','scope'].includes(k))) throw invalid();
  const search = text(url.searchParams.get('search') ?? '',120,true), status = text(url.searchParams.get('status') ?? '',30,true), cursor = text(url.searchParams.get('cursor') ?? '',200,true);
  const limit = Number(url.searchParams.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor && !/^\d{4}-\d{2}-\d{2}[T ][\d:.+-]+(?:Z)?\|(?:[0-9a-f-]{36}|(?:access|administration):\d+)$/.test(cursor))) throw invalid();
  return {search,status,cursor,limit,scope:choice(url.searchParams.get('scope') ?? 'all',['mine','all'])};
}
