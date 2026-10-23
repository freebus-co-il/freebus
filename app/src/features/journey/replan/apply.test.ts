import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleItinerary } from '../journey-fixtures';
import { legToAcknowledge, responseApplies } from './apply';

test('responseApplies only while the journey and its itinerary are the ones the request was made for', () => {
  const before = sampleItinerary();
  assert.equal(responseApplies('j1', before, { id: 'j1', itinerary: before }), true);
  assert.equal(responseApplies('j1', before, { id: 'j1', itinerary: sampleItinerary() }), false);
  assert.equal(responseApplies('j1', before, { id: 'j2', itinerary: before }), false);
  assert.equal(responseApplies('j1', before, null), false);
});

test('legToAcknowledge: moving past a ride acknowledges it, whether or not the in-app alert fired', () => {
  const itinerary = sampleItinerary();
  assert.equal(legToAcknowledge(1, 2, itinerary, null), 1);
  assert.equal(legToAcknowledge(1, 2, itinerary, 1), null);
  assert.equal(legToAcknowledge(0, 1, itinerary, null), null);
  assert.equal(legToAcknowledge(1, 1, itinerary, null), null);
  assert.equal(legToAcknowledge(null, 2, itinerary, null), null);
});
