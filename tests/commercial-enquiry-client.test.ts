import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commercialDetail, commercialPage, commercialEnquiryApi } from '../src/lib/commercialEnquiryApi.ts';
import { assertLocalCommercialAction } from '../src/lib/commercialLocalGuard.ts';
import { setPreviewReadOnly } from '../src/lib/previewGuard.ts';
import { setWorkspaceDataMode } from '../src/lib/testWorkspaceGuard.ts';
const owner = '10000000-0000-4000-8000-000000000001';
const row = { id: '20000000-0000-4000-8000-000000000001', reference: 'ECO-1', ownerId: owner, ownerName: 'Fixture',
  revision: 1, status: 'draft', vessel: 'FIXTURE', imo: '', eta: '', products: [], port: null, queue: null,
  createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', confirmedAt: null,
  source: { rawText: 'Synthetic', parsed: null, parserVersion: null, inboxId: null },
  reviewed: { vessel: 'FIXTURE', imo: '', eta: '', portId: null, buyerId: null, buyerText: null,
    products: [], remarks: '', rmk: false, viscosity: [], warnings: [], formattedText: '' } };
test('commercial list projections discard source/private fields; own detail fails closed on another owner', () => {
  const page = commercialPage({ items: [row], nextCursor: null });
  assert.equal('source' in page.items[0], false); assert.equal('reviewed' in page.items[0], false);
  assert.throws(() => commercialPage({ items: [row], nextCursor: null }, 'another-owner'));
  assert.throws(() => commercialDetail(row, 'another-owner'));
  assert.deepEqual(commercialDetail(row, owner).source, row.source);
});
test('LIVE legacy commercial actions cannot save, confirm or change outcomes while TEST is retained', () => {
  for (const type of ['confirm-enquiry', 'send-enquiry', 'amend-enquiry', 'postpone-enquiry', 'cancel-enquiry'] as const) {
    assert.throws(() => assertLocalCommercialAction({ type, id: row.id }, 'live'), /shared enquiry/);
    assert.doesNotThrow(() => assertLocalCommercialAction({ type, id: row.id }, 'test'));
  }
  assert.throws(() => assertLocalCommercialAction({ type: 'record-actual-volume', id: row.id, quantity: 20 }, 'live'));
  assert.doesNotThrow(() => assertLocalCommercialAction({ type: 'save-buyer-private-list', buyerId: 'synthetic-buyer', entries: [], baseEntries: [] }, 'live'));
});
test('commercial API blocks LIVE reads before fetch in TEST and VIEW AS', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Fetch must not run'); };
  try {
    setWorkspaceDataMode('test');
    await assert.rejects(commercialEnquiryApi.page(owner, 'mine'), /Switch to LIVE/);
    setWorkspaceDataMode('live'); setPreviewReadOnly(true);
    await assert.rejects(commercialEnquiryApi.detail(owner, row.id), /READ ONLY/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; setWorkspaceDataMode('live'); setPreviewReadOnly(false); }
});
