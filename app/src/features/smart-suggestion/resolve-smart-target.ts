import type { PresetId } from '@/features/saved-locations/types';
import { haversineMeters } from '@/lib/geo';
import { placeCoordinates, type SelectedPlace } from '@/lib/place';

/**
 * Within this of the saved home, the rider is treated as being AT home, and
 * the commute they're about to make is the outbound one.
 *
 * An indoor GPS fix drifts 50-100 m and a city block runs about 100 m, so
 * anything much tighter than this would call a rider standing in their own
 * kitchen "away". Anything much looser starts claiming a whole neighbourhood
 * is home and would offer the trip to work to someone three streets away
 * heading in the opposite direction.
 */
export const AT_HOME_RADIUS_METERS = 300;

/** Where the home screen thinks the rider is headed next, and which preset
 *  that is -- the preset picks the icon and title the card is labelled with. */
export type SmartTarget = { preset: PresetId; place: SelectedPlace };

/**
 * The one trip worth offering unprompted, or null when there isn't one.
 *
 * Home is the pivot: it is what "am I at home?" is measured against, so
 * without a home that has coordinates there is no question to answer and no
 * section to show. Work is only ever planned TO, never measured against --
 * `/plan` addresses a stop by id -- so it needs no coordinates of its own,
 * and a rider who saved only a home still gets the trip back to it.
 */
export function resolveSmartTarget(
  here: { lat: number; lon: number } | null,
  home: SelectedPlace | null,
  work: SelectedPlace | null,
): SmartTarget | null {
  if (here === null || home === null) return null;

  const homeCoordinates = placeCoordinates(home);
  if (homeCoordinates === null) return null;

  if (haversineMeters(here, homeCoordinates) <= AT_HOME_RADIUS_METERS) {
    return work === null ? null : { preset: 'work', place: work };
  }
  return { preset: 'home', place: home };
}
