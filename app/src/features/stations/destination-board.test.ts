import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Departure } from '@/api/types';

import { fastestArrivalKey } from './destination-board';
import { departureKey } from './station-line';

function departure(
  tripId: string, departureTime: string, arrivalTime: string | null,
): Departure {
  return {
    tripId,
    runId: tripId,
    unscheduled: false,
    stopId: 's1',
    stopSequence: 1,
    departureTime,
    headsign: 'Hadera',
    directionId: 0,
    lineCode: '22018',
    lineDirection: '1',
    route: { routeId: `r-${tripId}`, agencyId: '5', shortName: '70', longName: null, type: 3, color: null },
    realtime: null,
    ...(arrivalTime === null ? {} : {
      destination: { stopId: 'd1', stopSequence: 9, arrivalTime, rideSeconds: 600 },
    }),
  };
}

// The trap the mark exists for: the 07:00 bus crawls, the 07:10 express
// overtakes it, and departure order puts the slower one on top.
test('marks a later departure that arrives first', () => {
  const slow = departure('T1', '2026-09-30T07:00:00+03:00', '2026-09-30T08:00:00+03:00');
  const express = departure('T2', '2026-09-30T07:10:00+03:00', '2026-09-30T07:40:00+03:00');
  assert.equal(fastestArrivalKey([slow, express]), departureKey(express));
});

test('marks nothing when the first bus to leave is also the first to arrive', () => {
  const first = departure('T1', '2026-09-30T07:00:00+03:00', '2026-09-30T07:30:00+03:00');
  const later = departure('T2', '2026-09-30T07:10:00+03:00', '2026-09-30T07:45:00+03:00');
  assert.equal(fastestArrivalKey([first, later]), null);
});

// Two buses arriving together: the one that leaves first is the one to
// board, and it is already on top.
test('gives a tie to the bus that leaves first, and so marks nothing', () => {
  const first = departure('T1', '2026-09-30T07:00:00+03:00', '2026-09-30T07:40:00+03:00');
  const second = departure('T2', '2026-09-30T07:10:00+03:00', '2026-09-30T07:40:00+03:00');
  assert.equal(fastestArrivalKey([first, second]), null);
});

test('marks nothing on a board of one', () => {
  assert.equal(fastestArrivalKey([departure('T1', '2026-09-30T07:00:00+03:00', '2026-09-30T07:40:00+03:00')]), null);
});

// An unfiltered board, or an API deploy older than the field.
test('marks nothing when the rows carry no destination', () => {
  const a = departure('T1', '2026-09-30T07:00:00+03:00', null);
  const b = departure('T2', '2026-09-30T07:10:00+03:00', null);
  assert.equal(fastestArrivalKey([a, b]), null);
});

test('marks nothing on an empty board', () => {
  assert.equal(fastestArrivalKey([]), null);
});
