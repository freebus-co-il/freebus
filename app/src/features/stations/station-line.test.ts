import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Departure, TripDetail } from '@/api/types';
import type { VehicleMarker } from '@/features/results/vehicle-markers';

import { departureKey, highlightMarkers, lineDepartures, lineKey, runStops } from './station-line';

function departure(tripId: string, over: Partial<Departure> & { shortName?: string } = {}): Departure {
  const { shortName = '18', ...rest } = over;
  return {
    tripId,
    runId: tripId,
    unscheduled: false,
    stopId: 's2',
    stopSequence: 2,
    departureTime: '2026-08-31T10:20:00.000Z',
    headsign: 'Bat Yam',
    directionId: 0,
    lineCode: '22018',
    lineDirection: '1',
    route: { routeId: `r-${shortName}`, agencyId: '5', shortName, longName: null, type: 3, color: null },
    realtime: null,
    ...rest,
  };
}

function trip(times: (string | null)[]): TripDetail {
  return {
    tripId: 't1',
    route: { routeId: 'r-18', agencyId: '5', shortName: '18', longName: null, type: 3, color: null },
    headsign: 'Bat Yam',
    directionId: 0,
    wheelchairAccessible: null,
    serviceDate: 20260830,
    stops: times.map((time, index) => ({
      stop: {
        stopId: `s${index + 1}`, code: null, name: `Stop ${index + 1}`, lat: 32 + index / 100, lon: 34.8,
        locationType: 0, parentStation: null,
      },
      stopSequence: index + 1,
      arrivalTime: time,
      departureTime: time,
    })),
  };
}

test('a line is its operator, number and vehicle, whatever route row carries it', () => {
  assert.equal(lineKey({ agencyId: '5', shortName: '18', type: 3 }), lineKey({ agencyId: '5', shortName: '18', type: 3 }));
  assert.notEqual(lineKey({ agencyId: '5', shortName: '18', type: 3 }), lineKey({ agencyId: '3', shortName: '18', type: 3 }));
});

test('the board\'s departures of one line, in board order', () => {
  const board = [departure('a'), departure('b', { shortName: '4' }), departure('c'), departure('d', { shortName: '4' })];
  assert.deepEqual(lineDepartures(board, lineKey(board[0]!.route)).map((d) => d.tripId), ['a', 'c']);
  assert.equal(departureKey(board[0]!), 'a:2026-08-31T10:20:00.000Z');
});

test('a run\'s stops are timed as the board has it at this stop, however the trip itself is dated', () => {
  // The trip endpoint rendered the run a day early; the board says 10:20 at stop 2.
  const detail = trip(['2026-08-30T10:10:00.000Z', '2026-08-30T10:20:00.000Z', null, '2026-08-30T10:40:00.000Z']);
  const { stops, boardingIndex } = runStops(detail, { stopId: 's2', stopSequence: 2, departureTime: '2026-08-31T10:20:00.000Z' });
  assert.equal(boardingIndex, 1);
  assert.deepEqual(stops.map((s) => s.time), [
    '2026-08-31T10:10:00.000Z', '2026-08-31T10:20:00.000Z', null, '2026-08-31T10:40:00.000Z',
  ]);
  assert.deepEqual(stops[0], { stopId: 's1', name: 'Stop 1', lat: 32, lon: 34.8, time: '2026-08-31T10:10:00.000Z' });
});

test('an unscheduled run is its template trip, shifted to when it actually leaves here', () => {
  const detail = trip(['2026-08-31T10:10:00.000Z', '2026-08-31T10:20:00.000Z']);
  const { stops } = runStops(detail, { stopId: 's2', stopSequence: 2, departureTime: '2026-08-31T10:27:00.000Z' });
  assert.deepEqual(stops.map((s) => s.time), ['2026-08-31T10:17:00.000Z', '2026-08-31T10:27:00.000Z']);
});

test('a station the trip lists under another sequence is still found by its id; one it does not list shifts nothing', () => {
  const detail = trip(['2026-08-31T10:10:00.000Z', '2026-08-31T10:20:00.000Z']);
  assert.equal(runStops(detail, { stopId: 's2', stopSequence: 9, departureTime: '2026-08-31T10:20:00.000Z' }).boardingIndex, 1);
  const missing = runStops(detail, { stopId: 'elsewhere', stopSequence: 2, departureTime: '2026-08-31T11:00:00.000Z' });
  assert.equal(missing.boardingIndex, -1);
  assert.equal(missing.stops[0]?.time, '2026-08-31T10:10:00.000Z');
  assert.deepEqual(runStops(undefined, null), { stops: [], boardingIndex: -1 });
});

test('with a line in focus, its buses stay as they are and every other line\'s step back', () => {
  const board = [departure('a'), departure('b', { shortName: '4' })];
  const marker = (tripId: string): VehicleMarker => ({
    tripId, latitude: 32, longitude: 34.8, color: '#123456', routeType: 3, shortName: '18',
    etaMinutes: 4, faded: false, secondary: false,
  });
  const [mine, other, stray] = highlightMarkers([marker('a'), marker('b'), marker('x')], board, lineKey(board[0]!.route));
  assert.deepEqual(mine, marker('a'));
  assert.deepEqual(other, { ...marker('b'), secondary: true, faded: true, etaMinutes: null });
  assert.equal(stray?.secondary, true);
});
