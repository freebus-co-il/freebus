import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampDrag, moveItem, offsetOf, slotDrag, stepAside, targetIndex } from './reorder-math';

// Three rows of mixed height: 0-60, 60-140, 140-200.
const HEIGHTS = [60, 80, 60];

test('rows start where the ones above them end', () => {
  assert.equal(offsetOf(HEIGHTS, 0), 0);
  assert.equal(offsetOf(HEIGHTS, 2), 140);
  assert.equal(offsetOf(HEIGHTS, 3), 200);
});

test('a drag stops at either end of the column', () => {
  assert.equal(clampDrag(HEIGHTS, 0, -50), 0);
  assert.equal(clampDrag(HEIGHTS, 0, 500), 140);
  assert.equal(clampDrag(HEIGHTS, 2, -500), -140);
  assert.equal(clampDrag(HEIGHTS, 1, 10), 10);
});

test('the landing slot changes once an edge passes the next row middle', () => {
  // Row 1's middle is at 100: row 0's bottom edge (60) reaches it after 40.
  assert.equal(targetIndex(HEIGHTS, 0, 39), 0);
  assert.equal(targetIndex(HEIGHTS, 0, 41), 1);
  assert.equal(targetIndex(HEIGHTS, 0, 140), 2);
  assert.equal(targetIndex(HEIGHTS, 2, -140), 0);
  // A row taller than its neighbours stays put until it is really moved.
  assert.equal(targetIndex(HEIGHTS, 1, 0), 1);
  assert.equal(targetIndex(HEIGHTS, 1, 29), 1);
  assert.equal(targetIndex(HEIGHTS, 1, 31), 2);
  assert.equal(targetIndex(HEIGHTS, 1, -31), 0);
});

test('a dropped row settles exactly into its slot', () => {
  assert.equal(slotDrag(HEIGHTS, 0, 2), 140);
  assert.equal(slotDrag(HEIGHTS, 0, 1), 80);
  assert.equal(slotDrag(HEIGHTS, 2, 0), -140);
  assert.equal(slotDrag(HEIGHTS, 1, 1), 0);
});

test('passed rows step aside by the dragged row height, the rest stay', () => {
  // Row 0 dragged down to slot 2: rows 1 and 2 move up by 60.
  assert.deepEqual([0, 1, 2].map((index) => stepAside(HEIGHTS, index, 0, 2)), [0, -60, -60]);
  // Row 2 dragged up to slot 1: row 1 moves down by 60, row 0 stays.
  assert.deepEqual([0, 1, 2].map((index) => stepAside(HEIGHTS, index, 2, 1)), [0, 60, 0]);
});

test('dropping moves the item and keeps the rest in order', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});
