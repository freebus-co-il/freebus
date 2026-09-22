import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary } from '@/api/types';
import { buildJourneyRail, buildLegSchedule } from './journey-rail';

/** walk 5m -> bus (wait 5m, ride 20m) -> walk 5m, starting 10:00. */
function itinerary(): Itinerary {
  return {
    departureTime: '2026-08-31T10:00:00.000Z',
    arrivalTime: '2026-08-31T10:35:00.000Z',
    durationSeconds: 2100,
    transfers: 0,
    walkSeconds: 600,
    walkMeters: 700,
    transferAtRisk: null,
    legs: [
      {
        type: 'walk',
        from: { type: 'coordinate', lat: 32.06, lon: 34.77 },
        to: { type: 'stop', lat: 32.061, lon: 34.771, name: 'Rothschild' },
        distanceMeters: 350,
        durationSeconds: 300,
        geometry: null,
        walkEstimated: false,
      },
      {
        type: 'transit',
        route: { id: 'r1', agencyId: '3', shortName: '480', longName: '', type: 3, color: null },
        tripId: 't1',
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
        intermediateStops: [
          { type: 'stop', lat: 32.07, lon: 34.78, stopId: 's2', name: 'Mid A' },
          { type: 'stop', lat: 32.075, lon: 34.785, stopId: 's3', name: 'Mid B' },
        ],
        geometry: null,
        geometryFallback: false,
        realtime: null,
      },
      {
        type: 'walk',
        from: { type: 'stop', lat: 32.08, lon: 34.79, name: 'Allenby' },
        to: { type: 'coordinate', lat: 32.081, lon: 34.791 },
        distanceMeters: 350,
        durationSeconds: 300,
        geometry: null,
        walkEstimated: false,
      },
    ],
  };
}

test('the wait before boarding belongs to the ride window', () => {
  const windows = buildLegSchedule(itinerary());
  assert.equal(windows.length, 3);
  assert.equal(windows[0].startsAt, '2026-08-31T10:00:00.000Z');
  assert.equal(windows[0].endsAt, '2026-08-31T10:05:00.000Z');
  // Starts when the rider ARRIVES at the stop (10:05), not when the bus goes.
  assert.equal(windows[1].startsAt, '2026-08-31T10:05:00.000Z');
  assert.equal(windows[1].endsAt, '2026-08-31T10:30:00.000Z');
  assert.equal(windows[2].endsAt, '2026-08-31T10:35:00.000Z');
});

test('rail segments carry the operator colour, walks carry the walk colour', () => {
  const rail = buildJourneyRail(itinerary());
  assert.equal(rail.segments.length, 3);
  assert.equal(rail.segments[0].kind, 'walk');
  assert.equal(rail.segments[0].color, '#f59e0b');
  assert.equal(rail.segments[1].kind, 'transit');
  assert.notEqual(rail.segments[1].color, '#f59e0b');
  assert.equal(rail.totalSeconds, 2100);
});

test('a single-ride journey has no transfer points', () => {
  assert.deepEqual(buildJourneyRail(itinerary()).points, []);
});

test('a transfer point falls at the end of each non-final transit segment', () => {
  const base = itinerary();
  const second = structuredClone(base.legs[1]) as typeof base.legs[1] & { type: 'transit' };
  second.from = { ...second.from, departureTime: '2026-08-31T10:35:00.000Z' };
  second.to = { ...second.to, arrivalTime: '2026-08-31T10:50:00.000Z' };
  const withTransfer: Itinerary = {
    ...base,
    arrivalTime: '2026-08-31T10:55:00.000Z',
    legs: [base.legs[0], base.legs[1], second, base.legs[2]],
  };
  const rail = buildJourneyRail(withTransfer);
  assert.equal(rail.points.length, 1);
  // 300s walk + 1500s first ride.
  assert.equal(rail.points[0].atSeconds, 1800);
});
