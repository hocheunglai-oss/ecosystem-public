import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxApi, parseInboxPage, parseInboxMutation } from '../src/lib/inboxApi';
import { setPreviewReadOnly } from '../src/lib/previewGuard';
import { setWorkspaceDataMode } from '../src/lib/testWorkspaceGuard';
const owner = '10000000-0000-4000-8000-000000000001';
const item = { id: '20000000-0000-4000-8000-000000000001', providerMessageId: 'fixture-email-1', owner, channel: 'email', sender: 'trader@example.test', rawText: 'Vessel: FIXTURE ONE', receivedAt: '2026-10-15T01:02:03.000Z', read: false, dismissed: false };
const page = { items: [item], unreadCount: 80, nextCursor: 'opaque-token' };
test('LIVE inbox validates owner, fields, bounds and count without accepting server enquiry links', () => {
  assert.equal(parseInboxPage(page, owner).unreadCount, 80);
  assert.equal('enquiryId' in parseInboxPage({ ...page, items: [{ ...item, enquiryId: 'unverified' }] }, owner).items[0], false);
  for (const patch of [{ owner: 'someone-else' }, { rawText: 'x'.repeat(20001) }, { providerMessageId: 'x'.repeat(1025) }, { sender: 'x'.repeat(321) }, { receivedAt: 'bad' }, { read: 'false' }, { dismissed: undefined }, { subject: 'x'.repeat(1001) }, { id: 'not-uuid' }])
    assert.throws(() => parseInboxPage({ ...page, items: [{ ...item, ...patch }] }, owner));
  for (const patch of [{ items: [item, item] }, { items: Array(51).fill(item) }, { unreadCount: -1 }, { nextCursor: '' }]) assert.throws(() => parseInboxPage({ ...page, ...patch }, owner));
  assert.throws(() => parseInboxPage({ message: 'Vite HTML fallback' }, owner));
});
test('mutation receipt must match exact action, request and owned record', () => {
  const input = { action: 'read' as const, id: item.id, requestId: '30000000-0000-4000-8000-000000000001' };
  const result = { ...input, item: { ...item, read: true }, changedCount: 1, unreadCount: 79 };
  assert.equal(parseInboxMutation(result, owner, input).item?.read, true);
  for (const patch of [{ requestId: 'wrong' }, { action: 'dismiss' }, { item: null }, { item: { ...item, owner: 'wrong' } }, { changedCount: -1 }]) assert.throws(() => parseInboxMutation({ ...result, ...patch }, owner, input));
  assert.throws(() => parseInboxMutation({ ...result, action: 'dismiss-all' }, owner, { requestId: input.requestId, action: 'dismiss-all' }));
});
test('TEST and VIEW AS block even inbox reads before fetch; LIVE uses explicit mode and omits owner payload', async () => {
  const original = globalThis.fetch; const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json(page); };
  try {
    setWorkspaceDataMode('test'); await assert.rejects(inboxApi.page(owner), /Switch to LIVE/);
    setWorkspaceDataMode('live'); setPreviewReadOnly(true); await assert.rejects(inboxApi.page(owner), /PREVIEW/);
    assert.equal(calls.length, 0); setPreviewReadOnly(false);
    await inboxApi.page(owner, 'opaque|cursor'); assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.credentials, 'same-origin'); assert.equal(calls[0].options?.cache, 'no-store');
    assert.equal((calls[0].options?.headers as Record<string, string>)['X-Eco-Data-Mode'], 'live'); assert.equal(calls[0].options?.body, undefined);
    assert.ok(calls[0].url.endsWith('?limit=50&cursor=opaque%7Ccursor'));
    globalThis.fetch = async () => new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }); await assert.rejects(inboxApi.page(owner), /Inbox unavailable/);
    globalThis.fetch = async () => new Response('x'.repeat(4*1024*1024+1), { headers: { 'content-type': 'application/json' } }); await assert.rejects(inboxApi.page(owner), /Inbox unavailable/);
  } finally { globalThis.fetch = original; setPreviewReadOnly(false); setWorkspaceDataMode('live'); }
});
