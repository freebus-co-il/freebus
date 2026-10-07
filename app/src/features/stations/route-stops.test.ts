import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PARKED, routeStopDots, stopDotSlots } from './route-stops';
import type { RunStop } from './station-line';

const stop = (stopId: string, lat: number): RunStop => ({ stopId, name: `stop ${stopId}`, lat, lon: 34.8, time: null });
const run = [stop('a', 32.0), stop('b', 32.1), stop('here', 32.2), stop('c', 32.3), stop('d', 32.4)];

test('routeStopDots marks every stop but the station, dimming the ones already behind it', () => {
  assert.deepEqual(routeStopDots(run, 2), [
    { latitude: 32.0, longitude: 34.8, name: 'stop a', dimmed: true },
    { latitude: 32.1, longitude: 34.8, name: 'stop b', dimmed: true },
    { latitude: 32.3, longitude: 34.8, name: 'stop c', dimmed: false },
    { latitude: 32.4, longitude: 34.8, name: 'stop d', dimmed: false },
  ]);
});

test('routeStopDots dims nothing when the station is not on the run', () => {
  assert.ok(routeStopDots(run, -1).every((dot) => !dot.dimmed));
  assert.equal(routeStopDots(run, -1).length, 5);
});

test('stopDotSlots always has the pool\'s length, parking what it does not use', () => {
  const dots = routeStopDots(run, 2);
  const slots = stopDotSlots(dots, 6);
  assert.equal(slots.length, 6);
  assert.deepEqual(slots.slice(0, 4).map((slot) => slot.visible), [true, true, true, true]);
  assert.deepEqual(slots[4], PARKED);
  assert.deepEqual(slots[5], PARKED);
  assert.equal(stopDotSlots([], 3).length, 3);
});

test('stopDotSlots keeps the stops nearest the station when a run outgrows the pool', () => {
  // Ten stops, the station fourth: a pool of five shows the next five.
  const long = Array.from({ length: 10 }, (_, i) => stop(String(i), 32 + i / 10));
  const slots = stopDotSlots(routeStopDots(long, 3), 5);
  assert.deepEqual(slots.map((slot) => slot.name), ['stop 4', 'stop 5', 'stop 6', 'stop 7', 'stop 8']);
});
