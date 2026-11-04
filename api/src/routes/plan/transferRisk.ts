import type { DayContext } from "../../transit/raptor.js";
import { extraAlightingSeconds } from "../../transit/raptorReverse.js";
import type { Itinerary, Leg, TransitLeg } from "../../transit/itinerary.js";
import type { TimetableIndex } from "../../transit/index.js";
import {
  headwayFor, patternTravelOffset, requiredTransferSeconds, type TransferMargin,
} from "../../transit/headway.js";

/** The fields of the boarding leg `requiredMarginFor` reads. `TransitLeg`
 *  satisfies it; `journeyCheck.ts` builds one from a rider-supplied trip. */
export interface MarginBoardingLeg {
  tripId: string;
  from: { stopSequence: number; departureTime: string };
}

/**
 * The transfer margin the search that built an itinerary required to board
 * `next`, recomputed from SCHEDULED times (neither `Label` nor `TransitLeg`
 * records it).
 *
 * `reverseSourced` picks the rule. The forward pass (`raptor.ts`) charges the
 * pointwise `requiredTransferSeconds` at the candidate boarding instant. The
 * reverse pass (`raptorReverse.ts`, used by `arriveBy` and by reoptimised
 * `departAfter` chains) charges the maximum over its readiness window,
 * `extraAlightingSeconds`. Using the forward rule for both would be the
 * permissive direction: a smaller margin makes `transferAtRisk` fire less.
 *
 * On the forward path, `prevArrivalEpoch + walkSeconds + baseSeconds`
 * reconstructs the boarding instant `raptor.ts` calls `base`, with or without
 * a walk leg, because a reported walk is already buffer-stripped.
 *
 * The service day is recovered from `next`'s boarding position. A lookup miss
 * should be impossible; it degrades to the flat `baseSeconds` because this
 * feeds an annotation, which may enrich a response but never fail one.
 */
export function requiredMarginFor(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean,
  prevArrivalEpoch: number, walkSeconds: number, next: MarginBoardingLeg,
): number {
  const nextTripIdx = ix.tripIdToIdx.get(next.tripId);
  if (nextTripIdx === undefined) return transfer.cfg.baseSeconds;

  const timeFrom = ix.tripTimeOffset[nextTripIdx]!;
  const boardPos = next.from.stopSequence;
  const nextScheduledDepartureEpoch = Date.parse(next.from.departureTime) / 1000;
  const tripBaseEpoch = nextScheduledDepartureEpoch - ix.departureTime[timeFrom + boardPos]!;

  const dayIdx = days.findIndex((d) => d.baseEpoch === tripBaseEpoch);
  if (dayIdx === -1) return transfer.cfg.baseSeconds;

  const patternIdx = ix.patternOfTrip[nextTripIdx]!;

  // `transfer.headway` is parallel to `days`; both passes validate that.
  if (reverseSourced) {
    return transfer.cfg.baseSeconds
      + extraAlightingSeconds(
        ix, transfer, days, patternIdx, boardPos, dayIdx, nextScheduledDepartureEpoch,
      );
  }

  const base = prevArrivalEpoch + walkSeconds + transfer.cfg.baseSeconds;
  const secondsIntoDay = base - tripBaseEpoch;
  // The headway table is keyed on the pattern's departure from its FIRST
  // stop, so shift back from the boarding stop, as `raptor.ts` does.
  return requiredTransferSeconds(
    headwayFor(
      transfer.headway[dayIdx]!, patternIdx,
      secondsIntoDay - patternTravelOffset(ix, patternIdx, boardPos),
    ),
    transfer.cfg,
  );
}

interface TransferPair { leg: TransitLeg; next: TransitLeg; walkSeconds: number }

/**
 * Every interchange in an itinerary: a transit leg, the next transit leg, and
 * the walking seconds between them (0 for a same-stop transfer). The last
 * ride contributes no pair.
 */
function transferPairs(legs: readonly Leg[]): TransferPair[] {
  const out: TransferPair[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg === undefined || leg.type !== "transit") continue;

    let j = i + 1;
    let walkSeconds = 0;
    for (; j < legs.length; j++) {
      const maybeWalk = legs[j];
      if (maybeWalk === undefined || maybeWalk.type !== "walk") break;
      walkSeconds += maybeWalk.durationSeconds;
    }
    const next = legs[j];
    if (next === undefined || next.type !== "transit") continue;
    out.push({ leg, next, walkSeconds });
  }
  return out;
}

