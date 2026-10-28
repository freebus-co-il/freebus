import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Itinerary, TransitAlternative, TransitLeg } from '@/api/types';
import { twoRideItinerary } from '@/features/journey/journey-fixtures';

import { equallyGoodLines, lineOptions, lineVerdict, withLineChosen } from './line-options';

/** The same ride on another line, shifted by `minutes`. */
function onLine(leg: TransitLeg, shortName: string, tripId: string, minutes: number): TransitAlternative {
  const shift = (iso: string) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
  const { alternatives: _ignored, ...rest } = leg;
  return {
    ...rest,
    route: { ...leg.route, id: `route-${shortName}`, shortName },
    tripId,
    from: { ...leg.from, departureTime: shift(leg.from.departureTime), stopSequence: 7 },
    to: { ...leg.to, arrivalTime: shift(leg.to.arrivalTime), stopSequence: 12 },
    numStops: 5,
    intermediateStops: [],
    geometry: `line-${shortName}`,
  };
}

/** Two rides (480 at leg 1, 142 at leg 3), each with alternatives. */
function withAlternatives(): Itinerary {
  const itinerary = twoRideItinerary();
  const first = itinerary.legs[1] as TransitLeg;
  const second = itinerary.legs[3] as TransitLeg;
  first.alternatives = [onLine(first, '202', 'a202', 3), onLine(first, '10', 'a10', -4)];
  second.alternatives = [onLine(second, '5', 'a5', -2)];
  return itinerary;
}

const lines = (options: { route: { shortName: string } }[]) => options.map((option) => option.route.shortName);

test('the options are the planned line and its alternatives, in departure order', () => {
  const leg = withAlternatives().legs[1] as TransitLeg;
  assert.deepEqual(lines(lineOptions(leg)), ['10', '480', '202']);
  assert.equal('alternatives' in lineOptions(leg)[1]!, false);
});

test('a leg without alternatives -- a journey stored before they existed -- has only itself', () => {
  const leg = twoRideItinerary().legs[1] as TransitLeg;
  assert.deepEqual(lines(lineOptions(leg)), ['480']);
});

test('choosing a line puts its stops, route and geometry on the leg, and keeps the rest to go back to', () => {
  const next = withLineChosen(withAlternatives(), 1, 'a202')!;
  const leg = next.legs[1] as TransitLeg;
  assert.equal(leg.tripId, 'a202');
  assert.equal(leg.route.shortName, '202');
  assert.equal(leg.geometry, 'line-202');
  assert.equal(leg.numStops, 5);
  assert.deepEqual(leg.intermediateStops, []);
  assert.equal(leg.from.stopSequence, 7);
  assert.deepEqual(lines(leg.alternatives ?? []), ['10', '480']);

  const back = withLineChosen(next, 1, 't1')!;
  assert.equal((back.legs[1] as TransitLeg).tripId, 't1');
  assert.deepEqual(lines((back.legs[1] as TransitLeg).alternatives ?? []), ['10', '202']);
});

test('a first ride on another line moves when the rider sets out, not when they arrive', () => {
  const before = withAlternatives();
  const next = withLineChosen(before, 1, 'a10')!;
  assert.equal(next.departureTime, '2026-08-31T09:56:00.000Z');
  assert.equal(next.arrivalTime, before.arrivalTime);
  assert.equal(next.durationSeconds, before.durationSeconds + 240);
});

test('a last ride on another line moves the arrival, not the departure', () => {
  const before = withAlternatives();
  const next = withLineChosen(before, 3, 'a5')!;
  assert.equal(next.departureTime, before.departureTime);
  assert.equal(next.arrivalTime, '2026-08-31T10:53:00.000Z');
  assert.equal(next.durationSeconds, before.durationSeconds - 120);
});

test('the other legs are left exactly as they were', () => {
  const before = withAlternatives();
  const next = withLineChosen(before, 1, 'a202')!;
  assert.equal(next.legs[0], before.legs[0]);
  assert.equal(next.legs[2], before.legs[2]);
  assert.equal(next.legs[3], before.legs[3]);
  assert.equal((before.legs[1] as TransitLeg).tripId, 't1');
});

test('nothing to change is null', () => {
  const itinerary = withAlternatives();
  assert.equal(withLineChosen(itinerary, 1, 't1'), null, 'already on it');
  assert.equal(withLineChosen(itinerary, 1, 'nope'), null, 'not an option');
  assert.equal(withLineChosen(itinerary, 0, 'a202'), null, 'a walk');
  assert.equal(withLineChosen(itinerary, 9, 'a202'), null, 'no such leg');
});

const option = (overrides: Partial<TransitAlternative>): TransitAlternative => {
  const { alternatives: _ignored, ...leg } = twoRideItinerary().legs[1] as TransitLeg;
  return { ...leg, missesConnection: false, arrivalDelaySeconds: 0, ...overrides };
};

test('a bus that misses the connection reads as the minutes the next connection costs', () => {
  assert.deepEqual(
    lineVerdict(option({ missesConnection: true, arrivalDelaySeconds: 1200 }), option({})),
    { kind: 'slower', minutesLater: 20 },
  );
});

test('a slower bus that still makes the same connection costs nothing', () => {
  assert.deepEqual(lineVerdict(option({ arrivalDelaySeconds: 60 }), option({})), { kind: 'same' });
});

test('sooner is told too, and small differences either way are not', () => {
  assert.deepEqual(lineVerdict(option({ arrivalDelaySeconds: -300 }), option({})), { kind: 'sooner', minutesSooner: 5 });
  assert.deepEqual(lineVerdict(option({ arrivalDelaySeconds: 179 }), option({})), { kind: 'same' });
  assert.deepEqual(lineVerdict(option({ arrivalDelaySeconds: 180 }), option({})), { kind: 'slower', minutesLater: 3 });
});

test('a missed connection with no onward trip to measure still says it misses', () => {
  assert.deepEqual(lineVerdict(option({ missesConnection: true, arrivalDelaySeconds: null }), option({})), { kind: 'misses' });
});

test('after switching, the others are measured against the bus the rider is on', () => {
  const onLate = option({ missesConnection: true, arrivalDelaySeconds: 1800 });
  assert.deepEqual(lineVerdict(option({}), onLate), { kind: 'sooner', minutesSooner: 30 });
  assert.deepEqual(lineVerdict(option({ missesConnection: true, arrivalDelaySeconds: 1800 }), onLate), { kind: 'same' });
});

test('the results card lists only lines that do as well, once each', () => {
  const leg = withAlternatives().legs[1] as TransitLeg;
  leg.alternatives = [
    { ...onLine(leg, '202', 'a202', 3), missesConnection: false, arrivalDelaySeconds: 0 },
    { ...onLine(leg, '202', 'b202', 9), missesConnection: false, arrivalDelaySeconds: 0 },
    { ...onLine(leg, '10', 'a10', 6), missesConnection: true, arrivalDelaySeconds: 1200 },
    { ...onLine(leg, '480', 'next480', 12), route: leg.route, missesConnection: false, arrivalDelaySeconds: 0 },
  ];
  assert.deepEqual(lines(equallyGoodLines(leg)), ['202']);
});
