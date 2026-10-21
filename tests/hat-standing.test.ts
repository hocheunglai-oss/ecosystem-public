import test from 'node:test';
import assert from 'node:assert/strict';
import { hatStanding } from '../src/lib/hatStanding';

test('one Hat enters a ranking without promising first place', () => {
  assert.deepEqual(hatStanding([{ actorId: 'leader', count: 8 }], 'new-user'), {
    count: 0, rank: null, tied: false, next: { count: 1, needed: 1, rank: 2, kind: 'enter' },
  });
  assert.equal(hatStanding([], 'new-user').next?.rank, 1);
});

test('next-rank progress passes the closest higher total, including shared ranks', () => {
  const ranking = [{ actorId: 'first', count: 10 }, { actorId: 'second', count: 8 },
    { actorId: 'third', count: 8 }, { actorId: 'me', count: 5 }, { actorId: 'peer', count: 5 }];
  assert.deepEqual(hatStanding(ranking, 'me'), {
    count: 5, rank: 4, tied: true, next: { count: 9, needed: 4, rank: 2, kind: 'advance' },
  });
});

test('tied leaders need one more Hat to lead outright; sole leaders have no invented target', () => {
  assert.deepEqual(hatStanding([{ actorId: 'me', count: 5 }, { actorId: 'peer', count: 5 }], 'me'), {
    count: 5, rank: 1, tied: true, next: { count: 6, needed: 1, rank: 1, kind: 'lead' },
  });
  assert.deepEqual(hatStanding([{ actorId: 'me', count: 5 }, { actorId: 'peer', count: 4 }], 'me'), {
    count: 5, rank: 1, tied: false, next: null,
  });
});
