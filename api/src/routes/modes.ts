import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../errors.js";
import { routeTypeName } from "../transit/routeTypes.js";

/** One vehicle type the loaded feed can actually produce a journey with. */
interface ModeRow {
  type: number;
  /** English GTFS name, a FALLBACK for clients with no label of their own. */
  name: string;
  /** Distinct routes of this type -- routes, never trips. */
  routes: number;
}

/**
 * Which `route_type`s the CURRENT index can produce, tallied over the index
 * rather than with a `SELECT route_type, COUNT(*) FROM routes GROUP BY 1`.
 *
 * Those two differ, and the difference is the whole point of this endpoint:
 * `/plan`'s own mode filter tests `routeTypeByIdx[tripRouteIdx[t]]`, so a
 * `route_type` owning routes but no TRIP rows is a filter value that can only
 * ever return zero itineraries -- a dead toggle a rider cannot tell apart
 * from "nothing runs on this corridor".
 *
 * What this does NOT narrow to: `tripRouteIdx` covers every row in `trips`,
 * with no calendar filter (see transit/index.ts), so "has trips" means "has
 * at least one trip row", not "has service this week". Going further would
 * make the answer depend on WHEN it was asked, and a client's toggle list
 * would flicker as services roll over. Route-has-no-trips is the stable,
 * feed-level line to draw.
 *
 * Counts DISTINCT ROUTE INDICES, not trips, so `routes` means what it says.
 */
function tallyModes(tripRouteIdx: Int32Array, routeTypeByIdx: number[]): ModeRow[] {
  const routesByType = new Map<number, Set<number>>();
  for (let t = 0; t < tripRouteIdx.length; t++) {
    const routeIdx = tripRouteIdx[t]!;
    // -1 is the sentinel for a trip whose `route_id` was null (transit/index.ts).
    if (routeIdx < 0) continue;
    const type = routeTypeByIdx[routeIdx];
    if (type === undefined) continue;
    let seen = routesByType.get(type);
    if (seen === undefined) {
      seen = new Set<number>();
      routesByType.set(type, seen);
    }
    seen.add(routeIdx);
  }

  return [...routesByType.entries()]
    .map(([type, routes]) => ({ type, name: routeTypeName(type), routes: routes.size }))
    // Most-used first, so a client can render the list in the order it gets
    // without having to invent an ordering of its own. Ties break on the type
    // number purely to keep the response stable across restarts.
    .sort((a, b) => b.routes - a.routes || a.type - b.type);
}

export const modeRoutes: FastifyPluginAsync = async (app) => {
  // A single memo slot, compared against the index version on read. The tally
  // is a full pass over ~394k trips on the real feed -- too slow to repeat per
  // request, and far too cheap to deserve anything more elaborate than this.
  // An index swap changes `TimetableIndex.version` (read from `feed_meta`), so
  // the next call recomputes; there is deliberately no invalidation hook to
  // keep in sync with the manager.
  let cache: { version: string; modes: ModeRow[] } | null = null;

  app.get("/modes", async () => {
    const index = app.index.current();
    if (index === null) {
      // Same code and shape as /ready's own not-yet-built response, rather
      // than a second vocabulary for one condition.
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }

    if (cache === null || cache.version !== index.version) {
      cache = { version: index.version, modes: tallyModes(index.tripRouteIdx, app.routeTypeByIdx) };
    }
    return { modes: cache.modes };
  });
};
