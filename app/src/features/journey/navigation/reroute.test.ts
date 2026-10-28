import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REROUTE_AFTER_OFF_ROUTE_SECONDS, REROUTE_MIN_INTERVAL_SECONDS, shouldReroute } from './reroute';

const NOW = new Date('2026-08-31T10:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

test('a rider on the line is never re-routed', () => {
  assert.equal(shouldReroute({ offRouteSince: null, lastRerouteAt: null, accuracyMeters: 5, now: NOW }), false);
});

test('a moment off the line is not enough; staying off it is', () => {
  const base = { lastRerouteAt: null, accuracyMeters: 10, now: NOW };
  assert.equal(shouldReroute({ ...base, offRouteSince: ago(REROUTE_AFTER_OFF_ROUTE_SECONDS - 1) }), false);
  assert.equal(shouldReroute({ ...base, offRouteSince: ago(REROUTE_AFTER_OFF_ROUTE_SECONDS) }), true);
});

test('re-routes are spaced out', () => {
  const base = { offRouteSince: ago(60), accuracyMeters: 10, now: NOW };
  assert.equal(shouldReroute({ ...base, lastRerouteAt: ago(REROUTE_MIN_INTERVAL_SECONDS - 1) }), false);
  assert.equal(shouldReroute({ ...base, lastRerouteAt: ago(REROUTE_MIN_INTERVAL_SECONDS) }), true);
});

test('a vague fix cannot say the rider left the line', () => {
  assert.equal(shouldReroute({ offRouteSince: ago(60), lastRerouteAt: null, accuracyMeters: 120, now: NOW }), false);
});
