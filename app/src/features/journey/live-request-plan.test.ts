import assert from 'node:assert/strict';
import { test } from 'node:test';

import { at, fix, sampleJourney, twoRideJourney } from './journey-fixtures';
import { resolveJourneyState } from './journey-machine';
import { liveRequestPlan } from './live-request-plan';
import type { TransitLeg } from '@/api/types';

const indexes = (plan: ReturnType<typeof liveRequestPlan>) => plan.checked.map((c) => c.legIndex);

test('no journey asks about nothing', () => {
  const plan = liveRequestPlan(null, null);
  assert.deepEqual(plan.checked, []);
  assert.equal(plan.ride, null);
  assert.equal(plan.rideIndex, -1);
  assert.equal(plan.wantsBus, false);
});

test('walking to the stop checks the ride ahead and wants its bus', () => {
  const journey = sampleJourney();
  const base = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));
  assert.equal(base.phase, 'walking-to-stop');
  const plan = liveRequestPlan(journey, base);
  assert.deepEqual(indexes(plan), [1]);
  assert.equal(plan.rideIndex, 1);
  assert.equal(plan.wantsBus, true);
  assert.equal(plan.checkKey, 'j1:1=t1');
});

test('waiting and riding check the leg in play and want its bus', () => {
  const journey = twoRideJourney();
  const waiting = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'));
  assert.equal(waiting.phase, 'waiting');
  assert.deepEqual(indexes(liveRequestPlan(journey, waiting)), [1, 3]);

  const riding = resolveJourneyState(journey, null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(riding.phase, 'riding');
  const plan = liveRequestPlan(journey, riding);
  assert.deepEqual(indexes(plan), [1, 3]);
  assert.equal(plan.rideIndex, 1);
  assert.equal(plan.wantsBus, true);
});

test('a transfer walk keeps the ridden leg at the head of the chain', () => {
  // Without it the connection after leg 1 is never asked about, so a broken
  // transfer could never be seen while walking to it.
  const journey = twoRideJourney();
  const base = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));
  assert.equal(base.phase, 'transferring');
  const plan = liveRequestPlan(journey, base);
  assert.deepEqual(indexes(plan), [1, 3]);
  assert.equal(plan.checkKey, 'j1:1=t1,3=t2');
  // The bus in play is the one being walked to.
  assert.equal(plan.rideIndex, 3);
  assert.equal(plan.wantsBus, true);
});

test('the final walk has no ride and asks about nothing', () => {
  const journey = sampleJourney();
  const base = resolveJourneyState(journey, null, at('2026-08-31T10:32:00.000Z'));
  assert.equal(base.phase, 'arriving');
  const plan = liveRequestPlan(journey, base);
  assert.deepEqual(plan.checked, []);
  assert.equal(plan.ride, null);
  assert.equal(plan.wantsBus, false);
});

test('a late bus the timetable already calls missed is still watched', () => {
  // Resolved without live data, a rider at the stop past the grace reads as
  // off-plan -- exactly when the bus position is what could overrule that.
  const journey = sampleJourney();
  const base = resolveJourneyState(journey, fix(32.061, 34.771, '2026-08-31T10:12:55.000Z'), at('2026-08-31T10:13:00.000Z'));
  assert.equal(base.phase, 'off-plan');
  const plan = liveRequestPlan(journey, base);
  assert.deepEqual(indexes(plan), [1]);
  assert.equal(plan.rideIndex, 1);
  assert.equal(plan.wantsBus, true);
});

test('another line on the same leg is a new question', () => {
  const journey = sampleJourney();
  const base = resolveJourneyState(journey, null, at('2026-08-31T10:02:00.000Z'));
  const onAnotherLine = {
    ...journey,
    itinerary: {
      ...journey.itinerary,
      legs: journey.itinerary.legs.map((leg) => (leg.type === 'transit' ? { ...leg, tripId: 'other' } : leg)),
    },
  };
  const before = liveRequestPlan(journey, base);
  const after = liveRequestPlan(onAnotherLine, base);
  assert.deepEqual(indexes(after), indexes(before));
  assert.notEqual(after.checkKey, before.checkKey);
  assert.equal((after.checked[0]?.leg as TransitLeg).tripId, 'other');
});
