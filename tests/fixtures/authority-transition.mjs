import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Model an account/permission change from another tab. Focus deliberately reuses
// an in-flight session check, so it cannot stand in for authority invalidation.
// Callers retain their rendered-state/privacy assertions after this response gate.
export async function invalidateFixtureAuthority(page, session) {
  const expected = JSON.parse(JSON.stringify(session));
  const response = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== '/api/access/session') return false;
    if (!expected.user) return response.status() === 401;
    if (response.status() !== 200) return false;
    const actual = await response.json().catch(() => null);
    return isDeepStrictEqual(actual?.user, expected.user) && isDeepStrictEqual(actual?.preview, expected.preview);
  });
  await page.evaluate(() => {
    const channel = new BroadcastChannel('eco-access-invalidation');
    channel.postMessage('refresh-needed');
    channel.close();
  });
  assert.equal(await (await response).finished(), null);
}
