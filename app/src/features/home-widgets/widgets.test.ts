import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_HOME_WIDGETS,
  addHomeWidget,
  availableHomeWidgets,
  moveHomeWidget,
  parseHomeWidgets,
  removeHomeWidget,
} from './widgets';

test('a missing or malformed layout falls back to the default', () => {
  assert.deepEqual(parseHomeWidgets(undefined), DEFAULT_HOME_WIDGETS);
  assert.deepEqual(parseHomeWidgets(null), DEFAULT_HOME_WIDGETS);
  assert.deepEqual(parseHomeWidgets('nearby'), DEFAULT_HOME_WIDGETS);
  assert.deepEqual(parseHomeWidgets({ 0: 'nearby' }), DEFAULT_HOME_WIDGETS);
});

test('an empty layout is kept: the rider chose it', () => {
  assert.deepEqual(parseHomeWidgets([]), []);
});

test('unknown and repeated widgets are dropped, order is kept', () => {
  assert.deepEqual(parseHomeWidgets(['commute', 'weather', 3, 'nearby', 'commute']), ['commute', 'nearby']);
});

test('adding appends once', () => {
  assert.deepEqual(addHomeWidget(['nearby'], 'commute'), ['nearby', 'commute']);
  assert.deepEqual(addHomeWidget(['nearby'], 'nearby'), ['nearby']);
});

test('removing takes the widget off the page', () => {
  assert.deepEqual(removeHomeWidget(['nearby', 'commute'], 'nearby'), ['commute']);
  assert.deepEqual(removeHomeWidget(['commute'], 'nearby'), ['commute']);
});

test('moving swaps with the neighbour and stops at either end', () => {
  assert.deepEqual(moveHomeWidget(['nearby', 'commute'], 'commute', -1), ['commute', 'nearby']);
  assert.deepEqual(moveHomeWidget(['nearby', 'commute'], 'nearby', 1), ['commute', 'nearby']);
  assert.deepEqual(moveHomeWidget(['nearby', 'commute'], 'nearby', -1), ['nearby', 'commute']);
  assert.deepEqual(moveHomeWidget(['nearby', 'commute'], 'commute', 1), ['nearby', 'commute']);
  assert.deepEqual(moveHomeWidget(['nearby'], 'commute', -1), ['nearby']);
});

test('the add list holds only what is not on the page', () => {
  assert.deepEqual(availableHomeWidgets(['nearby']).map((widget) => widget.id), ['commute']);
  assert.deepEqual(availableHomeWidgets(['commute', 'nearby']), []);
});
