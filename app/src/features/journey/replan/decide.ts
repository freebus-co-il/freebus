import type { Itinerary, TransitLeg } from '@/api/types';

import { respectsBackbone, type Backbone } from './backbone';

/**
 * Whether a fresh plan replaces the one the rider is on.
 *
 * Inside the backbone the app just switches -- most riders care about the
 * stations, not the line -- when the new way is clearly sooner, or at once
 * when the current way has broken. Outside it, the app never switches by
 * itself: a faster bus that drops the train the rider chose is offered, and
 * only when their own way no longer works.
 */

export type SwitchDecision =
  | { kind: 'keep' }
  | { kind: 'switch'; itinerary: Itinerary; gainSeconds: number }
  | { kind: 'offer'; itinerary: Itinerary }
  | { kind: 'stuck' };

/** How much sooner a new way has to arrive to be worth changing for. */
export const SWITCH_GAIN_SECONDS = 120;
/** How long a switch stands before another may replace it, unless it breaks. */
export const SWITCH_HYSTERESIS_MS = 90_000;

function firstRide(itinerary: Itinerary): TransitLeg | null {
  return itinerary.legs.find((leg): leg is TransitLeg => leg.type === 'transit') ?? null;
}

function departsAtMs(leg: TransitLeg): number {
  return Date.parse(leg.realtime?.predictedDeparture ?? leg.from.departureTime);
}

function earliest(itineraries: Itinerary[]): Itinerary | null {
  return itineraries.reduce<Itinerary | null>(
    (best, it) => (best === null || Date.parse(it.arrivalTime) < Date.parse(best.arrivalTime) ? it : best),
    null,
  );
}

export function decideSwitch(args: {
  currentArrival: string;
  broken: boolean;
  backbone: Backbone | null;
  candidates: Itinerary[];
  nowMs: number;
  lastSwitchAt: number | null;
  /** The earliest the rider can start a candidate's first ride. */
  readyAtMs: (itinerary: Itinerary) => number;
}): SwitchDecision {
  const { currentArrival, broken, backbone, candidates, nowMs, lastSwitchAt, readyAtMs } = args;

  const reachable = candidates.filter((candidate) => {
    const ride = firstRide(candidate);
    return ride === null || departsAtMs(ride) >= readyAtMs(candidate);
  });
  const isInside = (candidate: Itinerary) => backbone === null || respectsBackbone(candidate, backbone);
  // A way whose transfer the planner already doubts is the next broken plan:
  // switching onto it is how a journey flaps. Safe ways first, always.
  const safe = reachable.filter((candidate) => candidate.transferAtRisk !== true);
  const risky = reachable.filter((candidate) => candidate.transferAtRisk === true);
  const gain = (it: Itinerary) => (Date.parse(currentArrival) - Date.parse(it.arrivalTime)) / 1000;

  if (broken) {
    const order: [Itinerary | null, 'switch' | 'offer'][] = [
      [earliest(safe.filter(isInside)), 'switch'],
      [earliest(safe.filter((c) => !isInside(c))), 'offer'],
      [earliest(risky.filter(isInside)), 'switch'],
      [earliest(risky.filter((c) => !isInside(c))), 'offer'],
    ];
    for (const [itinerary, kind] of order) {
      if (itinerary === null) continue;
      return kind === 'switch' ? { kind, itinerary, gainSeconds: gain(itinerary) } : { kind, itinerary };
    }
    return { kind: 'stuck' };
  }

  const best = earliest(safe.filter(isInside));
  if (best === null) return { kind: 'keep' };
  if (lastSwitchAt !== null && nowMs - lastSwitchAt < SWITCH_HYSTERESIS_MS) return { kind: 'keep' };
  const gainSeconds = gain(best);
  return gainSeconds >= SWITCH_GAIN_SECONDS ? { kind: 'switch', itinerary: best, gainSeconds } : { kind: 'keep' };
}
