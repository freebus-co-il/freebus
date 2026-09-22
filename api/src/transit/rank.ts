import type { Itinerary } from "./itinerary.js";

/**
 * The weights that turn an itinerary into a single number a rider would
 * recognise as "how much of a hassle is this". Passed explicitly rather than
 * read from `config.ts` so every function in this file stays pure and
 * testable without an environment -- `routes/plan.ts` supplies `rankConfig`.
 */
export interface RankConfig {
  /** What a walking second costs relative to a riding second. 1 makes them
   *  equal, which is the pre-feature behaviour. */
  walkWeight: number;
  /** Flat cost added per interchange, on top of the wait it already implies
   *  through `durationSeconds`. */
  transferPenaltySeconds: number;
  /** How far past the earliest feasible departure a
   *  journey may depart and still be ranked on cost (the departure window `W`). */
  departureWindowSeconds: number;
  /** The walk-share backstop. Fraction of `durationSeconds` that may be
   *  walking before the itinerary is dropped outright. */
  maxWalkShare: number;
}

/**
 * `durationSeconds` is measured from this itinerary's own
 * RE-ANCHORED departure (`routes/reoptimise.ts`'s `reanchorDeparture`), not
 * from the query instant, so waiting at the origin is priced at zero here by
 * construction and needs no term of its own -- that is the whole mechanism by
 * which a later, easier journey can beat an earlier, harder one.
 *
 * `durationSeconds` already counts `walkSeconds` once, so the walk term adds
 * `walkWeight - 1` rather than `walkWeight`; at the default 2 that makes a
 * walking second cost exactly twice a riding one.
 */
export function journeyCost(itin: Itinerary, cfg: RankConfig): number {
  return itin.durationSeconds
    + itin.walkSeconds * (cfg.walkWeight - 1)
    + cfg.transferPenaltySeconds * itin.transfers;
}

/**
 * `runRaptor` seeds round 0 with access labels and relaxes
 * footpaths off them (`raptor.ts:456`), so any stop inside BOTH the origin and
 * the destination walk radius is reachable with zero boardings -- and
 * `paretoRounds` will pick it, producing access-walk + footpath + egress-walk
 * reported as `transfers: 0`. That is a leak, not a ranking failure: it would
 * survive any change to the cost function, which is why it is a hard filter
 * with no configuration knob (see `config.ts`'s `rankConfig`).
 *
 * NOTE: deliberately NOT applied by `routes/planOnboard.ts`. A rider already
 * on a vehicle has no access leg, so "get off here and walk the rest" is a
 * legitimate zero-transit-leg answer there -- see that file's own call site.
 */
export function hasTransitLeg(itin: Itinerary): boolean {
  return itin.legs.some((leg) => leg.type === "transit");
}

/**
 * The walk-share backstop against the pathological tail -- NOT the main
 * mechanism, which is `journeyCost`. 0.7 is deliberately STRICTER than what
 * riders get from other apps: a widely-used transit app's real-world answer
 * to the reference query's second-best journey is 82% walking, and this cap
 * drops that one too. That is intentional, not an oversight -- the goal is an app that is
 * helpful about PUBLIC TRANSPORT, not one that is content to suggest a long
 * walk, and a journey that is more than 70% walking is not, in any useful
 * sense, a transit journey. Anyone who disagrees with exactly where that
 * line sits can move it: `PLAN_MAX_WALK_SHARE` is the tunable knob, not this
 * constant.
 *
 * `durationSeconds <= 0` keeps rather than drops. A zero-duration itinerary is
 * not a walking itinerary, it is a degenerate one, and silently deleting it
 * here would hide whatever produced it.
 */
export function walkShareWithin(itin: Itinerary, cfg: RankConfig): boolean {
  if (itin.durationSeconds <= 0) return true;
  return itin.walkSeconds <= cfg.maxWalkShare * itin.durationSeconds;
}

