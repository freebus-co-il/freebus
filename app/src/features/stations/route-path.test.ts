import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RouteShapeResponse } from '@/api/types';

import { routePath } from './route-path';

const shape = (attribution: RouteShapeResponse['attribution'], points = 2): RouteShapeResponse => ({
  geometry: { type: 'LineString', coordinates: Array.from({ length: points }, (_, i) => [34.78 + i / 100, 32.05]) },
  geometryFallback: false,
  attribution,
});

test('routePath credits a line drawn from OpenStreetMap rail track', () => {
  assert.equal(routePath(shape('osm'), '#000')?.credit, 'osm');
});

test('routePath does not credit a line drawn from the feed', () => {
  assert.equal(routePath(shape(null), '#000')?.credit, null);
  assert.equal(routePath(shape(undefined), '#000')?.credit, null);
});

test('routePath puts latitude first, as the map wants it', () => {
  assert.deepEqual(routePath(shape(null), '#000')?.coordinates[0], { latitude: 32.05, longitude: 34.78 });
});

test('routePath draws nothing for fewer than two points', () => {
  assert.equal(routePath(shape('osm', 1), '#000'), null);
});
