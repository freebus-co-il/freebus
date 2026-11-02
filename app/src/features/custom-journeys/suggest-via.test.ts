import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SelectedPlace } from '@/lib/place';

import { suggestVia } from './suggest-via';

const WORK: SelectedPlace = { kind: 'coordinate', lat: 32.0745, lon: 34.7922, label: 'Work' };
const HASHALOM: SelectedPlace = { kind: 'stop', stopId: '37350', name: 'Hashalom', lat: 32.073346, lon: 34.793256, rail: true };
const BINYAMINA: SelectedPlace = { kind: 'stop', stopId: '37372', name: 'Binyamina', lat: 32.514386, lon: 34.949573, rail: true };
const HOME: SelectedPlace = { kind: 'coordinate', lat: 32.4723, lon: 34.9707, label: 'Home' };
const FAR_BUS_STOP: SelectedPlace = { kind: 'stop', stopId: '3027', name: 'Yeshurun School', lat: 32.472538, lon: 34.969166 };

test('a short hop to the station is a walk', () => {
  assert.equal(suggestVia(WORK, HASHALOM), 'walk');
});

test('two stations are the train', () => {
  assert.equal(suggestVia(HASHALOM, BINYAMINA), 'train');
});

test('from a station to somewhere further is the bus', () => {
  assert.equal(suggestVia(BINYAMINA, HOME), 'bus');
});

test('to a station from somewhere further is the bus', () => {
  assert.equal(suggestVia(HOME, BINYAMINA), 'bus');
});

test('two far places with no station are left to the planner', () => {
  assert.equal(suggestVia(WORK, HOME), 'any');
  assert.equal(suggestVia(WORK, FAR_BUS_STOP), 'any');
});

test('a stop saved without coordinates is judged by its kind alone', () => {
  const noCoordinates: SelectedPlace = { kind: 'stop', stopId: '37350', name: 'Hashalom', rail: true };
  assert.equal(suggestVia(noCoordinates, BINYAMINA), 'train');
});
