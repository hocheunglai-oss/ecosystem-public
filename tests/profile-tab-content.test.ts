import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeProfileTabContent, encodeProfileTabContent, PROFILE_CONTENT_PREFIX, profileTabDocument } from '../src/lib/profileTabContent.ts';
import { profileTabsSave } from '../server/profile-tabs/validation.ts';

test('legacy text and malformed or future structured text remain intact', () => {
  for (const value of ['Legacy\nOWNER note', PROFILE_CONTENT_PREFIX + '{broken', PROFILE_CONTENT_PREFIX + '{"version":2,"blocks":[]}', PROFILE_CONTENT_PREFIX + '{"version":1,"blocks":[{"type":"file","url":"https://example.test"}]}']) {
    assert.deepEqual(decodeProfileTabContent(value, 'MY NOTES'), [{ id: 'legacy-text', title: 'MY NOTES', type: 'text', text: value }]);
  }
  assert.deepEqual(decodeProfileTabContent('', 'EMPTY'), []);
  assert.equal(profileTabDocument({ id: 'tab', title: 'OLD', content: 'Legacy' }).sections[0].blocks[0].id, 'legacy-text');
});
test('text and table structures round-trip through the existing bounded API contract', () => {
  const blocks = [
    { id: 'text1', title: 'NOTES', type: 'text' as const, text: 'Owner only\nKeep case@example.test' },
    { id: 'table1', title: 'PRICES', type: 'table' as const, columns: [{ id: 'col1', name: 'GRADE', width: 220 }, { id: 'col2', name: 'VALUE' }], rows: [{ id: 'row1', cells: ['VLSFO', '500'] }] },
  ];
  const content = encodeProfileTabContent(blocks);
  assert.deepEqual(decodeProfileTabContent(content, 'TAB'), blocks);
  const uuid = '11111111-1111-4111-8111-111111111111';
  assert.equal(profileTabsSave({ requestId: uuid, target: { kind: 'port', id: 'port-singapore' }, visibility: 'private', revision: 0, tabs: [{ id: uuid, title: 'TAB', visibility: 'private', content }] }).tabs[0].content, content);
});
test('structured content rejects invalid rows, IDs, metadata, dimensions and oversized transport', () => {
  const table = { id: 't', title: 'TABLE', type: 'table' as const, columns: [{ id: 'c', name: 'ONE' }], rows: [{ id: 'r', cells: ['ONE'] }] };
  for (const value of [
    [{ ...table, rows: [{ id: 'r', cells: ['ONE', 'TWO'] }] }],
    [{ ...table, columns: [{ id: 'c', name: 'ONE', width: 99 }] }],
    [{ ...table, rows: [{ id: 'c', cells: ['ONE'] }] }],
    [{ ...table, ownerId: 'another-owner' }],
    [{ id: 'text', title: 'TEXT', type: 'text', text: 'x'.repeat(20_000) }],
  ]) assert.throws(() => encodeProfileTabContent(value as never));
  assert.deepEqual(decodeProfileTabContent(encodeProfileTabContent([]), 'EMPTY'), []);
});
