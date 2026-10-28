import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Departure, TransitLeg, TripDetail } from '@/api/types';

import { sampleItinerary, twoRideItinerary } from './journey-fixtures';
import { boardedRun, boardTarget, legFromRun, rememberRuns, runToFollow, stationRuns, withRun, type StationRun } from './station-board';

const NOW = Date.parse('2026-08-31T10:05:00.000Z');

function departure(overrides: Partial<Departure> & { tripId: string; departureTime: string }): Departure {
  return {
    runId: overrides.tripId,
    unscheduled: false,
    stopId: 's1',
    stopSequence: 1,
    headsign: 'Bat Yam',
    directionId: 0,
    lineCode: 'l',
    lineDirection: '1',
    route: { routeId: 'r1', agencyId: '3', shortName: '480', longName: null, type: 3, color: null },
    realtime: null,
    destination: { stopId: 's4', stopSequence: 4, walkMeters: 0, arrivalTime: '2026-08-31T10:30:00.000Z', rideSeconds: 1200, name: 'Allenby' },
    ...overrides,
  };
}

const ride = () => sampleItinerary().legs[1] as TransitLeg;

test('the last ride is filtered to the destination itself, earlier rides to the next station', () => {
  const single = boardTarget(sampleItinerary(), 1);
  assert.equal(single?.final, true);
  assert.deepEqual([single?.lat, single?.lon], [32.081, 34.791]);

  const first = boardTarget(twoRideItinerary(), 1);
  assert.equal(first?.final, false);
  assert.deepEqual([first?.lat, first?.lon], [32.08, 34.79]);
});

test('runs that already left drop off; soonest first, by live time', () => {
  const runs = stationRuns([
    departure({ tripId: 'gone', departureTime: '2026-08-31T10:02:00.000Z' }),
    departure({ tripId: 'later', departureTime: '2026-08-31T10:12:00.000Z' }),
    departure({
      tripId: 'late', departureTime: '2026-08-31T10:00:00.000Z',
      realtime: { predictedDeparture: '2026-08-31T10:08:00.000Z', predictedArrival: null, delaySeconds: 480, vehicleRef: null, confidence: null, recordedAt: null },
    }),
  ], ride(), boardTarget(sampleItinerary(), 1)!, NOW);
  assert.deepEqual(runs.map((run) => run.tripId), ['late', 'later']);
  assert.equal(runs[0]?.live, true);
});

test('before the last ride only the same kind of vehicle to the same station counts', () => {
  const target = boardTarget(twoRideItinerary(), 1)!;
  const runs = stationRuns([
    departure({ tripId: 'same', departureTime: '2026-08-31T10:10:00.000Z' }),
    departure({
      tripId: 'train', departureTime: '2026-08-31T10:11:00.000Z',
      route: { routeId: 'rail', agencyId: '2', shortName: null, longName: null, type: 2, color: null },
    }),
    departure({
      tripId: 'elsewhere', departureTime: '2026-08-31T10:12:00.000Z',
      destination: { stopId: 'far', stopSequence: 5, walkMeters: 450, arrivalTime: '2026-08-31T10:31:00.000Z', rideSeconds: 1200 },
    }),
  ], ride(), target, NOW);
  assert.deepEqual(runs.map((run) => run.tripId), ['same']);
});

test('on the last ride every line near home counts, each with where it drops the rider', () => {
  const runs = stationRuns([
    departure({ tripId: 'near', departureTime: '2026-08-31T10:10:00.000Z' }),
    departure({
      tripId: 'other-line', departureTime: '2026-08-31T10:07:00.000Z',
      route: { routeId: 'r9', agencyId: '3', shortName: '29', longName: null, type: 3, color: null },
      destination: { stopId: 's9', stopSequence: 7, walkMeters: 420, arrivalTime: '2026-08-31T10:40:00.000Z', rideSeconds: 1980, name: 'Herzl' },
    }),
  ], ride(), boardTarget(sampleItinerary(), 1)!, NOW);
  assert.deepEqual(runs.map((run) => run.tripId), ['other-line', 'near']);
  assert.deepEqual(runs[0]?.alight, { stopId: 's9', stopSequence: 7, name: 'Herzl', walkMeters: 420 });
});

function run(tripId: string, departs: string): StationRun {
  return stationRuns([departure({ tripId, departureTime: departs })], ride(), boardTarget(sampleItinerary(), 1)!, Date.parse(departs))[0]!;
}

test('the ride keeps its run while that run is still on the board, even behind another', () => {
  const runs = [run('t0', '2026-08-31T10:07:00.000Z'), run('t1', '2026-08-31T10:10:00.000Z')];
  assert.equal(runToFollow(ride(), runs, NOW), null);
});

test('field note 3: a run off the board is held a while, since it may just be late', () => {
  const runs = [run('t2', '2026-08-31T10:20:00.000Z'), run('t3', '2026-08-31T10:30:00.000Z')];
  // The ride's run was due at 10:10.
  assert.equal(runToFollow(ride(), runs, Date.parse('2026-08-31T10:13:00.000Z')), null);
  assert.equal(runToFollow(ride(), runs, Date.parse('2026-08-31T10:16:00.000Z'))?.tripId, 't2');
  assert.equal(runToFollow(ride(), [], Date.parse('2026-08-31T10:16:00.000Z')), null);
});

