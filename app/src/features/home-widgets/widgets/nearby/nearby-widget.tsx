import { NearbyStops } from '@/features/nearby/nearby-stops';

import type { NearbyStyle } from './nearby-style';

/** Eleven stations either way: with the map, the closest is drawn on it and
 *  ten more are rows under it; as a list, all eleven are rows. */
const HOME_NEARBY_STOPS = 11;

/** `featureClosest` is what moves the closest station onto the map, and the
 *  section's title into the map's panel. Off, `NearbyStops` lists every
 *  station, the closest included, under its own "Nearby stops" title. */
export function NearbyWidget({ options }: { options: NearbyStyle }) {
  return <NearbyStops limit={HOME_NEARBY_STOPS} featureClosest={options === 'map'} />;
}
