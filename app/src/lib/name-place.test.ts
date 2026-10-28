import assert from 'node:assert/strict';
import { test } from 'node:test';

import { namedCoordinate } from './name-place';

const FALLBACK = 'Pinned location';

test('a bare position takes the name the lookup gives it', async () => {
  const place = await namedCoordinate({ lat: 32.0731, lon: 34.7925 }, async () => 'Rothschild Blvd 12', FALLBACK);

  assert.deepEqual(place, { kind: 'coordinate', lat: 32.0731, lon: 34.7925, label: 'Rothschild Blvd 12' });
});

test('the position is the one passed in, never the one the lookup matched', async () => {
  // Reverse geocoding answers with the position of the street it matched,
  // which can be tens of metres from the rider. Taking it would plan the trip
  // from the middle of the road instead of from where they are standing --
  // and, for a recent trip, would move the entry a little every time.
  const place = await namedCoordinate({ lat: 32.0731, lon: 34.7925 }, async () => 'Rothschild Blvd', FALLBACK);

  assert.equal(place.kind === 'coordinate' && place.lat, 32.0731);
  assert.equal(place.kind === 'coordinate' && place.lon, 34.7925);
});

test('a lookup that finds nothing leaves the fallback label', async () => {
  const place = await namedCoordinate({ lat: 32.0731, lon: 34.7925 }, async () => null, FALLBACK);

  assert.equal(place.kind === 'coordinate' && place.label, FALLBACK);
});

test('a lookup that fails leaves the fallback label rather than rejecting', async () => {
  // The place is already usable without a name -- a trip planned from a
  // coordinate needs no address. A geocoder outage must cost a nice label and
  // nothing else, so every caller can await this without a catch of its own.
  const place = await namedCoordinate({ lat: 32.0731, lon: 34.7925 }, async () => {
    throw new Error('network down');
  }, FALLBACK);

  assert.equal(place.kind === 'coordinate' && place.label, FALLBACK);
});

test('an empty name is no name -- a label must be something a rider can read', async () => {
  const place = await namedCoordinate({ lat: 32.0731, lon: 34.7925 }, async () => '  ', FALLBACK);

  assert.equal(place.kind === 'coordinate' && place.label, FALLBACK);
});