/**
 * Journey identity is the sequence of
 * `(tripId, boarding stopSequence, alighting stopSequence)` over the TRANSIT
 * legs only.
 *
 * Walk legs are excluded deliberately. The forward and reverse passes derive
 * access and egress from the same origin and destination points, but they can
 * reconstruct a different access STOP for the same ride -- so including the
 * walks would report two identical rides as two different journeys, which is
 * exactly the duplicate this key exists to collapse.
 *
 * `stopSequence` rather than `stopIdx`: it is what the built leg already
 * carries, and it is unique within a trip, which is all the key needs.
 */
export function journeyKey(itin: Itinerary): string {
  const parts: string[] = [];
  for (const leg of itin.legs) {
    if (leg.type !== "transit") continue;
    parts.push(`${leg.tripId}:${leg.from.stopSequence}:${leg.to.stopSequence}`);
  }
  return parts.join("|");
}

export interface RankOptions<T> {
  /** The `hasTransitLeg` and `walkShareWithin` filters. Defaults to `true`. `routes/planOnboard.ts`
   *  passes `false`: a rider already on a vehicle has no access leg, so a
   *  zero-transit-leg "get off here and walk" itinerary is the right answer
   *  there rather than the leak `hasTransitLeg` exists to catch. */
  applyFilters?: boolean;
  /**
   * Candidates for which this returns `true` are treated as IN-WINDOW for
   * ordering no matter when they depart. Everything else --
   * both filters, dedupe, `journeyCost` -- is unchanged for them.
   *
   * This exists because the window's departure-anchored bound and the reverse
   * probe's arrival-anchored generation bound are DIFFERENT SETS, and the
   * disagreement is not benign. Write `dur_f` for the forward candidate's
   * duration and `dur_p` for a probe candidate's, `D_f` for the forward
   * departure and `A_min = D_f + dur_f` for the earliest arrival. `plan.ts`
   * generates a probe candidate only if it arrives by `A_min + W`, so it
   * departs at `A_p - dur_p <= A_min + W - dur_p`. The window's cutoff is
   * `D_f + W = A_min - dur_f + W`. Solving the two against each other, the
   * probe candidate can clear the departure cutoff ONLY WHEN
   * `dur_p >= dur_f` -- only when the journey the probe found is NO FASTER
   * than the forward one. The probe exists precisely to find shorter,
   * lower-effort journeys, so `dur_p < dur_f` is its success case, and that is
   * exactly what an unexempted window demotes: the better the probe candidate,
   * the more certainly it is buried. That is not a tuning artefact, it is
   * arithmetic, and it holds for every fixture and every feed.
   *
   * Exempting is safe because the probe's own generation bound already
   * provides the guarantee the window exists for. The departure window is there
   * so an unboundedly-distant departure cannot displace a near one; a probe
   * candidate arrives no later than `A_min + W` by construction, so it is
   * bounded ALREADY -- just on arrival rather than on departure. A second,
   * differently-anchored bound on top adds no safety it does not already have.
   *
   * Only candidates the probe itself produced may be passed here. In
   * particular `plan.ts`'s `reverseSourced` is NOT the right flag: it is also
   * set when `reoptimiseBounded` swaps a forward itinerary onto a reverse
   * chain, which carries no arrival bound of its own and must stay subject to
   * the window.
   */
  exempt?: (candidate: T) => boolean;
}

/**
 * Filter, dedupe, anchor, order, in one pass.
 *
 * Generic over `T` rather than taking `Itinerary[]` for a load-bearing reason.
 * Both callers keep an array parallel to `itineraries`, index for index --
 * `plan.ts`'s `reverseSourced` (which rule `annotateTransferRisk` must compare
 * against) and `planOnboard.ts`'s `alighting` (which stop the rider gets off
 * at). Reordering the itineraries without reordering those would silently
 * mismatch every annotation, and it would not fail a type check. Wrapping the
 * pair and reordering the wrapper makes that mistake unrepresentable.
 *
 * `opts.exempt` lifts the departure window for candidates that already carry
 * an arrival bound of their own -- read its doc comment before touching the
 * ordering, the reason is arithmetic and it is not obvious.
 *
 * Returns a NEW array; the input is never mutated.
 */
