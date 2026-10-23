import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TransitLeg } from '@/api/types';

import { itin, ms, ride, stop } from '../replan/fixtures';
import { alsoLines, stopLadder, walkVerdict } from './sheet-copy';

test('walkVerdict: plenty from 2 minutes of slack, hurry below, late when negative', () => {
  assert.equal(walkVerdict(120), 'plenty');
  assert.equal(walkVerdict(119), 'hurry');
  assert.equal(walkVerdict(0), 'hurry');
  assert.equal(walkVerdict(-1), 'late');
});

const A = stop('a', 0);
const A2 = stop('a2', 100);
const B = stop('b', 3000);
const FAR = stop('far', 900);

const leg: TransitLeg = {
  ...ride({ line: '125', tripId: 'hero', from: A, to: B, dep: 10, arr: 30 }),
  alternatives: [
    { ...ride({ line: '189', tripId: 'alt189', from: A, to: B, dep: 12, arr: 31 }), arrivalDelaySeconds: 60 },
    { ...ride({ line: '125', tripId: 'later125', from: A, to: B, dep: 25, arr: 45 }), arrivalDelaySeconds: 900 },
  ],
};

test('alsoLines lists other lines from this stop by departure, at most 2, without the hero', () => {
  const candidates = [
    itin([ride({ line: '61', tripId: 'c61', from: A2, to: B, dep: 11, arr: 29 })]),
    itin([ride({ line: '5', tripId: 'c5', from: FAR, to: B, dep: 9, arr: 25 })]),
    itin([ride({ line: '24', tripId: 'c24', from: A, to: B, dep: 14, arr: 33 })]),
  ];
  const lines = alsoLines(leg, candidates, ms(5));
  assert.deepEqual(lines.map((line) => line.route.shortName), ['61', '189']);
});

test('alsoLines drops buses already gone', () => {
  assert.deepEqual(alsoLines(leg, [], ms(13)).map((line) => line.route.shortName), []);
});

const riding: TransitLeg = {
  ...ride({ line: '125', from: A, to: B, dep: 10, arr: 30 }),
  intermediateStops: [stop('s1', 500, 'One'), stop('s2', 1000, 'Two'), stop('s3', 1500, 'Three'), stop('s4', 2000, 'Four')],
};

test('stopLadder: next, the one after, how many hidden, then the alighting stop', () => {
  const ladder = stopLadder(riding, 4);
  assert.equal(ladder?.next.name, 'Two');
  assert.equal(ladder?.after?.name, 'Three');
  assert.equal(ladder?.hidden, 1);
  assert.equal(ladder?.alight.stopId, 'b');
});

test('stopLadder with one stop left is just the alighting stop', () => {
  const ladder = stopLadder(riding, 1);
  assert.equal(ladder?.next.stopId, 'b');
  assert.equal(ladder?.after, null);
  assert.equal(ladder?.hidden, 0);
});

test('stopLadder is null without a stop count', () => {
  assert.equal(stopLadder(riding, null), null);
});

test('alsoLines leaves out a fresh line that would drop the trip\'s backbone', () => {
  const backbone = { mode: 'bus' as const, board: { stopId: 'a', lat: A.lat, lon: A.lon, name: null }, alight: { stopId: 'b', lat: B.lat, lon: B.lon, name: null } };
  const candidates = [
    itin([ride({ line: '61', tripId: 'c61', from: A2, to: B, dep: 11, arr: 29 })]),
    itin([ride({ line: '7', tripId: 'c7', from: A, to: FAR, dep: 11, arr: 20 })]),
  ];
  assert.deepEqual(alsoLines(leg, candidates, ms(5), backbone).map((line) => line.route.shortName), ['61', '189']);
});
