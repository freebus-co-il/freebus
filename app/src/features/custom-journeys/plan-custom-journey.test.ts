import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary, Leg, PlanQuery, TransitLeg, WalkLeg } from '@/api/types';

import { mergeWalks, planCustomJourney, startFor, StepUnplannableError, stitch, type Fetchers } from './plan-custom-journey';
import { reversedPoints, type JourneyPoint } from './types';

const NOW = Date.parse('2026-11-02T06:00:00.000Z');

const HOME: JourneyPoint = { id: 'home', via: 'any', place: { kind: 'coordinate', lat: 32.47, lon: 34.97, label: 'Home' } };
const BINYAMINA: JourneyPoint = { id: 'bin', via: 'bus', place: { kind: 'stop', stopId: 'rail-bin', name: 'Binyamina', lat: 32.52, lon: 34.95 } };
const HASHALOM: JourneyPoint = { id: 'sha', via: 'train', place: { kind: 'stop', stopId: 'rail-sha', name: 'HaShalom', lat: 32.073, lon: 34.793 } };
const WORK: JourneyPoint = { id: 'work', via: 'walk', place: { kind: 'coordinate', lat: 32.075, lon: 34.796, label: 'Work' } };

function walk(fromLat: number, toLat: number, seconds: number): WalkLeg {
  return {
    type: 'walk',
    from: { type: 'coordinate', lat: fromLat, lon: 34.9 },
    to: { type: 'coordinate', lat: toLat, lon: 34.9 },
    distanceMeters: seconds,
    durationSeconds: seconds,
    geometry: 'abc',
    walkEstimated: false,
  };
}

function ride(tripId: string, routeType: number, departs: string, arrives: string): TransitLeg {
  return {
    type: 'transit',
    route: { id: tripId, agencyId: '1', shortName: tripId, longName: '', type: routeType, color: null },
    tripId,
    headsign: '',
    directionId: 0,
    from: { stop: { type: 'stop', lat: 32.5, lon: 34.9, stopId: `${tripId}-a` }, departureTime: departs, stopSequence: 1 },
    to: { stop: { type: 'stop', lat: 32.1, lon: 34.8, stopId: `${tripId}-b` }, arrivalTime: arrives, stopSequence: 5 },
    numStops: 4,
    intermediateStops: [],
    geometry: null,
    geometryFallback: true,
    realtime: null,
  };
}

function itinerary(legs: Leg[], departs: string, arrives: string): Itinerary {
  return {
    departureTime: departs, arrivalTime: arrives, durationSeconds: 0, transfers: 0,
    walkSeconds: 0, walkMeters: 0, legs, transferAtRisk: false,
  };
}

test('back-to-back walks around a pinned place become one estimated walk', () => {
  const legs = mergeWalks([walk(1, 2, 60), walk(2, 3, 120), ride('r', 3, '2026-11-02T06:10:00Z', '2026-11-02T06:20:00Z')]);
  assert.equal(legs.length, 2);
  const first = legs[0] as WalkLeg;
  assert.equal(first.durationSeconds, 180);
  assert.equal(first.from.lat, 1);
  assert.equal(first.to.lat, 3);
  assert.equal(first.geometry, null);
  assert.equal(first.walkEstimated, true);
});

test('a walk of nothing is dropped', () => {
  assert.equal(mergeWalks([walk(1, 1, 0), ride('r', 3, 'a', 'b')]).length, 1);
});

test('stitch totals the joined steps', () => {
  const itin = stitch([
    { legs: [walk(1, 2, 60), ride('bus', 3, '2026-11-02T06:05:00Z', '2026-11-02T06:20:00Z')], departureMs: NOW, arrivalMs: Date.parse('2026-11-02T06:20:00Z'), atRisk: false },
    { legs: [ride('train', 2, '2026-11-02T06:25:00Z', '2026-11-02T07:10:00Z')], departureMs: 0, arrivalMs: Date.parse('2026-11-02T07:10:00Z'), atRisk: false },
  ]);
  assert.equal(itin.transfers, 1);
  assert.equal(itin.walkSeconds, 60);
  assert.equal(itin.departureTime, new Date(NOW).toISOString());
  assert.equal(itin.arrivalTime, '2026-11-02T07:10:00.000Z');
  assert.equal(itin.durationSeconds, 70 * 60);
  assert.equal(itin.transferAtRisk, false);
});

test('a rider at a later point starts the journey there', () => {
  assert.deepEqual(startFor([HOME, BINYAMINA, HASHALOM, WORK], { lat: 32.5201, lon: 34.9501 }), { index: 1, fromFix: true });
});

test('a rider near the first point starts from their fix', () => {
  assert.deepEqual(startFor([HOME, BINYAMINA, WORK], { lat: 32.471, lon: 34.971 }), { index: 0, fromFix: true });
});

