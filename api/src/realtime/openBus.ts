import type { RealtimeJourney } from "./types.js";

/**
 * Parses the raw national SIRI snapshot that the Public Knowledge Workshop's
 * SIRI requester publishes once a minute, BEFORE its Stride ETL touches it:
 * `https://open-bus-siri-requester.hasadna.org.il/YYYY/MM/DD/HH/MM.br`.
 *
 * Why this exists alongside `stride.ts`: it is the same MOT data, but
 * Stride's ETL loads each snapshot 13-23 minutes late on a normal weekday
 * (2026-09-10's 05:00Z snapshot finished loading at 05:16:27), while this
 * file is live about 30 s after its minute. Replayed against that morning's
 * peak, predictions from Stride existed for 2-32% of the five minutes before
 * a bus arrived; from this file, 97-98%.
 *
 * The envelope is SIRI-SM (`StopMonitoringDelivery`), but the content is
 * vehicle monitoring: no `DirectionRef`, no `ExpectedArrivalTime`, so
 * `siri.ts`'s `parseVisit` would drop every visit. What each visit does
 * carry is a position and `MonitoredCall.DistanceFromStop`, which -- despite
 * its name -- is metres from the JOURNEY'S START: 4,275 of 4,276 vehicles
 * equal Stride's `distance_from_journey_start` for the same report
 * (2026-09-13 18:29Z). So every journey here has EMPTY `calls`, and
 * `match.ts`'s `predictFromDistance` derives the predictions exactly as it
 * does for Stride.
 */

