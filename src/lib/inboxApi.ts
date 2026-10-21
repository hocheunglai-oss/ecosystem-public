import type { IncomingEnquiry, InboxPage, InboxMutation, InboxMutationResult } from '../../shared/inbox';
import { assertPreviewWritable } from './previewGuard';
import { assertLiveDataWritable } from './testWorkspaceGuard';

const unavailable = () => new Error('Inbox unavailable. Try again.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;

function item(value: unknown, owner: string): IncomingEnquiry {
  if (!object(value) || !text(value.id, 36) || !uuid.test(value.id) || value.owner !== owner ||
    !text(value.providerMessageId, 1024) || !['whatsapp', 'email'].includes(value.channel as string) ||
    !text(value.sender, 320) || !text(value.rawText, 20000) || !text(value.receivedAt, 40) || !Number.isFinite(Date.parse(value.receivedAt)) ||
    typeof value.read !== 'boolean' || typeof value.dismissed !== 'boolean' ||
    (value.subject !== undefined && (typeof value.subject !== 'string' || value.subject.length > 1000))) throw unavailable();
  // Explicit projection excludes any browser-local enquiry relation or unexpected server fields.
  return { id: value.id, providerMessageId: value.providerMessageId, owner, channel: value.channel as IncomingEnquiry['channel'], sender: value.sender,
    rawText: value.rawText, receivedAt: value.receivedAt, read: value.read,
    dismissed: value.dismissed, ...(value.subject === undefined ? {} : { subject: value.subject as string }) };
}
export function parseInboxPage(value: unknown, owner: string): InboxPage {
  if (!uuid.test(owner) || !object(value) || !Array.isArray(value.items) || value.items.length > 50 || !count(value.unreadCount) ||
    !(value.nextCursor === null || text(value.nextCursor, 1024))) throw unavailable();
  const items = value.items.map(value => item(value, owner));
  if (new Set(items.map(value => value.id)).size !== items.length) throw unavailable();
  return { items, unreadCount: value.unreadCount, nextCursor: value.nextCursor as string | null };
}
export function parseInboxMutation(value: unknown, owner: string, input: InboxMutation): InboxMutationResult {
  if (!object(value) || value.requestId !== input.requestId || value.action !== input.action || !count(value.changedCount) || !count(value.unreadCount)) throw unavailable();
  const result = value.item === null ? null : item(value.item, owner);
  if (input.action === 'dismiss-all' ? result !== null : result?.id !== input.id) throw unavailable();
  return { requestId: input.requestId, action: input.action, item: result, changedCount: value.changedCount, unreadCount: value.unreadCount };
}
async function request(owner: string, input?: InboxMutation, cursor?: string, signal?: AbortSignal): Promise<unknown> {
  // Reads are private too: TEST and VIEW AS never contact the LIVE inbox.
  assertPreviewWritable(); assertLiveDataWritable();
  if (!uuid.test(owner)) throw unavailable();
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/enquiries/inbox${input ? '' : `?${query}`}`, {
    method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Eco-Data-Mode': 'live', ...(input ? { 'Content-Type': 'application/json', 'X-Eco-Request': '1' } : {}) },
    body: input ? JSON.stringify(input) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Object.assign(unavailable(), { status: response.status });
  if (!response.headers.get('content-type')?.includes('application/json')) throw unavailable();
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const decoder = new TextDecoder(); let body = '', bytes = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
    bytes += chunk.value.byteLength; if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw unavailable(); }
    body += decoder.decode(chunk.value, { stream: true });
  } } finally { reader.releaseLock(); }
  try { return JSON.parse(body + decoder.decode()); } catch { throw unavailable(); }
}
export const inboxApi = {
  page: async (owner: string, cursor?: string, signal?: AbortSignal) => parseInboxPage(await request(owner, undefined, cursor, signal), owner),
  mutate: async (owner: string, input: InboxMutation, signal?: AbortSignal) => parseInboxMutation(await request(owner, input, undefined, signal), owner, input),
};
