import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JourneyCheckResponse } from '@/api/journey-check';
import { legsToCheck } from '@/api/journey-check';
import { twoRideItinerary } from './journey-fixtures';
import { liveFromCheck } from './live-input';

const end = (predicted: boolean) => ({ stopId: 's', name: null, delaySeconds: predicted ? 60 : 0, predicted });

test('maps request positions back to itinerary legs and keeps only predicted times', () => {
  const checked = legsToCheck(twoRideItinerary(), 0);
  const response: JourneyCheckResponse = {
    at: '2026-08-31T10:00:00.000Z',
    arrivalTime: '2026-08-31T10:56:00.000Z',
    holds: false,
    legs: [
      { tripId: 't1', from: { ...end(true), scheduledDeparture: 'x', departure: '2026-08-31T10:11:00.000Z' }, to: { ...end(false), scheduledArrival: 'x', arrival: '2026-08-31T10:30:00.000Z' } },
      { tripId: 't2', from: { ...end(false), scheduledDeparture: 'x', departure: '2026-08-31T10:40:00.000Z' }, to: { ...end(false), scheduledArrival: 'x', arrival: '2026-08-31T10:55:00.000Z' } },
    ],
    connections: [{ afterLeg: 0, slackSeconds: 10, requiredSeconds: 90, holds: false }],
  };

  const mapped = liveFromCheck(response, checked, '2026-08-31T10:00:05.000Z');

  assert.deepEqual(mapped.legs, [
    { legIndex: 1, predictedDeparture: '2026-08-31T10:11:00.000Z', predictedArrival: null, fetchedAt: '2026-08-31T10:00:05.000Z' },
    { legIndex: 3, predictedDeparture: null, predictedArrival: null, fetchedAt: '2026-08-31T10:00:05.000Z' },
  ]);
  assert.deepEqual(mapped.connections, [{ afterLegIndex: 1, holds: false, fetchedAt: '2026-08-31T10:00:05.000Z' }]);
});

test('a response for a different chain than was asked maps to nothing', () => {
  const checked = legsToCheck(twoRideItinerary(), 0);
  const response: JourneyCheckResponse = {
    at: 'x', arrivalTime: 'x', holds: null, connections: [],
    legs: [{ tripId: 'other', from: { ...end(true), scheduledDeparture: 'x', departure: 'x' }, to: { ...end(true), scheduledArrival: 'x', arrival: 'x' } }],
  };
  assert.deepEqual(liveFromCheck(response, checked, 'x').legs, []);
});

test('a response carried over from an earlier chain maps no connection onto the new one', () => {
  // Asked while riding leg 1: [t1, t2]. Kept on screen while the chain shifts
  // to [t2] alone -- position 0 now means leg 3, and the old "after t1" verdict
  // must not become a verdict about what follows t2.
  const response: JourneyCheckResponse = {
    at: 'x', arrivalTime: 'x', holds: false,
    legs: [
      { tripId: 't1', from: { ...end(false), scheduledDeparture: 'x', departure: 'x' }, to: { ...end(false), scheduledArrival: 'x', arrival: 'x' } },
      { tripId: 't2', from: { ...end(true), scheduledDeparture: 'x', departure: '2026-08-31T10:41:00.000Z' }, to: { ...end(false), scheduledArrival: 'x', arrival: 'x' } },
    ],
    connections: [{ afterLeg: 0, slackSeconds: -30, requiredSeconds: 90, holds: false }],
  };
  const shifted = legsToCheck(twoRideItinerary(), 3);

  const mapped = liveFromCheck(response, shifted, '2026-08-31T10:33:00.000Z');

  assert.deepEqual(mapped.connections, []);
  assert.deepEqual(mapped.legs, []);
});

test('a connection maps only when both of its legs match what was asked', () => {
  const checked = legsToCheck(twoRideItinerary(), 0);
  const response: JourneyCheckResponse = {
    at: 'x', arrivalTime: 'x', holds: false,
    legs: [
      { tripId: 't1', from: { ...end(false), scheduledDeparture: 'x', departure: 'x' }, to: { ...end(false), scheduledArrival: 'x', arrival: 'x' } },
      { tripId: 'other', from: { ...end(false), scheduledDeparture: 'x', departure: 'x' }, to: { ...end(false), scheduledArrival: 'x', arrival: 'x' } },
    ],
    connections: [{ afterLeg: 0, slackSeconds: -30, requiredSeconds: 90, holds: false }],
  };
  assert.deepEqual(liveFromCheck(response, checked, 'x').connections, []);
});
