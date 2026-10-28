import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alignStopTimesToRun, firstRelevantStopIndex } from './first-relevant-stop';

/** Four stops due north, a kilometre apart, timed five minutes apart. */
const stops = [
  { lat: 32.00, lon: 34.8, time: '2026-09-13T10:00:00+03:00' },
  { lat: 32.01, lon: 34.8, time: '2026-09-13T10:05:00+03:00' },
  { lat: 32.02, lon: 34.8, time: '2026-09-13T10:10:00+03:00' },
  { lat: 32.03, lon: 34.8, time: '2026-09-13T10:15:00+03:00' },
];
const EARLY = new Date('2026-09-13T09:00:00+03:00');

test('with a live position, the list starts at the stop nearest the bus', () => {
  assert.equal(firstRelevantStopIndex({ stops, boardingIndex: -1, bus: { lat: 32.019, lon: 34.8 }, now: EARLY }), 2);
});

test('without a live position, the list starts at the last stop whose time has passed', () => {
  const now = new Date('2026-09-13T10:07:00+03:00');
  assert.equal(firstRelevantStopIndex({ stops, boardingIndex: -1, bus: null, now }), 1);
});

test('the rider\'s stop wins when it is further along than the bus', () => {
  assert.equal(firstRelevantStopIndex({ stops, boardingIndex: 3, bus: { lat: 32.01, lon: 34.8 }, now: EARLY }), 3);
});

test('the bus wins when it is already past the rider\'s stop', () => {
  assert.equal(firstRelevantStopIndex({ stops, boardingIndex: 1, bus: { lat: 32.02, lon: 34.8 }, now: EARLY }), 2);
});

test('nothing is hidden before the run has started', () => {
  assert.equal(firstRelevantStopIndex({ stops, boardingIndex: -1, bus: null, now: EARLY }), 0);
});

test('nothing is hidden when the stops carry no times and there is no bus', () => {
  const timeless = stops.map((stop) => ({ ...stop, time: null }));
  assert.equal(firstRelevantStopIndex({ stops: timeless, boardingIndex: -1, bus: null, now: EARLY }), 0);
});

test('an empty list starts at 0, and an index past the end is clamped to the last stop', () => {
  assert.equal(firstRelevantStopIndex({ stops: [], boardingIndex: -1, bus: null, now: EARLY }), 0);
  assert.equal(firstRelevantStopIndex({ stops, boardingIndex: 10, bus: null, now: EARLY }), 3);
});

test('alignStopTimesToRun: a one-day shift moves every time by exactly 24h', () => {
  const times = ['2026-09-13T10:00:00+03:00', '2026-09-13T10:05:00+03:00'];
  const aligned = alignStopTimesToRun(times, '2026-09-13T05:00:00+03:00', '2026-09-14T05:00:00+03:00');
  assert.equal(new Date(aligned[0]!).getTime(), new Date('2026-09-14T10:00:00+03:00').getTime());
  assert.equal(new Date(aligned[1]!).getTime(), new Date('2026-09-14T10:05:00+03:00').getTime());
});

test('alignStopTimesToRun: a zero delta leaves the times unchanged', () => {
  const times = ['2026-09-13T10:00:00+03:00', '2026-09-13T10:05:00+03:00'];
  const aligned = alignStopTimesToRun(times, '2026-09-13T05:00:00+03:00', '2026-09-13T05:00:00+03:00');
  assert.equal(new Date(aligned[0]!).getTime(), new Date(times[0]!).getTime());
  assert.equal(new Date(aligned[1]!).getTime(), new Date(times[1]!).getTime());
});

test('alignStopTimesToRun: null times stay null', () => {
  const aligned = alignStopTimesToRun(
    [null, '2026-09-13T10:00:00+03:00', null],
    '2026-09-13T05:00:00+03:00',
    '2026-09-14T05:00:00+03:00',
  );
  assert.equal(aligned[0], null);
  assert.equal(aligned[2], null);
});

