import type { ValhallaClient } from "../walking/valhalla.js";
import type { Itinerary, WalkLeg } from "../transit/itinerary.js";

/**
 * Fills in `geometry` and a real street `distanceMeters` on every walk leg, by
 * routing each one through Valhalla at request time.
 *
 * Without this, walk legs carry `geometry: null` and a haversine * 1.35
 * estimate, so a client can only draw a straight line between the endpoints —
 * across buildings, rail corridors and motorways alike.
 *
 * `durationSeconds` is deliberately NOT overwritten. It is the value RAPTOR
 * planned with, and the itinerary's own `departureTime`/`arrivalTime` were
 * derived from it: replacing it here would make the legs stop adding up to the
 * journey. Whether that value is a REAL walking time or still an estimate is
 * decided earlier, before this function ever runs: for a stop-to-stop
 * transfer it comes from the footpath matrix baked into the index (real only
 * when the index's footpaths were routed through Valhalla); for an access or
 * egress leg it comes from `refineAccessByWalking` (`routes/accessRefine.ts`),
 * which now routes that leg's own candidate through Valhalla before RAPTOR
 * ever searches. Either way, `durationSeconds` here is real once that upstream
 * step succeeded, and falls back to the 1.33 m/s / footpath-matrix estimate
 * only on its own degrade path (Valhalla down, timed out, or a malformed
 * response) — see each leg producer's own `walkEstimated` derivation for
 * exactly which case applies to a given leg.
 *
 * This function does NOT touch `walkEstimated`, and must not: that field
 * describes `durationSeconds`'s provenance (a real routed walking time vs.
 * the 1.33 m/s / footpath-matrix estimate), which this function never
 * computes or overwrites — see `durationSeconds` above and each leg
 * producer's own `walkEstimated` derivation (`routes/plan.ts`'s `walkLeg`
 * for access/egress, `transit/itinerary.ts`'s transfer-leg construction for
 * everything else). Setting it here on the strength of a geometry call that
 * has no bearing on duration was the bug: it let a transfer leg or a
 * degraded access leg claim a real duration purely because its PATH
 * happened to resolve, and could just as easily overwrite an honestly
 * `false` flag back to `true` when the path failed to resolve while the
 * duration was genuinely real. A caller wanting to know whether THIS leg's
 * path is real, as opposed to its duration, should test `geometry !== null`
 * directly — that is already exact, since `geometry` is only ever
 * non-null once this function has actually attached a real routed one.
 *
 * A failed or slow Valhalla call leaves the leg exactly as it was —
 * estimated distance, null geometry — because `route()` degrades rather
 * than throwing. A walk we cannot draw must never fail a whole plan.
 */
export async function resolveWalkGeometry(
  client: Pick<ValhallaClient, "route">,
  itineraries: readonly Itinerary[],
): Promise<void> {
  const legs: WalkLeg[] = [];
  for (const itinerary of itineraries) {
    for (const leg of itinerary.legs) {
      if (leg.type === "walk") legs.push(leg);
    }
  }
  if (legs.length === 0) return;

  // Issued together rather than in sequence: a plan can carry a walk leg per
  // itinerary end plus transfers, and serialising them would stack a full
  // round-trip each onto the response.
  const routed = await Promise.all(legs.map((leg) =>
    client.route([leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon])));

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const r = routed[i]!;
    // `estimated` is true when route() fell back to straight-line internally,
    // in which case there is nothing better to report than what we already had.
    if (r.estimated || r.geometry === null) continue;
    leg.geometry = r.geometry;
    leg.distanceMeters = Math.round(r.distanceMeters);
    // The turns belong to exactly this geometry -- their shape indexes point
    // into it -- so they are only ever set together with it.
    leg.steps = r.steps ?? [];
  }

  // walkMeters is the sum of the legs' distances, so it has to be recomputed
  // now that some of those distances have changed.
  for (const itinerary of itineraries) {
    let m = 0;
    for (const leg of itinerary.legs) if (leg.type === "walk") m += leg.distanceMeters;
    itinerary.walkMeters = Math.round(m);
  }
}
