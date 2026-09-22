import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withAlpha } from './route-color';

test('withAlpha turns a six-digit hex into rgba at the given opacity', () => {
  assert.equal(withAlpha('#3399FF', 0.3), 'rgba(51, 153, 255, 0.3)');
});

test('withAlpha expands a three-digit hex', () => {
  assert.equal(withAlpha('#666', 0.5), 'rgba(102, 102, 102, 0.5)');
});
