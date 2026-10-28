import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleJourney } from '../journey-fixtures';
import { itin, stop, walk } from './fixtures';
import { withBackbone } from './restore';

test('withBackbone fills a missing backbone from the itinerary', () => {
  const restored = withBackbone(sampleJourney());
  assert.equal(restored.backbone?.mode, 'bus');
  assert.equal(restored.backbone?.board.stopId, 's1');
  assert.equal(restored.backbone?.alight.stopId, 's4');
});

test('withBackbone leaves an existing backbone untouched', () => {
  const backbone = { mode: 'rail' as const, board: { stopId: 'x', lat: 1, lon: 1, name: null }, alight: { stopId: 'y', lat: 2, lon: 2, name: null } };
  const journey = { ...sampleJourney(), backbone };
  assert.equal(withBackbone(journey).backbone, backbone);
});

test('withBackbone leaves null for a walk-only journey', () => {
  const journey = { ...sampleJourney(), itinerary: itin([walk(stop('a'), stop('b', 100))], 0, 5) };
  assert.equal(withBackbone(journey).backbone, null);
});