test('a rider far from every point starts from the first point', () => {
  assert.deepEqual(startFor([HOME, BINYAMINA, WORK], { lat: 31.0, lon: 35.0 }), { index: 0, fromFix: false });
  assert.deepEqual(startFor([HOME, BINYAMINA, WORK], null), { index: 0, fromFix: false });
});

test('standing at the last point does not start the journey at its end', () => {
  assert.deepEqual(startFor([HOME, BINYAMINA, WORK], { lat: 32.075, lon: 34.796 }), { index: 0, fromFix: false });
});

test('each step is planned from the last, no earlier than it arrives, by the mode asked for', async () => {
  const asked: (PlanQuery & { results: number })[] = [];
  const fetchers: Fetchers = {
    plan: async (query) => {
      asked.push(query);
      if (query.to === 'stop:rail-bin') {
        return { query, itineraries: [itinerary([walk(1, 2, 120), ride('bus', 3, '2026-11-02T06:10:00Z', '2026-11-02T06:25:00Z')], '2026-11-02T06:08:00Z', '2026-11-02T06:25:00Z')] };
      }
      return {
        query,
        itineraries: [
          itinerary([ride('slow', 2, '2026-11-02T06:30:00Z', '2026-11-02T07:20:00Z')], '2026-11-02T06:30:00Z', '2026-11-02T07:20:00Z'),
          itinerary([ride('fast', 2, '2026-11-02T06:35:00Z', '2026-11-02T07:10:00Z')], '2026-11-02T06:35:00Z', '2026-11-02T07:10:00Z'),
        ],
      };
    },
    walk: async () => ({ distanceMeters: 300, durationSeconds: 240, geometry: 'xyz', steps: [], estimated: false }),
  };

  const planned = await planCustomJourney({ points: [HOME, BINYAMINA, HASHALOM, WORK], position: null, nowMs: NOW, lang: 'he', fetchers });

  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.from, '32.47,34.97');
  assert.equal(asked[0]!.modes, '3,11,715');
  assert.equal(asked[0]!.departAfter, new Date(NOW).toISOString());
  assert.equal(asked[1]!.from, 'stop:rail-bin');
  assert.equal(asked[1]!.to, 'stop:rail-sha');
  assert.equal(asked[1]!.modes, '0,1,2,12');
  assert.equal(asked[1]!.departAfter, '2026-11-02T06:25:00.000Z');

  const kinds = planned.itinerary.legs.map((leg) => (leg.type === 'transit' ? leg.tripId : 'walk'));
  // The soonest train, then the walk to work.
  assert.deepEqual(kinds, ['walk', 'bus', 'fast', 'walk']);
  const lastWalk = planned.itinerary.legs[3] as WalkLeg;
  assert.equal(lastWalk.durationSeconds, 240);
  assert.equal(lastWalk.geometry, 'xyz');
  assert.equal(planned.itinerary.arrivalTime, new Date(Date.parse('2026-11-02T07:10:00Z') + 240_000).toISOString());
  assert.equal(planned.destinationLabel, 'Work');
});

test('a step nothing makes names the point it could not reach', async () => {
  const fetchers: Fetchers = {
    plan: async (query) => (query.to === 'stop:rail-sha' ? { query, itineraries: [] } : {
      query,
      itineraries: [itinerary([ride('bus', 3, '2026-11-02T06:10:00Z', '2026-11-02T06:25:00Z')], '2026-11-02T06:10:00Z', '2026-11-02T06:25:00Z')],
    }),
    walk: async () => ({ distanceMeters: 1, durationSeconds: 1, geometry: null, steps: [], estimated: true }),
  };
  await assert.rejects(
    planCustomJourney({ points: [HOME, BINYAMINA, HASHALOM, WORK], position: null, nowMs: NOW, lang: 'he', fetchers }),
    (error: unknown) => error instanceof StepUnplannableError && error.pointIndex === 2,
  );
});

test('a walk the street router cannot draw is estimated', async () => {
  const fetchers: Fetchers = {
    plan: async () => { throw new Error('unused'); },
    walk: async () => { throw new Error('offline'); },
  };
  const planned = await planCustomJourney({ points: [{ ...HASHALOM, via: 'any' }, WORK], position: null, nowMs: NOW, lang: 'he', fetchers });
  const leg = planned.itinerary.legs[0] as WalkLeg;
  assert.equal(leg.walkEstimated, true);
  assert.ok(leg.durationSeconds > 0);
});

test('the way back reverses the points and keeps how each step is made', () => {
  const back = reversedPoints([HOME, BINYAMINA, HASHALOM, WORK]);
  assert.deepEqual(back.map((point) => point.place), [WORK.place, HASHALOM.place, BINYAMINA.place, HOME.place]);
  assert.deepEqual(back.map((point) => point.via), ['any', 'walk', 'train', 'bus']);
});
