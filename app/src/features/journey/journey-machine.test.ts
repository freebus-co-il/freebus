import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveJourneyState } from './journey-machine';
import { at, fix, sampleJourney as journey, twoRideJourney } from './journey-fixtures';
import { DEFAULT_ALERT_SETTINGS } from './types';
import type { RiderPosition, LiveJourneyInput } from './types';

const near = (lat: number, lon: number): RiderPosition => ({
  lat, lon, accuracyMeters: 10, at: '2026-08-31T10:00:00.000Z',
});

test('before the first stop, the rider is walking to it', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:02:00.000Z'));
  assert.equal(state.phase, 'walking-to-stop');
  assert.equal(state.legIndex, 0);
  // The pressure is the DEPARTURE, not the end of the walk.
  assert.equal(state.timer?.to, '2026-08-31T10:10:00.000Z');
  assert.equal(state.timer?.countsDown, true);
});

test('at the stop before the bus goes, the rider is waiting', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:07:00.000Z'));
  assert.equal(state.phase, 'waiting');
  assert.equal(state.leg?.route.shortName, '480');
  assert.equal(state.timer?.to, '2026-08-31T10:10:00.000Z');
});

test('riding with no position gives no stop count rather than a guess', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(state.phase, 'riding');
  assert.equal(state.stopsRemaining, null);
  assert.equal(state.timer?.to, '2026-08-31T10:30:00.000Z');
});

test('riding with a position counts the stops that are left', () => {
  // Sitting at Mid A: Mid B and Allenby remain.
  const state = resolveJourneyState(journey(), near(32.07, 34.78), at('2026-08-31T10:15:00.000Z'));
  assert.equal(state.phase, 'riding');
  assert.equal(state.stopsRemaining, 2);
});

test('one stop out is the alert moment', () => {
  const state = resolveJourneyState(journey(), near(32.075, 34.785), at('2026-08-31T10:25:00.000Z'));
  assert.equal(state.phase, 'alight-soon');
  assert.equal(state.stopsRemaining, 1);
});

test('with no position, the alert moment falls back to the clock', () => {
  // 60s before the 10:30 arrival, inside the 90s default lead.
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:29:00.000Z'));
  assert.equal(state.phase, 'alight-soon');
});

test('after the last ride the rider is walking to the destination', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:32:00.000Z'));
  assert.equal(state.phase, 'arriving');
});

test('past the arrival time the journey is done', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:36:00.000Z'));
  assert.equal(state.phase, 'arrived');
  assert.equal(state.progress, 1);
});

test('still at the boarding stop well after departure means it left without you', () => {
  const state = resolveJourneyState(journey(), near(32.061, 34.771), at('2026-08-31T10:13:00.000Z'));
  assert.equal(state.phase, 'off-plan');
  assert.equal(state.offPlan, 'missed-departure');
});

test('a brief overrun at the stop is absorbed, not alarmed', () => {
  const state = resolveJourneyState(journey(), near(32.061, 34.771), at('2026-08-31T10:11:00.000Z'));
  assert.equal(state.offPlan, null);
});

test('well past the alight stop is an overshoot', () => {
  // ~1.5 km beyond Allenby, after the scheduled arrival.
  const state = resolveJourneyState(journey(), near(32.093, 34.803), at('2026-08-31T10:31:00.000Z'));
  assert.equal(state.phase, 'off-plan');
  assert.equal(state.offPlan, 'overshot');
});

test('an acknowledged alight alert does not re-fire', () => {
  const acknowledged = { ...journey(), acknowledgedAlightLegIndex: 1 };
  const state = resolveJourneyState(acknowledged, near(32.075, 34.785), at('2026-08-31T10:25:00.000Z'));
  assert.equal(state.phase, 'riding');
});

