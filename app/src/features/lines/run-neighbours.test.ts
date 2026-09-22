import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runNeighbours } from './run-neighbours';

const runs = [{ tripId: 'a' }, { tripId: 'b' }, { tripId: 'c' }, { tripId: 'd' }];

test('a run\'s neighbours are the run ahead of it and the run behind it, in order', () => {
  assert.deepEqual(runNeighbours(runs, 'b'), ['a', 'b', 'c']);
});

test('the first run has nothing ahead, the last nothing behind', () => {
  assert.deepEqual(runNeighbours(runs, 'a'), ['a', 'b']);
  assert.deepEqual(runNeighbours(runs, 'd'), ['c', 'd']);
});

/** The rider's run is still worth drawing when the list does not name it --
 *  a board entry whose run the around-query could not place. */
test('a run missing from the list is drawn alone', () => {
  assert.deepEqual(runNeighbours(runs, 'zz'), ['zz']);
});

test('no run selected draws nothing', () => {
  assert.deepEqual(runNeighbours(runs, null), []);
});