test('leaving the station before the ride\'s run is due means the run that left last', () => {
  const seen = [
    run('t-1', '2026-08-31T09:55:00.000Z'),
    run('t0', '2026-08-31T10:04:30.000Z'),
    run('t2', '2026-08-31T10:20:00.000Z'),
  ];
  assert.equal(boardedRun(ride(), seen, NOW)?.tripId, 't0');
  // Leaving as the ride's own run is due: that is the one.
  assert.equal(boardedRun(ride(), seen, Date.parse('2026-08-31T10:09:30.000Z')), null);
});

const trip: TripDetail = {
  tripId: 't7',
  route: { routeId: 'r9', agencyId: '3', shortName: '29', longName: null, type: 3, color: null },
  headsign: 'Herzl',
  directionId: 1,
  wheelchairAccessible: null,
  serviceDate: 20260831,
  stops: [
    { stop: { stopId: 's0', code: null, name: 'Before', lat: 32.05, lon: 34.76, locationType: 0, parentStation: null }, stopSequence: 0, arrivalTime: '2026-08-31T10:05:00.000Z', departureTime: '2026-08-31T10:05:00.000Z' },
    { stop: { stopId: 's1', code: null, name: 'Rothschild', lat: 32.061, lon: 34.771, locationType: 0, parentStation: null }, stopSequence: 1, arrivalTime: '2026-08-31T10:07:00.000Z', departureTime: '2026-08-31T10:07:00.000Z' },
    { stop: { stopId: 's8', code: null, name: 'Mid', lat: 32.07, lon: 34.78, locationType: 0, parentStation: null }, stopSequence: 2, arrivalTime: '2026-08-31T10:20:00.000Z', departureTime: '2026-08-31T10:20:00.000Z' },
    { stop: { stopId: 's9', code: null, name: 'Herzl', lat: 32.083, lon: 34.795, locationType: 0, parentStation: null }, stopSequence: 7, arrivalTime: '2026-08-31T10:40:00.000Z', departureTime: '2026-08-31T10:40:00.000Z' },
  ],
};

const herzlRun = (): StationRun => stationRuns([departure({
  tripId: 't7', departureTime: '2026-08-31T10:07:00.000Z',
  route: trip.route,
  destination: { stopId: 's9', stopSequence: 7, walkMeters: 420, arrivalTime: '2026-08-31T10:40:00.000Z', rideSeconds: 1980, name: 'Herzl' },
})], ride(), boardTarget(sampleItinerary(), 1)!, NOW)[0]!;

test('a run becomes a ride over its own stops and times', () => {
  const leg = legFromRun(herzlRun(), trip, ride());
  assert.ok(leg);
  assert.equal(leg.tripId, 't7');
  assert.equal(leg.route.shortName, '29');
  assert.equal(leg.from.stop.stopId, 's1');
  assert.equal(leg.to.stop.stopId, 's9');
  assert.equal(leg.to.arrivalTime, '2026-08-31T10:40:00.000Z');
  assert.deepEqual(leg.intermediateStops.map((stop) => stop.stopId), ['s8']);
  assert.equal(leg.numStops, 2);
  // Not the planned ride's stops, so not its drawn route either.
  assert.equal(leg.geometry, null);
});

test('a run whose trip does not call at both stops is not a ride', () => {
  assert.equal(legFromRun(herzlRun(), { ...trip, stops: trip.stops.slice(0, 2) }, ride()), null);
});

test('a run setting down elsewhere moves the walk home and the arrival with it', () => {
  const itinerary = sampleItinerary();
  const leg = legFromRun(herzlRun(), trip, ride())!;
  const next = withRun(itinerary, 1, leg);
  const walk = next.legs[2];
  assert.equal(walk?.type, 'walk');
  if (walk?.type !== 'walk') return;
  assert.equal(walk.from.stopId, 's9');
  assert.deepEqual(walk.to, itinerary.legs[2]!.to);
  assert.equal(walk.walkEstimated, true);
  assert.equal(next.arrivalTime, new Date(Date.parse('2026-08-31T10:40:00.000Z') + walk.durationSeconds * 1000).toISOString());
});

test('before the last ride, a later run pushes the arrival back by its lateness', () => {
  const itinerary = twoRideItinerary();
  const planned = itinerary.legs[1] as TransitLeg;
  const later: TransitLeg = { ...planned, tripId: 'later', to: { ...planned.to, arrivalTime: '2026-08-31T10:36:00.000Z' } };
  const next = withRun(itinerary, 1, later);
  assert.equal(next.arrivalTime, '2026-08-31T11:01:00.000Z');
  // Same station: the transfer walk is the planned one.
  assert.equal(next.legs[2], itinerary.legs[2]);
});

test('runs seen for a ride are kept across boards until long past due', () => {
  const early = run('t0', '2026-08-31T10:04:30.000Z');
  const later = run('t2', '2026-08-31T10:20:00.000Z');
  const kept = rememberRuns([early], [later], Date.parse('2026-08-31T09:40:00.000Z'));
  assert.deepEqual(kept.map((each) => each.tripId), ['t0', 't2']);
  assert.deepEqual(rememberRuns(kept, [], Date.parse('2026-08-31T10:10:00.000Z')).map((each) => each.tripId), ['t2']);
});
