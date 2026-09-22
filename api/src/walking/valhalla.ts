import { haversineMeters, type LatLon } from "../geo.js";

export interface WalkCost {
  distanceMeters: number;
  durationSeconds: number;
}

export interface WalkRoute extends WalkCost {
  /** Encoded polyline at precision 6, or null when estimated. */
  geometry: string | null;
  /** True when this came from the straight-line fallback, not the street network. */
  estimated: boolean;
  /** The walk's turns, in order. Empty when estimated: a straight line has none.
   *  Optional so a stub router that knows nothing of turns still satisfies this. */
  steps?: WalkStep[];
}

/**
 * The kinds of move a walk is described in. A small fixed vocabulary rather
 * than Valhalla's own maneuver numbers, so a client can draw and phrase a step
 * without knowing Valhalla -- and so the words are the client's to write:
 * Valhalla's own narrative has no Hebrew (asked for `he-IL`, it answers in
 * English).
 */
export type WalkManeuver =
  | "depart" | "arrive" | "straight"
  | "slight-right" | "right" | "sharp-right"
  | "slight-left" | "left" | "sharp-left"
  | "uturn" | "roundabout" | "stairs" | "elevator" | "escalator"
  | "enter-building" | "exit-building" | "ferry";

export interface WalkStep {
  /** The move that STARTS this step: "turn right", then walk the step. */
  maneuver: WalkManeuver;
  /** The street the step walks along, as the map names it; null when unnamed. */
  street: string | null;
  lengthMeters: number;
  /** Where the step starts and ends, as indexes into the walk's decoded geometry. */
  beginShapeIndex: number;
  endShapeIndex: number;
}

/**
 * Valhalla's maneuver types (`odin/maneuver.h`, `DirectionsLeg_Maneuver_Type`)
 * that mean something other than walking on. Everything else -- continue,
 * "becomes", stay straight, merges, the transit kinds a pedestrian route never
 * carries -- reads as `straight`.
 */
const VALHALLA_MANEUVERS: Readonly<Record<number, WalkManeuver>> = {
  1: "depart", 2: "depart", 3: "depart",
  4: "arrive", 5: "arrive", 6: "arrive",
  9: "slight-right", 18: "slight-right", 20: "slight-right", 23: "slight-right",
  10: "right",
  11: "sharp-right",
  12: "uturn", 13: "uturn",
  14: "sharp-left",
  15: "left",
  16: "slight-left", 19: "slight-left", 21: "slight-left", 24: "slight-left",
  26: "roundabout", 27: "roundabout",
  28: "ferry", 29: "ferry",
  39: "elevator", 40: "stairs", 41: "escalator", 42: "enter-building", 43: "exit-building",
};

/** Moves that only bend the rider's line rather than turning them. */
const BENDS = new Set<WalkManeuver>(["straight", "slight-right", "slight-left"]);

/**
 * Folds the steps that are not really turns into the step before them: a bend
 * or a "continue" that keeps the rider on the street they are already on, or
 * leads onto an unnamed stub. Valhalla emits these wherever a street's own line
 * kinks -- one 750 m walk in Pardes Hanna had five "bear right onto HaDekalim"
 * steps while already on HaDekalim -- and a banner announcing each would teach
 * the rider to ignore the banner.
 */
export function withoutQuietSteps(steps: WalkStep[]): WalkStep[] {
  const kept: WalkStep[] = [];
  for (const step of steps) {
    const previous = kept[kept.length - 1];
    const quiet = previous !== undefined && previous.maneuver !== "arrive" && BENDS.has(step.maneuver)
      && (step.street === null || step.street === previous.street);
    if (!quiet || previous === undefined) {
      kept.push({ ...step });
      continue;
    }
    previous.lengthMeters += step.lengthMeters;
    previous.endShapeIndex = step.endShapeIndex;
  }
  return kept;
}

/** A /route leg's `maneuvers`, as steps. Malformed entries are skipped, never
 *  guessed at: a turn in the wrong place is worse than one left out. */
