import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleItinerary } from './journey-fixtures';
import { distanceToPathMeters, reachedFromRegion, trackLegIndex } from './journey-progress';

// sampleItinerary: walk from (32.06, 34.77) to Rothschild (32.061, 34.771),
// ride Rothschild -> Mid A (32.07, 34.78) -> Mid B (32.075, 34.785) -> Allenby
// (32.08, 34.79), walk from Allenby to (32.081, 34.791). Each walk is ~145 m.
const ORIGIN = { lat: 32.0601, lon: 34.7701 };
const ROTHSCHILD = { lat: 32.061, lon: 34.771 };
const MID_A = { lat: 32.07, lon: 34.78 };
const MID_B = { lat: 32.075, lon: 34.785 };
const ALLENBY = { lat: 32.08, lon: 34.79 };
const DESTINATION = { lat: 32.081, lon: 34.791 };
const NOWHERE = { lat: 32.2, lon: 34.9 };

test('distance to a path is the perpendicular to its nearest segment', () => {
  const path = [{ lat: 32, lon: 34 }, { lat: 32, lon: 34.01 }];
  assert.ok(Math.abs(distanceToPathMeters({ lat: 32.001, lon: 34.005 }, path) - 111.32) < 1);
});

test('no usable fix leaves the placement where it was', () => {
  assert.equal(trackLegIndex(sampleItinerary(), null, null, 1), null);
  assert.equal(trackLegIndex(sampleItinerary(), 1, null, 2), 1);
});

test('a first fix on the expected leg\'s route places the rider there', () => {
  assert.equal(trackLegIndex(sampleItinerary(), null, MID_A, 1), 1);
});

// The case the timetable gets wrong: it says the ride began, the rider is
// still walking to the stop.
test('a first fix on another leg\'s route places the rider on that leg', () => {
  assert.equal(trackLegIndex(sampleItinerary(), null, ORIGIN, 1), 0);
  // It says the ride ended; they are still on the bus.
  assert.equal(trackLegIndex(sampleItinerary(), null, MID_B, 2), 1);
});

test('a first fix on no route at all trusts the timetable', () => {
  assert.equal(trackLegIndex(sampleItinerary(), null, NOWHERE, 1), 1);
});

test('a walk is finished by reaching the stop, not by its minutes running out', () => {
  assert.equal(trackLegIndex(sampleItinerary(), 0, ORIGIN, 0), 0);
  assert.equal(trackLegIndex(sampleItinerary(), 0, ROTHSCHILD, 0), 1);
});

test('a ride is finished at the stop it is got off at, not at the stops before', () => {
  assert.equal(trackLegIndex(sampleItinerary(), 1, MID_B, 1), 1);
  assert.equal(trackLegIndex(sampleItinerary(), 1, ALLENBY, 1), 2);
});

test('reaching the destination finishes the journey', () => {
  assert.equal(trackLegIndex(sampleItinerary(), 2, DESTINATION, 2), 3);
});

test('a rider found well along a later leg is moved onto it', () => {
  assert.equal(trackLegIndex(sampleItinerary(), 0, MID_A, 0), 1);
});

test('the placement never moves backwards', () => {
  assert.equal(trackLegIndex(sampleItinerary(), 2, MID_A, 1), 2);
  assert.equal(trackLegIndex(sampleItinerary(), 3, ORIGIN, 0), 3);
});

test('a geofence places the rider by the stop it rings', () => {
  const itinerary = sampleItinerary();
  assert.equal(reachedFromRegion(itinerary, 'board:1'), 1);
  assert.equal(reachedFromRegion(itinerary, 'alight:1'), 2);
  assert.equal(reachedFromRegion(itinerary, 'destination'), 3);
  assert.equal(reachedFromRegion(itinerary, 'wake:1'), null);
  // A walk has no regions of its own; an id naming one is not evidence.
  assert.equal(reachedFromRegion(itinerary, 'board:0'), null);
});
