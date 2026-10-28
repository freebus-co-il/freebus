import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardPanTarget, cardPlacement } from './vehicle-card-placement';

const map = { width: 400, height: 380 };

test('the card hangs above the bus: its foot clears the dot and the arrow', () => {
  assert.equal(cardPlacement({ bus: { x: 200, y: 300 }, map }).bottom, 107);
});

test('the arrow points at the bus, measured from the card\'s own left edge', () => {
  assert.equal(cardPlacement({ bus: { x: 200, y: 300 }, map }).arrowLeft, 182);
});

test('the arrow stays off the card\'s rounded corners when the bus is near a side', () => {
  assert.equal(cardPlacement({ bus: { x: 5, y: 300 }, map }).arrowLeft, 22);
});

test('a bus with room for the card above it and its label below leaves the camera alone', () => {
  assert.equal(cardPanTarget({ bus: { x: 200, y: 300 }, map, cardHeight: 120, insetTop: 100 }), null);
});

test('a bus too near the top moves down just far enough for the card to fit', () => {
  assert.deepEqual(
    cardPanTarget({ bus: { x: 200, y: 50 }, map, cardHeight: 120, insetTop: 100 }),
    { x: 200, y: -7 },
  );
});

test('a bus too near the bottom moves up until its label shows', () => {
  assert.deepEqual(
    cardPanTarget({ bus: { x: 200, y: 370 }, map, cardHeight: 120, insetTop: 100 }),
    { x: 200, y: 220 },
  );
});

test('on a map too short for the card, the bus still lands where it can be seen', () => {
  assert.deepEqual(
    cardPanTarget({ bus: { x: 200, y: 100 }, map: { width: 400, height: 200 }, cardHeight: 120, insetTop: 100 }),
    { x: 200, y: 40 },
  );
});

test('a bus off the side of the map is brought back to the middle', () => {
  assert.deepEqual(
    cardPanTarget({ bus: { x: -30, y: 300 }, map, cardHeight: 120, insetTop: 100 }),
    { x: -30, y: 190 },
  );
});
