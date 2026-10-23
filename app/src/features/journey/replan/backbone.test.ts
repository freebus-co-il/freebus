import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backboneOf, respectsBackbone, sameStation, stationOf } from './backbone';
import { itin, ride, stop, walk } from './fixtures';

const HOME = stop('home', 0);
const FEED = stop('feeder', 300);
const SAVIDOR = stop('savidor', 2000);
const RAANANA = stop('raanana', 20000);

const trainTrip = itin([
  walk(HOME, FEED),
  ride({ line: '125', from: FEED, to: SAVIDOR, dep: 5, arr: 45 }),
  ride({ routeType: 2, line: 'IR', from: SAVIDOR, to: RAANANA, dep: 50, arr: 65 }),
]);

test('backboneOf picks the train over a longer bus', () => {
  const found = backboneOf(trainTrip);
  assert.equal(found?.legIndex, 2);
  assert.equal(found?.backbone.mode, 'rail');
  assert.equal(found?.backbone.board.stopId, 'savidor');
});

test('backboneOf picks the longest ride among buses', () => {
  const found = backboneOf(itin([
    ride({ line: 'A', from: HOME, to: FEED, dep: 0, arr: 10 }),
    ride({ line: 'B', from: FEED, to: SAVIDOR, dep: 12, arr: 40 }),
  ]));
  assert.equal(found?.legIndex, 1);
  assert.equal(found?.backbone.mode, 'bus');
});

test('backboneOf returns null for a walk-only itinerary', () => {
  assert.equal(backboneOf(itin([walk(HOME, FEED)], 0, 5)), null);
});

test('sameStation matches by stop id and by 200 m, not by 300 m', () => {
  assert.equal(sameStation(stationOf(stop('x', 0)), stationOf(stop('x', 5000))), true);
  assert.equal(sameStation(stationOf(stop('a', 0)), stationOf(stop('b', 200))), true);
  assert.equal(sameStation(stationOf(stop('a', 0)), stationOf(stop('b', 300))), false);
});

test('respectsBackbone accepts a different feeder bus into the same train', () => {
  const { backbone } = backboneOf(trainTrip)!;
  const other = itin([
    ride({ line: '189', from: HOME, to: SAVIDOR, dep: 3, arr: 30 }),
    ride({ routeType: 2, line: 'IR', from: SAVIDOR, to: RAANANA, dep: 35, arr: 50 }),
  ]);
  assert.equal(respectsBackbone(other, backbone), true);
});

test('respectsBackbone rejects an all-bus candidate when the backbone is rail', () => {
  const { backbone } = backboneOf(trainTrip)!;
  const bus = itin([ride({ line: '605', from: SAVIDOR, to: RAANANA, dep: 50, arr: 60 })]);
  assert.equal(respectsBackbone(bus, backbone), false);
});

test('respectsBackbone accepts the same train boarding at a stop 150 m away', () => {
  const { backbone } = backboneOf(trainTrip)!;
  const near = itin([
    ride({ routeType: 2, line: 'IR', from: stop('savidor-2', 2150), to: RAANANA, dep: 50, arr: 65 }),
  ]);
  assert.equal(respectsBackbone(near, backbone), true);
});

test('backboneAhead: the boundary holds until the rider reaches the backbone ride', async () => {
  const { backboneAhead } = await import('./backbone');
  const { backbone } = backboneOf(trainTrip)!;
  assert.equal(backboneAhead(backbone, trainTrip.legs.slice(0, 2)), backbone);
});

test('backboneAhead: once the backbone ride is kept (ridden or riding), only the destination is fixed', async () => {
  const { backboneAhead } = await import('./backbone');
  const { backbone } = backboneOf(trainTrip)!;
  assert.equal(backboneAhead(backbone, trainTrip.legs), null);
});