test('choosing a lead in minutes lets the clock govern even with a fix', () => {
  // What the settings screen writes for "5 min": leadStops 0, leadSeconds 300.
  // Reading stops here would leave the screen silent until the doors opened,
  // while the scheduled notification had already fired five minutes earlier.
  const minutes = { ...DEFAULT_ALERT_SETTINGS, leadStops: 0, leadSeconds: 300 };
  const early = resolveJourneyState(journey(), near(32.07, 34.78), at('2026-08-31T10:26:00.000Z'), minutes);
  assert.equal(early.phase, 'alight-soon');
  // Still counts the stops it can see -- the trigger changed, not the honesty.
  assert.equal(early.stopsRemaining, 2);

  const tooEarly = resolveJourneyState(journey(), near(32.07, 34.78), at('2026-08-31T10:20:00.000Z'), minutes);
  assert.equal(tooEarly.phase, 'riding');
});

test('a stop lead still beats the clock when a fix can count', () => {
  // Two stops out at 10:15 is well outside the 90s clock lead, and must not
  // alert -- the stop count is the trigger the rider asked for.
  const state = resolveJourneyState(journey(), near(32.07, 34.78), at('2026-08-31T10:15:00.000Z'));
  assert.equal(state.phase, 'riding');
  assert.equal(state.stopsRemaining, 2);
});

const S = DEFAULT_ALERT_SETTINGS;
function live(partial: Partial<LiveJourneyInput>): LiveJourneyInput {
  return { legs: [], connections: [], bus: null, ...partial };
}
const liveLeg = (legIndex: number, fetchedAt: string, predicted: { departure?: string; arrival?: string }) => ({
  legIndex,
  predictedDeparture: predicted.departure ?? null,
  predictedArrival: predicted.arrival ?? null,
  fetchedAt,
});

test('waiting counts down to a usable prediction and says it is live', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:07:00.000Z'), S, live({
    legs: [liveLeg(1, '2026-08-31T10:06:30.000Z', { departure: '2026-08-31T10:13:00.000Z' })],
  }));
  assert.equal(state.phase, 'waiting');
  assert.equal(state.timer?.to, '2026-08-31T10:13:00.000Z');
  assert.equal(state.timeSource, 'live');
});

test('a prediction older than the hold falls back to the timetable', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:07:00.000Z'), S, live({
    legs: [liveLeg(1, '2026-08-31T10:04:00.000Z', { departure: '2026-08-31T10:13:00.000Z' })],
  }));
  assert.equal(state.timer?.to, '2026-08-31T10:10:00.000Z');
  assert.equal(state.timeSource, 'scheduled');
});

test('walking to the stop races the predicted departure', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:02:00.000Z'), S, live({
    legs: [liveLeg(1, '2026-08-31T10:01:30.000Z', { departure: '2026-08-31T10:12:00.000Z' })],
  }));
  assert.equal(state.phase, 'walking-to-stop');
  assert.equal(state.timer?.to, '2026-08-31T10:12:00.000Z');
  assert.equal(state.timeSource, 'live');
});

test('a late bus still on its way is waited for, not declared missed', () => {
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:12:55.000Z'),
    at('2026-08-31T10:13:00.000Z'),
    S,
    live({ bus: { legIndex: 1, progress: { kind: 'toBoarding', stops: 2 }, recordedAt: '2026-08-31T10:12:30.000Z', lat: 32.05, lon: 34.76 } }),
  );
  assert.equal(state.phase, 'waiting');
  assert.equal(state.offPlan, null);
  assert.equal(state.busStopsAway, 2);
});

test('the missed-departure grace counts from the predicted departure', () => {
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:12:55.000Z'),
    at('2026-08-31T10:13:00.000Z'),
    S,
    live({ legs: [liveLeg(1, '2026-08-31T10:12:40.000Z', { departure: '2026-08-31T10:14:00.000Z' })] }),
  );
  assert.equal(state.phase, 'waiting');
});

test('a bus past the boarding stop with the rider still there is missed at once', () => {
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:10:25.000Z'),
    at('2026-08-31T10:10:30.000Z'),
    S,
    live({ bus: { legIndex: 1, progress: { kind: 'toAlighting', stops: 3 }, recordedAt: '2026-08-31T10:10:20.000Z', lat: 32.07, lon: 34.78 } }),
  );
  assert.equal(state.phase, 'off-plan');
  assert.equal(state.offPlan, 'missed-departure');
});

