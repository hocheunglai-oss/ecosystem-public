import test from 'node:test';
import assert from 'node:assert/strict';
import { accessRequest } from '../src/auth';
import { setWorkspaceDataMode } from '../src/lib/testWorkspaceGuard';
import { setPreviewReadOnly } from '../src/lib/previewGuard';

async function withFetch(work: (calls: { url: string; method: string }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try { await work(calls); }
  finally { globalThis.fetch = original; setWorkspaceDataMode('live'); setPreviewReadOnly(false); }
}

test('TEST blocks real user administration and phone changes before fetch with a definite rejection', async () => {
  await withFetch(async calls => {
    setWorkspaceDataMode('test');
    for (const [path, body] of [
      ['users/create', {}], ['users', {}], ['users/delete', {}], ['users/reset-password', {}],
      ['phone-requests', {}], ['phone-requests/review', { decision: 'approve' }],
      ['phone-requests/review', { decision: 'decline' }], ['future-business-mutation', {}],
    ] as const) {
      await assert.rejects(accessRequest(path, body), (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, /Switch to LIVE/);
        assert.equal((error as Error & { status: number }).status, 403); return true;
      });
    }
    assert.deepEqual(calls, []);
  });
});

test('TEST retains identity controls and authorized read requests; returning LIVE restores normal API dispatch', async () => {
  await withFetch(async calls => {
    setWorkspaceDataMode('test');
    for (const path of ['login', 'activate', 'password', 'password-prompt', 'logout', 'preview', 'preview/end']) {
      await accessRequest(path, {});
    }
    for (const path of ['users', 'phone-requests', 'session', 'preview/options']) await accessRequest(path);
    assert.equal(calls.length, 11); assert.equal(calls.filter(call => call.method === 'GET').length, 4);
    setWorkspaceDataMode('live');
    for (const path of ['users/create', 'users', 'users/delete', 'users/reset-password', 'phone-requests', 'phone-requests/review']) await accessRequest(path, {});
    assert.equal(calls.length, 17);
  });
});

test('TEST never overrides VIEW AS read-only protection for identity or business changes', async () => {
  await withFetch(async calls => {
    setWorkspaceDataMode('test'); setPreviewReadOnly(true);
    for (const path of ['password', 'password-prompt', 'users', 'phone-requests']) {
      await assert.rejects(accessRequest(path, {}), /PREVIEW IS READ ONLY/);
    }
    assert.deepEqual(calls, []);
    for (const path of ['preview', 'preview/end', 'logout']) await accessRequest(path, {});
    assert.equal(calls.length, 3);
  });
});
