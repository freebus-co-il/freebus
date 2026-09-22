import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary, LiveVehicle, TransitLeg, WalkLeg } from '@/api/types';
import { operatorColor } from '@/constants/operator-colors';
import { UNKNOWN_OPERATOR_COLOR } from '@/lib/route-color';

import { lineVehicleMarkers, vehicleMarkers } from './vehicle-markers';

function walkLeg(): WalkLeg {
  return {
    type: 'walk',
    from: { type: 'coordinate', lat: 32.06, lon: 34.77 },
    to: { type: 'stop', lat: 32.061, lon: 34.771, name: 'Rothschild' },
    distanceMeters: 350,
    durationSeconds: 300,
    geometry: null,
    walkEstimated: false,
  };
}

function transitLeg(over: { tripId: string; agencyId?: string | null; shortName?: string; type?: number }): TransitLeg {
  return {
    type: 'transit',
    route: {
      id: `r-${over.tripId}`,
      agencyId: over.agencyId === undefined ? '3' : over.agencyId,
      shortName: over.shortName ?? '480',
      longName: '',
      type: over.type ?? 3,
      color: null,
    },
    tripId: over.tripId,
    headsign: 'Bat Yam',
    directionId: 0,
    from: {
      stop: { type: 'stop', lat: 32.061, lon: 34.771, stopId: 's1', name: 'Rothschild' },
      departureTime: '2026-08-31T10:10:00.000Z',
      stopSequence: 1,
    },
    to: {
      stop: { type: 'stop', lat: 32.08, lon: 34.79, stopId: 's4', name: 'Allenby' },
      arrivalTime: '2026-08-31T10:30:00.000Z',
      stopSequence: 4,
    },
    numStops: 3,
    intermediateStops: [],
    geometry: null,
    geometryFallback: false,
    realtime: null,
  };
}

function itineraryOf(...legs: (TransitLeg | WalkLeg)[]): Itinerary {
  return {
    departureTime: '2026-08-31T10:00:00.000Z',
    arrivalTime: '2026-08-31T10:35:00.000Z',
    durationSeconds: 2100,
    transfers: legs.filter((l) => l.type === 'transit').length - 1,
    walkSeconds: 600,
    walkMeters: 700,
    transferAtRisk: null,
    legs,
  };
}

/** 45 s after `vehicle()`'s default report time. */
const NOW = new Date('2026-08-31T10:15:45.000Z');

function vehicle(over: Partial<LiveVehicle> & { tripId: string }): LiveVehicle {
  return {
    lat: 32.07, lon: 34.78, recordedAt: '2026-08-31T10:15:00.000Z', vehicleRef: 'veh-1',
    ...over,
  };
}

test('a vehicle on one of the itinerary legs is drawn in that leg\'s operator colour', () => {
  const markers = vehicleMarkers(
    itineraryOf(walkLeg(), transitLeg({ tripId: 't1' })),
    [vehicle({ tripId: 't1' })],
    NOW,
  );
  assert.deepEqual(markers, [{
    tripId: 't1',
    latitude: 32.07,
    longitude: 34.78,
    color: operatorColor('3'),
    routeType: 3,
    shortName: '480',
    // 10:15:45, and this leg boards at 10:10: a preview has nothing to count to.
    etaMinutes: null,
    faded: false,
    secondary: false,
  }]);
});

/**
 * The reason this join exists at all. React Query serves a cached entry for
 * the previous journey's trips while the new one's request is in flight, so
 * without the match a rider who switched journeys would briefly watch a bus
 * belonging to a trip they are no longer on.
 */
test('a vehicle on a trip this itinerary does not ride is dropped', () => {
  const markers = vehicleMarkers(
    itineraryOf(transitLeg({ tripId: 't1' })),
    [vehicle({ tripId: 't-other' }), vehicle({ tripId: 't1' })],
    NOW,
  );
  assert.deepEqual(markers.map((m) => m.tripId), ['t1']);
});

