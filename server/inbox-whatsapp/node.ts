import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { whatsappConfig, WhatsAppError, type WhatsAppConfig } from './config.ts';
import { handleWhatsAppWebhook, reportWhatsAppGetRejection, MAX_WEBHOOK_BYTES, type WhatsAppGetRejection, type WhatsAppDependencies, type WhatsAppRequest, type WhatsAppStore, type WhatsAppReceipt } from './handler.ts';

export function whatsappStore(config: WhatsAppConfig, fetcher: typeof fetch = fetch): WhatsAppStore {
  const client = createClient(config.supabaseUrl, config.supabaseKey, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
    global: {fetch: (url, init) => fetcher(url, {...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(8000)])})}});
  return {async ingest(input, signal) {
    const {data, error} = await client.rpc('eco_ingest_whatsapp_enquiry', {p_input: input}).abortSignal(signal);
    // Do not expose SQL/provider diagnostics or message content in responses/logs.
    if (error) throw new WhatsAppError('unavailable', 503);
    return data as WhatsAppReceipt;
  }};
}
const defaults: WhatsAppDependencies = {configure: whatsappConfig, store: whatsappStore, diagnoseGetRejection: diagnostic => console.warn(JSON.stringify(diagnostic))};
class WhatsAppNodeRequestError extends WhatsAppError {
  readonly diagnosticReason: WhatsAppGetRejection;
  readonly bodyBytes: number | null;
  constructor(code: WhatsAppError['code'], status: number, reason: WhatsAppGetRejection, bodyBytes: number | null = null) {
    super(code, status); this.diagnosticReason = reason; this.bodyBytes = bodyBytes;
  }
}
const criticalHeaders = new Set(['x-hub-signature-256', 'content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'host']);
export async function whatsappNodeRequest(req: IncomingMessage, readTimeoutMs = 5000): Promise<WhatsAppRequest> {
  const seen = new Set<string>();
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (criticalHeaders.has(name) && seen.has(name)) throw new WhatsAppNodeRequestError('invalid_request', 400, 'duplicate_header');
    seen.add(name);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value) && criticalHeaders.has(key.toLowerCase())) throw new WhatsAppNodeRequestError('invalid_request', 400, 'duplicate_header');
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const length = headers.get('content-length');
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new WhatsAppNodeRequestError('invalid_request', 400, 'invalid_content_length');
  if (Number(length) > MAX_WEBHOOK_BYTES) throw new WhatsAppNodeRequestError('body_too_large', 413, 'body_too_large');
  if (length !== null && headers.has('transfer-encoding')) throw new WhatsAppNodeRequestError('invalid_request', 400, 'conflicting_framing');
  const parsed = Object.getOwnPropertyDescriptor(req, 'body');
  const raw = Object.getOwnPropertyDescriptor(req, 'rawBody');
  // Never sign a reconstructed object/string. A pre-consumed runtime must supply exact raw bytes.
  const buffer = Buffer.isBuffer(raw?.value) ? raw.value : Buffer.isBuffer(parsed?.value) ? parsed.value : null;
  if (!buffer && parsed && 'value' in parsed && parsed.value !== undefined) throw new WhatsAppNodeRequestError('invalid_request', 400, 'preparsed_body');
  let body: Buffer;
  if (buffer) body = buffer;
  else {
    const chunks: Buffer[] = []; let size = 0; let stream = req;
    body = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); stream.off('data', data); stream.off('end', end); req.off('error', error); req.off('aborted', aborted); };
      const fail = (failure: WhatsAppError) => { cleanup(); req.once('error', () => {}); stream.pause(); reject(failure); };
      const data = (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) { fail(new WhatsAppNodeRequestError('invalid_request', 400, 'nonbyte_body', size)); return; }
        size += chunk.length; if (size > MAX_WEBHOOK_BYTES) { fail(new WhatsAppNodeRequestError('body_too_large', 413, 'body_too_large', size)); return; } chunks.push(chunk);
      };
      const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      const error = () => fail(new WhatsAppNodeRequestError('unavailable', 503, 'stream_error', size));
      const aborted = () => fail(new WhatsAppNodeRequestError('invalid_request', 400, 'request_aborted', size));
      const timer = setTimeout(() => fail(new WhatsAppNodeRequestError('unavailable', 503, 'stream_timeout', size)), readTimeoutMs);
      // Vercel helpers may return a restored PassThrough here while req itself is already ended.
      stream = req.on('data', data); stream.once('end', end); req.once('error', error); req.once('aborted', aborted);
      if (stream.readableEnded) end();
    });
  }
  if (body.length > MAX_WEBHOOK_BYTES) throw new WhatsAppNodeRequestError('body_too_large', 413, 'body_too_large', body.length);
  if (length !== null && body.length !== Number(length)) throw new WhatsAppNodeRequestError('invalid_request', 400, 'body_length_mismatch', body.length);
  return {method: req.method ?? '', url: req.url ?? '/', headers, body};
}
export async function serveWhatsApp(req: IncomingMessage, res: ServerResponse, environment = process.env, dependencies: WhatsAppDependencies = defaults): Promise<void> {
  try {
    const request = await whatsappNodeRequest(req);
    const response = await handleWhatsAppWebhook(request, environment, dependencies);
    res.statusCode = response.status; response.headers.forEach((value, key) => res.setHeader(key, value)); res.end(await response.text());
  } catch (error) {
    const safe = error instanceof WhatsAppError ? error : new WhatsAppError('unavailable', 503);
    reportWhatsAppGetRejection(req.method ?? '', req.url ?? '/', error instanceof WhatsAppNodeRequestError ? error.bodyBytes : null, error instanceof WhatsAppNodeRequestError ? error.diagnosticReason : 'unavailable', safe.status, dependencies.diagnoseGetRejection, {hasOrigin: req.headers.origin !== undefined, hasSecFetchSite: req.headers['sec-fetch-site'] !== undefined, hasDataMode: req.headers['x-eco-data-mode'] !== undefined});
    res.statusCode = safe.status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, no-store, max-age=0'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (safe.status === 503) res.setHeader('Retry-After', '30');
    res.end(JSON.stringify({error: safe.code}));
  }
}
