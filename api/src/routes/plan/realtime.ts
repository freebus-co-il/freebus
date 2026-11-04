import { toIso } from "../../transit/calendar.js";
import type { DayContext } from "../../transit/raptor.js";
import type { Itinerary, TransitLeg, TransitRide } from "../../transit/itinerary.js";
import type { TimetableIndex } from "../../transit/index.js";
import type { TransferMargin } from "../../transit/headway.js";
import type { RealtimeStore } from "../../realtime/store.js";
import { computeTransferAtRisk } from "./transferRisk.js";

/**
 * One transit leg's realtime annotation, or null when its trip has no fresh,
 * resolved data (`RealtimeStore.journeyFor` folds disabled, stale and
 * unmatched into that one null).
 *
 * SIRI gives one predicted ARRIVAL per stop call. `predictedDeparture` is
 * derived from it: the delay at the board stop (predicted minus scheduled
 * arrival there) applied to the scheduled departure. On this feed arrival and
 * departure are always equal, so the result matches the raw prediction, but
 * the derivation stays correct for a feed with real dwell times.
 *
 * Delays are measured against the SCHEDULED times, because `departureTime` /
 * `arrivalTime` already carry predictions when the trip was planned shifted.
 *
 * Never throws: a lookup miss degrades to an absent prediction.
 */
function realtimeForLeg(
  realtime: RealtimeStore, ix: TimetableIndex, tz: string, leg: TransitRide,
): TransitLeg["realtime"] {
  const tripIdx = ix.tripIdToIdx.get(leg.tripId);
  if (tripIdx === undefined) return null;
  const journey = realtime.journeyFor(tripIdx);
  if (journey === null) return null;

  // A transit leg's endpoints always carry a stopId (see `placeOfStop`).
  const boardStopIdx = ix.stopIdToIdx.get(leg.from.stop.stopId!);
  const alightStopIdx = ix.stopIdToIdx.get(leg.to.stop.stopId!);
  // `unambiguous`: on a loop pattern a stop visited twice cannot be tied to
  // this leg's exact visit.
  const predictedArrivalAtBoardEpoch =
    boardStopIdx === undefined ? null : realtime.unambiguousPredictionFor(tripIdx, boardStopIdx);
  const predictedArrivalEpoch =
    alightStopIdx === undefined ? null : realtime.unambiguousPredictionFor(tripIdx, alightStopIdx);

  const scheduledDepartureEpoch = Date.parse(leg.from.scheduledDepartureTime) / 1000;
  const scheduledArrivalEpoch = Date.parse(leg.to.scheduledArrivalTime) / 1000;

  // The board stop's scheduled arrival, read at this leg's pattern position
  // (`stopSequence`), with the service day's base epoch recovered from the
  // scheduled departure at that same position.
  const timeFrom = ix.tripTimeOffset[tripIdx]!;
  const boardPos = leg.from.stopSequence;
  const baseEpoch = scheduledDepartureEpoch - ix.departureTime[timeFrom + boardPos]!;
  const scheduledArrivalAtBoardEpoch = baseEpoch + ix.arrivalTime[timeFrom + boardPos]!;

  const boardDelaySeconds = predictedArrivalAtBoardEpoch === null
    ? null : predictedArrivalAtBoardEpoch - scheduledArrivalAtBoardEpoch;
  const predictedDepartureEpoch = boardDelaySeconds === null
    ? null : scheduledDepartureEpoch + boardDelaySeconds;

  return {
    predictedDeparture:
      predictedDepartureEpoch === null ? null : toIso(predictedDepartureEpoch, tz),
    predictedArrival:
      predictedArrivalEpoch === null ? null : toIso(predictedArrivalEpoch, tz),
    // At the ALIGHT stop: that is the delay that decides the next connection.
    delaySeconds:
      predictedArrivalEpoch === null ? null : predictedArrivalEpoch - scheduledArrivalEpoch,
    vehicleRef: journey.journey.vehicleRef,
    confidence: journey.journey.confidence,
    recordedAt:
      journey.journey.recordedAt === null ? null : toIso(journey.journey.recordedAt, tz),
    source: realtime.feedSource,
  };
}

/**
 * Annotates itineraries with live predictions, in place. Like the geometry
 * resolvers it may enrich a response but never fail one, and it never touches
 * `departureTime`/`arrivalTime`, which the itinerary's totals derive from.
 *
 * Only called when a realtime store exists. Without one, every leg keeps the
 * `realtime: null` / `transferAtRisk: null` defaults from `buildItinerary`.
 *
 * `reverseSourced` is parallel to `itineraries`.
 */
export function annotateRealtime(
  realtime: RealtimeStore, ix: TimetableIndex, tz: string, days: readonly DayContext[],
  transfer: TransferMargin, reverseSourced: readonly boolean[],
  itineraries: readonly Itinerary[],
): void {
  itineraries.forEach((itinerary, i) => {
    for (const leg of itinerary.legs) {
      if (leg.type !== "transit") continue;
      leg.realtime = realtimeForLeg(realtime, ix, tz, leg);
      for (const alternative of leg.alternatives) {
        alternative.realtime = realtimeForLeg(realtime, ix, tz, alternative);
      }
    }
    itinerary.transferAtRisk =
      computeTransferAtRisk(ix, days, transfer, reverseSourced[i] ?? false, itinerary.legs);
  });
}
