import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIntelligenceSnapshot } from '../src/lib/intelligenceApi';
import { syntheticIntelligence } from './fixtures/intelligence.mjs';

test('reference requests require same-origin credentials and never cache or fall back to bundled data', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/intelligence/snapshot');
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(init?.cache, 'no-store');
      assert.ok(init?.signal);
      return Response.json({ available: true, snapshot: syntheticIntelligence() });
    };
    const result = await loadIntelligenceSnapshot();
    assert.equal(result.available, true);
    assert.equal(result.snapshot?.suppliers[0].id, 'synthetic-supplier-1');
    for (const status of [401, 403, 503]) {
      globalThis.fetch = async () => Response.json({ message: 'Unavailable' }, { status });
      await assert.rejects(loadIntelligenceSnapshot(), /Fixture data unavailable/);
    }
    for (const value of [{}, { available: true, snapshot: null }, { available: true, snapshot: { ...syntheticIntelligence(), suppliers: [{ id: 'bad' }] } }]) {
      globalThis.fetch = async () => Response.json(value);
      await assert.rejects(loadIntelligenceSnapshot(), /Fixture data unavailable/);
    }
    globalThis.fetch = async () => Response.json({ available: false, snapshot: null });
    assert.deepEqual(await loadIntelligenceSnapshot(), { available: false, snapshot: null });
  } finally { globalThis.fetch = original; }
});
