import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveBusProgress } from './live-bus';

/** Five stops due north, a kilometre apart, timed five minutes apart. */
const stops = [
  { lat: 32.00, lon: 34.8, time: '2026-09-13T10:00:00+03:00' },
  { lat: 32.01, lon: 34.8, time: '2026-09-13T10:05:00+03:00' },
  { lat: 32.02, lon: 34.8, time: '2026-09-13T10:10:00+03:00' },
  { lat: 32.03, lon: 34.8, time: '2026-09-13T10:15:00+03:00' },
  { lat: 32.04, lon: 34.8, time: '2026-09-13T10:20:00+03:00' },
];
const EARLY = new Date('2026-09-13T09:00:00+03:00');

test('a bus two stops before the rider\'s stop is two stops away from it', () => {
  assert.deepEqual(
    liveBusProgress({ stops, boardingIndex: 3, alightingIndex: 4, bus: { lat: 32.01, lon: 34.8 }, now: EARLY }),
    { kind: 'toBoarding', stops: 2 },
  );
});

test('a bus at the rider\'s stop is zero stops away from it', () => {
  assert.deepEqual(
    liveBusProgress({ stops, boardingIndex: 3, alightingIndex: 4, bus: { lat: 32.0301, lon: 34.8 }, now: EARLY }),
    { kind: 'toBoarding', stops: 0 },
  );
});

test('once past the rider\'s stop, the bus counts down to where they get off', () => {
  assert.deepEqual(
    liveBusProgress({ stops, boardingIndex: 1, alightingIndex: 4, bus: { lat: 32.02, lon: 34.8 }, now: EARLY }),
    { kind: 'toAlighting', stops: 2 },
  );
});

test('a bus between two stops has not called at the one ahead of it', () => {
  // 32.027 is past the midpoint of the 32.02 -> 32.03 gap and ~333 m short of
  // 32.03, so it is the NEAREST stop but not one the bus has stopped at. Stops
  // 3 and 4 both remain. Counting from nearest alone answered 1 here, which at
  // the default one-stop lead is the get-off alarm sounding a stop early --
  // reported from the field as "the next stop is not my stop, there are 2 more".
  assert.deepEqual(
    liveBusProgress({ stops, boardingIndex: 1, alightingIndex: 4, bus: { lat: 32.027, lon: 34.8 }, now: EARLY }),
    { kind: 'toAlighting', stops: 2 },
  );
});

test('approaching the rider\'s own stop is not the same as reaching it', () => {
  // The same half-gap, before boarding rather than after it: the bus still has
  // to call at stop 3, which is the rider's.
  assert.deepEqual(
    liveBusProgress({ stops, boardingIndex: 3, alightingIndex: 4, bus: { lat: 32.027, lon: 34.8 }, now: EARLY }),
    { kind: 'toBoarding', stops: 1 },
  );
});

test('a bus past the rider\'s alighting stop says nothing about this journey', () => {
  assert.equal(
    liveBusProgress({ stops, boardingIndex: 0, alightingIndex: 2, bus: { lat: 32.04, lon: 34.8 }, now: EARLY }),
    null,
  );
});

test('without a live position there is nothing to count from', () => {
  assert.equal(liveBusProgress({ stops, boardingIndex: 3, alightingIndex: 4, bus: null, now: EARLY }), null);
});

test('a rider\'s stop the trip does not call at says nothing', () => {
  assert.equal(
    liveBusProgress({ stops, boardingIndex: -1, alightingIndex: 4, bus: { lat: 32.01, lon: 34.8 }, now: EARLY }),
    null,
  );
});