function parseSteps(raw: unknown): WalkStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: WalkStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const m = entry as Record<string, unknown>;
    const type = m["type"];
    const length = m["length"];
    const begin = m["begin_shape_index"];
    const end = m["end_shape_index"];
    if (typeof type !== "number" || typeof length !== "number" || !Number.isFinite(length)) continue;
    if (typeof begin !== "number" || !Number.isInteger(begin) || typeof end !== "number" || !Number.isInteger(end)) continue;
    const names = m["street_names"];
    const first = Array.isArray(names) ? names[0] : undefined;
    steps.push({
      maneuver: VALHALLA_MANEUVERS[type] ?? "straight",
      street: typeof first === "string" && first.trim() !== "" ? first.trim() : null,
      // `units: "kilometers"`, like the leg's own summary.
      lengthMeters: Math.round(length * 1000),
      beginShapeIndex: begin,
      endShapeIndex: end,
    });
  }
  return withoutQuietSteps(steps);
}

/**
 * THE detour factor. Straight-line distance understates a real walk — across
 * a rail line or a motorway, badly. 1.35 is a conventional multiplier for
 * urban pedestrian networks; it keeps every straight-line estimate in this
 * service from claiming connections that cannot actually be made in the time
 * allowed.
 *
 * Exported and imported rather than restated, because it has to be the SAME
 * number in four places — this module's `straightLineWalk` (footpath
 * durations), `transit/itinerary.ts` (chain-internal walk-leg distances) and
 * two call sites in `routes/plan.ts` (access/egress walk seconds, and the
 * access/egress leg's own reported distance). Those were four independent
 * literals: they happened to agree, but nothing made them agree, and a
 * response mixing two detour factors would report a walk leg whose distance
 * and duration disagree about how far the walk is.
 */
export const WALK_DETOUR_FACTOR = 1.35;

export function straightLineWalk(from: LatLon, to: LatLon, speedMps: number): WalkRoute {
  const distanceMeters = haversineMeters(from, to) * WALK_DETOUR_FACTOR;
  return {
    distanceMeters,
    durationSeconds: Math.round(distanceMeters / speedMps),
    geometry: null,
    estimated: true,
    steps: [],
  };
}

interface MatrixCell { from_index: number; to_index: number; distance: number | null; time: number | null }

/**
 * True only for a body shaped like Valhalla's /sources_to_targets response
 * (a `sources_to_targets` array). Anything else listening on the configured
 * URL -- a misconfigured proxy, a placeholder server, a completely different
 * service -- must not be mistaken for a healthy Valhalla, since `ping()`
 * governs whether the whole footpath matrix comes from real street routing
 * or falls back to straight-line estimates network-wide. A cell whose
 * `distance`/`time` are null is still a legitimate response (no pedestrian
 * path between the degenerate probe points) and must not fail this check.
 */
function isMatrixResponse(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  return Array.isArray((json as Record<string, unknown>)["sources_to_targets"]);
}

/**
 * Validates a parsed /route response and extracts the first leg, or returns
 * null if anything required is missing or not a finite number. Checking
 * `Number.isFinite` (not just presence) is what catches a `summary` whose
 * `length`/`time` are undefined -- without this, `leg.summary.length * 1000`
 * silently produces NaN instead of throwing, and that NaN would otherwise
 * flow straight into `distanceMeters` with `estimated: false`, telling the
 * caller it's a real street-routed number.
 */
function parseRouteResponse(
  json: unknown,
): { distanceMeters: number; durationSeconds: number; geometry: string; steps: WalkStep[] } | null {
  if (typeof json !== "object" || json === null) return null;
  const trip = (json as Record<string, unknown>)["trip"];
  if (typeof trip !== "object" || trip === null) return null;
  const legs = (trip as Record<string, unknown>)["legs"];
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const leg = legs[0] as unknown;
  if (typeof leg !== "object" || leg === null) return null;
  const shape = (leg as Record<string, unknown>)["shape"];
  const summary = (leg as Record<string, unknown>)["summary"];
  if (typeof shape !== "string") return null;
  if (typeof summary !== "object" || summary === null) return null;
  const length = (summary as Record<string, unknown>)["length"];
  const time = (summary as Record<string, unknown>)["time"];
  if (typeof length !== "number" || !Number.isFinite(length)) return null;
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  return {
    distanceMeters: length * 1000,
    durationSeconds: Math.round(time),
    geometry: shape,
    steps: parseSteps((leg as Record<string, unknown>)["maneuvers"]),
  };
}

