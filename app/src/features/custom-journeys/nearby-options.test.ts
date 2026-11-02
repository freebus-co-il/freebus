import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Departure, TransitLeg } from '@/api/types';
import { sampleItinerary } from '@/features/journey/journey-fixtures';
import type { BoardTarget, StationRun } from '@/features/journey/station-board';

import { rankNearby, STRONG_GAIN_SECONDS, withBoardingElsewhere } from './nearby-options';

const NOW = Date.parse('2026-11-02T16:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const leg = sampleItinerary().legs[1] as TransitLeg;
const FINAL: BoardTarget = { lat: 32.081, lon: 34.791, final: true, mode: 'bus' };

function run(key: string, departsIn: number, arrivesIn: number, walkMeters = 100): StationRun {
  return {
    key, tripId: key,
    route: { routeId: key, agencyId: '3', shortName: key, longName: null, type: 3, color: null },
    headsign: '', tripNumber: null, boardStopId: 's1', boardStopSequence: 1,
    departs: at(departsIn), live: false, realtime: null,
    alight: { stopId: 'home-stop', stopSequence: 9, name: 'Home stop', walkMeters },
    arrives: at(arrivesIn), rideSeconds: (arrivesIn - departsIn) * 60,
  };
}

function departure(tripId: string, stopId: string, departsIn: number, arrivesIn: number): Departure {
  return {
    tripId, runId: tripId, unscheduled: false, stopId, stopSequence: 3,
    departureTime: at(departsIn), headsign: '', directionId: 0, lineCode: tripId, lineDirection: '1',
    route: { routeId: tripId, agencyId: '3', shortName: tripId, longName: null, type: 3, color: null },
    realtime: null,
    destination: { stopId: 'home-stop', stopSequence: 12, walkMeters: 100, arrivalTime: at(arrivesIn), rideSeconds: (arrivesIn - departsIn) * 60, name: 'Home stop' },
  };
}

// The planned stop is at the rider; the other exit's stop is about 150 m off.
const FROM = { lat: leg.from.stop.lat, lon: leg.from.stop.lon };
const OTHER_EXIT = { stopId: 'exit-b', name: 'Exit B', lat: leg.from.stop.lat + 0.00135, lon: leg.from.stop.lon };

test('a stop by the other exit that gets the rider home well sooner is the strong suggestion', () => {
  const ranked = rankNearby({
    leg, target: FINAL, from: FROM, nowMs: NOW,
    currentRuns: [run('slow', 10, 40)],
    boards: [{ ...OTHER_EXIT, departures: [departure('fast', 'exit-b', 6, 25)] }],
  });
  assert.equal(ranked.strong?.stopId, 'exit-b');
  assert.equal(ranked.strong?.best?.tripId, 'fast');
  assert.equal(ranked.gainSeconds, 15 * 60);
  assert.equal(ranked.options[0]!.stopId, 'exit-b');
});

test('a gain too small to cross the road for is not called out', () => {
  const ranked = rankNearby({
    leg, target: FINAL, from: FROM, nowMs: NOW,
    currentRuns: [run('here', 10, 30)],
    boards: [{ ...OTHER_EXIT, departures: [departure('there', 'exit-b', 8, 30 - STRONG_GAIN_SECONDS / 60 + 1)] }],
  });
  assert.equal(ranked.strong, null);
});

test('a run that leaves before the rider can walk to it does not count', () => {
  const ranked = rankNearby({
    leg, target: FINAL, from: FROM, nowMs: NOW,
    currentRuns: [run('here', 10, 40)],
    // About two and a half minutes' walk away, leaving in one.
    boards: [{ ...OTHER_EXIT, departures: [departure('gone', 'exit-b', 1, 15)] }],
  });
  assert.equal(ranked.strong, null);
  assert.equal(ranked.options.find((option) => option.stopId === 'exit-b')?.best, null);
});

test('with nothing catchable at the planned stop, any stop that has a run is the suggestion', () => {
  const ranked = rankNearby({
    leg, target: FINAL, from: FROM, nowMs: NOW,
    currentRuns: [],
    boards: [{ ...OTHER_EXIT, departures: [departure('only', 'exit-b', 12, 40)] }],
  });
  assert.equal(ranked.strong?.stopId, 'exit-b');
  assert.equal(ranked.gainSeconds, null);
});

test('boarding elsewhere re-aims the walk before the ride at the new stop', () => {
  const itinerary = sampleItinerary();
  const elsewhere: TransitLeg = {
    ...leg,
    tripId: 'other',
    from: { ...leg.from, stop: { type: 'stop', lat: OTHER_EXIT.lat, lon: OTHER_EXIT.lon, stopId: 'exit-b', name: 'Exit B' } },
  };
  const result = withBoardingElsewhere(itinerary, 1, elsewhere);
  assert.ok(result);
  assert.equal(result.walkIndex, 0);
  assert.equal(result.itinerary.legs.length, 3);
  const walk = result.itinerary.legs[0]!;
  assert.equal(walk.type, 'walk');
  assert.equal(walk.type === 'walk' && walk.to.stopId, 'exit-b');
  assert.equal(walk.type === 'walk' && walk.from.lat, itinerary.legs[0]!.type === 'walk' ? itinerary.legs[0]!.from.lat : null);
  const ride = result.itinerary.legs[1]!;
  assert.equal(ride.type === 'transit' && ride.tripId, 'other');
});

test('a ride with no walk before it gets one from the planned stop', () => {
  const itinerary = { ...sampleItinerary() };
  itinerary.legs = itinerary.legs.slice(1);
  const elsewhere: TransitLeg = {
    ...leg,
    tripId: 'other',
    from: { ...leg.from, stop: { type: 'stop', lat: OTHER_EXIT.lat, lon: OTHER_EXIT.lon, stopId: 'exit-b', name: 'Exit B' } },
  };
  const result = withBoardingElsewhere(itinerary, 0, elsewhere);
  assert.ok(result);
  assert.equal(result.walkIndex, 0);
  assert.deepEqual(result.itinerary.legs.map((each) => each.type), ['walk', 'transit', 'walk']);
  const walk = result.itinerary.legs[0]!;
  assert.equal(walk.type === 'walk' && walk.from.stopId, 's1');
});
