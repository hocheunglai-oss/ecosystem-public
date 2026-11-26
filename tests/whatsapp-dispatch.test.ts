import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleWhatsAppDispatch } from '../server/whatsapp-dispatch/handler.ts';
import { ApiError } from '../server/auth/validation.ts';

const config = {
  origin: 'https://eco.fcuno.com', supabaseUrl: 'https://example.test', publishableKey: 'fixture',
  secretKey: 'fixture', rateLimitSecret: 'synthetic-only', secureCookies: true,
};
const host = 'eco.fcuno.com';
const url = 'https://' + host + '/api/enquiries/dispatcher';
const code = 'a'.repeat(43);
const job = {
  id: '90000000-0000-4000-8000-000000000001', claimToken: '90000000-0000-4000-8000-000000000002',
  groupName: 'Synthetic Pilot', reference: 'ECO-00000001', vessel: 'SYNTHETIC TRADER', imo: '9319466',
  eta: '20 OCT 2026', products: [{ grade: 'VLSFO', quantityText: '500-600' }],
  rmk: false, viscosity: ['120cst max'], formattedText: 'PRIVATE FORMAT', buyer: 'PRIVATE BUYER', rawText: 'PRIVATE SOURCE',
};
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { host, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function gateway(result: unknown = { routes: [] }) {
  const calls: { name: string; args: unknown }[] = [];
  return { calls, cookies: [], async authenticatedRpc<T>(name: string, args?: unknown): Promise<T> {
    calls.push({ name, args });
    if (result instanceof ApiError) throw result;
    return result as T;
  } };
}

test('route access uses the user session and connecting requires a live same-origin request', async () => {
  const account = gateway();
  const noWorker = async () => { throw new Error('Worker request not expected.'); };
  const response = await handleWhatsAppDispatch(new Request(url), config, account, noWorker);
  assert.deepEqual(await response.json(), { routes: [] });
  assert.equal(account.calls[0].name, 'eco_whatsapp_route');
  for (const headers of [
    { origin: 'https://other.example.test', 'x-eco-request': '1', 'x-eco-data-mode': 'live' },
    { origin: config.origin, 'x-eco-request': '1', 'x-eco-data-mode': 'test' },
    { host: 'preview.vercel.app', origin: config.origin, 'x-eco-request': '1', 'x-eco-data-mode': 'live' },
  ]) {
    const denied = await handleWhatsAppDispatch(post({ action: 'connect' }, headers), config, account, noWorker);
    assert.equal(denied.status, 403);
  }
  const live = { origin: config.origin, 'x-eco-request': '1', 'x-eco-data-mode': 'live' };
  const connected = await handleWhatsAppDispatch(post({ action: 'connect' }, live), config, account, noWorker);
  const { token } = await connected.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(account.calls[1], { name: 'eco_connect_whatsapp_dispatcher', args: { p_token_hash: createHash('sha256').update(token).digest('hex') } });
  assert.equal((await handleWhatsAppDispatch(post({ action: 'connect' }, live), config, gateway(new ApiError(403, 'Access denied.')), noWorker)).status, 403);
});

test('device claims project verified fields only and mark unusable exact-date jobs for review', async () => {
  const account = gateway();
  const auth = { authorization: 'Bearer ' + code };
  const result = await handleWhatsAppDispatch(post({ action: 'claim' }, auth), config, account, async args => {
    assert.deepEqual(args, { p_token_hash: createHash('sha256').update(code).digest('hex'), p_action: 'claim' });
    return { job };
  });
  assert.equal(result.status, 200);
  const { job: delivery } = await result.json();
  assert.deepEqual(Object.keys(delivery), ['id', 'claimToken', 'groupName', 'message']);
  assert.match(delivery.message, /ECO-00000001$/);
  assert.doesNotMatch(delivery.message, /PRIVATE/);
  assert.equal(account.calls.length, 0);
  const actions: string[] = [];
  const held = await handleWhatsAppDispatch(post({ action: 'claim' }, auth), config, account, async args => {
    actions.push(args.p_action);
    return args.p_action === 'claim' ? { job: { ...job, eta: '10/11' } } : { accepted: true };
  });
  assert.deepEqual(actions, ['claim', 'review']);
  assert.deepEqual(await held.json(), { job: null });
});
