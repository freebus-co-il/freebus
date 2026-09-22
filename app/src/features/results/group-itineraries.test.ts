import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary, TransitLeg } from '@/api/types';
import { twoRideItinerary } from '@/features/journey/journey-fixtures';

import { groupItineraries, itinerarySignature } from './group-itineraries';

/** The fixture's two rides, the first on `line` and leaving `minutes` later. */
function variant(line: string, minutes: number): Itinerary {
  const base = twoRideItinerary();
  const shift = (iso: string) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
  const first = base.legs[1] as TransitLeg;
  const legs = base.legs.slice();
  legs[1] = { ...first, route: { ...first.route, id: `route-${line}`, shortName: line }, tripId: `trip-${line}-${minutes}` };
  return { ...base, legs, departureTime: shift(base.departureTime) };
}

test('the same stops on different lines are one trip', () => {
  assert.equal(itinerarySignature(variant('480', 0)), itinerarySignature(variant('202', 10)));
  const groups = groupItineraries([variant('480', 0), variant('202', 10)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.instances.map((i) => (i.legs[1] as TransitLeg).route.shortName), ['480', '202']);
});

test('different stops are different trips, even on the same line', () => {
  const elsewhere = variant('480', 0);
  const ride = elsewhere.legs[1] as TransitLeg;
  elsewhere.legs[1] = { ...ride, from: { ...ride.from, stop: { ...ride.from.stop, stopId: 'other' } } };
  assert.equal(groupItineraries([variant('480', 0), elsewhere]).length, 2);
});

test('two lines leaving at the same minute are one departure, the first one kept', () => {
  const groups = groupItineraries([variant('480', 0), variant('202', 0), variant('5', 20)]);
  assert.deepEqual(groups[0]!.instances.map((i) => (i.legs[1] as TransitLeg).route.shortName), ['480', '5']);
});
