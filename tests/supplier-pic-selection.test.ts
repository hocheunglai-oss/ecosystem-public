import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierPicChoices, isSelectableSupplierPic } from '../src/lib/supplierPicSelection';
import { createAuthGateway } from '../server/auth/gateway';
import type { AuthConfig } from '../server/auth/config';

test('PIC choices preserve a legacy current value disabled and permit only server roster names or unassigned', () => {
  assert.deepEqual(supplierPicChoices(['SPC B', 'SPC A', 'SPC A'], 'OLD ADMIN'), [
    { value: '', label: 'UNASSIGNED', disabled: false },
    { value: 'OLD ADMIN', label: 'OLD ADMIN', disabled: true },
    { value: 'SPC A', label: 'SPC A', disabled: false },
    { value: 'SPC B', label: 'SPC B', disabled: false },
  ]);
  assert.equal(isSelectableSupplierPic('OLD ADMIN', ['SPC A']), false);
  assert.equal(isSelectableSupplierPic('ORDINARY', ['SPC A']), false);
  assert.equal(isSelectableSupplierPic('SPC A', ['SPC A']), true);
  assert.equal(isSelectableSupplierPic('', ['SPC A']), true);
  assert.deepEqual(supplierPicChoices([], 'OLD ADMIN').filter(choice => !choice.disabled).map(choice => choice.value), ['']);
  assert.equal(supplierPicChoices(['SPC A'], 'SPC A').filter(choice => choice.value === 'SPC A').length, 1);
});

test('the real API adapter returns a safe actionable PIC eligibility error', async () => {
  const config: AuthConfig = { origin: 'https://eco.example.test', supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'fixture-publishable',
    secretKey: 'fixture-server-only', rateLimitSecret: 'fixture-limiter-at-least-32-characters', secureCookies: true };
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 'PT422', message: 'PRIVATE DATABASE DETAILS' }, { status: 422 });
  try {
    const gateway = createAuthGateway(new Request(config.origin), config);
    for (const rpc of ['eco_create_supplier', 'eco_update_supplier']) {
      await assert.rejects(gateway.authenticatedRpc(rpc, { p_input: {} }), (error: unknown) => {
        assert.equal((error as { status: number }).status, 422);
        assert.equal((error as Error).message, 'Select an active SPC trader.'); return true;
      });
    }
  } finally { globalThis.fetch = original; }
});