test('each leg of a multi-leg journey gets its own vehicle and colour', () => {
  const markers = vehicleMarkers(
    itineraryOf(
      transitLeg({ tripId: 't1', agencyId: '3' }),
      walkLeg(),
      transitLeg({ tripId: 't2', agencyId: '5', shortName: '18', type: 2 }),
    ),
    [vehicle({ tripId: 't2', lat: 32.1, lon: 34.8 }), vehicle({ tripId: 't1' })],
    NOW,
  );
  // In the order the VEHICLES arrived, not the order the legs are ridden --
  // markers are keyed by trip id, so draw order carries no meaning.
  assert.deepEqual(markers.map((m) => [m.tripId, m.color, m.routeType, m.shortName]), [
    ['t2', operatorColor('5'), 2, '18'],
    ['t1', operatorColor('3'), 3, '480'],
  ]);
});

test('a leg whose route names no operator falls back to the neutral colour', () => {
  const markers = vehicleMarkers(
    itineraryOf(transitLeg({ tripId: 't1', agencyId: null })),
    [vehicle({ tripId: 't1' })],
    NOW,
  );
  assert.equal(markers[0]?.color, UNKNOWN_OPERATOR_COLOR);
});

test('no itinerary, no legs, and no vehicles all draw nothing', () => {
  assert.deepEqual(vehicleMarkers(null, [vehicle({ tripId: 't1' })], NOW), []);
  assert.deepEqual(vehicleMarkers(itineraryOf(), [vehicle({ tripId: 't1' })], NOW), []);
  assert.deepEqual(vehicleMarkers(itineraryOf(transitLeg({ tripId: 't1' })), [], NOW), []);
});

/** A journey of nothing but walking has no trip to match against, and a
 *  response naming one must not draw over it. */
test('a walk-only itinerary draws nothing', () => {
  assert.deepEqual(vehicleMarkers(itineraryOf(walkLeg()), [vehicle({ tripId: 't1' })], NOW), []);
});

// ---- Fading ---------------------------------------------------------------
//
// A marker is where the bus WAS when it last reported. The server only sends
// reports up to five minutes old on the keyless feeds; the map dims a marker
// once that is long enough for the bus to have moved on.

function markerFor(recordedAt: string | null, now: Date) {
  const [marker] = vehicleMarkers(
    itineraryOf(transitLeg({ tripId: 't1' })), [vehicle({ tripId: 't1', recordedAt })], now,
  );
  assert.ok(marker !== undefined);
  return marker;
}

test('a marker fades once its report is more than two minutes old', () => {
  assert.equal(markerFor('2026-08-31T10:13:45.000Z', NOW).faded, false, 'exactly two minutes');
  assert.equal(markerFor('2026-08-31T10:13:44.000Z', NOW).faded, true, 'two minutes and a second');
});

test('a report stamped after the phone\'s clock, or with no time at all, is not faded', () => {
  assert.equal(markerFor('2026-08-31T10:16:30.000Z', NOW).faded, false);
  assert.equal(markerFor(null, NOW).faded, false);
});

// ---- When it reaches the rider's stop ---------------------------------------
//
// Under every bus: minutes until it reaches the stop the rider boards it at
// (10:10 in the fixture), or -- on a running journey, once it is past that --
// the stop they get off at (10:30).

function etaAt(now: string, options: Parameters<typeof vehicleMarkers>[3] = {}) {
  const [marker] = vehicleMarkers(
    itineraryOf(transitLeg({ tripId: 't1' })), [vehicle({ tripId: 't1' })], new Date(now), options,
  );
  return marker?.etaMinutes;
}

test('a bus on its way counts down to the stop the rider boards at, by the timetable', () => {
  assert.equal(etaAt('2026-08-31T10:05:10.000Z'), 5);
  assert.equal(etaAt('2026-08-31T09:40:00.000Z'), 30);
});

