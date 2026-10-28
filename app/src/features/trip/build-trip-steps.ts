import type { Itinerary, TransitLeg } from '@/api/types';

/** Below a minute, a gap between alighting and the next boarding is an
 *  artefact of rounding, not something a rider experiences as waiting. */
const MIN_REPORTED_WAIT_SECONDS = 60;

/**
 * One thing the rider physically does, in order.
 *
 * Deliberately NOT one entry per leg. A leg is how the planner models a
 * journey; a step is how a person performs one, and the two diverge at
 * exactly the moments that matter most when you don't know where you are:
 * waiting is nobody's leg but it is the part you stand through, and getting
 * off is the end of a leg rather than an event, even though it is the single
 * action an unfamiliar rider is most afraid of missing.
 */
export type TripStep =
  | {
      kind: 'walk';
      startsAt: string;
      durationSeconds: number;
      distanceMeters: number;
      /** Where the walk ends. Null on the final walk, which ends at the
       *  rider's own destination and has no stop name to give. */
      destinationName: string | null;
      final: boolean;
    }
  | { kind: 'wait'; startsAt: string; durationSeconds: number }
  | { kind: 'ride'; startsAt: string; leg: TransitLeg }
  | { kind: 'arrive'; startsAt: string };

function secondsBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000;
}

/**
 * Turns an itinerary into the sequence a rider performs.
 *
 * Waits are DERIVED rather than read off anything: the API reports when each
 * ride departs and when the previous one arrived, but never the standing
 * around in between. Tracking a running "ready at" instant -- the moment the
 * rider is stood at the next stop, having finished whatever preceded -- makes
 * the wait fall out as the difference against the next departure, and works
 * the same whether the two rides are joined by a footpath or by nothing.
 */
export function buildTripSteps(itinerary: Itinerary): TripStep[] {
  const steps: TripStep[] = [];
  // The door departure: when the rider must be moving. See `ItineraryCard`.
  let readyAt = itinerary.departureTime;

  itinerary.legs.forEach((leg, index) => {
    if (leg.type === 'walk') {
      const final = index === itinerary.legs.length - 1;
      steps.push({
        kind: 'walk',
        startsAt: readyAt,
        durationSeconds: leg.durationSeconds,
        distanceMeters: leg.distanceMeters,
        destinationName: final ? null : (leg.to.name ?? null),
        final,
      });
      readyAt = new Date(new Date(readyAt).getTime() + leg.durationSeconds * 1000).toISOString();
      return;
    }

    const waitSeconds = secondsBetween(readyAt, leg.from.departureTime);
    if (waitSeconds >= MIN_REPORTED_WAIT_SECONDS) {
      steps.push({ kind: 'wait', startsAt: readyAt, durationSeconds: waitSeconds });
    }
    steps.push({ kind: 'ride', startsAt: leg.from.departureTime, leg });
    readyAt = leg.to.arrivalTime;
  });

  steps.push({ kind: 'arrive', startsAt: itinerary.arrivalTime });
  return steps;
}
