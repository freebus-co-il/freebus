import type { Itinerary } from '@/api/types';

export type ItineraryGroup = {
  signature: string;
  /** Same-pattern itineraries, sorted earliest departure first. */
  instances: Itinerary[];
};

/**
 * Two itineraries through the same stops -- boarding and getting off each ride
 * at the same stops, with the same walks between -- are the same trip to a
 * rider, whichever LINE carries each ride and whenever it leaves. The line is
 * just the vehicle; the route through the stops is the trip. So the 70 and the
 * 10 from the same stop to the same station for the same train are one card,
 * not two, as some planners do.
 *
 * Deliberately ignores both the lines and every time field. What the lines
 * cost or save is the ride card's business (see `features/trip/line-options`).
 */
export function itinerarySignature(itinerary: Itinerary): string {
  return itinerary.legs
    .map((leg) =>
      leg.type === 'walk'
        ? `walk:${Math.round(leg.distanceMeters)}`
        : `transit:${leg.from.stop.stopId ?? ''}:${leg.to.stop.stopId ?? ''}`,
    )
    .join('|');
}

/**
 * Groups by signature, preserving each group's rank as the position of its
 * best-ranked instance in `itineraries` -- so grouping never reorders the
 * caller's sort (by effort or by duration), it only collapses duplicates.
 */
export function groupItineraries(itineraries: Itinerary[]): ItineraryGroup[] {
  const order: string[] = [];
  const bySignature = new Map<string, Itinerary[]>();
  for (const itinerary of itineraries) {
    const signature = itinerarySignature(itinerary);
    const existing = bySignature.get(signature);
    if (existing) {
      existing.push(itinerary);
    } else {
      bySignature.set(signature, [itinerary]);
      order.push(signature);
    }
  }
  return order.map((signature) => ({
    signature,
    // One instance per departure: two lines leaving the same stop the same
    // minute along the same stops are one departure to a rider, and the first
    // -- the caller's own order -- is kept. The other is still one of its
    // ride's line options.
    instances: [...bySignature.get(signature)!]
      .filter((itinerary, index, all) => all.findIndex((other) => other.departureTime === itinerary.departureTime) === index)
      .sort((a, b) => a.departureTime.localeCompare(b.departureTime)),
  }));
}
