import type { RealtimeCall, RealtimeJourney, SiriSnapshot } from "./types.js";
import { SiriError } from "./types.js";

/**
 * Narrows to a plain object the way this file needs it everywhere: reject
 * `null` (typeof "object") and arrays (also typeof "object") so every other
 * helper can index the result with `[key]` and get `unknown`, not crash on
 * `null["x"]` or silently treat an array's indices as field names.
 */
function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

/**
 * SIRI's own XML-to-JSON conversion is famously inconsistent about whether a
 * one-element list survives as an array or collapses to the bare object —
 * true of `StopMonitoringDelivery`, and the
 * same ambiguity applies to `MonitoredStopVisit` and `OnwardCall`. Rather
 * than special-case each field, every list-shaped field in this parser is
 * read through this: an array is used as-is, `null`/`undefined` is "no
 * items", and anything else is one item.
 */
function asList(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  if (x === undefined || x === null) return [];
  return [x];
}

/** A non-empty string, or null. Empty strings are treated as absent rather
 * than as a legitimate (if useless) value, so callers don't have to. */
function asString(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

/**
 * Every numeric field in this feed arrives as a JSON string (`"34.991028"`,
 * not `34.991028`). `Number(x)` on a non-numeric string returns `NaN`, and
 * this codebase was bitten recently by a `NaN` reaching `new Date()` and
 * surfacing as a 500 — so this never returns `NaN`, only a finite number or
 * `null`. `Number("")` is `0`, not `NaN`, so blank strings are rejected
 * before the conversion, not after.
 */
function toFiniteNumber(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  const trimmed = x.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * ISO 8601 with an offset, e.g. `"2019-05-11T13:12:02+03:00"`, converted to
 * epoch SECONDS (this feed's other epoch-like value, GTFS stop_time, is also
 * seconds, and later tasks compare the two directly). `Date.parse` returns
 * `NaN` for anything it can't read; that becomes `null` here, same as every
 * other unparseable numeric field, rather than propagating as `NaN`.
 */
function toEpochSeconds(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * SIRI's `DirectionRef` is 1,2,3; GTFS `direction_id` is 0,1,2.
 * `null` propagates rather than becoming a fabricated direction, since a
 * journey with no direction can't be matched to a scheduled trip anyway —
 * `parseVisit` treats that `null` as a reason to drop the whole journey.
 */
function parseDirectionRef(x: unknown): number | null {
  const n = toFiniteNumber(x);
  return n === null ? null : n - 1;
}

/**
 * One `MonitoredCall` or `OnwardCall` entry. Both required fields —
 * `StopPointRef` and a parseable `ExpectedArrivalTime` — are checked here so
 * a call this service can't place at a stop or can't time never enters
 * `calls`; `RealtimeCall.expectedArrival` is typed as a plain `number`
 * specifically so nothing downstream has to re-check it for null.
 */
function parseCall(raw: unknown): RealtimeCall | null {
  const call = asRecord(raw);
  if (call === null) return null;
  const stopCode = asString(call["StopPointRef"]);
  if (stopCode === null) return null;
  const expectedArrival = toEpochSeconds(call["ExpectedArrivalTime"]);
  if (expectedArrival === null) return null;
  return { stopCode, order: toFiniteNumber(call["Order"]), expectedArrival };
}

/** The monitored call first, then onward calls in the order SIRI gave them. */
function parseCalls(mvj: Record<string, unknown>): RealtimeCall[] {
  const calls: RealtimeCall[] = [];
  const monitored = parseCall(mvj["MonitoredCall"]);
  if (monitored !== null) calls.push(monitored);

  const onwardCalls = asRecord(mvj["OnwardCalls"]);
  for (const raw of asList(onwardCalls === null ? undefined : onwardCalls["OnwardCall"])) {
    const call = parseCall(raw);
    if (call !== null) calls.push(call);
  }
  return calls;
}

/**
 * One `MonitoredStopVisit`, or `null` if it can't become a usable journey.
 * A visit is dropped — never thrown on — if it lacks a
 * `LineRef`, a `DirectionRef`, or all of its calls: any one of those means
 * this journey can't be matched to a scheduled trip or has nothing to
 * report, but the malformed entry must not take the whole snapshot down
 * with it (this is the ICD's most likely first-contact surprise).
 */
function parseVisit(visitRaw: unknown): RealtimeJourney | null {
  const visit = asRecord(visitRaw);
  if (visit === null) return null;
  const mvj = asRecord(visit["MonitoredVehicleJourney"]);
  if (mvj === null) return null;

  const lineRef = asString(mvj["LineRef"]);
  if (lineRef === null) return null;

  const directionId = parseDirectionRef(mvj["DirectionRef"]);
  if (directionId === null) return null;

  const calls = parseCalls(mvj);
  if (calls.length === 0) return null;

  const framed = asRecord(mvj["FramedVehicleJourneyRef"]);
  const location = asRecord(mvj["VehicleLocation"]);

  return {
    lineRef,
    directionId,
    dataFrameRef: framed === null ? null : asString(framed["DataFrameRef"]),
    datedVehicleJourneyRef: framed === null ? null : asString(framed["DatedVehicleJourneyRef"]),
    originAimedDeparture: toEpochSeconds(mvj["OriginAimedDepartureTime"]),
    operatorRef: asString(mvj["OperatorRef"]),
    publishedLineName: asString(mvj["PublishedLineName"]),
    vehicleRef: asString(mvj["VehicleRef"]),
    confidence: asString(mvj["ConfidenceLevel"]),
    lat: location === null ? null : toFiniteNumber(location["Latitude"]),
    lon: location === null ? null : toFiniteNumber(location["Longitude"]),
    // RecordedAtTime is on the visit, not the journey — see the ICD example.
    recordedAt: toEpochSeconds(visit["RecordedAtTime"]),
    calls,
    // SIRI-SM has no distance-along-shape concept: it reports predicted
    // times directly, so nothing downstream ever needs to derive one.
    distanceFromStart: null,
  };
}

/**
 * `ErrorCondition.OtherError.ErrorText` is the expected shape, but an
 * `ErrorCondition` with a differently-shaped
 * error underneath it is still an error, not an empty snapshot — so this
 * never returns `null`, only the best text it can find.
 */
function extractErrorText(errorCondition: Record<string, unknown>): string {
  const otherError = asRecord(errorCondition["OtherError"]);
  const text = otherError === null ? null : asString(otherError["ErrorText"]);
  return text ?? "SIRI ErrorCondition without further detail";
}

/**
 * Throws `SiriError` when `payload.Siri.ServiceDelivery.ErrorCondition` is
 * present -- a SERVICE-level SIRI error, one level above the
 * `StopMonitoringDelivery.ErrorCondition` the ICD documents and
 * `parseSiriResponse` already checks per-delivery -- else returns
 * normally. Exported so `poller.ts`'s `tick` can call
 * it BEFORE its own `hasStopMonitoringDelivery` envelope gate: a
 * service-level error response typically carries no `StopMonitoringDelivery`
 * key at all, so checking only inside `parseSiriResponse` never actually
 * runs on the real failure path -- the gate would otherwise throw its own
 * generic "not a SIRI envelope" first, discarding the ministry's real
 * error text. `parseSiriResponse`
 * still calls this too, so a caller that bypasses `tick` (as
 * `siri.test.ts` does) gets the same guarantee.
 */
export function throwOnServiceLevelError(payload: unknown): void {
  const serviceDelivery = asRecord(asRecord(payload)?.["Siri"])?.["ServiceDelivery"];
  const errorCondition = asRecord(asRecord(serviceDelivery)?.["ErrorCondition"]);
  if (errorCondition !== null) throw new SiriError(extractErrorText(errorCondition));
}

/**
 * Walks `Siri.ServiceDelivery.StopMonitoringDelivery[].MonitoredStopVisit[]`
 * into normalised `RealtimeJourney`s. Every step of that path is optional
 * chained and `asRecord`/`asList`-guarded rather than asserted, because we
 * have no API key yet and so no way to test against the real service before
 * this ships. The one exception is
 * `ErrorCondition`: an auth failure arrives inside an HTTP 200 (ICD §9), and
 * a parser that swallowed it as "no deliveries" would report an empty
 * country forever with no clue why, so it is detected explicitly and thrown
 * as `SiriError` rather than degraded like everything else here — checked at
 * BOTH the level the ICD documents (`StopMonitoringDelivery.ErrorCondition`)
 * AND the `ServiceDelivery` level directly above it (`throwOnServiceLevelError`,
 * above), since SIRI carries a service-wide error there too and a parser
 * that only checked the per-delivery spot would file that under "not a SIRI
 * envelope" with its text discarded.
 */
export function parseSiriResponse(payload: unknown, fetchedAt: number): SiriSnapshot {
  throwOnServiceLevelError(payload);

  const siri = asRecord(payload)?.["Siri"];
  const serviceDelivery = asRecord(siri)?.["ServiceDelivery"];
  const deliveries = asList(asRecord(serviceDelivery)?.["StopMonitoringDelivery"]);

  const journeys: RealtimeJourney[] = [];
  let visitsSeen = 0;
  let visitsDropped = 0;
  for (const deliveryRaw of deliveries) {
    const delivery = asRecord(deliveryRaw);
    if (delivery === null) continue;

    const errorCondition = asRecord(delivery["ErrorCondition"]);
    if (errorCondition !== null) throw new SiriError(extractErrorText(errorCondition));

    for (const visitRaw of asList(delivery["MonitoredStopVisit"])) {
      visitsSeen++;
      const journey = parseVisit(visitRaw);
      if (journey !== null) journeys.push(journey);
      else visitsDropped++;
    }
  }

  return { journeys, fetchedAt, visitsSeen, visitsDropped };
}

/** Per-filter query parameters, ICD §7.12. */
const FILTER_PARAMS = {
  "active-calls": { MonitoringRef: "AllActiveTripsFilter", StopVisitDetailLevel: "calls" },
  active: { MonitoringRef: "AllActiveTripsFilter", StopVisitDetailLevel: "normal" },
  planned: { MonitoringRef: "AllPlannedTripsFilter", StopVisitDetailLevel: "normal" },
} as const satisfies Record<string, { MonitoringRef: string; StopVisitDetailLevel: string }>;

export type SnapshotFilter = keyof typeof FILTER_PARAMS;

/**
 * Builds a national snapshot request per ICD §7.12/§7.18.3. Deliberately
 * does not accept `PreviewInterval`, `StartTime`, `LineRef`,
 * `MaximumStopVisits`, `MaximumStopVisitsPerLine`, or
 * `MaximumNumberOfCallsOnwards` as parameters at all — ICD 7.18.3 forbids
 * every one of them on a snapshot request, so there is nothing for a caller
 * to accidentally pass through.
 *
 * `baseUrl` arrives by email from the ministry and gets pasted into an env
 * var by a human, so a trailing slash is a when-not-if — stripped here
 * rather than trusted, so it can't double up into `//2.8/json`.
 */
export function buildSnapshotUrl(baseUrl: string, key: string, filter: SnapshotFilter): string {
  const { MonitoringRef, StopVisitDetailLevel } = FILTER_PARAMS[filter];
  const params = new URLSearchParams({ Key: key, MonitoringRef, StopVisitDetailLevel });
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/2.8/json?${params.toString()}`;
}

/**
 * The key is a secret carried in a URL query parameter, which means every
 * log site that might print a SIRI request URL
 * has to run it through this first. Matches `Key=` case-insensitively
 * because we don't fully control how a future base URL or proxy might case
 * the parameter name.
 */
export function redactKey(url: string): string {
  return url.replace(/([?&]Key=)[^&]*/gi, "$1***");
}