export interface OpenBusSnapshot {
  journeys: RealtimeJourney[];
  /** Every `MonitoredStopVisit` the payload carried, kept or not. */
  rowsSeen: number;
  /** Of `rowsSeen`, how many were unusable or ghosts. Same reason as
   *  `StrideSnapshot.rowsDropped`: an empty feed and a fully rejected one
   *  are otherwise indistinguishable. */
  rowsDropped: number;
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

/** SIRI XML-to-JSON turns a one-element list into a bare object. */
function asList(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  return x === undefined || x === null ? [] : [x];
}

function asString(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

/** Every numeric in this feed arrives as a string. A finite number or
 *  `null`, never `NaN` -- the same contract as `siri.ts` and `stride.ts`. */
function toFiniteNumber(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string" || x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** ISO 8601 with an offset, to epoch seconds, or `null`. */
function toEpochSeconds(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Metres from the journey's start, or `null` when the feed does not know.
 *
 * `"0"` is only believed at `Order` 1. Past the first stop it is the feed's
 * "no fix" shape: at the 2026-09-10 peak, 29 of 8,872 visits reported 0 past
 * their first stop, every one of the 8 visits with no `VehicleLocation` was
 * among them, and the only report that disagreed with Stride was one. Read
 * as a real 0 it would place a mid-route bus back at its origin and predict
 * it minutes early at every stop it has already passed.
 */
function distanceFromStart(call: Record<string, unknown> | null): number | null {
  if (call === null) return null;
  const distance = toFiniteNumber(call["DistanceFromStop"]);
  if (distance === null || distance < 0) return null;
  if (distance === 0 && toFiniteNumber(call["Order"]) !== 1) return null;
  return distance;
}

/**
 * One visit, or `null` if it cannot become a usable journey: no route, no
 * service date, no scheduled origin departure (together, the trip key), no
 * readable report time, or a report older than `maxVehicleAgeSeconds`.
 * Never throws -- one malformed visit must not take a national snapshot
 * down with it.
 */
function parseVisit(raw: unknown, now: number, maxVehicleAgeSeconds: number): RealtimeJourney | null {
  const visit = asRecord(raw);
  if (visit === null) return null;
  const mvj = asRecord(visit["MonitoredVehicleJourney"]);
  if (mvj === null) return null;

  const lineRef = asString(mvj["LineRef"]);
  if (lineRef === null) return null;

  const framed = asRecord(mvj["FramedVehicleJourneyRef"]);
  const dataFrameRef = framed === null ? null : asString(framed["DataFrameRef"]);
  if (dataFrameRef === null) return null;

  const originAimedDeparture = toEpochSeconds(mvj["OriginAimedDepartureTime"]);
  if (originAimedDeparture === null) return null;

  const recordedAt = toEpochSeconds(visit["RecordedAtTime"]);
  if (recordedAt === null) return null;

  // Ghosts: a vehicle that stopped reporting keeps appearing with its last
  // report. Dropped before matching so it can never occupy a trip a live
  // vehicle should own. Measured against the SNAPSHOT'S fetch time, not
  // this file's ResponseTimestamp, so a file that arrives late ages too.
  if (now - recordedAt > maxVehicleAgeSeconds) return null;

  const location = asRecord(mvj["VehicleLocation"]);
  return {
    lineRef,
    // Never reported; `resolveJourney` recovers it from the route.
    directionId: null,
    dataFrameRef,
    datedVehicleJourneyRef: framed === null ? null : asString(framed["DatedVehicleJourneyRef"]),
    originAimedDeparture,
    operatorRef: asString(mvj["OperatorRef"]),
    publishedLineName: null,
    vehicleRef: asString(mvj["VehicleRef"]),
    // SIRI's own confidence, which this feed does not carry; provenance is
    // the public `source` field's job, not this one's.
    confidence: null,
    lat: location === null ? null : toFiniteNumber(location["Latitude"]),
    lon: location === null ? null : toFiniteNumber(location["Longitude"]),
    recordedAt,
    calls: [],
    distanceFromStart: distanceFromStart(asRecord(mvj["MonitoredCall"])),
  };
}

/**
 * The snapshot's journeys, or `null` when the body is not a SIRI stop
 * monitoring delivery at all -- an HTML error page, a truncated file -- so
 * the poller fails the tick instead of storing an empty country. A
 * well-formed delivery with no visits is a legitimately quiet feed and
 * parses to zero journeys.
 */
export function parseOpenBusSnapshot(
  payload: unknown, opts: { now: number; maxVehicleAgeSeconds: number },
): OpenBusSnapshot | null {
  const serviceDelivery = asRecord(asRecord(asRecord(payload)?.["Siri"])?.["ServiceDelivery"]);
  if (serviceDelivery === null || !("StopMonitoringDelivery" in serviceDelivery)) return null;

  const journeys: RealtimeJourney[] = [];
  let rowsSeen = 0;
  let rowsDropped = 0;
  for (const deliveryRaw of asList(serviceDelivery["StopMonitoringDelivery"])) {
    const delivery = asRecord(deliveryRaw);
    if (delivery === null) continue;
    for (const visit of asList(delivery["MonitoredStopVisit"])) {
      rowsSeen++;
      const journey = parseVisit(visit, opts.now, opts.maxVehicleAgeSeconds);
      if (journey === null) rowsDropped++;
      else journeys.push(journey);
    }
  }
  return { journeys, rowsSeen, rowsDropped };
}

const SNAPSHOT_ID = /^\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}$/;

/**
 * The newest published snapshot id from `daemon_status.json`
 * (`{"last_snapshot_id": "2026/09/13/17/32", ...}`), or `null`. The id is
 * interpolated into a URL path, so nothing but that exact shape is accepted.
 */
export function latestSnapshotId(status: unknown): string | null {
  const id = asRecord(status)?.["last_snapshot_id"];
  return typeof id === "string" && SNAPSHOT_ID.test(id) ? id : null;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** 84 bytes, updated as each minute's snapshot lands (~30 s past the minute). */
export function statusUrl(baseUrl: string): string {
  return `${trimBase(baseUrl)}/daemon_status.json`;
}

/** Brotli-compressed JSON, ~270 KB at the national peak (4.3 MB decoded). */
export function snapshotUrl(baseUrl: string, snapshotId: string): string {
  return `${trimBase(baseUrl)}/${snapshotId}.br`;
}