test('a stale bus report changes nothing', () => {
  const state = resolveJourneyState(
    journey(),
    near(32.061, 34.771),
    at('2026-08-31T10:13:00.000Z'),
    S,
    live({ bus: { legIndex: 1, progress: { kind: 'toBoarding', stops: 2 }, recordedAt: '2026-08-31T10:05:00.000Z', lat: 32.05, lon: 34.76 } }),
  );
  assert.equal(state.offPlan, 'missed-departure');
  assert.equal(state.busStopsAway, null);
});

test('a connection that no longer holds is a missed transfer, while riding and while walking to it', () => {
  const broken = live({ connections: [{ afterLegIndex: 1, holds: false, fetchedAt: '2026-08-31T10:14:50.000Z' }] });
  const riding = resolveJourneyState(twoRideJourney(), null, at('2026-08-31T10:15:00.000Z'), S, broken);
  assert.equal(riding.phase, 'off-plan');
  assert.equal(riding.offPlan, 'missed-transfer');

  const walking = resolveJourneyState(twoRideJourney(), null, at('2026-08-31T10:32:00.000Z'), S, live({
    connections: [{ afterLegIndex: 1, holds: false, fetchedAt: '2026-08-31T10:31:50.000Z' }],
  }));
  assert.equal(walking.offPlan, 'missed-transfer');
});

test('a connection the server cannot vouch for is not a missed transfer', () => {
  const state = resolveJourneyState(twoRideJourney(), null, at('2026-08-31T10:15:00.000Z'), S, live({
    connections: [{ afterLegIndex: 1, holds: null, fetchedAt: '2026-08-31T10:14:50.000Z' }],
  }));
  assert.equal(state.phase, 'riding');
});

test('the arrival shifts by the last ride\'s live delay', () => {
  const scheduled = resolveJourneyState(journey(), null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(scheduled.arrivalTime, '2026-08-31T10:35:00.000Z');
  assert.equal(scheduled.timeSource, 'scheduled');

  const shifted = resolveJourneyState(journey(), null, at('2026-08-31T10:15:00.000Z'), S, live({
    legs: [liveLeg(1, '2026-08-31T10:14:30.000Z', { arrival: '2026-08-31T10:33:00.000Z' })],
  }));
  assert.equal(shifted.arrivalTime, '2026-08-31T10:38:00.000Z');
});

const busOn = (stops: number, recordedAt: string, lat: number, lon: number) =>
  live({ bus: { legIndex: 1, progress: { kind: 'toAlighting', stops }, recordedAt, lat, lon } });

test('with no fix, a fresh bus counts the stops', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:15:00.000Z'), S, busOn(2, '2026-08-31T10:14:40.000Z', 32.07, 34.78));
  assert.equal(state.phase, 'riding');
  assert.equal(state.stopsRemaining, 2);
  assert.equal(state.stopsSource, 'bus');
  assert.equal(state.nextStopName, 'Mid A');
});

test('an inaccurate fix gives way to a fresh bus', () => {
  const state = resolveJourneyState(
    journey(), fix(32.061, 34.771, '2026-08-31T10:14:58.000Z', 400), at('2026-08-31T10:15:00.000Z'), S,
    busOn(2, '2026-08-31T10:14:40.000Z', 32.07, 34.78),
  );
  assert.equal(state.stopsSource, 'bus');
  assert.equal(state.stopsRemaining, 2);
});

test('a stale fix gives way to a fresh bus, and the bus can raise the alert', () => {
  const state = resolveJourneyState(
    journey(), fix(32.07, 34.78, '2026-08-31T10:00:00.000Z'), at('2026-08-31T10:25:00.000Z'), S,
    busOn(1, '2026-08-31T10:24:45.000Z', 32.075, 34.785),
  );
  assert.equal(state.phase, 'alight-soon');
  assert.equal(state.stopsSource, 'bus');
});