test('alignStopTimesToRun: a missing or unparseable anchor leaves the times unchanged', () => {
  const times = ['2026-09-13T10:00:00+03:00', null];
  assert.deepEqual(alignStopTimesToRun(times, null, '2026-09-14T05:00:00+03:00'), times);
  assert.deepEqual(alignStopTimesToRun(times, '2026-09-13T05:00:00+03:00', null), times);
  assert.deepEqual(alignStopTimesToRun(times, 'not-a-date', '2026-09-14T05:00:00+03:00'), times);
});

test('alignStopTimesToRun combined with firstRelevantStopIndex: a run dated tomorrow against stops the trip endpoint dated yesterday hides nothing', () => {
  // Reproduces the controller's finding: the trip endpoint answers this run's
  // stops against an earlier service date than the run's own departure, so
  // every raw time reads as already passed relative to `now`.
  const yesterdayStops = [
    { lat: 32.00, lon: 34.8, time: '2026-09-13T05:00:00+03:00' },
    { lat: 32.01, lon: 34.8, time: '2026-09-13T05:20:00+03:00' },
    { lat: 32.02, lon: 34.8, time: '2026-09-13T05:59:40+03:00' },
  ];
  const now = new Date('2026-09-14T04:00:00+03:00');
  const aligned = alignStopTimesToRun(
    yesterdayStops.map((stop) => stop.time),
    '2026-09-13T05:00:00+03:00',
    '2026-09-14T05:00:00+03:00',
  );
  const alignedStops = yesterdayStops.map((stop, index) => ({ ...stop, time: aligned[index] ?? null }));
  assert.equal(firstRelevantStopIndex({ stops: alignedStops, boardingIndex: -1, bus: null, now }), 0);
});

/** An out-and-back route: 23 stops north up one side of a road, then 23 back
 *  down the other side about 95 m east, so stop k and stop 45 - k face each
 *  other across the road. Timed two minutes apart from 10:00. */
const outAndBack = Array.from({ length: 46 }, (_, index) => {
  const outbound = index <= 22;
  const along = outbound ? index : 45 - index;
  return {
    lat: 32 + along * 0.003,
    lon: outbound ? 34.8 : 34.801,
    time: new Date(new Date('2026-09-13T10:00:00+03:00').getTime() + index * 120_000).toISOString(),
  };
});
/** Across the road between stop 5 and its twin, stop 40 -- and nearer stop 40. */
const busOppositeStop5 = { lat: 32.015, lon: 34.8006 };

test('an out-and-back route: a bus between stop 5 and its twin across the road follows the timetable to stop 5', () => {
  const now = new Date('2026-09-13T10:11:00+03:00');
  assert.equal(firstRelevantStopIndex({ stops: outAndBack, boardingIndex: -1, bus: busOppositeStop5, now }), 5);
});

test('an out-and-back route without times: the earliest of the stops near the bus wins', () => {
  const timeless = outAndBack.map((stop) => ({ ...stop, time: null }));
  assert.equal(firstRelevantStopIndex({ stops: timeless, boardingIndex: -1, bus: busOppositeStop5, now: EARLY }), 5);
});

test('a closed loop: a bus at the terminal before its run starts folds nothing, even nearer the last stop', () => {
  // The loop ends where it starts -- the last stop is the terminal's arrival
  // platform, a few metres from the first -- and GPS noise puts the bus a
  // little nearer the last one.
  const loop = [
    { lat: 32.0000, lon: 34.8000, time: '2026-09-13T10:00:00+03:00' },
    { lat: 32.0100, lon: 34.8000, time: '2026-09-13T10:05:00+03:00' },
    { lat: 32.0100, lon: 34.8100, time: '2026-09-13T10:10:00+03:00' },
    { lat: 32.0000, lon: 34.8100, time: '2026-09-13T10:15:00+03:00' },
    { lat: 32.00005, lon: 34.8000, time: '2026-09-13T10:20:00+03:00' },
  ];
  const bus = { lat: 32.00004, lon: 34.8 };
  assert.equal(firstRelevantStopIndex({ stops: loop, boardingIndex: -1, bus, now: EARLY }), 0);
});
