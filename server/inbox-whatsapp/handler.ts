import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WHATSAPP_IDENTITY_NAMESPACE, WHATSAPP_PROVIDER, UUID, WhatsAppError, type WhatsAppConfig } from './config.ts';

export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const MAX_WEBHOOK_EVENTS = 100;
export const MAX_CHALLENGE_BYTES = 1024;
export const MAX_VERIFICATION_QUERY_BYTES = 8192;
export const MAX_VERIFICATION_QUERY_ENTRIES = 16;
export const WEBHOOK_PATH = '/api/enquiries/whatsapp';
export interface WhatsAppInput {
  sourceId: string; provider: typeof WHATSAPP_PROVIDER; accountId: string; destinationId: string;
  messageId: string; senderIdentity: string; identityNamespace: typeof WHATSAPP_IDENTITY_NAMESPACE;
  rawText: string; receivedAt: string;
  quarantineReason?: 'unsupported_attachment' | 'unsupported_body' | 'oversized' | 'malformed_message';
}
export interface WhatsAppReceipt { id: string; status: 'accepted' | 'quarantined'; duplicate: boolean; reason?: string }
export interface WhatsAppStore { ingest(input: WhatsAppInput, signal: AbortSignal): Promise<WhatsAppReceipt> }
export interface WhatsAppRequest { method: string; url: string; headers: Headers; body: Uint8Array }
export interface WhatsAppDependencies {
  configure: (env: NodeJS.ProcessEnv, phase: 'challenge' | 'delivery') => WhatsAppConfig;
  store: (config: WhatsAppConfig) => WhatsAppStore;
  diagnoseGetRejection?: (diagnostic: WhatsAppGetDiagnostic) => void;
}
const verificationKeys = ['hub.mode', 'hub.verify_token', 'hub.challenge'];
export type WhatsAppGetRejection = 'invalid_path' | 'browser_context' | 'configuration' | 'query_shape' | 'query_bounds' | 'mode' | 'challenge' | 'token_length' | 'token_mismatch' | 'body_present' | 'unavailable' |
  'duplicate_header' | 'invalid_content_length' | 'conflicting_framing' | 'preparsed_body' | 'nonbyte_body' | 'body_too_large' | 'body_length_mismatch' | 'request_aborted' | 'stream_error' | 'stream_timeout';