export class ValhallaClient {
  constructor(private readonly opts: { url: string; timeoutMs: number; speedMps?: number }) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.opts.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`Valhalla ${path} returned ${res.status}`);
    return await res.json();
  }

  async ping(): Promise<boolean> {
    try {
      const json = await this.post("/sources_to_targets", {
        sources: [{ lat: 32.0554, lon: 34.78 }],
        targets: [{ lat: 32.0554, lon: 34.78 }],
        costing: "pedestrian",
        units: "kilometers",
      });
      return isMatrixResponse(json);
    } catch {
      return false;
    }
  }

  /**
   * Rows are sources, columns are targets. A null cell means Valhalla found no
   * pedestrian path — genuinely unreachable on foot, which is information, not
   * an error.
   *
   * `from_index`/`to_index` come from the server response, not from anything
   * we control, so both are bounds-checked against the requested dimensions
   * before being used to index `out`. Without checking `to_index` too, a
   * cell reporting an index past `targets.length` would silently grow that
   * output row past its pre-populated null-grid length, corrupting the
   * fixed-shape invariant every caller relies on.
   */
  async matrix(sources: LatLon[], targets: LatLon[]): Promise<(WalkCost | null)[][]> {
    const body = {
      sources: sources.map(([lat, lon]) => ({ lat, lon })),
      targets: targets.map(([lat, lon]) => ({ lat, lon })),
      costing: "pedestrian",
      units: "kilometers",
    };
    const json = await this.post("/sources_to_targets", body) as
      { sources_to_targets: MatrixCell[][] };

    const out: (WalkCost | null)[][] = sources.map(() => targets.map(() => null));
    for (const row of json.sources_to_targets) {
      for (const cell of row) {
        if (cell.distance === null || cell.time === null) continue;
        if (cell.from_index < 0 || cell.from_index >= sources.length) continue;
        if (cell.to_index < 0 || cell.to_index >= targets.length) continue;
        const outRow = out[cell.from_index];
        if (outRow === undefined) continue;
        // `units: "kilometers"` means distance arrives in km.
        outRow[cell.to_index] = {
          distanceMeters: cell.distance * 1000,
          durationSeconds: Math.round(cell.time),
        };
      }
    }
    return out;
  }

  /**
   * A single walk. Falls back to a straight-line estimate rather than
   * throwing: a slow or dead container should degrade a plan's accuracy,
   * not fail it. The caller surfaces `estimated` on the leg so the
   * degradation is visible.
   *
   * Two distinct failure paths, both degrading to the same estimate but for
   * different reasons:
   *  - the POST itself throws (network error, timeout, non-2xx) -- routine,
   *    expected whenever the container is slow or down;
   *  - the POST succeeds but the 200 body doesn't parse into a usable leg
   *    (checked by `parseRouteResponse`, including `Number.isFinite` on the
   *    numeric fields) -- this means Valhalla's response contract changed,
   *    or our parsing of it is wrong. It is not routine, but must still not
   *    propagate a NaN/undefined distance under `estimated: false`, so it
   *    degrades the same way. A future change wiring in logging should log
   *    this branch specifically, since it is the one worth investigating.
   */
  async route(from: LatLon, to: LatLon): Promise<WalkRoute> {
    let json: unknown;
    try {
      json = await this.post("/route", {
        locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
        costing: "pedestrian",
        units: "kilometers",
      });
    } catch {
      return straightLineWalk(from, to, this.opts.speedMps ?? 1.33);
    }

    const parsed = parseRouteResponse(json);
    if (parsed === null) return straightLineWalk(from, to, this.opts.speedMps ?? 1.33);
    return { ...parsed, estimated: false };
  }
}
