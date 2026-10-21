import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { authConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { handleParser, type ParserReceipt, type ParserReviewReceipt, type ParserServices } from './handler.ts';
import { createParserProvider } from './provider.ts';
import { createParserReviewProvider } from './review-provider.ts';
export async function serveParser(req: IncomingMessage & { body?: unknown }, res: ServerResponse, environment = process.env, services?: ParserServices) {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const config = authConfig(environment), headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 196608) { res.statusCode = 413; res.end(JSON.stringify({ message: 'Request too large.' })); return; } chunks.push(buffer); } body = Buffer.concat(chunks).toString('utf8'); }
      if (Buffer.byteLength(body ?? '', 'utf8') > 196608) { res.statusCode = 413; res.end(JSON.stringify({ message: 'Request too large.' })); return; }
    }
    const request = new Request(new URL(req.url ?? '/', config.origin), { method: req.method, headers, body });
    const admin = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) } });
    const response = await handleParser(request, config, createAuthGateway(request, config), services ?? {
      provider: () => createParserProvider(environment),
      reviewProvider: () => createParserReviewProvider(environment),
      async finishReview(actorId, requestId, result, errorCode) {
        const { data, error } = await admin.rpc('eco_finish_parser_review', { p_actor_id: actorId, p_request_id: requestId, p_result: result, p_error_code: errorCode });
        if (error) throw new Error('PARSER_REVIEW_UNCONFIRMED'); return data as ParserReviewReceipt;
      },
      async stampReport(actorId, reportId, fingerprint) {
        const { error } = await admin.rpc('eco_stamp_parser_report', { p_actor_id: actorId, p_report_id: reportId, p_fingerprint: fingerprint });
        if (error) throw new Error('PARSER_REPORT_STAMP_UNCONFIRMED');
      },
      async finish(actorId, requestId, result, errorCode) {
        const { data, error } = await admin.rpc('eco_finish_parser_ai', { p_actor_id: actorId, p_request_id: requestId, p_result: result, p_error_code: errorCode });
        if (error) throw new Error('PARSER_RECEIPT_UNCONFIRMED');
        return data as ParserReceipt;
      },
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(await response.text());
  } catch { res.statusCode = 503; res.end(JSON.stringify({ message: 'Parser service unavailable.' })); }
}
