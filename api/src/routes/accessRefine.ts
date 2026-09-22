import type { RaptorAccess } from "../transit/raptor.js";
import type { TimetableIndex } from "../transit/index.js";
import type { ValhallaClient, WalkCost } from "../walking/valhalla.js";
import type { LatLon } from "../geo.js";

export interface RefineOptions {
  ix: TimetableIndex;
  /** The client's requested walking limit, in metres. */
  maxWalkMeters: number;
}

/**
 * The result of one refinement call. `refined` is exactly true on the one
 * path where a well-formed matrix row was actually consumed: every stop in
 * `stops` then carries a REAL Valhalla-measured `secondsToReach`, not the
 * 1.33 m/s estimate `accessStops` produced it with. `refined` is false on
 * every degrade path (thrown call, missing/wrong-length row) and for the
 * zero-candidate short-circuit — in all of those, `stops` is the untouched
 * or empty input and every surviving `secondsToReach` is still the estimate.
 * One boolean per endpoint is exact, never approximate: either every
 * returned candidate came from the matrix row, or none did — refinement
 * cannot partially succeed within a single call.
 */
export interface RefineResult {
  stops: RaptorAccess[];
  refined: boolean;
}

/**
 * Replaces a prefiltered candidate list's straight-line estimates with real
 * walking distances, dropping any stop whose actual walk exceeds the cap.
 *
 * `accessStops` selects candidates by haversine, which is a correct LOWER
 * BOUND on street distance and therefore a sound prefilter — it can never
 * discard a stop that would have qualified. What it cannot do is reject a stop
 * whose straight-line distance is inside the cap but whose real walk is far
 * outside it: measured on this feed, 11.2% of walks are underestimated by more
 * than half and the worst case by 4.56x, because a straight line ignores
 * motorways, rail corridors and rivers. That produced journeys ending in a
 * 46-minute walk under a 1 km limit, with an arrival time 34 minutes early.
 *
 * One matrix call per endpoint covers every candidate: a one-to-many matrix is
 * a single graph search from the source, so cost scales with the search area
 * rather than the target count (measured: 660 targets in 131 ms against 50 in
 * 22 ms). There is deliberately no candidate cap — capping would risk
 * discarding the genuinely best stop to save time the measurement says we have.
 *
 * Returns a `{ stops, refined }` pair rather than a bare array so the caller
 * can tell whether the returned `secondsToReach` values are real durations or
 * still estimates — see `RefineResult`'s own doc comment.
 */
export async function refineAccessByWalking(
  client: Pick<ValhallaClient, "matrix">,
  point: LatLon,
  candidates: readonly RaptorAccess[],
  opts: RefineOptions,
): Promise<RefineResult> {
  // An empty list still costs a round-trip if we ask, and can only ever come
  // back empty. Nothing was refined -- there was nothing to refine.
  if (candidates.length === 0) return { stops: [], refined: false };

  const targets: LatLon[] = candidates.map((c) =>
    // stopIdx came from a loop bounded by ix.nStops, so both reads are in range.
    [opts.ix.stopLat[c.stopIdx]!, opts.ix.stopLon[c.stopIdx]!]);

  let row: (WalkCost | null)[] | undefined;
  try {
    const matrix = await client.matrix([point], targets);
    row = matrix[0];
  } catch {
    // Degrade, never fail. Without Valhalla the plan is exactly as accurate as
    // the straight-line estimate alone, which is strictly better than no plan.
    // The untouched candidates still carry the 1.33 m/s estimate.
    return { stops: [...candidates], refined: false };
  }
  // A malformed response is the same situation as a failed one.
  if (row === undefined || row.length !== candidates.length) {
    return { stops: [...candidates], refined: false };
  }

  const out: RaptorAccess[] = [];
  for (const [i, c] of candidates.entries()) {
    const cost = row[i];
    // null means Valhalla found no pedestrian path at all — genuinely not
    // walkable, not an error.
    if (cost === null || cost === undefined) continue;
    // A cell that omits its keys or carries a string yields NaN here, which
    // would pass `> maxWalkMeters` as false and reach `Math.round(NaN)` --
    // and downstream that is a `RangeError` out of `toIso(new Date(NaN))`, a
    // 500, not a wrong answer. Mirrors footpaths.ts's own finite +
    // non-negative check on the same shape of matrix output.
    if (!Number.isFinite(cost.distanceMeters) || cost.distanceMeters < 0) continue;
    if (!Number.isFinite(cost.durationSeconds) || cost.durationSeconds < 0) continue;
    // The cap is a DISTANCE limit, which is what the client asked for; the
    // duration is what the planner should search with.
    if (cost.distanceMeters > opts.maxWalkMeters) continue;
    out.push({
      stopIdx: c.stopIdx,
      secondsToReach: Math.round(cost.durationSeconds),
    });
  }
  return { stops: out, refined: true };
}
