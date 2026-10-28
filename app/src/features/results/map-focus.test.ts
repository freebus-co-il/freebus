import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleItinerary } from '@/features/journey/journey-fixtures';

import { legFocusCoordinates, MIN_FOCUS_SPAN_METERS, withMinimumSpan, type LatLng } from './map-focus';

const METERS_PER_DEGREE_LAT = 111_320;

function spanMeters(points: LatLng[]) {
  const lats = points.map((point) => point.latitude);
  const lons = points.map((point) => point.longitude);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  return {
    lat: (Math.max(...lats) - Math.min(...lats)) * METERS_PER_DEGREE_LAT,
    lon: (Math.max(...lons) - Math.min(...lons)) * METERS_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180),
  };
}

test('a ride frames its two ends and every stop it passes', () => {
  const points = legFocusCoordinates(sampleItinerary(), 1);
  assert.deepEqual(points, [
    { latitude: 32.061, longitude: 34.771 },
    { latitude: 32.07, longitude: 34.78 },
    { latitude: 32.075, longitude: 34.785 },
    { latitude: 32.08, longitude: 34.79 },
  ]);
});

test('a leg that does not exist frames nothing', () => {
  assert.deepEqual(legFocusCoordinates(sampleItinerary(), 9), []);
});

test('a 30 m walk is widened to the minimum span on both axes, around its centre', () => {
  const walk = [
    { latitude: 32.06, longitude: 34.77 },
    { latitude: 32.0602, longitude: 34.7702 },
  ];
  const padded = withMinimumSpan(walk);
  const span = spanMeters(padded);
  assert.ok(Math.abs(span.lat - MIN_FOCUS_SPAN_METERS) < 1, `lat span ${span.lat}`);
  assert.ok(Math.abs(span.lon - MIN_FOCUS_SPAN_METERS) < 1, `lon span ${span.lon}`);
  // The original points are kept, so nothing the leg draws falls outside.
  assert.deepEqual(padded.slice(0, 2), walk);
});

test('a leg already wider than the minimum comes back untouched', () => {
  const ride = legFocusCoordinates(sampleItinerary(), 1);
  assert.equal(withMinimumSpan(ride), ride);
});

test('a single point still gets a span to frame', () => {
  const span = spanMeters(withMinimumSpan([{ latitude: 32.06, longitude: 34.77 }]));
  assert.ok(span.lat >= MIN_FOCUS_SPAN_METERS - 1 && span.lon >= MIN_FOCUS_SPAN_METERS - 1);
});
