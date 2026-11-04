import type { Lang, Translator } from "../../db/i18n.js";
import type { RaptorAccess } from "../../transit/raptor.js";
import type { WalkLeg } from "../../transit/itinerary.js";
import type { TimetableIndex } from "../../transit/index.js";
import { haversineMeters, type LatLon } from "../../geo.js";
import { WALK_DETOUR_FACTOR } from "../../walking/valhalla.js";

export type ParsedPlace =
  | { kind: "coord"; lat: number; lon: number }
  | { kind: "stop"; stopId: string };

export function parsePlace(raw: string): ParsedPlace {
  if (raw.startsWith("stop:")) {
    const stopId = raw.slice(5);
    if (stopId === "") throw new Error(`Invalid place: ${raw}`);
    return { kind: "stop", stopId };
  }
  const parts = raw.split(",");
  if (parts.length !== 2) throw new Error(`Invalid place: ${raw}`);
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`Invalid place: ${raw}`);
  }
  return { kind: "coord", lat, lon };
}

/**
 * Access or egress stops for one endpoint.
 *
 * A `stop:` endpoint resolves to that stop with zero walking (the client asked
 * to start there, not near there); `point` is null only when that stop id is
 * unknown. A coordinate matches every stop within `maxWalkMeters` in a
 * straight line, which is complete because straight-line distance is a lower
 * bound on street distance.
 *
 * De-duplicated by stop index, keeping the smallest `secondsToReach`:
 * `paretoRounds` only returns a `stopIdx`, so two entries for one stop would
 * make it ambiguous which egress produced an arrival.
 */
export function accessStops(
  ix: TimetableIndex, place: ParsedPlace, maxWalkMeters: number, speedMps: number,
): { stops: RaptorAccess[]; point: LatLon | null } {
  if (place.kind === "stop") {
    const idx = ix.stopIdToIdx.get(place.stopId);
    if (idx === undefined) return { stops: [], point: null };
    return {
      stops: [{ stopIdx: idx, secondsToReach: 0 }],
      point: [ix.stopLat[idx]!, ix.stopLon[idx]!],
    };
  }

  const from: LatLon = [place.lat, place.lon];
  const bySeconds = new Map<number, number>();
  for (let s = 0; s < ix.nStops; s++) {
    const d = haversineMeters(from, [ix.stopLat[s]!, ix.stopLon[s]!]);
    if (d <= maxWalkMeters) {
      const seconds = Math.round((d * WALK_DETOUR_FACTOR) / speedMps);
      const existing = bySeconds.get(s);
      if (existing === undefined || seconds < existing) bySeconds.set(s, seconds);
    }
  }
  const stops: RaptorAccess[] = [...bySeconds].map(([stopIdx, secondsToReach]) =>
    ({ stopIdx, secondsToReach }));
  return { stops, point: from };
}

/**
 * How many nearest stops the nearest-stop fallback routes through Valhalla
 * when `maxWalkMeters` leaves an endpoint with nothing. More than one because
 * the closest stop by crow flight can sit across a motorway; five still costs
 * a single matrix call.
 */
export const NEAREST_STOP_FALLBACK_COUNT = 5;

/**
 * The `n` nearest stops to `point` by straight-line distance, ignoring
 * `maxWalkMeters`: the candidates for the nearest-stop fallback.
 *
 * Each `secondsToReach` is seeded with the same estimate `accessStops` uses,
 * so it survives into the response if Valhalla is down and refinement returns
 * the candidates untouched.
 *
 * A bounded top-n insertion scan rather than a full sort: 0.59 ms against
 * 9.68 ms on this feed's 35k stops (see docs/planner-notes.md).
 */
export function nearestStops(
  ix: TimetableIndex, point: LatLon, n: number, speedMps: number,
): RaptorAccess[] {
  const bestIdx: number[] = [];
  const bestDist: number[] = [];
  for (let s = 0; s < ix.nStops; s++) {
    const d = haversineMeters(point, [ix.stopLat[s]!, ix.stopLon[s]!]);
    if (bestIdx.length < n || d < bestDist[bestIdx.length - 1]!) {
      let i = bestIdx.length;
      while (i > 0 && bestDist[i - 1]! > d) i--;
      bestIdx.splice(i, 0, s);
      bestDist.splice(i, 0, d);
      if (bestIdx.length > n) { bestIdx.pop(); bestDist.pop(); }
    }
  }
  return bestIdx.map((stopIdx, i) => ({
    stopIdx,
    secondsToReach: Math.round((bestDist[i]! * WALK_DETOUR_FACTOR) / speedMps),
  }));
}

/**
 * `?modes=` to a set of GTFS `route_type` values.
 *
 * Validated, not coerced with `Number`: `Number("")` is 0 (so `modes=` would
 * mean "tram only") and `Number("abc")` is NaN (so a typo would silently
 * return zero itineraries). Anything but a comma-separated list of integers
 * is a 400. Whitespace around an entry is fine; an empty entry is not.
 */
export function parseModes(raw: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid modes value: "${part}". `
        + "modes must be a comma-separated list of integer GTFS route_type "
        + "values, e.g. modes=0,3. Omit the parameter entirely for no filter.",
      );
    }
    out.add(Number(trimmed));
  }
  return out;
}

/**
 * One access or egress walk leg between the rider's coordinate and a stop, or
 * `undefined` when there is nothing to walk (a `stop:` endpoint, or zero
 * access time).
 *
 * `refined` describes the duration: `walkEstimated` is false only when
 * `seconds` came from Valhalla. `distanceMeters` starts as the haversine
 * estimate and is usually replaced later by `resolveWalkGeometry`.
 *
 * Shared with `planOnboard.ts` so both endpoints build the same walk leg.
 */
export function buildWalkLeg(
  ix: TimetableIndex, tr: Translator, lang: Lang,
  point: LatLon | null, stopIdx: number, seconds: number, outbound: boolean,
  refined: boolean,
): WalkLeg | undefined {
  if (point === null || seconds === 0) return undefined;
  const stopPlace = {
    type: "stop" as const, lat: ix.stopLat[stopIdx]!, lon: ix.stopLon[stopIdx]!,
    stopId: ix.stopIds[stopIdx]!,
    name: tr.resolve(ix.stopNames[stopIdx] ?? null, lang),
  };
  const coordPlace = { type: "coordinate" as const, lat: point[0], lon: point[1] };
  return {
    type: "walk",
    from: outbound ? coordPlace : stopPlace,
    to: outbound ? stopPlace : coordPlace,
    distanceMeters: Math.round(
      haversineMeters(point, [ix.stopLat[stopIdx]!, ix.stopLon[stopIdx]!])
        * WALK_DETOUR_FACTOR,
    ),
    durationSeconds: seconds,
    geometry: null,
    walkEstimated: !refined,
  };
}
