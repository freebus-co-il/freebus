import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JourneyPhase, JourneyState, RiderPosition } from '../types';
import { itin, ms, ride, stop, t, walk } from './fixtures';
import { replanOriginFor, spliceItinerary } from './splice';

const HOME = stop('home', 0);
const A = stop('a', 300);
const B = stop('b', 2000);
const C = stop('c', 5000);
const DEST = stop('dest', 5200);

const current = itin([
  walk(HOME, A),
  ride({ line: '125', from: A, to: B, dep: 10, arr: 30 }),
  ride({ line: '605', from: B, to: C, dep: 35, arr: 55 }),
  walk(C, DEST),
], 5, 60);

const remainder = itin([
  ride({ line: '189', from: B, to: C, dep: 33, arr: 50 }),
  walk(C, DEST),
], 33, 55);

test('keeps done legs and the current ride, appends the replacement', () => {
  const spliced = spliceItinerary(current, 1, remainder);
  assert.equal(spliced.legs.length, 4);
  assert.equal(spliced.legs[1], current.legs[1]);
  assert.equal(spliced.legs[2], remainder.legs[0]);
  assert.equal(spliced.departureTime, current.departureTime);
});

test('recomputes transfers and arrival', () => {
  const spliced = spliceItinerary(current, 1, remainder);
  assert.equal(spliced.arrivalTime, t(55));
  assert.equal(spliced.transfers, 1);
  assert.equal(spliced.durationSeconds, 50 * 60);
  assert.equal(spliced.walkSeconds, 600);
});

test('keepThroughLegIndex -1 replaces everything and takes the replacement\'s departure', () => {
  const spliced = spliceItinerary(current, -1, remainder);
  assert.deepEqual(spliced.legs, remainder.legs);
  assert.equal(spliced.departureTime, remainder.departureTime);
  assert.equal(spliced.transfers, 0);
});

function state(phase: JourneyPhase, legIndex: number): JourneyState {
  const leg = current.legs[legIndex];
  return {
    phase, legIndex, leg: leg?.type === 'transit' ? leg : null, stopsRemaining: null, timer: null, offPlan: null,
    progress: 0.3, timeSource: 'scheduled', busStopsAway: null, stopsSource: null, nextStopName: null,
    arrivalTime: t(60), trackedLegIndex: null, boardedLegIndex: null, ridingEarly: false,
  };
}
const fix = (iso: string, accuracyMeters = 10): RiderPosition => ({ lat: 32.001, lon: 34.8, accuracyMeters, at: iso });

test('riding origin is the alighting stop at the live arrival', () => {
  const live = { ...current, legs: current.legs.map((leg, i) => (i === 1 && leg.type === 'transit'
    ? { ...leg, realtime: { predictedDeparture: null, predictedArrival: t(33), delaySeconds: 180, vehicleRef: null, confidence: null, recordedAt: null } }
    : leg)) };
  assert.deepEqual(replanOriginFor(state('riding', 1), live, fix(t(20)), ms(20)), { from: 'stop:b', departAfter: t(33), keepThroughLegIndex: 1 });
});

test('waiting keeps the ride waited for and plans on from its alighting stop', () => {
  // At the station the run is the station board's to follow, never the
  // planner's to swap.
  assert.deepEqual(replanOriginFor(state('waiting', 1), current, fix(t(8)), ms(8)), {
    from: 'stop:b', departAfter: t(30), keepThroughLegIndex: 1,
  });
});

test('no origin once arriving', () => {
  assert.equal(replanOriginFor(state('arriving', 3), current, fix(t(56)), ms(56)), null);
});

test('walking without a usable fix plans from the stop at when the walk gets there', () => {
  assert.deepEqual(replanOriginFor(state('walking-to-stop', 0), current, null, ms(2)), {
    from: 'stop:a', departAfter: t(7), keepThroughLegIndex: -1,
  });
});
