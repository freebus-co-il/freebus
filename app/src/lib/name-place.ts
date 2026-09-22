import type { SelectedPlace } from './place';

/** Turns a position into the name of the place at it, or null when there is
 *  nothing to call it. Injected rather than imported so every caller's tests
 *  run without a network, and so a screen can pass a cached lookup. */
export type ReverseLookup = (lat: number, lon: number) => Promise<string | null>;

/**
 * A bare position, named as well as it can be.
 *
 * Three parts of the app turn coordinates into a place a rider then reads
 * back: a shared map link, a pin dropped on the map, and the live GPS origin
 * a recent trip is saved from. Reverse geocoding goes to the self-hosted
 * Photon (see the backend's `CompositeGeocoder`), which costs nothing per
 * lookup unlike Google's Geocoding API; when it cannot name a spot, these
 * fall back to a placeholder label -- "Pinned location", "Current location".
 *
 * Never rejects. The place is already usable unnamed -- planning a trip from
 * a coordinate has never needed an address -- so a geocoder that is down or
 * knows nothing about this spot costs a nice label and nothing more, and
 * callers can await this without a catch of their own.
 *
 * The position is always the one passed in. A reverse lookup answers with the
 * position of whatever it matched, which can be tens of metres away; adopting
 * it would plan from the middle of the road, and would drift a saved trip's
 * origin a little on every re-record.
 */
export async function namedCoordinate(
  at: { lat: number; lon: number },
  reverse: ReverseLookup,
  fallback: string,
): Promise<SelectedPlace> {
  const found = await reverse(at.lat, at.lon).catch(() => null);
  return { kind: 'coordinate', lat: at.lat, lon: at.lon, label: found?.trim() || fallback };
}