test('a live prediction wins over the timetable', () => {
  const predictions = new Map([[0, { departure: '2026-08-31T10:13:00.000Z', arrival: null }]]);
  assert.equal(etaAt('2026-08-31T10:05:10.000Z', { predictions }), 8);
});

test('at the stop, and for a moment after, it reads as arriving', () => {
  assert.equal(etaAt('2026-08-31T10:10:00.000Z'), 0);
  assert.equal(etaAt('2026-08-31T10:10:50.000Z'), 0);
});

test('past the boarding stop a preview says nothing, and a running journey counts to where the rider gets off', () => {
  assert.equal(etaAt('2026-08-31T10:15:00.000Z'), null);
  assert.equal(etaAt('2026-08-31T10:15:00.000Z', { towardsAlighting: true }), 15);
  const predictions = new Map([[0, { departure: null, arrival: '2026-08-31T10:34:00.000Z' }]]);
  assert.equal(etaAt('2026-08-31T10:15:00.000Z', { towardsAlighting: true, predictions }), 19);
});

test('a bus past every stop of the rider\'s says nothing', () => {
  assert.equal(etaAt('2026-08-31T10:40:00.000Z', { towardsAlighting: true }), null);
});

test('each leg counts down with its own predictions', () => {
  const second = { ...transitLeg({ tripId: 't2' }), from: { ...transitLeg({ tripId: 't2' }).from, departureTime: '2026-08-31T10:40:00.000Z' } };
  const markers = vehicleMarkers(
    itineraryOf(transitLeg({ tripId: 't1' }), walkLeg(), second),
    [vehicle({ tripId: 't1' }), vehicle({ tripId: 't2' })],
    new Date('2026-08-31T10:05:00.000Z'),
    { predictions: new Map([[2, { departure: '2026-08-31T10:45:00.000Z', arrival: null }]]) },
  );
  assert.deepEqual(markers.map((m) => [m.tripId, m.etaMinutes]), [['t1', 5], ['t2', 40]]);
});

// ---- A line's buses -------------------------------------------------------
//
// The line page has no itinerary: every vehicle the route endpoint returns is
// one of this line's buses, drawn in the line's colour with its glyph, and
// faded exactly like a journey's, with no countdown: a line's map has no stop of the rider's.

test('every vehicle on a line is drawn in the line\'s colour, glyph and name', () => {
  const markers = lineVehicleMarkers(
    [vehicle({ tripId: 'a' }), vehicle({ tripId: 'b', lat: 32.1, lon: 34.8, recordedAt: '2026-08-31T10:12:00.000Z' })],
    { agencyId: '5', type: 3, shortName: '18' },
    NOW,
  );
  assert.deepEqual(markers, [
    {
      tripId: 'a', latitude: 32.07, longitude: 34.78, color: operatorColor('5'),
      routeType: 3, shortName: '18', etaMinutes: null, faded: false, secondary: false,
    },
    {
      tripId: 'b', latitude: 32.1, longitude: 34.8, color: operatorColor('5'),
      routeType: 3, shortName: '18', etaMinutes: null, faded: true, secondary: false,
    },
  ]);
});

test('a line with no buses draws none', () => {
  assert.deepEqual(lineVehicleMarkers([], { agencyId: '5', type: 3, shortName: '18' }, NOW), []);
});

/** Opened from a station board: the rider's own run is the bus that matters,
 *  and the runs either side of it are drawn smaller. */
test('with a run selected, every other bus on the line is secondary', () => {
  const markers = lineVehicleMarkers(
    [vehicle({ tripId: 'ahead' }), vehicle({ tripId: 'mine' }), vehicle({ tripId: 'behind' })],
    { agencyId: '5', type: 3, shortName: '18' },
    NOW,
    'mine',
  );
  assert.deepEqual(markers.map((m) => [m.tripId, m.secondary]), [
    ['ahead', true], ['mine', false], ['behind', true],
  ]);
});
