import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TransitLeg } from '@/api/types';

import { fix, sampleItinerary } from '../journey-fixtures';
import { cameraKey, navigationCamera, type FollowCamera, type NavigationCameraInput } from './navigation-camera';

const NOW = new Date('2026-08-31T10:02:00.000Z');

function input(overrides: Partial<NavigationCameraInput>): NavigationCameraInput {
  return {
    itinerary: sampleItinerary(),
    state: { phase: 'walking-to-stop', legIndex: 0 },
    fix: fix(32.0605, 34.7705, '2026-08-31T10:01:55.000Z'),
    now: NOW,
    compassHeading: null,
    bus: null,
    ...overrides,
  };
}

const near = (actual: number, expected: number, tolerance: number) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('walking follows the rider close and tilted, turned the way the walk runs', () => {
  const camera = navigationCamera(input({})) as FollowCamera;
  assert.equal(camera.kind, 'follow');
  assert.deepEqual(camera.center, { latitude: 32.0605, longitude: 34.7705 });
  // The fixture's first walk runs north-east.
  near(camera.heading, 40, 10);
  assert.ok(camera.pitch >= 45);
  assert.ok(camera.zoom >= 17);
});

test('walking turns the map to where the phone faces when the compass says', () => {
  const camera = navigationCamera(input({ compassHeading: 270 })) as FollowCamera;
  assert.equal(camera.heading, 270);
});

test('a stale or vague fix is not followed; the walk is framed instead', () => {
  const stale = navigationCamera(input({ fix: fix(32.0605, 34.7705, '2026-08-31T09:50:00.000Z') }));
  // A rider standing still for a minute sends no new fix, and is still followed.
  const still = navigationCamera(input({ fix: fix(32.0605, 34.7705, '2026-08-31T10:01:00.000Z') }));
  assert.equal(still?.kind, 'follow');
  assert.equal(stale?.kind, 'frame');
  const vague = navigationCamera(input({ fix: fix(32.0605, 34.7705, '2026-08-31T10:01:55.000Z', 500) }));
  assert.equal(vague?.kind, 'frame');
});

/** Precision-6 encoded polyline, as the server sends geometry. */
function encode(points: [number, number][]): string {
  let out = '';
  let last = [0, 0];
  const push = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const next = [Math.round(lat * 1e6), Math.round(lon * 1e6)];
    push(next[0]! - last[0]!);
    push(next[1]! - last[1]!);
    last = next;
  }
  return out;
}

test('a re-routed walk is the one the heading is read from', () => {
  // A re-route running due west from the rider, unlike the planned north-east walk.
  const west = encode([[32.0605, 34.7705], [32.0605, 34.7685]]);
  const camera = navigationCamera(input({ walkGeometry: west })) as FollowCamera;
  assert.equal(camera.kind, 'follow');
  near(camera.heading, 270, 2);
});

test('waiting frames the stop, the rider and the approaching bus together', () => {
  const bus = { lat: 32.05, lon: 34.76 };
  const camera = navigationCamera(input({ state: { phase: 'waiting', legIndex: 1 }, bus }));
  assert.equal(camera?.kind, 'frame');
  const coordinates = camera!.kind === 'frame' ? camera!.coordinates : [];
  const stop = (sampleItinerary().legs[1] as TransitLeg).from.stop;
  for (const point of [stop, { lat: 32.0605, lon: 34.7705 }, bus]) {
    assert.ok(coordinates.some((c) => c.latitude === point.lat && c.longitude === point.lon), JSON.stringify(point));
  }
});

test('riding follows further out along the route, from the bus when the rider has no fix', () => {
  const bus = { lat: 32.07, lon: 34.78 };
  const camera = navigationCamera(input({ state: { phase: 'riding', legIndex: 1 }, fix: null, bus })) as FollowCamera;
  assert.equal(camera.kind, 'follow');
  assert.deepEqual(camera.center, { latitude: 32.07, longitude: 34.78 });
  assert.ok(camera.zoom < 17);
  // Mid A -> Mid B -> Allenby runs north-east.
  near(camera.heading, 45, 20);
});

test('riding with nothing to follow frames the ride', () => {
  assert.equal(navigationCamera(input({ state: { phase: 'riding', legIndex: 1 }, fix: null }))?.kind, 'frame');
});

test('off plan and arrived leave the map to frame the journey', () => {
  assert.equal(navigationCamera(input({ state: { phase: 'off-plan', legIndex: 1 } })), null);
  assert.equal(navigationCamera(input({ state: { phase: 'arrived', legIndex: 3 } })), null);
});

test('the camera key ignores jitter and changes for a real move or turn', () => {
  const base = navigationCamera(input({ compassHeading: 90 }));
  assert.equal(cameraKey(base), cameraKey(navigationCamera(input({ compassHeading: 92 }))));
  assert.notEqual(cameraKey(base), cameraKey(navigationCamera(input({ compassHeading: 110 }))));
  assert.notEqual(
    cameraKey(base),
    cameraKey(navigationCamera(input({ compassHeading: 90, fix: fix(32.0606, 34.7705, '2026-08-31T10:01:58.000Z') }))),
  );
  assert.equal(cameraKey(null), 'none');
});
