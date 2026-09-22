/** One vehicle's predicted call at one stop. */
export interface RealtimeCall {
  /** GTFS stop_code, as SIRI reports it. Resolution to a stop index is match.ts's job. */
  stopCode: string;
  /** SIRI `Order`, i.e. GTFS stop_sequence. Null when the service omitted it. */
  order: number | null;
  /** Epoch seconds. */
  expectedArrival: number;
}

/** One vehicle's journey, as SIRI describes it, before any resolution. */
export interface RealtimeJourney {
  /** SIRI LineRef — our routes.route_id. */
  lineRef: string;
  /**
   * GTFS direction_id (0,1,2) — already converted from SIRI's 1,2,3 — or
   * `null` when the source does not report one at all.
   *
   * SIRI-SM always does: `parseVisit` drops a visit without a DirectionRef.
   * The Stride SIRI-VM feed never does, and `resolveJourney` recovers it
   * from the route instead — checked feed-wide on 2026-09-01, all 7,753
   * routes carry exactly one direction_id, so the route determines it. A
   * route that ever carried two resolves to nothing rather than to a guess.
   */
  directionId: number | null;
  /** SIRI DataFrameRef, the service date, as YYYY-MM-DD. */
  dataFrameRef: string | null;
  /** SIRI DatedVehicleJourneyRef. Kept for diagnostics; not used as a join key. */
  datedVehicleJourneyRef: string | null;
  /** Scheduled start of the trip, epoch seconds. The join key. */
  originAimedDeparture: number | null;
  operatorRef: string | null;
  publishedLineName: string | null;
  vehicleRef: string | null;
  confidence: string | null;
  lat: number | null;
  lon: number | null;
  /** When the vehicle reported this, epoch seconds. */
  recordedAt: number | null;
  /** The monitored call plus every onward call, in the order SIRI gave
   *  them. Always EMPTY on the SIRI-VM path, which carries no predictions
   *  at all — see `distanceFromStart`. */
  calls: RealtimeCall[];
  /**
   * Metres travelled along the trip's shape, as SIRI-VM reports it; `null`
   * on SIRI-SM, which has no such concept.
   *
   * Zero is LEGITIMATE — a vehicle sitting at its origin — and must never
   * be conflated with `null`. `match.ts`'s `predictFromDistance` turns this
   * into one delay for the vehicle, and thence into the per-stop
   * predictions SIRI-SM would have supplied directly.
   */
  distanceFromStart: number | null;
}

export interface SiriSnapshot {
  journeys: RealtimeJourney[];
  /** Epoch seconds when we finished receiving it. */
  fetchedAt: number;
  /**
   * Every `MonitoredStopVisit` this response carried, across every
   * delivery, whether or not it survived `parseVisit`. `visitsDropped`
   * alone can't be judged without knowing how many
   * visits there were to drop from -- `0 journeys, 0 visits` (a
   * legitimately quiet feed) and `0 journeys, 8,412 visits` (every one
   * dropped) look identical from `journeys.length` alone.
   */
  visitsSeen: number;
  /** Of `visitsSeen`, how many `parseVisit` returned `null` for -- missing
   * `LineRef`/`DirectionRef`, or no usable calls. Never includes a
   * per-CALL drop (`parseCall` dropping one call within an otherwise-kept
   * visit) -- that would need visit-level counting to double as call-level
   * counting, which this diagnostic does not need. */
  visitsDropped: number;
}

/** A parse that failed in a way worth telling the operator about. */
export class SiriError extends Error {}

/**
 * Which feed a prediction came from. A `"siri-sm"` prediction is the
 * operator's own ETA for a stop. The other two are inferred here from a
 * vehicle position plus the schedule, from the same MOT data
 * by two routes: `"open-bus-vm"` reads the Public Knowledge Workshop's raw
 * per-minute snapshot (positions about a minute old), `"stride-vm"` reads
 * their Stride database, whose ETL runs 13-23 minutes behind on a weekday.
 * Public on every annotated leg so a client may present them differently.
 */
export type RealtimeSource = "siri-sm" | "open-bus-vm" | "stride-vm";
