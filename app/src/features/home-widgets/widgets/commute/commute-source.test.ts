import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JourneyPoint } from '@/features/custom-journeys/types';
import type { SelectedPlace } from '@/lib/place';

import {
  closestStartIndex,
  emptyCommuteSource,
  parseCommuteSource,
  placeDestinationIndex,
} from './commute-source';

const at = (lat: number, lon: number, label = 'p'): SelectedPlace => ({ kind: 'coordinate', lat, lon, label });
const journey = (...places: SelectedPlace[]): JourneyPoint[] =>
  places.map((place, index) => ({ id: `p${index}`, place, via: 'any' }));

const TEL_AVIV = at(32.0853, 34.7818);
const HAIFA = at(32.794, 34.9896);
const JERUSALEM = at(31.7683, 35.2137);

test('anything unrecognised reads as the Home and Work card', () => {
  assert.deepEqual(parseCommuteSource(undefined), { kind: 'smart' });
  assert.deepEqual(parseCommuteSource('places'), { kind: 'smart' });
  assert.deepEqual(parseCommuteSource({ kind: 'weather' }), { kind: 'smart' });
});

test('places and journeys keep their ids, and drop ones that are not strings', () => {
  assert.deepEqual(parseCommuteSource({ kind: 'places', first: 'home', second: 7 }), {
    kind: 'places', first: 'home', second: null,
  });
  assert.deepEqual(parseCommuteSource({ kind: 'journeys', there: 'cj1', back: 'cj2' }), {
    kind: 'journeys', there: 'cj1', back: 'cj2',
  });
});

test('a journey with no way back stored goes back reversed', () => {
  assert.deepEqual(parseCommuteSource({ kind: 'journeys', there: 'cj1' }), {
    kind: 'journeys', there: 'cj1', back: 'reverse',
  });
  assert.deepEqual(emptyCommuteSource('journeys'), { kind: 'journeys', there: null, back: 'reverse' });
});

test('between two places, the trip goes to the one further away', () => {
  const nearTelAviv = { lat: 32.08, lon: 34.78 };
  assert.equal(placeDestinationIndex(nearTelAviv, TEL_AVIV, HAIFA), 1);
  assert.equal(placeDestinationIndex(nearTelAviv, HAIFA, TEL_AVIV), 0);
});

test('a place with no coordinates is planned to, not from', () => {
  const stop: SelectedPlace = { kind: 'stop', stopId: '1', name: 'Old stop' };
  assert.equal(placeDestinationIndex({ lat: 32.08, lon: 34.78 }, TEL_AVIV, stop), 1);
});

test('of a journey and its way back, the one starting closer is previewed', () => {
  const there = journey(TEL_AVIV, JERUSALEM);
  const back = journey(JERUSALEM, TEL_AVIV);
  assert.equal(closestStartIndex({ lat: 32.08, lon: 34.78 }, [there, back]), 0);
  assert.equal(closestStartIndex({ lat: 31.77, lon: 35.21 }, [there, back]), 1);
});

test('without a fix the outbound journey is previewed', () => {
  assert.equal(closestStartIndex(null, [journey(TEL_AVIV, HAIFA), journey(HAIFA, TEL_AVIV)]), 0);
});
