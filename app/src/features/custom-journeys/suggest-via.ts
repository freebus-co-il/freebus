import { haversineMeters } from '@/lib/geo';
import { placeCoordinates, type SelectedPlace } from '@/lib/place';

import type { PointVia } from './types';

/** Closer than this, a step is a walk: about a quarter of an hour on foot,
 *  which no bus beats once the wait for it is counted. */
export const WALK_SUGGEST_METERS = 1000;

function isRail(place: SelectedPlace): boolean {
  return place.kind === 'stop' && place.rail === true;
}

/**
 * How the rider most likely makes a step they just added, as the editor's
 * starting answer (they can change it): a short hop is a walk, two stations
 * are the train, and a station to anywhere further is the bus. Anything else
 * is left to the planner.
 */
export function suggestVia(from: SelectedPlace, to: SelectedPlace): PointVia {
  const a = placeCoordinates(from);
  const b = placeCoordinates(to);
  if (a && b && haversineMeters(a, b) <= WALK_SUGGEST_METERS) return 'walk';
  if (isRail(from) && isRail(to)) return 'train';
  if (isRail(from) || isRail(to)) return 'bus';
  return 'any';
}