export interface WhatsAppGetDiagnostic {
  event: 'eco_whatsapp_get_rejected'; reason: WhatsAppGetRejection; status: number;
  hasOrigin: boolean; hasSecFetchSite: boolean; hasDataMode: boolean;
  queryEntryCount: number; queryKeyCount: number; unexpectedQuery: boolean; repeatedRequiredQuery: boolean;
  challengeLength: number; challengeFormat: 'missing' | 'empty' | 'decimal' | 'opaque' | 'control' | 'oversized'; bodyBytes: number | null;
}
function challengeShape(value: string | null): Pick<WhatsAppGetDiagnostic, 'challengeLength' | 'challengeFormat'> {
  const length = value === null ? 0 : Buffer.byteLength(value, 'utf8');
  return {challengeLength: Math.min(length, MAX_CHALLENGE_BYTES + 1), challengeFormat: value === null ? 'missing' : !length ? 'empty' : length > MAX_CHALLENGE_BYTES ? 'oversized' : /[\p{Cc}\uD800-\uDFFF]/u.test(value) ? 'control' : /^[0-9]+$/.test(value) ? 'decimal' : 'opaque'};
}
/** Fixed enums/counts only. Never log a request URL, key/name, value, token, or body. */
export function reportWhatsAppGetRejection(method: string, urlText: string, bodyBytes: number | null, reason: WhatsAppGetRejection, status: number, report?: WhatsAppDependencies['diagnoseGetRejection'], browserContext: Pick<WhatsAppGetDiagnostic, 'hasOrigin' | 'hasSecFetchSite' | 'hasDataMode'> = {hasOrigin: false, hasSecFetchSite: false, hasDataMode: false}): void {
  if (method !== 'GET' || !report) return;
  try {
    const url = new URL(urlText, 'https://eco.invalid');
    const keys = [...url.searchParams.keys()];
    report({event: 'eco_whatsapp_get_rejected', reason, status, hasOrigin: Boolean(browserContext.hasOrigin), hasSecFetchSite: Boolean(browserContext.hasSecFetchSite), hasDataMode: Boolean(browserContext.hasDataMode), queryEntryCount: Math.min(keys.length, 16), queryKeyCount: Math.min(new Set(keys).size, 16),
      unexpectedQuery: keys.some(key => !verificationKeys.includes(key)), repeatedRequiredQuery: verificationKeys.some(key => url.searchParams.getAll(key).length > 1),
      ...challengeShape(url.searchParams.get('hub.challenge')), bodyBytes: bodyBytes === null ? null : Math.min(Math.max(0, bodyBytes), MAX_WEBHOOK_BYTES + 1)});
  } catch { /* Observability must never change the response or expose an exception. */ }
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function invalid(): never { throw new WhatsAppError('invalid_request', 400); }
function boundedList(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > MAX_WEBHOOK_EVENTS) invalid(); return value; }
function safeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}
export function validWhatsAppSignature(body: Uint8Array, signature: string | null, secret: string): boolean {
  if (!/^[0-9a-f]{32}$/i.test(secret) || !/^sha256=[0-9a-f]{64}$/.test(signature ?? '')) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(body).digest(), Buffer.from(signature!.slice(7), 'hex'));
}
/** Do not import SPC acknowledgements, interactive controls, or isolated authentication codes. */
export function isWhatsAppControl(text: string): boolean {
  const value = text.trim();
  return /^ok$/i.test(value) || /^(?:MOBILE_)?RECEIVE_/i.test(value) || /^[0-9]{4,8}$/.test(value) ||
    /^(?:otp|verification|security|authentication|login)(?:\s+code)?\s*[:=-]?\s*[0-9]{4,8}$/i.test(value);
}
function messageInput(message: Record<string, unknown>, contacts: unknown[] | undefined, config: WhatsAppConfig, now: number): WhatsAppInput | null {
  if (typeof message.id !== 'string' || !/^wamid\.[A-Za-z0-9+/_=-]{1,1018}$/.test(message.id) ||
      typeof message.timestamp !== 'string' || !/^[1-9][0-9]{0,11}$/.test(message.timestamp)) invalid();
  const milliseconds = Number(message.timestamp) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > now + 5 * 60_000 || milliseconds < Date.UTC(2000, 0, 1)) invalid();
  // These payload types represent actions/replies, not new enquiries.
  if (['button', 'interactive', 'reaction', 'system'].includes(String(message.type))) return null;
  const text = record(message.text)?.body;
  if (message.type === 'text' && typeof text === 'string' && isWhatsAppControl(text)) return null;
  const sender = typeof message.from === 'string' && /^[1-9][0-9]{6,14}$/.test(message.from) ? message.from : '';
  const input: WhatsAppInput = {sourceId: config.sourceId, provider: WHATSAPP_PROVIDER, accountId: config.accountId,
    destinationId: config.phoneNumberId, messageId: message.id, senderIdentity: sender,
    identityNamespace: WHATSAPP_IDENTITY_NAMESPACE, rawText: '', receivedAt: new Date(milliseconds).toISOString()};
  // BSUID/usernames are not phone numbers. Never strip characters or guess an owner.
  if (!sender || (contacts !== undefined && !contacts.some(contact => record(contact)?.wa_id === sender))) {
    input.quarantineReason = 'malformed_message'; return input;
  }
  if (['audio', 'document', 'image', 'video', 'sticker'].includes(String(message.type))) input.quarantineReason = 'unsupported_attachment';
  else if (message.type !== 'text') input.quarantineReason = 'unsupported_body';
  else if (typeof text !== 'string' || !text.trim() || /[\p{Cc}\uD800-\uDFFF]/u.test(text.replace(/[\r\n\t]/g, ''))) input.quarantineReason = 'malformed_message';
  else if (Buffer.byteLength(text, 'utf8') > 20_000) input.quarantineReason = 'oversized';
  else input.rawText = text;
  return input;
}
/** Validate the entire bounded batch before any database write, including all matching changes. */
export function whatsappInputs(payload: unknown, config: WhatsAppConfig, now = Date.now()): WhatsAppInput[] {
  const root = record(payload); if (root?.object !== 'whatsapp_business_account') invalid();
  const inputs: WhatsAppInput[] = []; let eventCount = 0; let changeCount = 0;
  for (const item of boundedList(root.entry)) {
    const entry = record(item); if (!entry || typeof entry.id !== 'string') invalid();
    const changes = boundedList(entry.changes); changeCount += changes.length; if (changeCount > MAX_WEBHOOK_EVENTS) invalid();
    for (const value of changes) {
      const change = record(value); if (!change || typeof change.field !== 'string') invalid();
      if (entry.id !== config.accountId || change.field !== 'messages') continue;
      const data = record(change.value); const metadata = record(data?.metadata);
      if (!data || data.messaging_product !== 'whatsapp' || !metadata || typeof metadata.phone_number_id !== 'string') invalid();
      if (metadata.phone_number_id !== config.phoneNumberId) continue;
      if (metadata.display_phone_number !== undefined && (typeof metadata.display_phone_number !== 'string' ||
          !/^\+?[1-9][0-9 ()-]{6,30}$/.test(metadata.display_phone_number) || metadata.display_phone_number.replace(/[+ ()-]/g, '') !== config.displayPhoneNumber.slice(1))) invalid();
      const contacts = data.contacts === undefined ? undefined : boundedList(data.contacts);
      const messages = data.messages === undefined ? [] : boundedList(data.messages);
      const statuses = data.statuses === undefined ? [] : boundedList(data.statuses);
      eventCount += messages.length + statuses.length; if (eventCount > MAX_WEBHOOK_EVENTS) invalid();
      for (const value of messages) { const message = record(value); if (!message) invalid(); const input = messageInput(message, contacts, config, now); if (input) inputs.push(input); }
    }
  }
  return inputs;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new WhatsAppError('unavailable', 503);
  let listener: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { listener = () => reject(new WhatsAppError('unavailable', 503)); signal.addEventListener('abort', listener, {once: true}); });
  try { return await Promise.race([promise, cancelled]); } finally { if (listener) signal.removeEventListener('abort', listener); }
}
export async function handleWhatsAppWebhook(request: WhatsAppRequest, env: NodeJS.ProcessEnv, deps: WhatsAppDependencies, options: {now?: () => number; deadlineMs?: number; signal?: AbortSignal} = {}): Promise<Response> {
  const headers = new Headers({'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff'});
  const answer = (status: number, value: unknown) => new Response(JSON.stringify(value), {status, headers});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejection: WhatsAppGetRejection = 'unavailable';
  const browserContext = {hasOrigin: request.headers.has('origin'), hasSecFetchSite: request.headers.has('sec-fetch-site'), hasDataMode: request.headers.has('x-eco-data-mode')};
  const rejectGet = (reason: WhatsAppGetRejection): never => { rejection = reason; return invalid(); };
  try {
    const url = new URL(request.url, 'https://eco.invalid');
    if (url.pathname !== WEBHOOK_PATH) rejectGet('invalid_path');
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site') || request.headers.has('x-eco-data-mode')) rejectGet('browser_context');
    if (!['GET', 'POST'].includes(request.method)) { headers.set('Allow', 'GET, POST'); return answer(405, {error: 'method_not_allowed'}); }
    rejection = 'configuration';
    const config = deps.configure(env, request.method === 'GET' ? 'challenge' : 'delivery');
    rejection = 'unavailable';
    if (request.method === 'GET') {
      if (request.body.byteLength) rejectGet('body_present');
      if (Buffer.byteLength(url.search, 'utf8') > MAX_VERIFICATION_QUERY_BYTES || url.searchParams.size > MAX_VERIFICATION_QUERY_ENTRIES) rejectGet('query_bounds');
      // Meta may append provider fields; only the three required values affect verification.
      if (verificationKeys.some(key => url.searchParams.getAll(key).length !== 1)) rejectGet('query_shape');
      if (url.searchParams.get('hub.mode') !== 'subscribe') rejectGet('mode');
      // Meta's challenge is opaque text. Return it exactly, with bounded plain-text reflection.
      const shape = challengeShape(url.searchParams.get('hub.challenge'));
      if (!['decimal', 'opaque'].includes(shape.challengeFormat)) rejectGet('challenge');
      if ((url.searchParams.get('hub.verify_token')?.length ?? 0) > 256) rejectGet('token_length');
      if (!safeEqual(url.searchParams.get('hub.verify_token') ?? '', config.verifyToken)) {
        reportWhatsAppGetRejection(request.method, request.url, request.body.byteLength, 'token_mismatch', 403, deps.diagnoseGetRejection, browserContext);
        return answer(403, {error: 'forbidden'});
      }
      headers.set('Content-Type', 'text/plain; charset=utf-8'); return new Response(url.searchParams.get('hub.challenge'), {status: 200, headers});
    }
    if (url.search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) invalid();
    if (request.body.byteLength > MAX_WEBHOOK_BYTES) throw new WhatsAppError('body_too_large', 413);
    if (!validWhatsAppSignature(request.body, request.headers.get('x-hub-signature-256'), config.appSecret)) throw new WhatsAppError('invalid_signature', 401);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(request.body)); } catch { invalid(); }
    const inputs = whatsappInputs(payload, config, (options.now ?? Date.now)());
    if (inputs.length) {
      const controller = new AbortController(); timer = setTimeout(() => controller.abort(), options.deadlineMs ?? 20_000);
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const store = deps.store(config);
      for (const input of inputs) {
        if (signal.aborted) throw new WhatsAppError('unavailable', 503);
        const receipt = await abortable(store.ingest(input, signal), signal);
        if (!receipt || !UUID.test(receipt.id) || !['accepted', 'quarantined'].includes(receipt.status) || typeof receipt.duplicate !== 'boolean') throw new WhatsAppError('unavailable', 503);
      }
    }
    return answer(200, {received: true});
  } catch (error) {
    const safe = error instanceof WhatsAppError ? error : new WhatsAppError('unavailable', 503);
    reportWhatsAppGetRejection(request.method, request.url, request.body.byteLength, rejection, safe.status, deps.diagnoseGetRejection, browserContext);
    if (safe.status === 503) headers.set('Retry-After', '30');
    return answer(safe.status, {error: safe.code});
  } finally { if (timer) clearTimeout(timer); }
}
