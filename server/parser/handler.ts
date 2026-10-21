import type { AuthConfig } from '../auth/config.ts';
import type { AdministrationGateway } from '../admin/handler.ts';
import { ApiError } from '../auth/validation.ts';
import { fixInput, reportInput, reportQuery, reviewIdentity, reviewInput } from './validation.ts';
import { ParserProviderError, produceSuggestions, type ParserProvider } from './provider.ts';
import { produceReview, type ParserReviewProvider } from './review-provider.ts';
import { replayParserCase, isParserReplaySnapshot } from '../../shared/parserReplay.ts';
import { generatedSystemInformation } from '../generated/system-information.ts';
import { PARSER_VERSION } from '../../shared/parserService.ts';
import type { ParserFixResult, ParserReportDetail, ParserReviewAnalysis } from '../../shared/parserService.ts';
export interface ParserReceipt { id: string; state: 'pending' | 'complete' | 'failed'; runProvider?: boolean; result?: ParserFixResult }
export interface ParserReviewReceipt { id: string; state: 'pending' | 'complete' | 'failed'; runProvider?: boolean; evidence?: ParserReportDetail; result?: ParserReviewAnalysis | ParserReportDetail }
export interface ParserServices { reviewProvider?(): ParserReviewProvider; finishReview?(actorId: string, requestId: string, result: unknown, errorCode: string | null): Promise<ParserReviewReceipt>; stampReport?(actorId: string, reportId: string, fingerprint: string): Promise<void>; provider(): ParserProvider; finish(actorId: string, requestId: string, result: ParserFixResult | null, errorCode: string | null): Promise<ParserReceipt> }
export async function handleParser(request: Request, config: AuthConfig, gateway: AdministrationGateway, services: ParserServices): Promise<Response> {
  const respond = (body: unknown, status = 200) => { const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); for (const cookie of gateway.cookies) headers.append('Set-Cookie', cookie); if (status === 429) headers.set('Retry-After', '60'); return new Response(JSON.stringify(body), { status, headers }); };
  try {
    const url = new URL(request.url);
    if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
    const actor = await gateway.currentUser();
    if (!actor?.isActive) throw new ApiError(401, 'Sign in required.');
    if (await gateway.getPreview()) throw new ApiError(403, 'Parser requests are unavailable in preview.');
    let body: unknown;
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if ((origin !== config.origin && (!config.deploymentOrigin || origin !== config.deploymentOrigin)) || request.headers.get('x-eco-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'Access denied.');
      if (url.search) throw new ApiError(400, 'Invalid parser request.');
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON required.');
      const raw = await request.text();
      if (Buffer.byteLength(raw, 'utf8') > (url.pathname === '/api/parser/reports' ? 196608 : 65536)) throw new ApiError(413, 'Request too large.');
      try { body = JSON.parse(raw); } catch { throw new ApiError(400, 'Invalid parser request.'); }
    }
    if (url.pathname === '/api/parser/reports' && request.method === 'GET') {
      if (!actor.isAdmin) throw new ApiError(403, 'Access denied.');
      return respond(await gateway.authenticatedRpc('eco_list_parser_reports', { p_query: reportQuery(url) }));
    }
    if (url.pathname === '/api/parser/reports' && request.method === 'POST') {
      const created = await gateway.authenticatedRpc<{id: string; createdAt: string}>('eco_create_parser_report', { p_input: reportInput(body) });
      if (services.stampReport) await services.stampReport(actor.id, created.id, generatedSystemInformation.build.sourceSha256);
      return respond(created);
    }
    if (['/api/parser/review','/api/parser/review-ai'].includes(url.pathname) && request.method === 'POST') {
      if (!actor.isAdmin) throw new ApiError(403, 'Access denied.');
      const input = url.pathname === '/api/parser/review-ai' ? reviewIdentity(body) : reviewInput(body);
      if ('action' in input && input.action !== 'replay') return respond(await gateway.authenticatedRpc('eco_review_parser_report', { p_input: input }));
      const kind = url.pathname === '/api/parser/review-ai' ? 'ai' : 'replay';
      const { action: _action, ...identity } = input as typeof input & { action?: string };
      const receipt = await gateway.authenticatedRpc<ParserReviewReceipt>('eco_begin_parser_review', { p_input: { ...identity, kind } });
      if (!receipt.runProvider) {
        if (receipt.state === 'complete' && receipt.result) return respond(receipt.result);
        return respond({ message: receipt.state === 'pending' ? 'Review is pending. Retry the same request.' : 'Review failed. Retry with a new request.', operationState: receipt.state }, receipt.state === 'pending' ? 409 : 503);
      }
      let result: unknown;
      try {
        if (!receipt.evidence || !services.finishReview) throw new ApiError(503,'Review service unavailable.');
        const evidence = receipt.evidence;
        if (kind === 'ai') {
          if (!services.reviewProvider) throw new ApiError(503,'AI review is not configured.');
          result = await produceReview(services.reviewProvider(), evidence, identity);
        } else {
          result = replayParserCase({ rawText: evidence.rawText, expected: evidence.workflow.expected,
            captureComplete: Boolean(evidence.capture && isParserReplaySnapshot(evidence.capture.original) && isParserReplaySnapshot(evidence.capture.submitted)),
            provenance: { reportId: evidence.id, reportRevision: evidence.workflow.revision, sourceRevision: evidence.sourceRevision, sourceHash: evidence.sourceHash, parserVersion: evidence.parserVersion, buildFingerprint: evidence.buildFingerprint ?? '', ...(evidence.capture ? { originalRevision: evidence.capture.originalRevision, parseOrigin: evidence.capture.parseOrigin } : {}) },
          }, { parserVersion: PARSER_VERSION, buildFingerprint: generatedSystemInformation.build.sourceSha256 });
        }
      } catch (error) {
        const code = error instanceof ParserProviderError ? error.code.toUpperCase() : error instanceof ApiError ? 'CONFIGURATION_UNAVAILABLE' : 'REVIEW_FAILED';
        try { if (!services.finishReview) throw new Error(); await services.finishReview(actor.id, input.requestId, null, code); }
        catch { return respond({ message: 'Review outcome is unconfirmed. Retry the same request.', operationState: 'pending' },503); }
        return respond({ message: 'Review failed. Your approved correction is unchanged.', operationState: 'failed' },503);
      }
      try {
        const completed = await services.finishReview!(actor.id,input.requestId,result,null);
        if (completed.state === 'failed') return respond({ message: 'Review changed or expired. Reload the report.', operationState: 'failed' },409);
        if (completed.state !== 'complete' || !completed.result) throw new Error();
        return respond(completed.result);
      } catch { return respond({ message: 'Review outcome is unconfirmed. Retry the same request.', operationState: 'pending' },503); }
    }
    if (url.pathname !== '/api/parser/fix' || request.method !== 'POST') return respond({ message: 'Not found.' }, 404);
    const input = fixInput(body);
    const receipt = await gateway.authenticatedRpc<ParserReceipt>('eco_begin_parser_ai', { p_input: input });
    if (!receipt.runProvider) {
      if (receipt.state === 'complete' && receipt.result) return respond(receipt.result);
      return respond({ message: receipt.state === 'pending' ? 'AI FIX is still pending. Retry the same request.' : 'AI FIX failed. Your enquiry is unchanged.', operationState: receipt.state }, receipt.state === 'pending' ? 409 : 503);
    }
    let result: ParserFixResult;
    try { result = await produceSuggestions(services.provider(), input); }
    catch (error) {
      const code = error instanceof ParserProviderError ? error.code.toUpperCase() : error instanceof ApiError ? 'CONFIGURATION_UNAVAILABLE' : 'PROVIDER_FAILED';
      try { await services.finish(actor.id, input.requestId, null, code); } catch { return respond({ message: 'AI FIX outcome is unconfirmed. Retry the same request.', operationState: 'pending' }, 503); }
      return respond({ message: 'AI suggestions are unavailable. Your enquiry is unchanged.', operationState: 'failed' }, 503);
    }
    try {
      const completed = await services.finish(actor.id, input.requestId, result, null);
      if (completed.state !== 'complete' || !completed.result) throw new Error('UNCONFIRMED');
      return respond(completed.result);
    } catch { return respond({ message: 'AI FIX outcome is unconfirmed. Retry the same request.', operationState: 'pending' }, 503); }
  } catch (error) { return respond({ message: error instanceof ApiError ? error.message : 'Parser service unavailable.' }, error instanceof ApiError ? error.status : 503); }
}
