import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveSharedPlace, type ShareLookups } from './resolve-shared-place';

const FALLBACK = 'Shared location';

/** Lookups that fail the test if they are used -- the point of most cases
 *  below is that the position was already in the payload and nothing had to
 *  be asked of the network. */
const NO_LOOKUPS: ShareLookups = {
  resolveLink: () => Promise.reject(new Error('should not follow a link')),
  searchAddresses: () => Promise.reject(new Error('should not geocode')),
  resolvePlace: () => Promise.reject(new Error('should not resolve a place')),
  reverseLookup: () => Promise.reject(new Error('should not reverse geocode')),
};

function lookups(overrides: Partial<ShareLookups>): ShareLookups {
  return { ...NO_LOOKUPS, ...overrides };
}

test('a link that already names its position needs no lookup at all', async () => {
  const resolved = await resolveSharedPlace(
    'https://maps.apple.com/?ll=32.0853,34.7818&q=Levinsky%20Market',
    NO_LOOKUPS,
    FALLBACK,
  );

  assert.deepEqual(resolved, {
    kind: 'place',
    place: { kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: 'Levinsky Market' },
  });
});

// A dropped pin has coordinates and no name. Naming it is what makes the
// results screen say where the rider is going instead of "shared location".
test('an unnamed position is named by reverse geocoding it', async () => {
  const resolved = await resolveSharedPlace(
    'geo:32.0853,34.7818',
    lookups({ reverseLookup: async () => 'Levinsky St 10' }),
    FALLBACK,
  );

  assert.deepEqual(resolved, {
    kind: 'place',
    place: { kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: 'Levinsky St 10' },
  });
});

// The position is already known and the trip can be planned from it -- a
// failed name lookup is a cosmetic loss, never a reason to lose the share.
test('a position with no name still resolves when reverse geocoding fails', async () => {
  const resolved = await resolveSharedPlace(
    'geo:32.0853,34.7818',
    lookups({ reverseLookup: async () => { throw new Error('offline'); } }),
    FALLBACK,
  );

  assert.deepEqual(resolved, {
    kind: 'place',
    place: { kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: FALLBACK },
  });
});

test('a short link is followed to the position it points at', async () => {
  const resolved = await resolveSharedPlace(
    'https://maps.app.goo.gl/aBcD1234',
    lookups({
      resolveLink: async () => ({ kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: 'Levinsky Market' }),
    }),
    FALLBACK,
  );

  assert.deepEqual(resolved, {
    kind: 'place',
    place: { kind: 'coordinate', lat: 32.0853, lon: 34.7818, label: 'Levinsky Market' },
  });
});

test('a short link that leads nowhere cannot be read', async () => {
  const resolved = await resolveSharedPlace(
    'https://maps.app.goo.gl/aBcD1234',
    lookups({ resolveLink: async () => null }),
    FALLBACK,
  );

  assert.deepEqual(resolved, { kind: 'unreadable' });
});

test('shared text matching exactly one address resolves to it', async () => {
  const resolved = await resolveSharedPlace(
    'Dizengoff 100, Tel Aviv',
    lookups({
      searchAddresses: async () => [
        { label: 'Dizengoff 100', secondaryLabel: 'Tel Aviv', lat: 32.0806, lon: 34.7736, placeId: null, distanceMeters: null },
      ],
    }),
    FALLBACK,
  );

  assert.deepEqual(resolved, {
    kind: 'place',
    place: { kind: 'coordinate', lat: 32.0806, lon: 34.7736, label: 'Dizengoff 100' },
  });
});

// A Google-backed server names the match without positioning it; the one
// match is then positioned on its own, and the trip is plannable.
test('a single match with only a place id is resolved to its position', async () => {
  const resolved = await resolveSharedPlace(
    'Azrieli Center',
    lookups({
      searchAddresses: async () => [
        { label: 'Azrieli Center', secondaryLabel: 'Tel Aviv', lat: null, lon: null, placeId: 'abc', distanceMeters: null },
      ],
      resolvePlace: async (placeId) => (placeId === 'abc' ? { lat: 32.0743, lon: 34.7922 } : null),
    }),
    FALLBACK,
  );

  assert.deepEqual(resolved, {
    kind: 'place',
    place: { kind: 'coordinate', lat: 32.0743, lon: 34.7922, label: 'Azrieli Center' },
  });
});

test('a single match whose position cannot be resolved is handed to the picker', async () => {
  const resolved = await resolveSharedPlace(
    'Azrieli Center',
    lookups({
      searchAddresses: async () => [
        { label: 'Azrieli Center', secondaryLabel: 'Tel Aviv', lat: null, lon: null, placeId: 'abc', distanceMeters: null },
      ],
      resolvePlace: async () => { throw new Error('offline'); },
    }),
    FALLBACK,
  );

  assert.deepEqual(resolved, { kind: 'ambiguous', query: 'Azrieli Center' });
});

// Guessing between two addresses would send the rider to the wrong city
// silently. The picker asks, with what they shared already typed in.
test('shared text matching several addresses is handed to the picker', async () => {
  const resolved = await resolveSharedPlace(
    'Herzl',
    lookups({
      searchAddresses: async () => [
        { label: 'Herzl', secondaryLabel: 'Tel Aviv', lat: 32.05, lon: 34.77, placeId: null, distanceMeters: null },
        { label: 'Herzl', secondaryLabel: 'Haifa', lat: 32.81, lon: 34.99, placeId: null, distanceMeters: null },
      ],
    }),
    FALLBACK,
  );

  assert.deepEqual(resolved, { kind: 'ambiguous', query: 'Herzl' });
});

test('shared text matching nothing is still handed to the picker to edit', async () => {
  const resolved = await resolveSharedPlace('Herzl', lookups({ searchAddresses: async () => [] }), FALLBACK);

  assert.deepEqual(resolved, { kind: 'ambiguous', query: 'Herzl' });
});

test('shared text whose lookup fails is handed to the picker to retry', async () => {
  const resolved = await resolveSharedPlace(
    'Herzl',
    lookups({ searchAddresses: async () => { throw new Error('offline'); } }),
    FALLBACK,
  );

  assert.deepEqual(resolved, { kind: 'ambiguous', query: 'Herzl' });
});

test('a share with nothing usable in it cannot be read', async () => {
  assert.deepEqual(await resolveSharedPlace('https://example.com/article', NO_LOOKUPS, FALLBACK), {
    kind: 'unreadable',
  });
});
