import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TFunction } from 'i18next';

import { at, sampleJourney, twoRideJourney } from './journey-fixtures';
import { liveLabelFor, offPlanLine } from './journey-labels';
import { resolveJourneyState } from './journey-machine';
import { DEFAULT_ALERT_SETTINGS } from './types';

const t = ((key: string) => key) as unknown as TFunction;

test('a missed transfer names the line being caught, not the one being ridden', () => {
  const journey = twoRideJourney();
  const state = resolveJourneyState(journey, null, at('2026-08-31T10:15:00.000Z'), DEFAULT_ALERT_SETTINGS, {
    legs: [], bus: null, connections: [{ afterLegIndex: 1, holds: false, fetchedAt: '2026-08-31T10:14:50.000Z' }],
  });
  assert.equal(offPlanLine(journey.itinerary, state)?.route.shortName, '142');
});

test('other divergences name the vehicle in play', () => {
  const journey = sampleJourney();
  const state = resolveJourneyState(journey, { lat: 32.061, lon: 34.771, accuracyMeters: 10, at: '2026-08-31T10:13:00.000Z' }, at('2026-08-31T10:13:00.000Z'));
  assert.equal(state.offPlan, 'missed-departure');
  assert.equal(offPlanLine(journey.itinerary, state)?.route.shortName, '480');
});

test('the live label marks countdowns to a departure, and only when realtime exists', () => {
  const journey = sampleJourney();
  const waitingLive = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'), DEFAULT_ALERT_SETTINGS, {
    legs: [{ legIndex: 1, predictedDeparture: '2026-08-31T10:12:00.000Z', predictedArrival: null, fetchedAt: '2026-08-31T10:06:50.000Z' }],
    connections: [], bus: null,
  });
  assert.equal(liveLabelFor(waitingLive, true, t), 'journey.live.live');
  assert.equal(liveLabelFor(waitingLive, false, t), '');

  const waitingScheduled = resolveJourneyState(journey, null, at('2026-08-31T10:07:00.000Z'));
  assert.equal(liveLabelFor(waitingScheduled, true, t), 'journey.live.scheduled');

  const riding = resolveJourneyState(journey, null, at('2026-08-31T10:15:00.000Z'));
  assert.equal(liveLabelFor(riding, true, t), '');
});
