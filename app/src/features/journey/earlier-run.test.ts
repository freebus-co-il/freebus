import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TransitAlternative, TransitLeg } from '@/api/types';

import { boardedEarlierRun, catchableEarlierRun, withEarlierRunAtStart } from './earlier-run';
import { sampleItinerary } from './journey-fixtures';

const ms = (iso: string) => new Date(iso).getTime();

/** The sample journey's ride (planned 10:10) with runs around it. */
function rideWith(departures: { tripId: string; departure: string; arrival: string }[]): TransitLeg {
  const leg = sampleItinerary().legs[1] as TransitLeg;
  const alternatives = departures.map(({ tripId, departure, arrival }): TransitAlternative => ({
    ...leg,
    tripId,
    from: { ...leg.from, departureTime: departure },
    to: { ...leg.to, arrivalTime: arrival },
    missesConnection: false,
    arrivalDelaySeconds: 0,
  }));
  return { ...leg, alternatives };
}

const AROUND_THE_PLANNED_RIDE = [
  { tripId: 'early-far', departure: '2026-08-31T09:50:00.000Z', arrival: '2026-08-31T10:10:00.000Z' },
  { tripId: 'early-near', departure: '2026-08-31T10:02:00.000Z', arrival: '2026-08-31T10:22:00.000Z' },
  { tripId: 'later', departure: '2026-08-31T10:20:00.000Z', arrival: '2026-08-31T10:40:00.000Z' },
];

test('the catchable earlier run is the last one the rider can still reach', () => {
  const leg = rideWith(AROUND_THE_PLANNED_RIDE);
  // At the stop by 09:55: both earlier runs are still ahead, so the later of
  // them -- the one with the most slack -- is the one to take.
  const run = catchableEarlierRun(leg, ms('2026-08-31T09:55:00.000Z'));
  assert.equal(run?.tripId, 'early-near');
});

test('a run that left before the rider could get there is not offered', () => {
  const leg = rideWith(AROUND_THE_PLANNED_RIDE);
  // Reaching the stop at 10:05 misses both: 10:02 has gone, and the planned
  // 10:10 is what they were going to take anyway.
  assert.equal(catchableEarlierRun(leg, ms('2026-08-31T10:05:00.000Z')), null);
});

test('later runs are never mistaken for earlier ones', () => {
  const leg = rideWith(AROUND_THE_PLANNED_RIDE);
  // 10:20 is after the planned 10:10, so it is a fallback, not a head start.
  assert.notEqual(catchableEarlierRun(leg, ms('2026-08-31T09:00:00.000Z'))?.tripId, 'later');
});

test('a ride with no alternatives at all leaves the plan alone', () => {
  const leg = { ...(sampleItinerary().legs[1] as TransitLeg), alternatives: [] };
  assert.equal(catchableEarlierRun(leg, ms('2026-08-31T09:55:00.000Z')), null);
  assert.equal(boardedEarlierRun(leg, ms('2026-08-31T10:05:00.000Z')), null);
});

test('the run being ridden is the most recent one that has already left', () => {
  const leg = rideWith(AROUND_THE_PLANNED_RIDE);
  const run = boardedEarlierRun(leg, ms('2026-08-31T10:06:00.000Z'));
  assert.equal(run?.tripId, 'early-near');
});

// A run still ahead of the rider cannot be the one carrying them.
test('before any earlier run has left, none is the one being ridden', () => {
  const leg = rideWith(AROUND_THE_PLANNED_RIDE);
  assert.equal(boardedEarlierRun(leg, ms('2026-08-31T09:45:00.000Z')), null);
});

test('starting early begins the journey on the run the rider can still walk to', () => {
  const base = sampleItinerary();
  const legs = base.legs.slice();
  legs[1] = rideWith(AROUND_THE_PLANNED_RIDE);
  const itinerary = { ...base, legs };

  // 09:56, with a five-minute walk ahead: at the stop by 10:01, in time for
  // the 10:02 rather than the planned 10:10.
  const started = withEarlierRunAtStart(itinerary, ms('2026-08-31T09:56:00.000Z'));
  const ride = started.legs[1] as TransitLeg;
  assert.equal(ride.tripId, 'early-near');
  // The whole journey moves with it: it leaves earlier and arrives earlier.
  assert.equal(started.departureTime, '2026-08-31T09:52:00.000Z');
  assert.equal(started.arrivalTime, '2026-08-31T10:27:00.000Z');
});

test('starting on time leaves the planned run alone', () => {
  const base = sampleItinerary();
  const legs = base.legs.slice();
  legs[1] = rideWith(AROUND_THE_PLANNED_RIDE);
  const itinerary = { ...base, legs };

  // 10:00: the five-minute walk lands at 10:05, past the 10:02.
  const started = withEarlierRunAtStart(itinerary, ms('2026-08-31T10:00:00.000Z'));
  assert.equal((started.legs[1] as TransitLeg).tripId, (legs[1] as TransitLeg).tripId);
  assert.equal(started.departureTime, base.departureTime);
});

test('a walk-only journey has no run to bring forward', () => {
  const base = sampleItinerary();
  const walkOnly = { ...base, legs: [base.legs[0]!] };
  assert.equal(withEarlierRunAtStart(walkOnly, ms('2026-08-31T09:56:00.000Z')), walkOnly);
});
