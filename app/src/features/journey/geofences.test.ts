import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary } from '@/api/types';

import { haversineMeters } from '@/lib/geo';

import { alightRadiusMeters, MIN_ALIGHT_RADIUS_METERS, PASSED_STOP_METERS } from './alerts';
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

/** The fixture with its ride turned into a train. */
function onRail(): ActiveJourney {
  const base = journey();
  const leg = base.itinerary.legs[1];
  if (leg.type !== 'transit') throw new Error('fixture changed');
  base.itinerary.legs[1] = { ...leg, route: { ...leg.route, type: 2 } };
  return base;
}

test('the wake ring is drawn around the alight stop, inside the stop before it', () => {
  const wake = buildJourneyRegions(journey()).find((region) => region.kind === 'wake');
  // Allenby, sized by the shared get-off rule.
  assert.equal(wake?.lat, 32.08);
  assert.equal(wake?.lon, 34.79);
  const leg = journey().itinerary.legs[1];
  if (leg.type !== 'transit') throw new Error('fixture changed');
  assert.equal(wake?.radiusMeters, alightRadiusMeters(leg));
  assert.ok(wake!.radiusMeters < haversineMeters(leg.intermediateStops.at(-1)!, leg.to.stop));
});

test('a close stop before shrinks the ring so entering it means having passed that stop', () => {
  const base = journey();
  const leg = base.itinerary.legs[1];
  if (leg.type !== 'transit') throw new Error('fixture changed');
  // About 300 m before Allenby.
  leg.intermediateStops = [...leg.intermediateStops.slice(0, 1), { type: 'stop', lat: 32.0773, lon: 34.79, stopId: 's3', name: 'Mid B' }];
  const wake = buildJourneyRegions(base).find((region) => region.kind === 'wake');
  const gap = haversineMeters(leg.intermediateStops.at(-1)!, leg.to.stop);
  assert.equal(wake?.radiusMeters, alightRadiusMeters(leg));
  assert.ok(wake!.radiusMeters <= Math.max(MIN_ALIGHT_RADIUS_METERS, gap - PASSED_STOP_METERS));
});

test('a train gets the same ring by the same rule', () => {
  const base = onRail();
  const leg = base.itinerary.legs[1];
  if (leg.type !== 'transit') throw new Error('fixture changed');
  const wake = buildJourneyRegions(base).find((region) => region.kind === 'wake');
  assert.equal(wake?.lat, 32.08);
  assert.equal(wake?.radiusMeters, alightRadiusMeters(leg));
});

test('a ride with no intermediate stops rings the alight stop, inside the boarding stop', () => {
  const base = journey();
  const leg = base.itinerary.legs[1];
  if (leg.type !== 'transit') throw new Error('fixture changed');
  leg.intermediateStops = [];
  const wake = buildJourneyRegions(base).find((region) => region.kind === 'wake');
  assert.equal(wake?.lat, 32.08);
  assert.ok(wake!.radiusMeters < haversineMeters(leg.from.stop, leg.to.stop));
});

test('never exceeds the platform region budget', () => {
  const base = journey();
  const ride = base.itinerary.legs[1];
  if (ride.type !== 'transit') throw new Error('fixture changed');
  base.itinerary.legs = [base.itinerary.legs[0], ...Array.from({ length: 12 }, () => structuredClone(ride))];
  assert.ok(buildJourneyRegions(base).length <= MAX_REGIONS);
});

test('under GPS, the wake ring waits for the rider to board; the stop regions do not', () => {
  const waiting = buildJourneyRegions({ ...journey(), gpsLegIndex: 1 }).map((region) => region.kind);
  assert.ok(!waiting.includes('wake'));
  assert.ok(waiting.includes('board') && waiting.includes('alight'));
  const aboard = buildJourneyRegions({ ...journey(), gpsLegIndex: 1, boardedLegIndex: 1 }).map((region) => region.kind);
  assert.ok(aboard.includes('wake'));
});
