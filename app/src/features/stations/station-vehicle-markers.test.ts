import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Departure, LiveVehicle } from '@/api/types';
import { operatorColor } from '@/constants/operator-colors';

import { STATION_VEHICLE_LIMIT, stationLines, stationTripIds, stationVehicleMarkers } from './station-vehicle-markers';

const NOW = new Date('2026-08-31T10:15:45.000Z');

function departure(tripId: string, over: Partial<Departure['route']> = {}): Departure {
  return {
    tripId,
    runId: tripId,
    unscheduled: false,
    stopId: 's1',
    stopSequence: 3,
    departureTime: '2026-08-31T10:20:00.000Z',
    headsign: 'Bat Yam',
    directionId: 0,
    lineCode: '22018',
    lineDirection: '1',
    route: { routeId: 'r1', agencyId: '5', shortName: '18', longName: null, type: 3, color: null, ...over },
    realtime: null,
  };
}

function vehicle(tripId: string): LiveVehicle {
  return { tripId, lat: 32.07, lon: 34.78, recordedAt: '2026-08-31T10:15:00.000Z', vehicleRef: 'v' };
}

test('a bus running one of the board\'s departures is drawn in that departure\'s line colour', () => {
  const markers = stationVehicleMarkers(
    [departure('a'), departure('b', { agencyId: '3', shortName: '480' })],
    [vehicle('b'), vehicle('stray')],
    NOW,
  );
  assert.deepEqual(markers, [{
    tripId: 'b', latitude: 32.07, longitude: 34.78, color: operatorColor('3'),
    // Due here at 10:20; it is 10:15:45.
    routeType: 3, shortName: '480', etaMinutes: 4, faded: false, secondary: false,
  }]);
});

test('the trips polled are the board\'s first ones, each once, capped at the vehicles endpoint\'s limit', () => {
  const board = Array.from({ length: 20 }, (_, i) => departure(`t${i}`));
  assert.equal(STATION_VEHICLE_LIMIT, 12);
  assert.deepEqual(stationTripIds(board), board.slice(0, 12).map((d) => d.tripId));
  assert.deepEqual(stationTripIds([departure('x'), departure('x'), departure('y')]), ['x', 'y']);
});

test('a stop\'s line badges drop repeats of the same line, keeping the first order', () => {
  const routes = [
    { agencyId: '5', shortName: '18', type: 3 },
    { agencyId: '5', shortName: '18', type: 3 },
    { agencyId: '3', shortName: '18', type: 3 },
    { agencyId: '2', shortName: null, type: 2 },
  ];
  assert.deepEqual(stationLines(routes), [routes[0], routes[2], routes[3]]);
});

test('a bus counts down to this station by the board\'s live prediction when it has one', () => {
  const late: Departure = {
    ...departure('a'),
    realtime: {
      predictedDeparture: '2026-08-31T10:25:00.000Z', predictedArrival: null, delaySeconds: 300,
      vehicleRef: 'v', confidence: null, recordedAt: '2026-08-31T10:15:00.000Z',
    },
  };
  const [marker] = stationVehicleMarkers([late], [vehicle('a')], NOW);
  assert.equal(marker?.etaMinutes, 9);
});
