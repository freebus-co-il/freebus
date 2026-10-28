import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WalkStep } from '@/api/types';

import {
  angleBetween, bearingAlong, cumulativeMeters, guidanceMeters, OFF_ROUTE_METERS, pointAlong, projectOntoPath, walkGuidance, type Point,
} from './walk-guidance';

const METERS_PER_DEGREE = 111_320;
const LAT = 32;
const metersPerLon = METERS_PER_DEGREE * Math.cos((LAT * Math.PI) / 180);

/** A point `north` and `east` metres from a fixed origin. */
const at = (north: number, east: number): Point => ({ lat: LAT + north / METERS_PER_DEGREE, lon: 34.8 + east / metersPerLon });

/** 200 m north, then a right turn and 100 m east. */
const L_PATH = [at(0, 0), at(100, 0), at(200, 0), at(200, 50), at(200, 100)];
const L_STEPS: WalkStep[] = [
  { maneuver: 'depart', street: 'Herzl', lengthMeters: 200, beginShapeIndex: 0, endShapeIndex: 2 },
  { maneuver: 'right', street: 'Weizmann', lengthMeters: 100, beginShapeIndex: 2, endShapeIndex: 4 },
  { maneuver: 'arrive', street: null, lengthMeters: 0, beginShapeIndex: 4, endShapeIndex: 4 },
];

const near = (actual: number, expected: number, tolerance = 2) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('the path is measured along its own points', () => {
  const cumulative = cumulativeMeters(L_PATH);
  near(cumulative[2]!, 200);
  near(cumulative[4]!, 300);
  const middle = pointAlong(L_PATH, 250);
  near((middle.lon - 34.8) * metersPerLon, 50);
});

test('a point is placed on the path by its nearest place, with how far off it is', () => {
  const projection = projectOntoPath(at(150, 12), L_PATH)!;
  near(projection.alongMeters, 150);
  near(projection.offsetMeters, 12);
});

test('the next turn is the right turn, counted down as the rider walks to it', () => {
  const start = walkGuidance(L_PATH, L_STEPS, at(0, 0))!;
  assert.equal(start.maneuver, 'right');
  assert.equal(start.street, 'Weizmann');
  near(start.metersToManeuver, 200);
  near(start.remainingMeters, 300);

  const closer = walkGuidance(L_PATH, L_STEPS, at(150, 3))!;
  assert.equal(closer.maneuver, 'right');
  near(closer.metersToManeuver, 50);
  assert.equal(closer.offRoute, false);
});

test('at the turn itself, and past it, what is next is arriving', () => {
  assert.equal(walkGuidance(L_PATH, L_STEPS, at(197, 0))!.maneuver, 'arrive');
  const past = walkGuidance(L_PATH, L_STEPS, at(200, 30))!;
  assert.equal(past.maneuver, 'arrive');
  assert.equal(past.street, null);
  near(past.metersToManeuver, 70);
});

test('a rider far from the line is off route', () => {
  assert.equal(walkGuidance(L_PATH, L_STEPS, at(100, OFF_ROUTE_METERS + 10))!.offRoute, true);
  assert.equal(walkGuidance(L_PATH, L_STEPS, at(100, OFF_ROUTE_METERS - 10))!.offRoute, false);
});

test('a walk with no turns, or no position yet, still says how far there is to go', () => {
  const noSteps = walkGuidance(L_PATH, [], at(100, 0))!;
  assert.equal(noSteps.maneuver, 'arrive');
  near(noSteps.metersToManeuver, 200);
  const noPosition = walkGuidance(L_PATH, L_STEPS, null)!;
  assert.equal(noPosition.maneuver, 'right');
  near(noPosition.metersToManeuver, 200);
  assert.equal(noPosition.offRoute, false);
  assert.equal(walkGuidance([at(0, 0)], L_STEPS, null), null);
});

test('the path heads north before the turn and east after it', () => {
  near(bearingAlong(L_PATH, 50)!, 0, 1);
  near(bearingAlong(L_PATH, 260)!, 90, 1);
});

test('headings wrap around north', () => {
  assert.equal(angleBetween(350, 10), 20);
  assert.equal(angleBetween(10, 350), 20);
  assert.equal(angleBetween(90, 270), 180);
  assert.equal(angleBetween(45, 45), 0);
});

test('distances to a turn are rounded the way a walker reads them', () => {
  assert.equal(guidanceMeters(3), 10);
  assert.equal(guidanceMeters(84), 80);
  assert.equal(guidanceMeters(237), 250);
  assert.equal(guidanceMeters(1240), 1200);
});
