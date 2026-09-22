import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldTickOnCardChange } from './carousel-tick';

test('a swipe onto a different card ticks', () => {
  assert.equal(shouldTickOnCardChange(0, 1, true), true);
  assert.equal(shouldTickOnCardChange(2, 1, true), true);
});

test('the carousel arriving does not tick', () => {
  // The first viewability report fires on mount. The rider opened a screen;
  // they did not swipe.
  assert.equal(shouldTickOnCardChange(null, 0, true), false);
  assert.equal(shouldTickOnCardChange(null, 3, true), false);
});

test('the app scrolling the carousel itself does not tick', () => {
  // The journey screen advances this as legs complete, and that moment has
  // its own haptic already.
  assert.equal(shouldTickOnCardChange(0, 1, false), false);
});

test('a report about the card already showing does not tick', () => {
  assert.equal(shouldTickOnCardChange(1, 1, true), false);
});
