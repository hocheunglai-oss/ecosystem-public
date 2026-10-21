import assert from 'node:assert/strict';

// Unrelated UI suites use an empty durable inbox; no local fallback or writes.
export async function installEmptyLiveInbox(context) {
  await context.route('**/api/enquiries/inbox*', route => {
    const request = route.request();
    assert.equal(new URL(request.url()).pathname, '/api/enquiries/inbox');
    assert.equal(request.method(), 'GET');
    assert.equal(request.headers()['x-eco-data-mode'], 'live');
    return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
  });
}
