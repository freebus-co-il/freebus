import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addressCredit, GOOGLE_MAPS_TEXT, OSM_COPYRIGHT_URL, shapeCredit } from './attribution';

test('addressCredit credits the backend when there are address rows', () => {
  assert.equal(addressCredit('google', 3), 'google');
  assert.equal(addressCredit('osm', 1), 'osm');
});

test('addressCredit shows nothing without address rows', () => {
  assert.equal(addressCredit('google', 0), null);
});

test('addressCredit shows nothing when an older server sends no attribution', () => {
  assert.equal(addressCredit(undefined, 5), null);
});

test('shapeCredit credits only OSM-drawn geometry', () => {
  assert.equal(shapeCredit('osm'), 'osm');
  assert.equal(shapeCredit(null), null);
  assert.equal(shapeCredit(undefined), null);
});

test('the Google credit is the exact untranslated wordmark text', () => {
  assert.equal(GOOGLE_MAPS_TEXT, 'Google Maps');
});

test('the OSM credit links to the copyright page', () => {
  assert.equal(OSM_COPYRIGHT_URL, 'https://www.openstreetmap.org/copyright');
});
