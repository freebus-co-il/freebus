import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatHeadsign, leaveState, LEAVE_COUNTDOWN_MAX_MINUTES, tripNumberOf } from './itinerary-facts';

const NOW = new Date('2026-08-29T09:00:00.000Z');

function minutesFromNow(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

test('reads as departed once the leave time has passed', () => {
  assert.deepEqual(leaveState(minutesFromNow(-3), NOW), { kind: 'departed' });
});

test('reads as now inside the last minute', () => {
  assert.deepEqual(leaveState(minutesFromNow(0.4), NOW), { kind: 'now' });
});

test('counts down in whole minutes', () => {
  assert.deepEqual(leaveState(minutesFromNow(6), NOW), { kind: 'countdown', minutes: 6 });
});

// Past an hour a countdown stops being useful and starts being arithmetic --
// "leave in 143 min" is a worse answer than "leave at 14:20".
test('gives a clock time beyond the countdown ceiling', () => {
  assert.deepEqual(leaveState(minutesFromNow(LEAVE_COUNTDOWN_MAX_MINUTES + 1), NOW), { kind: 'clockTime' });
});

test('still counts down at exactly the countdown ceiling', () => {
  assert.deepEqual(leaveState(minutesFromNow(LEAVE_COUNTDOWN_MAX_MINUTES), NOW), {
    kind: 'countdown',
    minutes: LEAVE_COUNTDOWN_MAX_MINUTES,
  });
});

// This feed writes headsigns as `city_place`. The underscore is a field
// separator, never part of a name a rider would recognise, so it must never
// reach the screen -- whatever shape the feed hands over.
test('leads with the place and trails the city', () => {
  assert.equal(formatHeadsign('חולון_פארק פרס'), 'פארק פרס, חולון');
});

test('passes a headsign with no separator straight through', () => {
  assert.equal(formatHeadsign('Central Station'), 'Central Station');
});

test('keeps the leading city when the rest carries more separators', () => {
  assert.equal(formatHeadsign('Tel Aviv_Central_Station'), 'Central Station, Tel Aviv');
});

test('never leaves a separator in the output', () => {
  for (const headsign of ['a_b_c', 'a__b', '_a_', 'city_', '_place', 'a_b_c_d']) {
    assert.ok(!formatHeadsign(headsign).includes('_'), `underscore survived in ${headsign}`);
  }
});

test('leaves a plain station name (a rail headsign) intact', () => {
  assert.equal(formatHeadsign('תל אביב סבידור מרכז'), 'תל אביב סבידור מרכז');
});

test('reads a train number, trimmed', () => {
  assert.equal(tripNumberOf({ tripNumber: ' 243 ' }), '243');
});

test('has no train number for a non-rail trip, a blank one, or an older API', () => {
  assert.equal(tripNumberOf({ tripNumber: null }), null);
  assert.equal(tripNumberOf({ tripNumber: '  ' }), null);
  assert.equal(tripNumberOf({}), null);
});
