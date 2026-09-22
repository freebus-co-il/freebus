import type Database from "better-sqlite3";
import { encodePolyline, haversineMeters, type LatLon } from "../geo.js";
import type { RailGraph, RailWay } from "./railGraph.js";
import { railPairKey, type BakedRailGeometry } from "./railGeometry.js";

export const OSM_ATTRIBUTION =
  "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)";

/**
 * A baked line this many times longer than the straight distance between its
 * stations almost certainly took a wrong corridor (a link missing from OSM).
 * The longest legitimate one on the real network is 2.28x -- באר שבע צפון to
 * באר שבע מרכז, round the curve -- so 3x leaves room without admitting the
 * 10-200x detours a broken graph produces.
 */
export const MAX_DETOUR_RATIO = 3;

/** Below this the ratio is dominated by where each station snapped. */
const MIN_RATIO_CROW_METERS = 200;

export interface Station {
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
}

/** Two stations consecutive on some rail trip, oriented as `railPairKey` stores them. */
export interface StationPair {
  key: string;
  from: Station;
  to: Station;
}

interface PairRow {
  a_id: string; a_name: string | null; a_lat: number; a_lon: number;
  b_id: string; b_name: string | null; b_lat: number; b_lon: number;
}

/** Every pair of stations some rail trip calls at one after the other. */
export function railStationPairs(db: Database.Database): StationPair[] {
  const rows = db.prepare(`
    WITH rail_calls AS (
      SELECT st.stop_ref,
             LEAD(st.stop_ref) OVER (PARTITION BY st.trip_ref ORDER BY st.stop_sequence) AS next_ref
      FROM stop_times st
      JOIN trips t  ON t.trip_ref = st.trip_ref
      JOIN routes r ON r.route_id = t.route_id
      WHERE r.route_type = 2
    )
    SELECT DISTINCT
      a.stop_id AS a_id, a.stop_name AS a_name, a.stop_lat AS a_lat, a.stop_lon AS a_lon,
      b.stop_id AS b_id, b.stop_name AS b_name, b.stop_lat AS b_lat, b.stop_lon AS b_lon
    FROM rail_calls c
    JOIN stops a ON a.stop_ref = c.stop_ref
    JOIN stops b ON b.stop_ref = c.next_ref
    WHERE a.stop_lat IS NOT NULL AND a.stop_lon IS NOT NULL
      AND b.stop_lat IS NOT NULL AND b.stop_lon IS NOT NULL
      AND a.stop_id <> b.stop_id
  `).all() as PairRow[];

  const pairs = new Map<string, StationPair>();
  for (const row of rows) {
    const a: Station = { stopId: row.a_id, name: row.a_name, lat: row.a_lat, lon: row.a_lon };
    const b: Station = { stopId: row.b_id, name: row.b_name, lat: row.b_lat, lon: row.b_lon };
    const { key, reversed } = railPairKey(a.stopId, b.stopId);
    if (!pairs.has(key)) pairs.set(key, reversed ? { key, from: b, to: a } : { key, from: a, to: b });
  }
  return [...pairs.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

export interface BakeResult {
  baked: BakedRailGeometry;
  /** Pairs with no track path between them; the API draws those through their stations. */
  unroutable: string[];
  /** Pairs baked with a suspiciously long line -- see MAX_DETOUR_RATIO. */
  detours: { key: string; ratio: number }[];
}

function lengthMeters(line: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversineMeters(line[i - 1]!, line[i]!);
  return total;
}

export function bakeRailGeometry(
  graph: RailGraph, pairs: readonly StationPair[], meta: { osmTimestamp: string },
): BakeResult {
  const lines: Record<string, string> = {};
  const unroutable: string[] = [];
  const detours: { key: string; ratio: number }[] = [];

  for (const { key, from, to } of pairs) {
    const line = graph.route([from.lat, from.lon], [to.lat, to.lon]);
    if (line === null) { unroutable.push(key); continue; }
    lines[key] = encodePolyline(line);
    const crow = haversineMeters([from.lat, from.lon], [to.lat, to.lon]);
    if (crow >= MIN_RATIO_CROW_METERS) {
      const ratio = lengthMeters(line) / crow;
      if (ratio > MAX_DETOUR_RATIO) detours.push({ key, ratio });
    }
  }

  return {
    baked: { osmTimestamp: meta.osmTimestamp, attribution: OSM_ATTRIBUTION, lines },
    unroutable,
    detours,
  };
}

interface OverpassWay {
  type: "way";
  nodes?: unknown;
  geometry?: unknown;
}

/**
 * Reads an Overpass `out body geom;` response for `railway=rail` ways.
 *
 * Throws on a response with no ways rather than returning none: Overpass
 * answers a timed-out or overloaded query with HTTP 200 and a `remark`, and
 * baking that would silently replace every line with nothing.
 */
export function parseOverpassRail(json: unknown): { ways: RailWay[]; osmTimestamp: string } {
  const body = json as { elements?: unknown; remark?: unknown; osm3s?: { timestamp_osm_base?: unknown } };
  if (!Array.isArray(body?.elements)) {
    const remark = typeof body?.remark === "string" ? `: ${body.remark}` : "";
    throw new Error(`Overpass response has no \`elements\` array${remark}`);
  }

  const ways: RailWay[] = [];
  for (const element of body.elements as { type?: unknown }[]) {
    if (element?.type !== "way") continue;
    const { nodes, geometry } = element as OverpassWay;
    if (!Array.isArray(nodes) || !Array.isArray(geometry) || nodes.length !== geometry.length) continue;
    const points = (geometry as ({ lat?: unknown; lon?: unknown } | null)[]).map(
      (g) => (typeof g?.lat === "number" && typeof g.lon === "number" ? [g.lat, g.lon] as LatLon : null),
    );
    if (points.some((p) => p === null) || nodes.some((n) => typeof n !== "number")) continue;
    ways.push({ nodeIds: nodes as number[], points: points as LatLon[] });
  }
  if (ways.length === 0) throw new Error("Overpass response contains no rail ways");

  const timestamp = body.osm3s?.timestamp_osm_base;
  return { ways, osmTimestamp: typeof timestamp === "string" ? timestamp : "" };
}
