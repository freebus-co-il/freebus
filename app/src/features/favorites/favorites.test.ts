import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_FAVORITES, favoriteKey, favoriteLineKeysAt, favoritesFirst, isFavorite, isFavoriteDeparture, parseStoredFavorites, refreshFavorite, serializeFavorites,
  stopLineDepartures, toggleFavorite, type Favorite, type FavoriteStopLine,
} from './favorites';

const station = (stopId: string, name = `stop ${stopId}`): Favorite => ({ kind: 'station', stopId, name });
const line = (lineCode: string): Favorite => ({
  kind: 'line', lineCode, shortName: '5', longName: 'A<->B', agencyId: '3', type: 3,
});
const stopLine = (lineDirection: string): FavoriteStopLine => ({
  kind: 'stopLine', stopId: '1000', stopName: 'Central', lineCode: '10005', lineDirection,
  shortName: '5', agencyId: '3', type: 3, headsign: 'North',
});

test('a station, a line and a stop line with the same ids are three favorites', () => {
  const keys = new Set([favoriteKey(station('10005')), favoriteKey(line('10005')), favoriteKey(stopLine('1'))]);
  assert.equal(keys.size, 3);
});

test('the same line at the same stop in two directions is two favorites', () => {
  // A railway station serves both directions of a line from one stop id.
  assert.notEqual(favoriteKey(stopLine('1')), favoriteKey(stopLine('2')));
});

test('toggleFavorite appends a new favorite at the end', () => {
  const items = toggleFavorite([station('1'), station('2')], station('3'));
  assert.deepEqual(items.map(favoriteKey), ['station:1', 'station:2', 'station:3']);
});

test('toggleFavorite removes a saved favorite, matched by identity not snapshot', () => {
  const items = toggleFavorite([station('1', 'Old name'), station('2')], station('1', 'New name'));
  assert.deepEqual(items.map(favoriteKey), ['station:2']);
});

test('isFavorite matches by identity', () => {
  assert.equal(isFavorite([station('1', 'Old name')], station('1', 'New name')), true);
  assert.equal(isFavorite([station('1')], station('2')), false);
});

test('refreshFavorite returns the same array when nothing changed', () => {
  const items = [station('1'), station('2')];
  assert.equal(refreshFavorite(items, station('1')), items);
  assert.equal(refreshFavorite(items, station('9')), items);
});

test('refreshFavorite replaces a changed snapshot in place', () => {
  const items = refreshFavorite([station('1'), station('2', 'Old')], station('2', 'Renamed'));
  assert.deepEqual(items, [station('1'), station('2', 'Renamed')]);
});

test('parseStoredFavorites reads what serializeFavorites writes', () => {
  const state = { items: [station('1'), line('7'), stopLine('2')], widgetOffered: true };
  assert.deepEqual(parseStoredFavorites(serializeFavorites(state)), state);
});

test('parseStoredFavorites treats nothing stored as an empty list', () => {
  assert.deepEqual(parseStoredFavorites(null), EMPTY_FAVORITES);
});

test('parseStoredFavorites reports an unreadable file as null, not as empty', () => {
  assert.equal(parseStoredFavorites('{"items": [ truncated'), null);
  assert.equal(parseStoredFavorites('"a string"'), null);
});

test('parseStoredFavorites skips entries it cannot read and keeps the rest in order', () => {
  const raw = JSON.stringify({
    version: 1,
    items: [station('1'), { kind: 'fromTheFuture' }, { kind: 'station' }, line('7')],
  });
  assert.deepEqual(parseStoredFavorites(raw)?.items.map(favoriteKey), ['station:1', 'line:7']);
});

test('parseStoredFavorites keeps the first of a repeated entry', () => {
  const raw = JSON.stringify({ items: [station('1', 'First'), station('2'), station('1', 'Second')] });
  assert.deepEqual(parseStoredFavorites(raw)?.items, [station('1', 'First'), station('2')]);
});

test('stopLineDepartures keeps the pinned line going the pinned way', () => {
  const board = [
    { id: 'a', lineCode: '10005', lineDirection: '1' },
    { id: 'b', lineCode: '10005', lineDirection: '2' },
    { id: 'c', lineCode: '10007', lineDirection: '1' },
    { id: 'd', lineCode: '10005', lineDirection: '1' },
  ];
  assert.deepEqual(stopLineDepartures(board, stopLine('1')).map((d) => d.id), ['a', 'd']);
});

test('favoriteLineKeysAt has every saved line and only the lines pinned at this stop', () => {
  // `line('7')` is agency 3, number 5, a bus; the pin is line 5 at stop 1000.
  const elsewhere: FavoriteStopLine = { ...stopLine('1'), stopId: '2000', shortName: '9' };
  const items = [line('7'), stopLine('1'), elsewhere];
  assert.deepEqual([...favoriteLineKeysAt(items, '1000')], ['3|5|3']);
  assert.deepEqual([...favoriteLineKeysAt([elsewhere], '1000')], []);
});

test('isFavoriteDeparture marks a saved line in both directions', () => {
  const items = [line('10005')];
  assert.equal(isFavoriteDeparture(items, '1000', { lineCode: '10005', lineDirection: '1' }), true);
  assert.equal(isFavoriteDeparture(items, '1000', { lineCode: '10005', lineDirection: '2' }), true);
  assert.equal(isFavoriteDeparture(items, '1000', { lineCode: '10007', lineDirection: '1' }), false);
});

test('isFavoriteDeparture marks a pinned line only going the pinned way at the pinned stop', () => {
  const items = [stopLine('1')];
  assert.equal(isFavoriteDeparture(items, '1000', { lineCode: '10005', lineDirection: '1' }), true);
  assert.equal(isFavoriteDeparture(items, '1000', { lineCode: '10005', lineDirection: '2' }), false);
  assert.equal(isFavoriteDeparture(items, '2000', { lineCode: '10005', lineDirection: '1' }), false);
});

test('favoritesFirst moves favorites to the front and keeps both groups in order', () => {
  assert.deepEqual(favoritesFirst([1, 2, 3, 4, 5], (n) => n % 2 === 0), [2, 4, 1, 3, 5]);
});
