import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseNearbyStyle } from './nearby-style';

test('the nearby widget keeps its map unless the list was chosen', () => {
  assert.equal(parseNearbyStyle('list'), 'list');
  assert.equal(parseNearbyStyle('map'), 'map');
  assert.equal(parseNearbyStyle(undefined), 'map');
  assert.equal(parseNearbyStyle('grid'), 'map');
});
