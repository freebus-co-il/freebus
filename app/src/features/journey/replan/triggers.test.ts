import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JourneyPhase, JourneyState, LiveJourneyInput } from '../types';
import { ms, t } from './fixtures';
import { replanReason, type ReplanMemory } from './triggers';

function state(phase: JourneyPhase, overrides: Partial<JourneyState> = {}): JourneyState {
  return {
    phase, legIndex: 1, leg: null, stopsRemaining: null, timer: null, offPlan: null, progress: 0.3,
    timeSource: 'live', busStopsAway: null, stopsSource: null, nextStopName: null,
    arrivalTime: t(60), trackedLegIndex: null, boardedLegIndex: null, ridingEarly: false, ...overrides,
  };
}

const fresh: ReplanMemory = { lastRunAt: null, lastSwitchAt: null, inFlight: false, arrivalAtLastPlan: t(60) };
const ranAt = (minutes: number): ReplanMemory => ({ ...fresh, lastRunAt: ms(minutes) });
const noLive: LiveJourneyInput = { legs: [], connections: [], bus: null };

test('null while a re-plan is in flight', () => {
  assert.equal(replanReason({ state: state('waiting', { offPlan: 'missed-departure' }), live: noLive, memory: { ...fresh, inFlight: true }, nowMs: ms(10) }), null);
});

test('null once arrived', () => {
  assert.equal(replanReason({ state: state('arrived'), live: noLive, memory: fresh, nowMs: ms(10) }), null);
});

test('throttle beats an off-plan event 20 s after the last run', () => {
  const nowMs = ms(10);
  assert.equal(replanReason({ state: state('off-plan', { offPlan: 'missed-departure' }), live: noLive, memory: { ...fresh, lastRunAt: nowMs - 20_000 }, nowMs }), null);
});

test('off-plan triggers once the throttle has passed', () => {
  assert.equal(replanReason({ state: state('off-plan', { offPlan: 'missed-departure' }), live: noLive, memory: ranAt(9), nowMs: ms(10) }), 'off-plan');
});

test('a connection that will not hold triggers', () => {
  const live: LiveJourneyInput = { legs: [], connections: [{ afterLegIndex: 1, holds: false, fetchedAt: t(9) }], bus: null };
  assert.equal(replanReason({ state: state('riding'), live, memory: ranAt(5), nowMs: ms(10) }), 'connection-broken');
});

test('an unknown connection (null) does not trigger', () => {
  const live: LiveJourneyInput = { legs: [], connections: [{ afterLegIndex: 1, holds: null, fetchedAt: t(9) }], bus: null };
  assert.equal(replanReason({ state: state('riding'), live, memory: ranAt(5), nowMs: ms(10) }), null);
});

test('a live arrival shift of 2 minutes triggers', () => {
  assert.equal(replanReason({ state: state('riding', { arrivalTime: t(62) }), live: noLive, memory: ranAt(5), nowMs: ms(10) }), 'live-shift');
});

test('a shift of 1 minute does not', () => {
  assert.equal(replanReason({ state: state('riding', { arrivalTime: t(61) }), live: noLive, memory: ranAt(5), nowMs: ms(10) }), null);
});

test('steady beat while waiting, first time and after 2 minutes', () => {
  assert.equal(replanReason({ state: state('waiting'), live: noLive, memory: fresh, nowMs: ms(10) }), 'steady');
  assert.equal(replanReason({ state: state('waiting'), live: noLive, memory: ranAt(8), nowMs: ms(10) }), 'steady');
  assert.equal(replanReason({ state: state('walking-to-stop'), live: noLive, memory: ranAt(9), nowMs: ms(10) }), null);
});

test('returns null while riding with nothing changed after 10 minutes', () => {
  assert.equal(replanReason({ state: state('riding'), live: noLive, memory: ranAt(0), nowMs: ms(10) }), null);
});
