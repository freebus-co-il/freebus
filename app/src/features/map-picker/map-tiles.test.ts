import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_STATIONS_LAT_DELTA, stationUnderPin, tilesForRegion } from './map-tiles';

const TEL_AVIV = { latitude: 32.0853, longitude: 34.7818 };

test('a street-level region is covered by the fixed tiles around it', () => {
  const tiles = tilesForRegion({ ...TEL_AVIV, latitudeDelta: 0.008, longitudeDelta: 0.005 });
  assert.ok(tiles);
  // 32.0813..32.0893 spans tile rows 3208; 34.7793..34.7843 spans columns 3477 and 3478.
  assert.deepEqual(tiles.map((t) => t.key), ['3208:3477', '3208:3478']);
  assert.deepEqual(tiles[0]!.box, { minLat: 32.08, maxLat: 32.09, minLon: 34.77, maxLon: 34.78 });
});

// The point of tiles: a small pan asks for the same URLs again, which the
// query cache (and the edge cache) already hold.
test('a small pan inside the same tiles asks for the same tiles', () => {
  const a = tilesForRegion({ ...TEL_AVIV, latitudeDelta: 0.004, longitudeDelta: 0.003 });
  const b = tilesForRegion({ latitude: 32.0856, longitude: 34.7822, latitudeDelta: 0.004, longitudeDelta: 0.003 });
  assert.deepEqual(a, b);
});

test('zoomed out past a neighbourhood, no tiles are asked for at all', () => {
  assert.equal(tilesForRegion({ ...TEL_AVIV, latitudeDelta: MAX_STATIONS_LAT_DELTA * 1.5, longitudeDelta: 0.02 }), null);
  // Israel from end to end: never a request per tile of the country.
  assert.equal(tilesForRegion({ latitude: 31.5, longitude: 34.9, latitudeDelta: 4, longitudeDelta: 2 }), null);
});

test('a very wide view at the zoom limit is refused rather than tiled', () => {
  assert.equal(tilesForRegion({ ...TEL_AVIV, latitudeDelta: 0.02, longitudeDelta: 0.2 }), null);
});

test('the pin is on the nearest station within a few metres, and on none further away', () => {
  const herzl = { stopId: 'a', lat: 32.0600, lon: 34.7750 };
  const nextDoor = { stopId: 'b', lat: 32.06003, lon: 34.7750 }; // ~3 m north
  assert.equal(stationUnderPin({ lat: 32.0600, lon: 34.7750 }, [nextDoor, herzl]), herzl);
  // ~55 m away: the rider is picking a spot near the stop, not the stop.
  assert.equal(stationUnderPin({ lat: 32.0605, lon: 34.7750 }, [herzl]), null);
});