export function rankItineraries<T>(
  candidates: readonly T[],
  itineraryOf: (candidate: T) => Itinerary,
  cfg: RankConfig,
  opts: RankOptions<T> = {},
): T[] {
  const applyFilters = opts.applyFilters ?? true;
  const exempt = opts.exempt ?? (() => false);

  // Filter and dedupe in one walk. `seen` maps a journey key to its index in
  // `kept`, so a duplicate can REPLACE the entry already there rather than
  // being dropped -- this keeps the LATER departure of two
  // reconstructions of the same ride, and the forward pass (which produces the
  // earlier one) is walked first.
  const kept: T[] = [];
  const seen = new Map<string, number>();
  for (const candidate of candidates) {
    const itin = itineraryOf(candidate);
    if (applyFilters && !hasTransitLeg(itin)) continue;
    if (applyFilters && !walkShareWithin(itin, cfg)) continue;

    const key = journeyKey(itin);
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, kept.length);
      kept.push(candidate);
      continue;
    }
    if (Date.parse(itin.departureTime)
        > Date.parse(itineraryOf(kept[at]!).departureTime)) {
      kept[at] = candidate;
    }
  }
  if (kept.length === 0) return kept;

  // The departure-window anchor: the earliest departure among the SURVIVORS, not
  // the query instant and not the earliest departure searched. Computed after
  // filtering on purpose -- a walk-only journey about to be dropped must not
  // be able to pull the anchor earlier and change what counts as in-window.
  // This is also what makes the sparse case work: when nothing runs until
  // 14:00, the window becomes 14:00-14:30 rather than cutting that service off.
  //
  // Exempt candidates are anchored over only when NOTHING ELSE SURVIVES. Two
  // reasons, in order of importance:
  //  - The sparse case must keep working when the filters delete every
  //    non-exempt candidate (e.g. the only forward answer is 85% walking and
  //    the walk-share cap drops it, leaving the probe's answer alone). With no
  //    fallback `anchorMs` would stay `Infinity`, `cutoffMs` would be `NaN`,
  //    and every comparison against it would be false -- so the whole list
  //    would silently read as out-of-window. That is a correctness floor, not
  //    a preference.
  //  - Preferring the non-exempt minimum when one exists keeps the window
  //    meaning what it is meant to mean: it is the earliest-arrival
  //    search's own offer that defines "near", and the probe -- which is
  //    exempt from the bound anyway -- should not be able to move the bound
  //    for everyone else by reconstructing some other round's earlier chain.
  let anchorMs = Infinity;
  let exemptAnchorMs = Infinity;
  for (const candidate of kept) {
    const departureMs = Date.parse(itineraryOf(candidate).departureTime);
    if (exempt(candidate)) exemptAnchorMs = Math.min(exemptAnchorMs, departureMs);
    else anchorMs = Math.min(anchorMs, departureMs);
  }
  if (anchorMs === Infinity) anchorMs = exemptAnchorMs;
  const cutoffMs = anchorMs + cfg.departureWindowSeconds * 1000;

  // `inWindow` first, then cost, then departure as a stable final tiebreak so
  // two identically-priced journeys never swap order between requests.
  const inWindow = (candidate: T, departureMs: number): number =>
    exempt(candidate) || departureMs <= cutoffMs ? 0 : 1;
  return kept.sort((a, b) => {
    const ia = itineraryOf(a);
    const ib = itineraryOf(b);
    const da = Date.parse(ia.departureTime);
    const db = Date.parse(ib.departureTime);
    return inWindow(a, da) - inWindow(b, db)
      || journeyCost(ia, cfg) - journeyCost(ib, cfg)
      || da - db;
  });
}
