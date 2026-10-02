/**
 * Whose data the rider is looking at, for the credit shown beside it.
 *
 * OpenStreetMap's ODbL wants "© OpenStreetMap contributors" wherever OSM data
 * reaches a user (walking routes, rail track, Photon addresses); Google's
 * Places policy wants "Google Maps" beside its results. The API says which
 * applies per response, because production switches geocoders.
 */
export type Attribution = 'google' | 'osm';

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** Google's permitted text form of its wordmark: never translated, never
 *  re-cased, never wrapped. */
export const GOOGLE_MAPS_TEXT = 'Google Maps';

/** The credit under a list of address results, or null when there is nothing
 *  to credit -- no address rows, or a server too old to say. */
export function addressCredit(attribution: Attribution | undefined, addressCount: number): Attribution | null {
  if (attribution === undefined || addressCount === 0) return null;
  return attribution;
}

/** The credit for a drawn line: only geometry the server says came from OSM. */
export function shapeCredit(attribution: 'osm' | null | undefined): 'osm' | null {
  return attribution === 'osm' ? 'osm' : null;
}
