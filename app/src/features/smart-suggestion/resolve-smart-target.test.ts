import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SelectedPlace } from '@/lib/place';

import { AT_HOME_RADIUS_METERS, resolveSmartTarget } from './resolve-smart-target';

const HOME = { lat: 32.0853, lon: 34.7818 };
const HOME_PLACE: SelectedPlace = { kind: 'coordinate', ...HOME, label: 'Home' };
const WORK_PLACE: SelectedPlace = { kind: 'coordinate', lat: 32.0684, lon: 34.7942, label: 'Work' };

/** Moves `meters` due north of `from` -- latitude degrees are ~111.32 km
 *  apart everywhere, so this needs no longitude correction. */
function metersNorthOf(from: { lat: number; lon: number }, meters: number) {
  return { lat: from.lat + meters / 111_320, lon: from.lon };
}

test('suggests work when standing at home', () => {
  const target = resolveSmartTarget(HOME, HOME_PLACE, WORK_PLACE);

  assert.deepEqual(target, { preset: 'work', place: WORK_PLACE });
});

test('suggests home when away from home', () => {
  const target = resolveSmartTarget({ lat: 32.0684, lon: 34.7942 }, HOME_PLACE, WORK_PLACE);

  assert.deepEqual(target, { preset: 'home', place: HOME_PLACE });
});

test('suggests home from just outside the at-home radius', () => {
  const justOutside = metersNorthOf(HOME, AT_HOME_RADIUS_METERS + 20);

  const target = resolveSmartTarget(justOutside, HOME_PLACE, WORK_PLACE);

  assert.deepEqual(target, { preset: 'home', place: HOME_PLACE });
});

test('suggests work from just inside the at-home radius', () => {
  const justInside = metersNorthOf(HOME, AT_HOME_RADIUS_METERS - 20);

  const target = resolveSmartTarget(justInside, HOME_PLACE, WORK_PLACE);

  assert.deepEqual(target, { preset: 'work', place: WORK_PLACE });
});

test('suggests nothing when standing at home with no work saved', () => {
  assert.equal(resolveSmartTarget(HOME, HOME_PLACE, null), null);
});

test('suggests nothing without a location fix', () => {
  assert.equal(resolveSmartTarget(null, HOME_PLACE, WORK_PLACE), null);
});

test('suggests nothing when no home is saved', () => {
  assert.equal(resolveSmartTarget(HOME, null, WORK_PLACE), null);
});

// Home is what "am I at home?" is measured against, so a home saved before
// coordinates were carried through (see `SelectedPlace`) cannot answer it.
test('suggests nothing when home is a stop saved without coordinates', () => {
  const coordinateless: SelectedPlace = { kind: 'stop', stopId: '12345', name: 'Home stop' };

  assert.equal(resolveSmartTarget(HOME, coordinateless, WORK_PLACE), null);
});

// Work is only ever planned TO, never measured against -- `/plan` addresses a
// stop by id, so work needs no coordinates of its own.
test('suggests a work stop saved without coordinates', () => {
  const coordinateless: SelectedPlace = { kind: 'stop', stopId: '54321', name: 'Work stop' };

  const target = resolveSmartTarget(HOME, HOME_PLACE, coordinateless);

  assert.deepEqual(target, { preset: 'work', place: coordinateless });
});