test('a good fix always wins over the bus', () => {
  const state = resolveJourneyState(
    journey(), fix(32.07, 34.78, '2026-08-31T10:14:55.000Z'), at('2026-08-31T10:15:00.000Z'), S,
    busOn(1, '2026-08-31T10:14:40.000Z', 32.075, 34.785),
  );
  assert.equal(state.stopsRemaining, 2);
  assert.equal(state.stopsSource, 'rider');
});

test('a weak fix with no fresh bus is still used, exactly as before', () => {
  const state = resolveJourneyState(
    journey(), near(32.07, 34.78), at('2026-08-31T10:15:00.000Z'), S,
    busOn(1, '2026-08-31T10:10:00.000Z', 32.075, 34.785),
  );
  assert.equal(state.stopsRemaining, 2);
  assert.equal(state.stopsSource, 'rider');
});

test('no fix and no fresh bus leaves the count to the clock', () => {
  const state = resolveJourneyState(journey(), null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(state.stopsRemaining, null);
  assert.equal(state.stopsSource, null);
  assert.equal(state.nextStopName, null);
});

test('the next stop is the nearest one until the rider is past it', () => {
  const before = resolveJourneyState(journey(), fix(32.069, 34.779, '2026-08-31T10:14:58.000Z'), at('2026-08-31T10:15:00.000Z'));
  assert.equal(before.nextStopName, 'Mid A');
  const past = resolveJourneyState(journey(), fix(32.071, 34.781, '2026-08-31T10:14:58.000Z'), at('2026-08-31T10:15:00.000Z'));
  assert.equal(past.nextStopName, 'Mid B');
  // Just short of Allenby: AT it, GPS has the rider off the bus and walking.
  const last = resolveJourneyState(journey(), fix(32.0791, 34.7891, '2026-08-31T10:24:58.000Z'), at('2026-08-31T10:25:00.000Z'));
  assert.equal(last.nextStopName, 'Allenby');
});

test('a late bus still on its way past its scheduled ride is waited for, not an overshoot', () => {
  // 10:31: the timetable says the ride ended a minute ago and the walk began,
  // but the rider is still at Rothschild and the bus has not reached it.
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:30:55.000Z'),
    at('2026-08-31T10:31:00.000Z'),
    S,
    live({ bus: { legIndex: 1, progress: { kind: 'toBoarding', stops: 1 }, recordedAt: '2026-08-31T10:30:40.000Z', lat: 32.05, lon: 34.76 } }),
  );
  assert.equal(state.phase, 'waiting');
  assert.equal(state.offPlan, null);
  assert.equal(state.legIndex, 1);
  assert.equal(state.busStopsAway, 1);
});

test('a predicted departure still ahead keeps a ride in play past its scheduled window', () => {
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:30:55.000Z'),
    at('2026-08-31T10:31:00.000Z'),
    S,
    live({ legs: [liveLeg(1, '2026-08-31T10:30:40.000Z', { departure: '2026-08-31T10:33:00.000Z' })] }),
  );
  assert.equal(state.phase, 'waiting');
  assert.equal(state.timer?.to, '2026-08-31T10:33:00.000Z');
  assert.equal(state.timeSource, 'live');
});

test('a journey running late by live data has not arrived at its scheduled end', () => {
  const late = (fetchedAt: string) => live({ legs: [liveLeg(1, fetchedAt, { arrival: '2026-08-31T10:33:00.000Z' })] });
  const stillGoing = resolveJourneyState(journey(), null, at('2026-08-31T10:35:30.000Z'), S, late('2026-08-31T10:35:00.000Z'));
  assert.notEqual(stillGoing.phase, 'arrived');
  assert.equal(stillGoing.arrivalTime, '2026-08-31T10:38:00.000Z');
  assert.equal(stillGoing.timer?.to, '2026-08-31T10:38:00.000Z');

  const done = resolveJourneyState(journey(), null, at('2026-08-31T10:38:10.000Z'), S, late('2026-08-31T10:37:50.000Z'));
  assert.equal(done.phase, 'arrived');

  // Once the prediction lapses the journey ends by the timetable again.
  const lapsed = resolveJourneyState(journey(), null, at('2026-08-31T10:35:30.000Z'), S, late('2026-08-31T10:30:00.000Z'));
  assert.equal(lapsed.phase, 'arrived');
});

