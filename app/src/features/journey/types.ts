import type { Itinerary, TransitLeg } from '@/api/types';

import type { LiveBusProgress } from './live-bus';

/** What the rider is doing right now. One hero line each -- see the spec. */
export type JourneyPhase =
  | 'walking-to-stop'
  | 'waiting'
  | 'riding'
  | 'alight-soon'
  | 'transferring'
  | 'arriving'
  | 'arrived'
  | 'off-plan';

export type OffPlanReason = 'missed-departure' | 'overshot' | 'missed-transfer';

/**
 * The persisted record -- the ONLY thing written to storage. Everything a
 * surface renders is derived from this plus the clock plus a position, so a
 * cold start needs to restore nothing but this.
 */
export type ActiveJourney = {
  id: string;
  itinerary: Itinerary;
  /** Content address back into the plan cache, mirroring `trip.tsx`'s params
   *  so the journey screen can re-find its itinerary the same way. */
  signature: string;
  departure: string;
  startedAt: string;
  /** What the rider typed as their destination, for the surfaces to name. */
  destinationLabel: string;
  /** Leg index whose get-off alert the rider has acknowledged, so it never
   *  re-fires for that leg. Null until they tap "Got it". */
  acknowledgedAlightLegIndex: number | null;
  /** The furthest leg GPS has placed the rider on -- `itinerary.legs.length`
   *  once they have reached the destination. Absent until a usable fix (or a
   *  stop's geofence) has ever placed them, and while absent the journey moves
   *  by the timetable. Never decreases. Optional so a journey stored before
   *  this existed still reads back. */
  gpsLegIndex?: number | null;
};

export type RiderPosition = {
  lat: number;
  lon: number;
  accuracyMeters: number;
  at: string;
};

/** How loud, and how early. Persisted in preferences. */
export type AlertSettings = {
  /** Alert this many stops before the alight stop. */
  leadStops: number;
  /** Fallback when position is unknown and stops cannot be counted. */
  leadSeconds: number;
  sound: boolean;
  vibrate: boolean;
  /** Keep alerting until the rider acknowledges, for sleepers. */
  repeatUntilAcknowledged: boolean;
};

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  leadStops: 1,
  leadSeconds: 90,
  sound: true,
  vibrate: true,
  repeatUntilAcknowledged: false,
};

/** A `/journey/check` prediction for one transit leg. `fetchedAt` exists so
 *  the machine can tell a fresh answer from one nobody has renewed since
 *  polling stopped -- past `LIVE_HOLD_SECONDS` it is treated as no answer at
 *  all, rather than trusted forever. */
export type LiveLeg = { legIndex: number; predictedDeparture: string | null; predictedArrival: string | null; fetchedAt: string };

/** A `/journey/check` verdict on one transfer. `holds` is three-valued
 *  because the server sometimes cannot say either way -- `null` must never be
 *  read as `false`, or a connection nobody has checked would look broken. */
export type LiveConnection = { afterLegIndex: number; holds: boolean | null; fetchedAt: string };

/** A live vehicle's position, kept alongside its progress along the leg: the
 *  riding fallback needs a point of its own to name the next stop from when
 *  the rider's own fix is too weak to trust. */
export type LiveBus = { legIndex: number; progress: LiveBusProgress | null; recordedAt: string | null; lat: number; lon: number };

/** Everything the machine knows about the current journey from the network,
 *  as of the last poll. Optional everywhere it is consumed, so the machine
 *  behaves exactly as before when none of this exists yet. */
export type LiveJourneyInput = { legs: LiveLeg[]; connections: LiveConnection[]; bus: LiveBus | null };

/** Everything a surface needs, and nothing it has to compute. */
export type JourneyState = {
  phase: JourneyPhase;
  /** Index into `itinerary.legs` of the leg being ridden or walked. */
  legIndex: number;
  /** The transit leg in play; null while walking and after arrival. */
  leg: TransitLeg | null;
  /** Stops before alighting. Null when no position is known -- the surfaces
   *  must fall back to time rather than invent a count. */
  stopsRemaining: number | null;
  /** The range the OS should self-tick for this phase. See the spec: this is
   *  what makes a 40-minute journey cost ~8 updates instead of 2,400. */
  timer: { from: string; to: string; countsDown: boolean } | null;
  offPlan: OffPlanReason | null;
  /** Overall completion 0..1, by time. */
  progress: number;
  /** Which clock `timer.to` runs to. 'live' only while a prediction is usable
   *  (see LIVE_HOLD_SECONDS); the surfaces label the countdown with it. */
  timeSource: 'live' | 'scheduled';
  /** While waiting: how many stops the bus still has before the rider's stop,
   *  from a FRESH live position only. Never a timetable guess. */
  busStopsAway: number | null;
  /** Who counted `stopsRemaining`: the rider's own fix, or the bus's position
   *  standing in for a weak one. */
  stopsSource: 'rider' | 'bus' | null;
  /** The next stop the vehicle will reach, for "Next: X". Null without a fix. */
  nextStopName: string | null;
  /** The journey's arrival, shifted by the last ride's live delay when known. */
  arrivalTime: string;
  /** The leg GPS places the rider on as of this resolve (see `trackLegIndex`),
   *  for the provider to write back into the record. Null while the journey
   *  is still running on the timetable. */
  trackedLegIndex: number | null;
  /** GPS has the rider travelling this ride's route while the bus the plan
   *  picked has not left yet: they set out early and caught the run before it.
   *  The provider switches the journey onto that run (see `earlier-run.ts`). */
  ridingEarly: boolean;
};
