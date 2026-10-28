import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary, TransitLeg, WalkLeg } from './types';
import { journeyCheckPath, legsToCheck } from './journey-check';

function ride(tripId: string, from: string | undefined, to: string): TransitLeg {
  return {
    type: 'transit',
    route: { id: 'r', agencyId: '3', shortName: '480', longName: '', type: 3, color: null },
    tripId,
    headsign: 'Bat Yam',
    directionId: 0,
    from: { stop: { type: 'stop', lat: 32, lon: 34, stopId: from, name: 'A' }, departureTime: '2026-08-31T10:10:00.000Z', stopSequence: 1 },
    to: { stop: { type: 'stop', lat: 32.1, lon: 34.1, stopId: to, name: 'B' }, arrivalTime: '2026-08-31T10:30:00.000Z', stopSequence: 4 },
    numStops: 3,
    intermediateStops: [],
    geometry: null,
    geometryFallback: false,
    realtime: null,
  };
}

const walk: WalkLeg = {
  type: 'walk',
  from: { type: 'coordinate', lat: 32, lon: 34 },
  to: { type: 'stop', lat: 32, lon: 34, name: 'A' },
  distanceMeters: 100,
  durationSeconds: 60,
  geometry: null,
  walkEstimated: false,
};

function itinerary(legs: Itinerary['legs']): Itinerary {
  return {
    departureTime: '2026-08-31T10:00:00.000Z',
    arrivalTime: '2026-08-31T11:00:00.000Z',
    durationSeconds: 3600,
    transfers: 1,
    walkSeconds: 60,
    walkMeters: 100,
    transferAtRisk: null,
    legs,
  };
}

test('checks the transit legs from the given leg on, skipping walks', () => {
  const plan = itinerary([walk, ride('t1', 's1', 's2'), walk, ride('t2', 's3', 's4')]);
  assert.deepEqual(legsToCheck(plan, 0).map((c) => c.legIndex), [1, 3]);
  assert.deepEqual(legsToCheck(plan, 2).map((c) => c.legIndex), [3]);
});

test('stops at the first leg the server could not resolve, so connection indexes stay contiguous', () => {
  const plan = itinerary([ride('t1', 's1', 's2'), ride('t2', undefined, 's4'), ride('t3', 's5', 's6')]);
  assert.deepEqual(legsToCheck(plan, 0).map((c) => c.legIndex), [0]);
});

test('the path repeats leg in journey order and encodes each triple', () => {
  const plan = itinerary([ride('t1', 's1', 's2'), ride('t2', 's3', 's4')]);
  assert.equal(
    journeyCheckPath(legsToCheck(plan, 0), 'he'),
    '/journey/check?leg=t1%2Cs1%2Cs2&leg=t2%2Cs3%2Cs4&lang=he',
  );
});
