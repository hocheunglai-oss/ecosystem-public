import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error local operator verification module
import { matchesDraftSave } from '../scripts/verify-commercial-enquiries-cloud.mjs';

const expected = { base: 'https://synthetic-stage.vercel.app', rawText: 'VESSEL: SYNTHETIC VERIFIER\nPORT: SINGAPORE', vessel: 'SYNTHETIC VERIFIER' };
const body = () => ({ dataMode: 'live', action: 'save', source: { rawText: expected.rawText }, reviewed: { vessel: expected.vessel } });
function response(input: unknown = body(), method = 'POST', url = expected.base + '/api/enquiries/records', status = 200) {
  return { url: () => url, status: () => status, request: () => ({ method: () => method, postDataJSON: () => input }) };
}

test('save barrier identifies the exact live draft request, not earlier reads, confirmations or another enquiry', () => {
  assert.equal(matchesDraftSave(response(), expected), true);
  for (const unrelated of [
    response(body(), 'GET'), response(body(), 'POST', 'https://another-stage.vercel.app/api/enquiries/records'),
    response(body(), 'POST', expected.base + '/api/enquiries/records?scope=mine'),
    response({ ...body(), action: 'confirm' }), response({ ...body(), dataMode: 'test' }),
    response({ ...body(), source: { rawText: 'A DIFFERENT ENQUIRY' } }),
    response({ ...body(), reviewed: { vessel: 'ANOTHER VESSEL' } }), response(null), response({}),
    { url: () => expected.base + '/api/enquiries/records', request: () => ({ method: () => 'POST', postDataJSON: () => { throw new Error('Not JSON'); } }) },
  ]) assert.equal(matchesDraftSave(unrelated, expected), false);
});

test('matching failed save responses are observed so the existing HTTP assertion fails instead of waiting for a later success', () => {
  for (const status of [400, 401, 403, 409, 500, 503]) assert.equal(matchesDraftSave(response(body(), 'POST', expected.base + '/api/enquiries/records', status), expected), true);
});
