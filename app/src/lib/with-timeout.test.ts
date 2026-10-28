import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TIMED_OUT, withTimeout } from './with-timeout';

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// The deadline here is far longer than the test run: if the pending timer is
// not cleared once the promise wins, the Node process stays alive waiting on
// it and `npm test` visibly hangs. Winning fast is only half the contract.
test('a promise that settles before the deadline resolves with its value', async () => {
  assert.equal(await withTimeout(Promise.resolve('fix'), 10_000), 'fix');
});

test('a promise slower than the deadline resolves with TIMED_OUT', async () => {
  assert.equal(await withTimeout(resolveAfter(50, 'fix'), 10), TIMED_OUT);
});

// The caller has already been told the location is unavailable and may have
// started picking an origin by hand -- a fix landing late must not be able to
// reach back and change what it was told.
test('a fix arriving after the deadline does not change the settled result', async () => {
  const slow = resolveAfter(30, 'late fix');

  assert.equal(await withTimeout(slow, 10), TIMED_OUT);

  // Let the underlying promise land, then confirm the verdict still stands.
  await slow;
  assert.equal(await withTimeout(slow, 10_000), 'late fix');
});

test('a rejection before the deadline propagates to the caller', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('no provider')), 10_000),
    /no provider/,
  );
});
