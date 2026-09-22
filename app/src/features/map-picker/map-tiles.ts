import { haversineMeters } from '@/lib/geo';

export type Box = { minLat: number; maxLat: number; minLon: number; maxLon: number };

export type MapRegion = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

/**
 * A tile's side in degrees: about 1.1 km north-south. Stations are asked for
 * a tile at a time, never for the exact viewport, so panning back over a tile
 * repeats a URL the cache already holds -- and a dense tile in central Tel
 * Aviv is still only a few hundred stops.
 */
export const TILE_DEG = 0.01;

/**
 * The most latitude a region may span and still show stations: about 2.2 km
 * top to bottom. Zoomed out past that, a pin per stop is a carpet, and the
 * tiles to fill it grow with the square of the zoom.
 */
export const MAX_STATIONS_LAT_DELTA = 0.02;

/** A guard against a very wide screen at the zoom limit asking for a row of
 *  tiles nobody can make out. */
export const MAX_TILES = 16;

/** How close the map's centre has to be to a station for the pin to be ON
 *  it. A tap animates the station to the exact centre; this only absorbs the
 *  rounding a map reports its camera back with, and a drag that lands on
 *  the sign itself. */
export const SNAP_METERS = 8;

export function regionBox(region: MapRegion): Box {
  return {
    minLat: region.latitude - region.latitudeDelta / 2,
    maxLat: region.latitude + region.latitudeDelta / 2,
    minLon: region.longitude - region.longitudeDelta / 2,
    maxLon: region.longitude + region.longitudeDelta / 2,
  };
}

/** Rounded so a tile's edges are the same string every time it is asked for,
 *  not `0.30000000000000004` one pan and `0.3` the next. */
function edge(index: number): number {
  return Number((index * TILE_DEG).toFixed(6));
}

/**
 * The fixed tiles covering `region`, or null when the map is too zoomed out
 * to show stations at all.
 */
export function tilesForRegion(region: MapRegion): { key: string; box: Box }[] | null {
  if (region.latitudeDelta > MAX_STATIONS_LAT_DELTA) return null;
  const box = regionBox(region);
  const firstLat = Math.floor(box.minLat / TILE_DEG);
  const lastLat = Math.floor(box.maxLat / TILE_DEG);
  const firstLon = Math.floor(box.minLon / TILE_DEG);
  const lastLon = Math.floor(box.maxLon / TILE_DEG);
  if ((lastLat - firstLat + 1) * (lastLon - firstLon + 1) > MAX_TILES) return null;

  const tiles: { key: string; box: Box }[] = [];
  for (let lat = firstLat; lat <= lastLat; lat++) {
    for (let lon = firstLon; lon <= lastLon; lon++) {
      tiles.push({
        key: `${lat}:${lon}`,
        box: { minLat: edge(lat), maxLat: edge(lat + 1), minLon: edge(lon), maxLon: edge(lon + 1) },
      });
    }
  }
  return tiles;
}

export function insideBox(box: Box, point: { lat: number; lon: number }): boolean {
  return point.lat >= box.minLat && point.lat <= box.maxLat && point.lon >= box.minLon && point.lon <= box.maxLon;
}

/** The station the pin stands on: the nearest one within `SNAP_METERS` of
 *  the centre, or null. */
export function stationUnderPin<T extends { lat: number; lon: number }>(
  center: { lat: number; lon: number },
  stations: readonly T[],
): T | null {
  let best: T | null = null;
  let bestMeters = SNAP_METERS;
  for (const station of stations) {
    const meters = haversineMeters(center, station);
    if (meters <= bestMeters) {
      best = station;
      bestMeters = meters;
    }
  }
  return best;
}
