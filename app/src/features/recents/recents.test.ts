import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SelectedPlace } from '@/lib/place';

import { migrateStoredSearches, promote, recentSearchKey, type RecentSearch } from './recents';

const stop = (stopId: string): SelectedPlace => ({ kind: 'stop', stopId, name: `stop ${stopId}` });
const at = (lat: number, lon: number): SelectedPlace => ({ kind: 'coordinate', lat, lon, label: 'here' });
const search = (place: SelectedPlace): RecentSearch => ({ kind: 'search', place });

test('promote puts the newest entry first', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(promote(list, { id: 'c' }, (x) => x.id, 20), [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
});

test('promote keeps one entry per key, moved to the front', () => {
  // The rule the rider actually asked for: the same search must not appear
  // twice, and searching it again makes it the most recent.
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(promote(list, { id: 'c' }, (x) => x.id, 20), [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
});

test('promote caps the list', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(promote(list, { id: 'd' }, (x) => x.id, 3), [{ id: 'd' }, { id: 'a' }, { id: 'b' }]);
});

test('recentSearchKey identifies a stop by its stop id', () => {
  assert.equal(recentSearchKey(search(stop('1000'))), 'stop:1000');
});

test('recentSearchKey tells two different places apart', () => {
  assert.notEqual(recentSearchKey(search(stop('1000'))), recentSearchKey(search(stop('2000'))));
});

test('recentSearchKey does not confuse a stop with a coordinate', () => {
  assert.notEqual(recentSearchKey(search(stop('1000'))), recentSearchKey(search(at(32.0731, 34.793))));
});

test('recentSearchKey keeps two addresses on the same street apart', () => {
  // ~25 m apart: the old trip key rounded to ~110 m to absorb the drift of a
  // live GPS ORIGIN, which would merge these two. A destination is chosen,
  // never measured, so two the rider deliberately told apart stay apart.
  const near = recentSearchKey(search(at(32.07310, 34.79305)));
  const nearer = recentSearchKey(search(at(32.07332, 34.79288)));
  assert.notEqual(near, nearer);
});

test('promote with recentSearchKey drops a repeated search', () => {
  // End to end on the rule: the same place searched again leaves one entry.
  let list: RecentSearch[] = [];
  list = promote(list, search(stop('1000')), recentSearchKey, 3);
  list = promote(list, search(stop('2000')), recentSearchKey, 3);
  list = promote(list, search(stop('1000')), recentSearchKey, 3);

  assert.deepEqual(list.map(recentSearchKey), ['stop:1000', 'stop:2000']);
});

test('migrateStoredSearches reads the searches this version writes', () => {
  const stored = [search(stop('1000')), search(at(32.07, 34.79))];
  assert.deepEqual(migrateStoredSearches(stored, undefined), stored);
});

test('migrateStoredSearches carries an older install\'s trips across by destination', () => {
  // The whole point of the migration: a rider upgrading must not find their
  // list emptied. A trip's destination IS the search that produced it.
  const trips = [
    { kind: 'trip', origin: at(32.07, 34.79), destination: stop('2000') },
    { kind: 'trip', origin: stop('1000'), destination: stop('3000') },
  ];
  assert.deepEqual(migrateStoredSearches(undefined, trips), [search(stop('2000')), search(stop('3000'))]);
});

test('migrateStoredSearches collapses trips that shared a destination', () => {
  // Two trips to work from different origins were two rows as trips. As
  // searches they are the same place, and must not appear twice -- most
  // recent first, like `promote`.
  const trips = [
    { kind: 'trip', origin: at(32.07, 34.79), destination: stop('2000') },
    { kind: 'trip', origin: stop('1000'), destination: stop('2000') },
  ];
  assert.deepEqual(migrateStoredSearches(undefined, trips), [search(stop('2000'))]);
});

test('migrateStoredSearches skips entries that are not usable places', () => {
  // Parsing a real device, not something we just serialised: a half-written
  // or older-shaped entry is dropped rather than handed on as a place.
  const trips = [
    null,
    { kind: 'trip', origin: stop('1000') },
    { kind: 'trip', destination: { kind: 'coordinate', lat: 'nope' } },
    { kind: 'trip', destination: stop('2000') },
  ];
  assert.deepEqual(migrateStoredSearches(undefined, trips), [search(stop('2000'))]);
});

test('migrateStoredSearches degrades to empty when storage holds neither shape', () => {
  assert.deepEqual(migrateStoredSearches(undefined, undefined), []);
  assert.deepEqual(migrateStoredSearches('garbage', 42), []);
});
