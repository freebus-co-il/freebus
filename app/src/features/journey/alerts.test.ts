import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary } from '@/api/types';

import { planAlightAlerts } from './alerts';
import type { ActiveJourney } from './types';
import { DEFAULT_ALERT_SETTINGS } from './types';

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

test('every ride gets a pre-scheduled alight alert', () => {
  const alerts = planAlightAlerts(journey(), DEFAULT_ALERT_SETTINGS);
  assert.equal(alerts[0].legIndex, 1);
  // 90s before the 10:30 arrival.
  assert.equal(alerts[0].fireAt, '2026-08-31T10:28:30.000Z');
  assert.equal(alerts[0].kind, 'alight');
});

test('the default schedules one repeat, because one alert is missable', () => {
  const alerts = planAlightAlerts(journey(), DEFAULT_ALERT_SETTINGS);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].fireAt, '2026-08-31T10:29:00.000Z');
  assert.equal(alerts[1].legIndex, 1);
});

test('the repeat is a second scheduled alert, not a runtime timer', () => {
  // Both are absolute instants fixed at planning time, so the second one
  // still fires if the app is killed between the two.
  const alerts = planAlightAlerts(journey(), DEFAULT_ALERT_SETTINGS);
  assert.ok(alerts.every((alert) => !Number.isNaN(Date.parse(alert.fireAt))));
  assert.ok(Date.parse(alerts[1].fireAt) > Date.parse(alerts[0].fireAt));
});

test('repeatUntilAcknowledged keeps alerting up to the arrival', () => {
  const alerts = planAlightAlerts(journey(), { ...DEFAULT_ALERT_SETTINGS, repeatUntilAcknowledged: true });
  assert.deepEqual(
    alerts.map((alert) => alert.fireAt),
    ['2026-08-31T10:28:30.000Z', '2026-08-31T10:29:00.000Z', '2026-08-31T10:29:30.000Z'],
  );
});

test('a lead too short to fit a repeat still gets its one alert', () => {
  const alerts = planAlightAlerts(journey(), { ...DEFAULT_ALERT_SETTINGS, leadSeconds: 30 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].fireAt, '2026-08-31T10:29:30.000Z');
});

test('a longer lead moves the alert earlier', () => {
  const alerts = planAlightAlerts(journey(), { ...DEFAULT_ALERT_SETTINGS, leadSeconds: 300 });
  assert.equal(alerts[0].fireAt, '2026-08-31T10:25:00.000Z');
});

test('alert ids are stable so re-planning replaces rather than duplicates', () => {
  const first = planAlightAlerts(journey(), DEFAULT_ALERT_SETTINGS);
  const second = planAlightAlerts(journey(), DEFAULT_ALERT_SETTINGS);
  assert.deepEqual(first.map((a) => a.id), second.map((a) => a.id));
});
