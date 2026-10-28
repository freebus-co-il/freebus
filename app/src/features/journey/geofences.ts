import type { ActiveJourney } from './types';

/**
 * iOS monitors at most 20 regions APP-WIDE, and blows past it silently rather
 * than erroring. Staying well under leaves room for anything else that ever
 * wants a region, and every itinerary a rider actually takes fits easily.
 */
export const MAX_REGIONS = 16;

/** A stop is "arrived at" from this far out -- generous enough for GPS in a
 *  street canyon, tight enough not to trigger from the previous stop. */
export const STOP_RADIUS_METERS = 150;

/** Used when a ride has no intermediate stop to hang the wake ring on. Sized
 *  to give roughly a minute of warning at urban bus speeds. */
export const WAKE_RING_FALLBACK_RADIUS_METERS = 1200;

export type JourneyRegion = {
  id: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  kind: 'board' | 'transfer' | 'wake' | 'alight' | 'destination';
  legIndex: number;
};

/**
 * The handful of places where crossing a line means something.
 *
 * Deliberately NOT one region per intermediate stop: a single long ride would
 * exhaust the platform budget on its own, and the app does not need to know
 * about stop 7 of 22 -- it needs to know when to wake up and start paying
 * attention. Entering a `wake` ring is what escalates location accuracy and
 * arms the get-off alert; everything else is a phase transition.
 */
export function buildJourneyRegions(journey: ActiveJourney): JourneyRegion[] {
  const regions: JourneyRegion[] = [];
  const legs = journey.itinerary.legs;
  const firstTransit = legs.findIndex((leg) => leg.type === 'transit');

  legs.forEach((leg, legIndex) => {
    if (leg.type !== 'transit') return;

    regions.push({
      id: `board:${legIndex}`,
      lat: leg.from.stop.lat,
      lon: leg.from.stop.lon,
      radiusMeters: STOP_RADIUS_METERS,
      kind: legIndex === firstTransit ? 'board' : 'transfer',
      legIndex,
    });

    const penultimate = leg.intermediateStops.at(-1);
    regions.push(
      penultimate
        ? {
            id: `wake:${legIndex}`,
            lat: penultimate.lat,
            lon: penultimate.lon,
            radiusMeters: STOP_RADIUS_METERS,
            kind: 'wake',
            legIndex,
          }
        : {
            id: `wake:${legIndex}`,
            lat: leg.to.stop.lat,
            lon: leg.to.stop.lon,
            radiusMeters: WAKE_RING_FALLBACK_RADIUS_METERS,
            kind: 'wake',
            legIndex,
          },
    );

    regions.push({
      id: `alight:${legIndex}`,
      lat: leg.to.stop.lat,
      lon: leg.to.stop.lon,
      radiusMeters: STOP_RADIUS_METERS,
      kind: 'alight',
      legIndex,
    });
  });

  const finalLeg = legs.at(-1);
  if (finalLeg) {
    const end = finalLeg.type === 'walk' ? finalLeg.to : finalLeg.to.stop;
    regions.push({
      id: 'destination',
      lat: end.lat,
      lon: end.lon,
      radiusMeters: STOP_RADIUS_METERS,
      kind: 'destination',
      legIndex: legs.length - 1,
    });
  }

  // Over budget, the LAST regions are the ones to keep: they belong to the
  // end of the journey, which is where the alerts that matter live. Dropping
  // the tail instead would silently disarm the get-off alarm.
  return regions.length <= MAX_REGIONS ? regions : regions.slice(regions.length - MAX_REGIONS);
}
