import type { ParserFixInput, ParserFixResult, ParserReportInput, ParserReportPage, ParserReportDetail, ParserReviewAnalysis, ParserReviewInput, ParserReviewIdentity, ParserScope } from '../../shared/parserService';
import { assertPreviewWritable } from './previewGuard';
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (body !== undefined) assertPreviewWritable();
  const response = await fetch(`/api/parser/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Eco-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000) });
  const data = await response.json().catch(() => ({ message: 'Parser service unavailable.' }));
  if (!response.ok) throw Object.assign(new Error(data.message ?? 'Parser request failed.'), { status: response.status, operationState: data.operationState });
  return data as T;
}
export const parserApi = {
  fix: (input: ParserFixInput, signal?: AbortSignal) => request<ParserFixResult>('fix', input, signal),
  report: (input: ParserReportInput, signal?: AbortSignal) => request<{ id: string; createdAt: string }>('reports', input, signal),
  reportDetail: (id: string, scope: ParserScope, signal?: AbortSignal) => { const query = new URLSearchParams({ id, dataMode: scope.dataMode, ...(scope.generation ? { generation: scope.generation } : {}) }); return request<ParserReportDetail>(`reports?${query}`, undefined, signal); },
  review: (input: ParserReviewInput, signal?: AbortSignal) => request<ParserReportDetail>('review', input, signal),
  reviewAi: (input: ParserReviewIdentity, signal?: AbortSignal) => request<ParserReviewAnalysis>('review-ai', input, signal),
  reports: (scope: ParserScope, cursor?: string, signal?: AbortSignal, stage: 'pending_user' | 'pending_ai' | 'reviewed' | 'all' = 'pending_user') => { const query = new URLSearchParams({ dataMode: scope.dataMode, stage, summary: 'true', limit: '25', ...(scope.generation ? { generation: scope.generation } : {}), ...(cursor ? { cursor } : {}) }); return request<ParserReportPage>(`reports?${query}`, undefined, signal); },
};
