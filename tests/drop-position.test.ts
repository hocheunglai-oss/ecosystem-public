import test from 'node:test';
import assert from 'node:assert/strict';
import { dropDestination, dropEdge } from '../src/lib/dropPosition';

test('visible before/after boundaries match resulting order in both drag directions and at ends', () => {
  const examples = [
    { from: 0, target: 2, edge: 'before' as const, expected: ['B','A','C','D'] },
    { from: 0, target: 2, edge: 'after' as const, expected: ['B','C','A','D'] },
    { from: 3, target: 1, edge: 'before' as const, expected: ['A','D','B','C'] },
    { from: 3, target: 1, edge: 'after' as const, expected: ['A','B','D','C'] },
    { from: 3, target: 0, edge: 'before' as const, expected: ['D','A','B','C'] },
    { from: 0, target: 3, edge: 'after' as const, expected: ['B','C','D','A'] },
    { from: 1, target: 1, edge: 'before' as const, expected: ['A','B','C','D'] },
    { from: 1, target: 1, edge: 'after' as const, expected: ['A','B','C','D'] },
  ];
  for (const { from,target,edge,expected } of examples) {
    const items = ['A','B','C','D'];
    const [item] = items.splice(from,1); items.splice(dropDestination(from,target,edge),0,item);
    assert.deepEqual(items,expected);
  }
  assert.equal(dropEdge(109,100,20),'before');
  assert.equal(dropEdge(110,100,20),'after');
});