test('a fix taken before the bus report cannot prove the bus left without the rider', () => {
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:10:15.000Z'),
    at('2026-08-31T10:10:30.000Z'),
    S,
    live({ bus: { legIndex: 1, progress: { kind: 'toAlighting', stops: 3 }, recordedAt: '2026-08-31T10:10:20.000Z', lat: 32.07, lon: 34.78 } }),
  );
  assert.equal(state.offPlan, null);
});

test('a fix too coarse to place the rider at the stop cannot either', () => {
  const state = resolveJourneyState(
    journey(),
    fix(32.061, 34.771, '2026-08-31T10:10:25.000Z', 120),
    at('2026-08-31T10:10:30.000Z'),
    S,
    live({ bus: { legIndex: 1, progress: { kind: 'toAlighting', stops: 3 }, recordedAt: '2026-08-31T10:10:20.000Z', lat: 32.07, lon: 34.78 } }),
  );
  assert.equal(state.offPlan, null);
});

// --- Moving by GPS rather than by the timetable ---------------------------

const tracked = (gpsLegIndex: number) => ({ ...journey(), gpsLegIndex });

test('a slow walker is still walking after the walk\'s scheduled minutes', () => {
  // 10:08: the timetable has them waiting at Rothschild; they are ~130 m short.
  const state = resolveJourneyState(tracked(0), fix(32.0601, 34.7701, '2026-08-31T10:07:55.000Z'), at('2026-08-31T10:08:00.000Z'));
  assert.equal(state.phase, 'walking-to-stop');
  assert.equal(state.legIndex, 0);
  assert.equal(state.trackedLegIndex, 0);
});

test('a first good fix starts GPS tracking, even on an untracked journey', () => {
  const state = resolveJourneyState(journey(), fix(32.0601, 34.7701, '2026-08-31T10:07:55.000Z'), at('2026-08-31T10:08:00.000Z'));
  assert.equal(state.legIndex, 0);
  assert.equal(state.trackedLegIndex, 0);
});

test('reaching the stop early moves on to the ride before its window', () => {
  const state = resolveJourneyState(tracked(0), fix(32.061, 34.771, '2026-08-31T10:02:55.000Z'), at('2026-08-31T10:03:00.000Z'));
  assert.equal(state.phase, 'waiting');
  assert.equal(state.legIndex, 1);
  assert.equal(state.trackedLegIndex, 1);
});

test('a rider still on a late bus is riding after its scheduled arrival, not overshooting', () => {
  // 10:32, two minutes past the scheduled arrival, still at Mid A.
  const state = resolveJourneyState(tracked(1), fix(32.07, 34.78, '2026-08-31T10:31:55.000Z'), at('2026-08-31T10:32:00.000Z'));
  assert.equal(state.phase, 'riding');
  assert.equal(state.legIndex, 1);
  assert.equal(state.stopsRemaining, 2);
});

test('getting off at the stop moves on to the walk', () => {
  const state = resolveJourneyState(tracked(1), fix(32.08, 34.79, '2026-08-31T10:24:55.000Z'), at('2026-08-31T10:25:00.000Z'));
  assert.equal(state.phase, 'arriving');
  assert.equal(state.legIndex, 2);
});