/**
 * The longest time a rider stands still between two rides: next departure
 * minus previous arrival, less any walk in between. `runRaptorReverse` never
 * bounds this; `arriveBy` uses it to reject overnight waits.
 */
export function maxTransferWaitSeconds(legs: readonly Leg[]): number {
  let maxWait = 0;
  for (const { leg, next, walkSeconds } of transferPairs(legs)) {
    const arrivalEpoch = Date.parse(leg.to.arrivalTime) / 1000;
    const nextDepartureEpoch = Date.parse(next.from.departureTime) / 1000;
    const wait = nextDepartureEpoch - arrivalEpoch - walkSeconds;
    if (wait > maxWait) maxWait = wait;
  }
  return maxWait;
}

/**
 * One transfer, priced against the timetable: the margin the rule requires,
 * and whether the SCHEDULE alone already falls short of it (which happens
 * only where the last-service fallback yielded to the flat buffer).
 */
function marginShortfall(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean, pair: TransferPair,
): { required: number; scheduledShort: boolean; nextDepartureEpoch: number } {
  const scheduledArrivalEpoch = Date.parse(pair.leg.to.scheduledArrivalTime) / 1000;
  const nextDepartureEpoch = Date.parse(pair.next.from.scheduledDepartureTime) / 1000;
  const required = requiredMarginFor(
    ix, days, transfer, reverseSourced, scheduledArrivalEpoch, pair.walkSeconds, pair.next,
  );
  return {
    required,
    nextDepartureEpoch,
    scheduledShort:
      scheduledArrivalEpoch + pair.walkSeconds + required > nextDepartureEpoch,
  };
}

/**
 * The realtime verdict on an itinerary's transfers.
 *
 * True when some transfer is short on schedule, or its predicted arrival plus
 * the walk plus the headway-scaled margin lands after the next scheduled
 * departure. A connection that holds by five seconds is not safe if the
 * planner itself would have refused it.
 *
 * False when every transfer is confirmed (including no transfers at all).
 * Null when some transfer has no prediction and none is at risk: calling that
 * `false` would assert a safety the data cannot support.
 */
export function computeTransferAtRisk(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: boolean,
  legs: readonly Leg[],
): boolean | null {
  let anyAtRisk = false;
  let anyUnknown = false;

  for (const pair of transferPairs(legs)) {
    const { leg, walkSeconds } = pair;
    const { required, scheduledShort, nextDepartureEpoch } =
      marginShortfall(ix, days, transfer, reverseSourced, pair);
    // No prediction can rescue a connection the schedule already condemns:
    // this planner never promises a vehicle running early.
    if (scheduledShort) {
      anyAtRisk = true;
      continue;
    }
    if (leg.realtime === null || leg.realtime.predictedArrival === null) {
      anyUnknown = true;
      continue;
    }
    const predictedArrivalEpoch = Date.parse(leg.realtime.predictedArrival) / 1000;
    if (predictedArrivalEpoch + walkSeconds + required > nextDepartureEpoch) {
      anyAtRisk = true;
    }
  }

  if (anyAtRisk) return true;
  if (anyUnknown) return null;
  return false;
}

/**
 * Raises `transferAtRisk` to `true` on every itinerary with a transfer the
 * SCHEDULE alone cannot support: the last-service fallback, where the planner
 * returns a journey the scaled margin would have refused rather than nothing.
 *
 * Runs on every request, with or without a realtime store, because a yielded
 * connection is a fact about the timetable. Only ever raises the flag; a
 * `null` is never turned into `false` here.
 *
 * `reverseSourced` is parallel to `itineraries`.
 */
export function annotateTransferRisk(
  ix: TimetableIndex, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: readonly boolean[],
  itineraries: readonly Itinerary[],
): void {
  itineraries.forEach((itinerary, i) => {
    if (itinerary.transferAtRisk === true) return;
    const short = transferPairs(itinerary.legs).some(
      (pair) => marginShortfall(ix, days, transfer, reverseSourced[i] ?? false, pair).scheduledShort,
    );
    if (short) itinerary.transferAtRisk = true;
  });
}
