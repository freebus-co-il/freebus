import { placeLabel } from '@/lib/place';

import type { JourneyPoint } from './types';

/** The points in order, for a row's subtitle. A middle dot rather than an
 *  arrow, which would point the wrong way in one of the two languages. */
export function pointsSummary(points: readonly JourneyPoint[]): string {
  return points.map((point) => placeLabel(point.place)).join(' · ');
}
