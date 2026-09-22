import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RealtimeInfo } from '@/api/types';

import { DELAY_WORTH_REPORTING_SECONDS, departureTime } from './departure-time';

const SCHEDULED = '2026-08-31T08:00:00+03:00';

function realtime(over: Partial<RealtimeInfo>): RealtimeInfo {
  return {
    predictedDeparture: null,
    predictedArrival: null,
    delaySeconds: null,
    vehicleRef: null,
    confidence: null,
    recordedAt: null,
    ...over,
  };
}

test('with no realtime at all, the scheduled time stands and is not live', () => {
  assert.deepEqual(departureTime(SCHEDULED, null), {
    iso: SCHEDULED,
    live: false,
    delaySeconds: null,
  });
});

test('a prediction replaces the scheduled time and reads as live', () => {
  const predicted = '2026-08-31T08:04:00+03:00';
  const result = departureTime(SCHEDULED, realtime({ predictedDeparture: predicted, delaySeconds: 240 }));
  assert.equal(result.iso, predicted);
  assert.equal(result.live, true);
  assert.equal(result.delaySeconds, 240);
});

test('a located vehicle with no prediction for THIS stop is still scheduled', () => {
  // The API can resolve a journey but hold no call for this particular stop.
  // A known vehicle on an unknown local schedule is not a live answer.
  const result = departureTime(SCHEDULED, realtime({ vehicleRef: 'bus-7', predictedDeparture: null }));
  assert.deepEqual(result, { iso: SCHEDULED, live: false, delaySeconds: null });
});

test('a trivial deviation is not reported as a delay', () => {
  const result = departureTime(
    SCHEDULED,
    realtime({ predictedDeparture: '2026-08-31T08:01:00+03:00', delaySeconds: 60 }),
  );
  assert.equal(result.live, true);
  assert.equal(result.delaySeconds, null, 'a minute is rounding, not a delay a rider can act on');
});

test('running early is reported as well as running late', () => {
  const result = departureTime(
    SCHEDULED,
    realtime({ predictedDeparture: '2026-08-31T07:55:00+03:00', delaySeconds: -300 }),
  );
  assert.equal(result.delaySeconds, -300);
});

test('the reporting threshold is inclusive at its boundary', () => {
  const result = departureTime(
    SCHEDULED,
    realtime({
      predictedDeparture: '2026-08-31T08:02:00+03:00',
      delaySeconds: DELAY_WORTH_REPORTING_SECONDS,
    }),
  );
  assert.equal(result.delaySeconds, DELAY_WORTH_REPORTING_SECONDS);
});
