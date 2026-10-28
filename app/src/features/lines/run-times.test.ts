import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RouteRun } from '@/api/types';

import { activeRun, shiftIso } from './run-times';

function run(over: Partial<RouteRun> & { runId: string }): RouteRun {
  return {
    tripId: 'T1', unscheduled: false, offsetSeconds: 0, headsign: null,
    departureTime: '2026-08-31T08:00:00+03:00', directionId: 0,
    ...over,
  };
}

test('shiftIso moves an instant by a negative offset', () => {
  assert.equal(
    new Date(shiftIso('2026-08-31T08:00:00+03:00', -300)).getTime(),
    new Date('2026-08-31T07:55:00+03:00').getTime(),
  );
});

test('shiftIso moves an instant by a positive offset', () => {
  assert.equal(
    new Date(shiftIso('2026-08-31T08:00:00+03:00', 300)).getTime(),
    new Date('2026-08-31T08:05:00+03:00').getTime(),
  );
});

test('shiftIso leaves a zero offset untouched, string and all', () => {
  assert.equal(shiftIso('2026-08-31T08:00:00+03:00', 0), '2026-08-31T08:00:00+03:00');
});

test('shiftIso shifts across midnight', () => {
  assert.equal(
    new Date(shiftIso('2026-08-31T23:58:00+03:00', 300)).getTime(),
    new Date('2026-09-01T00:03:00+03:00').getTime(),
  );
});

test('shiftIso is total: an unparseable instant with a non-zero offset is returned unchanged', () => {
  assert.equal(shiftIso('not a time', 300), 'not a time');
});

test('activeRun keeps the picked run, by runId, preferring the listed copy', () => {
  const held = run({ runId: 'T1@veh', unscheduled: true, headsign: null });
  const listed = run({ runId: 'T1@veh', unscheduled: true, headsign: 'fresh' });
  const runs = [listed, run({ runId: 'T1' })];
  assert.equal(activeRun(runs, held, null)?.headsign, 'fresh');
});

test('activeRun tells two runs sharing a tripId apart by runId', () => {
  const runs = [run({ runId: 'T1@veh', unscheduled: true }), run({ runId: 'T1' })];
  assert.equal(activeRun(runs, run({ runId: 'T1' }), null)?.runId, 'T1');
  assert.equal(activeRun(runs, run({ runId: 'T1@veh', unscheduled: true }), 'T1')?.runId, 'T1@veh');
});

test('activeRun keeps a held run that has left the list, with no default', () => {
  const runs = [run({ runId: 'T1@veh', unscheduled: true }), run({ runId: 'T1' })];
  const held = run({ runId: 'T9@gone' });
  assert.equal(activeRun(runs, held, null), held);
});

test('activeRun keeps a held run that has left the list, even with a default', () => {
  const runs = [run({ runId: 'T1@veh', unscheduled: true }), run({ runId: 'T1' })];
  const held = run({ runId: 'T9@gone' });
  assert.equal(activeRun(runs, held, 'T1'), held);
});

test('activeRun with nothing held shows the default run, else the first', () => {
  const runs = [run({ runId: 'T1@veh', unscheduled: true }), run({ runId: 'T1' })];
  assert.equal(activeRun(runs, null, 'T1')?.runId, 'T1');
  assert.equal(activeRun(runs, null, null)?.runId, 'T1@veh');
});

test('activeRun answers null for a default run the list does not name, or no runs', () => {
  const runs = [run({ runId: 'T1' })];
  assert.equal(activeRun(runs, null, 'T7'), null);
  assert.equal(activeRun([], null, null), null);
});