test('a tracked journey holds its leg without a fix instead of following the clock', () => {
  const state = resolveJourneyState(tracked(0), null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(state.phase, 'walking-to-stop');
  assert.equal(state.legIndex, 0);
});

test('a tracked journey never slides back to an earlier leg', () => {
  const state = resolveJourneyState(tracked(2), fix(32.07, 34.78, '2026-08-31T10:24:55.000Z'), at('2026-08-31T10:25:00.000Z'));
  assert.equal(state.legIndex, 2);
});

test('a long walk away from the alight stop is the walk, not an overshoot', () => {
  // 1.5 km on from Allenby, past the arrival -- but along the walk's own route.
  const longWalk = tracked(2);
  const walk = longWalk.itinerary.legs[2];
  if (walk?.type === 'walk') walk.to = { type: 'coordinate', lat: 32.1, lon: 34.81 };
  const state = resolveJourneyState(longWalk, fix(32.093, 34.803, '2026-08-31T10:39:55.000Z'), at('2026-08-31T10:40:00.000Z'));
  assert.equal(state.phase, 'arriving');
  assert.equal(state.offPlan, null);
});

test('a tracked journey ends on reaching the destination, early or late', () => {
  const early = resolveJourneyState(tracked(2), fix(32.081, 34.791, '2026-08-31T10:31:55.000Z'), at('2026-08-31T10:32:00.000Z'));
  assert.equal(early.phase, 'arrived');

  // Past the scheduled arrival and still walking: not over.
  const late = resolveJourneyState(tracked(2), fix(32.0802, 34.7902, '2026-08-31T10:39:55.000Z'), at('2026-08-31T10:40:00.000Z'));
  assert.equal(late.phase, 'arriving');
});

test('a tracked journey that never reaches the destination ends at the backstop', () => {
  assert.equal(resolveJourneyState(tracked(2), null, at('2026-08-31T11:00:00.000Z')).phase, 'arriving');
  assert.equal(resolveJourneyState(tracked(2), null, at('2026-08-31T11:05:30.000Z')).phase, 'arrived');
});

test('there is no next stop once the point is past the alight stop', () => {
  // Beyond Allenby, farther from Mid B than Allenby itself is, but well inside
  // the overshoot radius.
  const state = resolveJourneyState(journey(), fix(32.083, 34.793, '2026-08-31T10:24:58.000Z'), at('2026-08-31T10:25:00.000Z'));
  assert.equal(state.nextStopName, null);
});

// Leaving before the plan said to and catching the run before the planned one:
// the rider is moving along the ride's route while the planned bus is still to
// come. Everything the plan says about that bus is about a bus they are not on.
const MID_A = { lat: 32.07, lon: 34.78 };

test('carried along the route before the planned bus leaves, the rider is riding', () => {
  const state = resolveJourneyState(
    journey(),
    fix(MID_A.lat, MID_A.lon, '2026-08-31T10:05:00.000Z'),
    at('2026-08-31T10:05:00.000Z'),
  );
  assert.equal(state.phase, 'riding');
  assert.equal(state.offPlan, null);
});

test('a broken connection is not held against a rider already past that bus', () => {
  const live: LiveJourneyInput = {
    legs: [],
    connections: [{ afterLegIndex: 1, holds: false, fetchedAt: '2026-08-31T10:04:30.000Z' }],
    bus: null,
  };
  const state = resolveJourneyState(
    twoRideJourney(),
    fix(MID_A.lat, MID_A.lon, '2026-08-31T10:05:00.000Z'),
    at('2026-08-31T10:05:00.000Z'),
    DEFAULT_ALERT_SETTINGS,
    live,
  );
  assert.equal(state.phase, 'riding');
  assert.equal(state.offPlan, null);
});

// The control: still on the pavement, so the verdict is about their own bus.
test('a broken connection still stands for a rider waiting at the stop', () => {
  const live: LiveJourneyInput = {
    legs: [],
    connections: [{ afterLegIndex: 1, holds: false, fetchedAt: '2026-08-31T10:04:30.000Z' }],
    bus: null,
  };
  const state = resolveJourneyState(
    twoRideJourney(),
    fix(32.061, 34.771, '2026-08-31T10:05:00.000Z'),
    at('2026-08-31T10:05:00.000Z'),
    DEFAULT_ALERT_SETTINGS,
    live,
  );
  assert.equal(state.phase, 'off-plan');
  assert.equal(state.offPlan, 'missed-transfer');
});
