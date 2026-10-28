import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary } from '@/api/types';

import { buildJourneyRegions, MAX_REGIONS } from './geofences';
import type { ActiveJourney } from './types';

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

function journey(): ActiveJourney {
  return {
    id: 'j1',
    itinerary: itinerary(),
    signature: 'sig',
    departure: '2026-08-31T10:00:00.000Z',
    startedAt: '2026-08-31T09:58:00.000Z',
    destinationLabel: 'Home',
    acknowledgedAlightLegIndex: null,
  };
}

test('regions cover only decision points', () => {
  const kinds = buildJourneyRegions(journey()).map((region) => region.kind);
  assert.deepEqual(kinds, ['board', 'wake', 'alight', 'destination']);
});

test('the wake ring sits on the stop before the alight stop', () => {
  const wake = buildJourneyRegions(journey()).find((region) => region.kind === 'wake');
  // Mid B, the last intermediate stop.
  assert.equal(wake?.lat, 32.075);
  assert.equal(wake?.lon, 34.785);
});

test('a ride with no intermediate stops falls back to a ring around the alight stop', () => {
  const base = journey();
  const leg = base.itinerary.legs[1];
  if (leg.type !== 'transit') throw new Error('fixture changed');
  leg.intermediateStops = [];
  const wake = buildJourneyRegions(base).find((region) => region.kind === 'wake');
  assert.equal(wake?.lat, 32.08);
  assert.equal(wake?.radiusMeters, 1200);
});

test('never exceeds the platform region budget', () => {
  const base = journey();
  const ride = base.itinerary.legs[1];
  if (ride.type !== 'transit') throw new Error('fixture changed');
  base.itinerary.legs = [base.itinerary.legs[0], ...Array.from({ length: 12 }, () => structuredClone(ride))];
  assert.ok(buildJourneyRegions(base).length <= MAX_REGIONS);
});
