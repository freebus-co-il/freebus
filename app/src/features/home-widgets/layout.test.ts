import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addToLayout, parseStoredLayout, removeFromLayout, resolveLayout } from './layout';

const REGISTERED = ['nearby', 'commute', 'weather'];

test('a never-edited layout is the default widgets that are registered', () => {
  assert.deepEqual(resolveLayout(null, REGISTERED, ['nearby']), ['nearby']);
  assert.deepEqual(resolveLayout(null, ['commute'], ['nearby']), []);
});

test('an empty layout is kept: the rider chose it', () => {
  assert.deepEqual(resolveLayout([], REGISTERED, ['nearby']), []);
});

test('widgets nothing registers, and repeats, are dropped; order is kept', () => {
  assert.deepEqual(resolveLayout(['commute', 'removed', 'nearby', 'commute'], REGISTERED, ['nearby']), ['commute', 'nearby']);
});

test('anything but a list reads back as never edited', () => {
  assert.equal(parseStoredLayout(undefined), null);
  assert.equal(parseStoredLayout('nearby'), null);
  assert.equal(parseStoredLayout({ 0: 'nearby' }), null);
  assert.deepEqual(parseStoredLayout(['nearby', 3, 'commute']), ['nearby', 'commute']);
});

test('adding appends once, removing takes it off', () => {
  assert.deepEqual(addToLayout(['nearby'], 'commute'), ['nearby', 'commute']);
  assert.deepEqual(addToLayout(['nearby'], 'nearby'), ['nearby']);
  assert.deepEqual(removeFromLayout(['nearby', 'commute'], 'nearby'), ['commute']);
});
