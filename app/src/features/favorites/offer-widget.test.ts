import assert from 'node:assert/strict';
import { test } from 'node:test';

import { offerFavoritesWidget } from './offer-widget';

test('on a page the rider never arranged, the widget goes first', () => {
  assert.deepEqual(offerFavoritesWidget(['nearby'], false), ['favorites', 'nearby']);
});

test('on a page the rider arranged, the widget goes last', () => {
  assert.deepEqual(offerFavoritesWidget(['commute', 'nearby'], true), ['commute', 'nearby', 'favorites']);
});

test('a page that already has the widget is left alone', () => {
  assert.equal(offerFavoritesWidget(['nearby', 'favorites'], true), null);
});
