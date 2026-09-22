import type { TimetableIndex } from "./index.js";
import type { Label, RaptorAccess, DayContext } from "./raptor.js";
import type { ReverseLabel } from "./raptorReverse.js";
import type { TimetableShift } from "./shift.js";
import type { Lang, Translator } from "../db/i18n.js";
import { toIso } from "./calendar.js";
import { haversineMeters } from "../geo.js";
// The ONE detour factor, imported rather than restated -- see its own doc
// comment. `FootpathArrays` stores only a footpath's travel seconds, never
// its distance, so this is the only distance a chain-internal walk leg can
// ever report, and it has to agree with what the access/egress helper in
// routes/plan.ts reports for a leg of the same length.
import { WALK_DETOUR_FACTOR, type WalkStep } from "../walking/valhalla.js";
import type { RealtimeSource } from "../realtime/types.js";

export interface Place {
  type: "coordinate" | "stop";
  lat: number;
  lon: number;
  stopId?: string;
  name?: string | null;
}

export interface WalkLeg {
  type: "walk";
  from: Place;
  to: Place;
  distanceMeters: number;
  durationSeconds: number;
  geometry: string | null;
  /**
   * True iff `durationSeconds` is NOT a real routed walking time -- this
   * describes the DURATION's provenance, not the distance's or the
   * geometry's (those are `distanceMeters`/`geometry`, set and overwritten
   * independently; see `routes/walkGeometry.ts`'s own doc comment for why
   * it never touches this field). For an access/egress leg, false once
   * `refineAccessByWalking` has routed that candidate through a live
   * Valhalla matrix call (see `routes/plan.ts`'s `walkLeg`). For a
   * mid-itinerary transfer leg, false when its footpath came from a routed
   * index and it is not a same-station interchange -- see this file's own
   * transfer-leg construction, below.
   */
  walkEstimated: boolean;
  /**
   * The walk's turns, in order -- each with the stretch of `geometry` it
   * covers -- once `routes/walkGeometry.ts` has routed it through Valhalla.
   * Absent while the walk is still a straight line, which has no turns to give.
   */
  steps?: WalkStep[];
}

export interface TransitLeg {
  type: "transit";
  route: {
    id: string; agencyId: string | null; shortName: string | null;
    longName: string | null; type: number; color: string | null;
  };
  tripId: string;
  /** Where the trip is going: a rail trip's last stop, see `db/tripHeadsign.ts`. */
  headsign: string | null;
  /** The train number for a rail trip, null otherwise. */
  tripNumber: string | null;
  directionId: number;
  /**
   * `departureTime`/`arrivalTime` are what the PLANNER used and what the rider
   * should act on: the live predicted times whenever this trip carried a
   * realtime delay into the search (see `transit/shift.ts`), and the timetable
   * otherwise.
   *
   * `scheduledDepartureTime`/`scheduledArrivalTime` are always the published
   * timetable, and are always present -- equal to the pair above whenever no
   * delay applied. They exist so a client can render "10:14 (sched 10:03)",
   * and so everything that reasons about the TIMETABLE (`scheduledTransferAtRisk`,
   * and `realtimeForLeg`'s delay arithmetic) has a baseline that does not
   * move under it.
   */
  from: {
    stop: Place; departureTime: string; scheduledDepartureTime: string; stopSequence: number;
  };
  to: { stop: Place; arrivalTime: string; scheduledArrivalTime: string; stopSequence: number };
  numStops: number;
  intermediateStops: Place[];
  geometry: string | null;
  /**
   * True when `geometry` is NOT the operator's real shape: a straight line
   * through the leg's stops, because the trip carries no shape, its shape row
   * is missing, or the shape could not be cut to this leg. Also true while
   * `geometry` is still `null` — the pair is only ever `false` once a real
   * line has actually been attached, so an unresolved leg never reads as real
   * geometry. Mirrors the same flag on `/routes/:routeId/shape`. A
   * client can style a fallback line differently instead of believing it has
   * real geometry.
   */
  geometryFallback: boolean;
  /**
   * Live SIRI predictions for this ride, annotated by the route layer after
   * this itinerary is built -- see `routes/plan.ts`'s `annotateRealtime` and
   * `routes/departures.ts`'s equivalent. Null whenever realtime is disabled,
   * stale, or this trip was not resolved: `RealtimeStore.journeyFor` already
   * collapses all three into that single `null` (see its own doc comment),
   * so this field need not distinguish them. Pessimistically `null` here at
   * construction -- exactly like `geometry`/`geometryFallback` above -- so an
   * itinerary that never reaches the annotation step (or whose trip never
   * resolves) reports "no data" rather than silently omitting the field.
   */
  realtime: {
    /** Epoch-second predictions, converted to the response's ISO format. */
    predictedDeparture: string | null;
    predictedArrival: string | null;
    /** Predicted minus scheduled, in seconds. Negative means running early. */
    delaySeconds: number | null;
    vehicleRef: string | null;
    /** SIRI's own confidence in the prediction. */
    confidence: string | null;
    /** When the vehicle last reported, ISO. */
    recordedAt: string | null;
    /**
     * Which feed produced this prediction. `"siri-sm"` is the operator's own
     * ETA for the stop; `"stride-vm"` is derived here from a vehicle
     * position plus the schedule and is the weaker signal, so a client may
     * reasonably present it more tentatively.
     *
     * Distinct from `confidence`, which stays exactly what it is documented
     * to be -- SIRI's own confidence, and always `null` on the VM path.
     */
    source: RealtimeSource;
  } | null;
  /**
   * The later buses the rider could also take for this same ride: trips (the
   * planned line's own next one included) boarding at this leg's board stop
   * and calling at its alight stop, leaving within a window after this leg --
   * each marked with whether it misses the next ride and how much later it gets
   * the rider to the end of the itinerary. See `transit/alternatives.ts`. One
   * trip per route, as complete legs (stops, geometry, realtime) so a client
   * can swap one in for this leg wholesale when the rider says which bus they
   * actually got on. Ordered by departure. Empty until `/plan` annotates it.
   */
  alternatives: TransitAlternative[];
}

/** A ride on its own: a transit leg without the alternatives offered for it. */
export type TransitRide = Omit<TransitLeg, "alternatives">;

/**
 * A ride offered in place of another, and what taking it instead does to the
 * journey -- see `transit/alternatives.ts` for how both are measured.
 */
export interface TransitAlternative extends TransitRide {
  /** It reaches the alight stop too late for the planned next ride. */
  missesConnection: boolean;
  /**
   * How much later the rider reaches the end of the itinerary on it than on the
   * planned ride; negative when sooner. Null when no onward trip was found.
   */
  arrivalDelaySeconds: number | null;
}

export type Leg = WalkLeg | TransitLeg;

export interface Itinerary {
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  transfers: number;
  walkSeconds: number;
  walkMeters: number;
  legs: Leg[];
  /**
   * True when a transit leg's predicted arrival, plus the following walk
   * and the planner's own boarding buffer, lands after the next leg's
   * scheduled departure -- i.e. the connection RAPTOR built no longer has
   * the margin RAPTOR itself required to build it. False when every
   * transfer's data confirms the connection still holds that margin,
   * including the trivial case of an itinerary with no transfer at all (a
   * single transit leg, or none). Null -- not false -- whenever at least
   * one transfer's status cannot be determined and none is confirmed at
   * risk: a UI must be able to tell a safe connection from an unmeasured
   * one, which is also why realtime being disabled (no MOT key configured)
   * reports `null` here on every itinerary, never `false`, regardless of
   * whether that itinerary even has a transfer to be at risk about -- see
   * the global "no key, no behaviour change beyond the two new null
   * fields" rule this whole feature is built under. Set by
   * `routes/plan.ts`'s `annotateRealtime`, after this itinerary is built;
   * pessimistically `null` here at construction, for the same reason
   * `realtime` above is.
   */
  transferAtRisk: boolean | null;
}

/**
 * Rounds whose arrival strictly improves on every earlier round.
 *
 * Round k is the at-most-k-trips answer, so a round matching an earlier
 * round's arrival spent an extra transfer for nothing and is dropped. What
 * survives is exactly the Pareto set over (arrival time, transfers).
 *
 * Generic (`T extends { arrivalEpoch: number }`) rather than merely
 * shape-typed: the route handler calls this for the reverse pass too, by
 * mapping `ReverseLabel.departureEpoch` to a negated pseudo-`arrivalEpoch`
 * first (a later departure is "better", the mirror of an earlier arrival
 * being better) -- see the `/plan` handler. The type parameter exists
 * so `opts.accept` can see the caller's real label shape (or whatever it was
 * mapped to) rather than being stuck at the bare `{ arrivalEpoch }` every
 * caller's input structurally satisfies; this function itself still never
 * needs to know which direction produced its input.
 *
 * A round-index cutoff must never be used here: RAPTOR's `best[]`
 * never regresses (`raptor.ts`'s per-round array only ever improves a stop's
 * value or carries it forward unchanged), so once a walk-only value wins a
 * round it is *automatically* still present, unchanged, at every later
 * round's own `destinations`-wide arg-min too -- skipping round 0 just
 * re-discovers the identical walk-only value at round 1 and re-picks it,
 * because it is still the smallest arrival among `destinations` there.
 * Round number never tells us whether a label actually rode anything; only
 * the label's own chain does. Hence `accept` below.
 */
export function paretoRounds<T extends { arrivalEpoch: number }>(
  rounds: readonly (readonly (T | null)[])[],
  destinations: readonly RaptorAccess[],
  opts: {
    /**
     * Optional gate on which labels may WIN a round's pick. A rejected label
     * is skipped entirely -- it neither becomes the pick nor sets
     * `bestSoFar`, and the second half is the point.
     *
     * `/plan` passes a predicate that requires the label's chain to include
     * a boarding, because walk-only itineraries are dropped
     * unconditionally: a candidate that cannot survive into the response
     * must not be able to suppress candidates that can. Without it, a
     * walk-only label at a stop inside both walk radii can win a round's
     * pick ahead of a genuinely boarded label at a DIFFERENT candidate stop
     * in the SAME round -- `paretoRounds` takes one minimum arrival across
     * ALL of `destinations` per round, not per stop -- deleting a bus
     * itinerary the response could otherwise have returned. See
     * `routes/plan.test.ts`'s `serveWalkDominance` fixture for a worked
     * example, measured end to end.
     *
     * This is NOT the whole real-feed symptom (one bus itinerary at
     * `maxWalkMeters` 800/1000, zero at 1200/2500, on some queries -- e.g.
     * one Pardes Hanna query, unaffected by the `accept` predicate above).
     * A SEPARATE mechanism in `raptor.ts`'s own per-stop `best[]`
     * pruning can discard a transit label before `paretoRounds` ever runs,
     * whenever its only viable alighting stop is also faster to reach on
     * foot -- no predicate here can rescue a label that was never written.
     *
     * Round number is NOT a usable proxy for the part this DOES fix:
     * RAPTOR's `best[]` never regresses, so a walk-only value reached in
     * round 0 persists at that stop into every later round and keeps
     * winning the pick there. See this function's own doc comment.
     *
     * `/plan/onboard` passes nothing. Its rider is already aboard, its
     * chains have no access leg, and its walk-only answer means "get off
     * here and walk the rest" -- a real answer that endpoint filters
     * nothing from.
     */
    accept?: (label: T) => boolean;
  } = {},
): { round: number; stopIdx: number; arrivalEpoch: number }[] {
  const out: { round: number; stopIdx: number; arrivalEpoch: number }[] = [];
  let bestSoFar = Infinity;

  for (let k = 0; k < rounds.length; k++) {
    let bestStop = -1;
    let bestArrival = Infinity;
    for (const dest of destinations) {
      const label = rounds[k]?.[dest.stopIdx];
      if (label === null || label === undefined) continue;
      if (opts.accept !== undefined && !opts.accept(label)) continue;
      const arrival = label.arrivalEpoch + dest.secondsToReach;
      if (arrival < bestArrival) { bestArrival = arrival; bestStop = dest.stopIdx; }
    }
    if (bestStop >= 0 && bestArrival < bestSoFar) {
      bestSoFar = bestArrival;
      out.push({ round: k, stopIdx: bestStop, arrivalEpoch: bestArrival });
    }
  }
  return out;
}

// A generous, purely defensive bound on chain length. `predecessor` chains
// are direct object references built strictly backward (forward pass) or
// strictly toward the destination (reverse pass) during a single RAPTOR run
// that never creates a cycle -- verified by construction across 60,000+
// networks -- so this guard is never expected to trigger. It
// exists only so a future defect in raptor.ts/raptorReverse.ts (an
// accidental self-referencing or cyclic `predecessor`) turns into a clean
// `null` here instead of an infinite loop.
function guardBound(ix: TimetableIndex): number {
  return ix.nStops * 4 + 64;
}

// Same defensive-only reasoning as `guardBound` above -- `hasRidden` and
// `hasRiddenReverse` have no `ix` in scope to size a bound against `nStops`,
// so a flat, generous constant serves the identical purpose: a future defect
// in raptor.ts/raptorReverse.ts turns into a clean `false` here instead of an
// infinite loop. Never expected to trigger against a real chain.
const HAS_RIDDEN_MAX_STEPS = 10_000;

/**
 * True when this forward label's chain includes an actual boarding, i.e. it
 * is not a walk-only (access-only) journey.
 *
 * Walks `predecessor` -- the same object-reference chain
 * `reconstructForward` follows, and for the same reason `rounds[k]` itself
 * is unsafe to re-derive from (see that function's doc comment) -- until it
 * finds a `"transit"` label (true, this journey boarded something) or an
 * `"access"` label (false, it never did). An unbounded chain never happens
 * in practice (see `guardBound`'s own reasoning); `HAS_RIDDEN_MAX_STEPS`
 * exists only so a future defect there degrades to `false` rather than
 * hanging.
 *
 * No `originsOnVehicle` equivalent is needed here, unlike `raptor.ts`'s
 * `arrivedOnVehicle` below. This function gates `paretoRounds`'s `accept`
 * predicate (see that parameter's own doc comment), and the only caller that
 * would ever need one -- `/plan/onboard`, where the rider genuinely starts
 * already aboard a vehicle -- passes no `accept` predicate at all: its
 * walk-only answer means "get off here and walk the rest", a real answer the
 * endpoint filters nothing from.
 *
 * See also `raptor.ts`'s `arrivedOnVehicle` (around :344): a second
 * provenance oracle answering the same underlying question -- has this
 * chain's rider boarded a vehicle -- for forward labels, but by reading only
 * one link of `predecessor` rather than walking the full chain, justified
 * there by the invariant that a walk label's predecessor is never itself a
 * walk. The two must keep agreeing; if they were ever to drift apart, a
 * label's ridden-or-not status would depend on which of the two answered.
 */
export function hasRidden(label: Label): boolean {
  let l: Label | null = label;
  for (let step = 0; l !== null && step < HAS_RIDDEN_MAX_STEPS; step++) {
    if (l.kind === "transit") return true;
    if (l.kind === "access") return false;
    l = l.predecessor;
  }
  return false;
}

/**
 * The reverse-pass mirror of `hasRidden`: true when this `ReverseLabel`'s
 * chain includes an actual boarding. Walks `predecessor` -- destination-ward
 * here, see `reconstructReverse`'s own doc comment on the direction flip --
 * until it finds a `"transit"` label (true) or an `"egress"` label (false,
 * the reverse-pass mirror of `"access"`).
 */
export function hasRiddenReverse(label: ReverseLabel): boolean {
  let l: ReverseLabel | null = label;
  for (let step = 0; l !== null && step < HAS_RIDDEN_MAX_STEPS; step++) {
    if (l.kind === "transit") return true;
    if (l.kind === "egress") return false;
    l = l.predecessor;
  }
  return false;
}

/**
 * Walks a forward label chain back to its access label, by following
 * `predecessor` object references -- NEVER by re-looking up a stop id in
 * `rounds`. `rounds[k]` is a live, mutable array while round k is still being
 * computed: transit arrivals and footpath relaxations keep overwriting the
 * entry at a given stop as better labels are found, so by the time
 * reconstruction runs (well after the whole search finished), the label
 * currently stored at `rounds[k][someStop]` may be a completely different,
 * later improvement than the one a given label was actually built from.
 * Measured on the real feed: 3.1% of walk labels have
 * `rounds[k][label.fromStop] !== label.predecessor`. `predecessor` pins the
 * exact object instead, so it can never go stale.
 *
 * The only `rounds` lookup here is the very first one, to find the labeled
 * *starting point* of the walk (round `round`, stop `stopIdx`) -- after that,
 * every step follows `.predecessor` and never touches `rounds` again.
 */
export function reconstructForward(
  ix: TimetableIndex,
  rounds: readonly (readonly (Label | null)[])[],
  round: number,
  stopIdx: number,
): { stopIdx: number; label: Label }[] | null {
  const start = rounds[round]?.[stopIdx];
  if (start === null || start === undefined) return null;

  const chain: { stopIdx: number; label: Label }[] = [];
  let s = stopIdx;
  let label: Label = start;
  const maxSteps = guardBound(ix);

  for (let step = 0; ; step++) {
    chain.push({ stopIdx: s, label });
    if (label.kind === "access") {
      chain.reverse();
      return chain;
    }
    const pred = label.predecessor;
    // Invariant: every non-access label was built by extending some earlier
    // label, so `predecessor` is non-null here. A null predecessor on a
    // non-access label would mean a malformed label set; treat it as
    // unreconstructable rather than dereferencing further.
    if (pred === null) return null;
    if (step >= maxSteps) return null;
    // `fromStop` names the exact stop `predecessor` lives at: for a transit
    // label it equals `boardStop` (the label read from `prev[boardStop]`),
    // and for a walk label it is the stop the footpath was relaxed from --
    // both are set from the very same object this label's `predecessor`
    // points at, at the moment this label was created.
    s = label.fromStop;
    label = pred;
  }
}

/**
 * The mirror of `reconstructForward` for the reverse (arrive-by) pass,
 * already in travel order (origin -> destination), because that is the
 * direction `predecessor` points here.
 *
 * FOOTGUN: `predecessor`'s direction is flipped relative to the forward
 * pass. In `Label` (forward), `predecessor` points backward in journey order,
 * toward the origin -- reconstruction there walks backward and must reverse
 * the accumulated chain at the end. In `ReverseLabel`, `predecessor` points
 * forward in journey order, toward the destination: a `ReverseLabel` at stop
 * `s` was built to satisfy a deadline already known at some stop closer to
 * the destination (the label it was extended *to reach*), and that is
 * exactly what `predecessor` references. So walking `predecessor` here
 * already visits stops in origin -> destination order and needs no reversal.
 *
 * Traced on paper against `runRaptorReverse`:
 *  - `relaxFootpathsReverse` writes `target[t] = { ..., toStop: s,
 *    predecessor: label }`, where `label` lives at `s` and `s` is CLOSER to
 *    the destination (it was already reached; `t` is the new, farther-back
 *    stop the footpath was relaxed backward onto). So the walk label at `t`
 *    points its `predecessor` at the label at `s = toStop`, i.e. onward,
 *    destination-ward. Matches the doc comment on `ReverseLabel.predecessor`
 *    verbatim.
 *  - In `runRaptorReverse`'s main loop, a transit `visitLabel` is written at
 *    board stop `s` (the iteration variable, walked backward through the
 *    pattern) with `predecessor: alightLabel`, where `alightLabel` was read
 *    from `prev[alightStop]` -- `alightStop` being where the trip was
 *    already held from, i.e. destination-ward of `s`. Again, `predecessor`
 *    points at `toStop` (`=== alightStop` for transit), destination-ward.
 *  - Egress labels (`predecessor: null`) sit at the destination-ward end of
 *    the chain, mirroring how forward's access labels (`predecessor: null`)
 *    sit at the origin-ward end.
 * So following `predecessor` from an origin-side stop lands, step by step,
 * on stops progressively closer to the destination, terminating at an
 * egress label -- i.e., already in travel order. Reversing this chain (by
 * naive analogy with the forward pass, which does need it) would silently
 * emit it backward.
 */
export function reconstructReverse(
  ix: TimetableIndex,
  rounds: readonly (readonly (ReverseLabel | null)[])[],
  round: number,
  stopIdx: number,
): { stopIdx: number; label: ReverseLabel }[] | null {
  const start = rounds[round]?.[stopIdx];
  if (start === null || start === undefined) return null;

  const chain: { stopIdx: number; label: ReverseLabel }[] = [];
  let s = stopIdx;
  let label: ReverseLabel = start;
  const maxSteps = guardBound(ix);

  for (let step = 0; ; step++) {
    chain.push({ stopIdx: s, label });
    if (label.kind === "egress") return chain;
    const pred = label.predecessor;
    if (pred === null) return null;
    if (step >= maxSteps) return null;
    // `toStop` names the exact stop `predecessor` lives at (`=== alightStop`
    // for a transit label; the walked-to stop for a walk label) -- see the
    // footgun note above.
    s = label.toStop;
    label = pred;
  }
}

/**
 * Converts a reverse chain into the forward `{ stopIdx, label }[]` shape
 * `buildItinerary` consumes.
 *
 * A `ReverseLabel` records the leg LEAVING the stop it lives at (a departure
 * time, plus where that leg leads onward); a forward `Label` records the leg
 * ARRIVING at the stop it lives at. So converting shifts every reverse
 * entry's transit/walk information onto the NEXT stop in travel order:
 * `reverse[i]` (at stop `s_i`, describing the leg to `s_{i+1} = toStop`)
 * becomes `out[i+1]` (at stop `s_{i+1}`, describing the leg that arrived
 * there). The reverse chain's first stop (the true origin side) has no
 * incoming leg of its own -- it is where the journey starts -- so it becomes
 * a synthesized `access`-kind bookend instead, mirroring how a real forward
 * chain always starts with one. The reverse chain's terminal `egress` entry
 * is the mirror-image bookend (marking "close enough to the real
 * destination") and is dropped rather than converted, since the forward
 * shape has no bookend at its end -- it simply ends on the last real
 * transit/walk entry, exactly as `reconstructForward`'s output does.
 */
export function reconstructReverseChain(
  ix: TimetableIndex,
  rounds: readonly (readonly (ReverseLabel | null)[])[],
  round: number,
  stopIdx: number,
): { stopIdx: number; label: Label }[] | null {
  const reverse = reconstructReverse(ix, rounds, round, stopIdx);
  if (reverse === null || reverse.length === 0) return null;

  const first = reverse[0]!;
  const chain: { stopIdx: number; label: Label }[] = [{
    stopIdx: first.stopIdx,
    label: {
      arrivalEpoch: first.label.departureEpoch,
      kind: "access",
      fromStop: -1,
      tripIdx: -1,
      dayIdx: -1,
      boardStop: -1,
      boardEpoch: first.label.departureEpoch,
      predecessor: null,
    },
  }];

  // The last entry is always the egress bookend (see reconstructReverse);
  // every earlier entry is a real leg to convert.
  for (let i = 0; i < reverse.length - 1; i++) {
    const entry = reverse[i]!;
    const rl = entry.label;
    // Guaranteed by reconstructReverse: only the final entry is ever
    // egress-kind, and this loop stops one short of it.
    const isWalk = rl.kind === "walk";

    chain.push({
      stopIdx: rl.toStop,
      label: {
        arrivalEpoch: rl.alightEpoch,
        kind: isWalk ? "walk" : "transit",
        fromStop: entry.stopIdx,
        tripIdx: isWalk ? -1 : rl.tripIdx,
        dayIdx: isWalk ? -1 : rl.dayIdx,
        boardStop: isWalk ? -1 : entry.stopIdx,
        boardEpoch: rl.departureEpoch,
        predecessor: null,
      },
    });
  }

  return chain;
}

function placeOfStop(ix: TimetableIndex, s: number, tr: Translator, lang: Lang): Place {
  return {
    type: "stop",
    lat: ix.stopLat[s]!,
    lon: ix.stopLon[s]!,
    stopId: ix.stopIds[s]!,
    name: tr.resolve(ix.stopNames[s] ?? null, lang),
  };
}

/**
 * The station stop s belongs to, for deciding whether a transfer between two
 * stops is a same-station interchange: s's own parent station when it has
 * one, otherwise s itself. Two stops are in the same station exactly when
 * this resolves to the same index for both -- the identical rule
 * `footpaths.ts`'s `stationPeers` uses to decide which pairs bypass the
 * walking-radius prefilter and get the constant `sameStationSeconds +
 * transferMinSeconds` edge instead of a routed one (confirmed by tracing
 * both: `stationPeers` groups every stop under `key = stopParent[s] !== -1
 * ? stopParent[s] : s`, i.e. two distinct stops are grouped together iff
 * they resolve to the same key under that exact formula -- which is what
 * this function computes for a single stop, so comparing it for both
 * endpoints of a pair is equivalent to asking whether `stationPeers` would
 * have grouped them).
 */
function stationOf(ix: TimetableIndex, s: number): number {
  const parent = ix.stopParent[s]!;
  return parent !== -1 ? parent : s;
}

/**
 * One ride on trip `t` from pattern position `boardPos` to `alightPos`, at
 * the given absolute board and arrival instants. Shared by `buildItinerary`
 * and by `alternatives.ts`, so an alternative line is the same shape, down to
 * the field, as the leg it stands in for.
 */
export function transitLegOf(
  ix: TimetableIndex, t: number, boardPos: number, alightPos: number,
  boardEpoch: number, arrivalEpoch: number,
  ctx: { tr: Translator; lang: Lang; tz: string; routeOf: (routeIdx: number) => TransitLeg["route"] },
  // Default to the planned instants, which is exactly right for every caller
  // that builds a leg straight off the timetable (`alternatives.ts`): with no
  // delay applied, planned and scheduled ARE the same instant.
  scheduledBoardEpoch: number = boardEpoch,
  scheduledArrivalEpoch: number = arrivalEpoch,
): TransitRide {
  const stopFrom = ix.patternStopOffset[ix.patternOfTrip[t]!]!;
  const intermediate: Place[] = [];
  for (let j = boardPos + 1; j < alightPos; j++) {
    intermediate.push(placeOfStop(ix, ix.patternStops[stopFrom + j]!, ctx.tr, ctx.lang));
  }
  return {
    type: "transit",
    route: ctx.routeOf(ix.tripRouteIdx[t]!),
    tripId: ix.tripIds[t]!,
    headsign: ctx.tr.resolve(ix.tripHeadsigns[t] ?? null, ctx.lang),
    tripNumber: ix.tripNumbers[t] ?? null,
    directionId: ix.tripDirection[t]!,
    from: {
      stop: placeOfStop(ix, ix.patternStops[stopFrom + boardPos]!, ctx.tr, ctx.lang),
      departureTime: toIso(boardEpoch, ctx.tz),
      scheduledDepartureTime: toIso(scheduledBoardEpoch, ctx.tz),
      stopSequence: boardPos,
    },
    to: {
      stop: placeOfStop(ix, ix.patternStops[stopFrom + alightPos]!, ctx.tr, ctx.lang),
      arrivalTime: toIso(arrivalEpoch, ctx.tz),
      scheduledArrivalTime: toIso(scheduledArrivalEpoch, ctx.tz),
      stopSequence: alightPos,
    },
    numStops: alightPos - boardPos,
    intermediateStops: intermediate,
    // Unresolved, and honestly labelled as such. `resolveLegGeometry` (in
    // the route layer -- this module holds no SQL) overwrites both fields.
    // The pair starts PESSIMISTIC because `false` here would mean "no
    // geometry, and that is not a fallback", which is incoherent: any
    // future path that skips resolution would report a null line as if it
    // were the operator's real shape. `true` degrades safely instead --
    // `geometryFallback: true` never claims more than it has.
    geometry: null,
    geometryFallback: true,
    // Overwritten by `routes/plan.ts`'s `annotateRealtime`, after this
    // itinerary is built -- see this field's own doc comment.
    realtime: null,
  };
}

/**
 * Collapses back-to-back walk legs into one. `buildItinerary` unconditionally
 * bookends the chain with `accessLeg`/`egressLeg`, with no check for whether
 * the chain itself already starts or ends in a walk (RAPTOR's round-0
 * footpath relaxation can land on a stop other than the access point before
 * boarding, and the mirror case happens at egress) -- so two riders' worth of
 * "walk, then immediately walk again" would otherwise reach the client as two
 * separate legs instead of the one continuous walk it actually is.
 *
 * `geometry` becomes `null` on the merged leg rather than concatenating the
 * two halves' geometries: a stale two-piece line can't represent one
 * continuous path, and `resolveWalkGeometry` already re-routes any
 * null-geometry walk leg through Valhalla at request time, which produces a
 * correct single line for the merged distance instead.
 */
export function mergeAdjacentWalkLegs(legs: Leg[]): Leg[] {
  const merged: Leg[] = [];
  for (const leg of legs) {
    const previous = merged[merged.length - 1];
    if (leg.type === "walk" && previous?.type === "walk") {
      previous.to = leg.to;
      previous.distanceMeters += leg.distanceMeters;
      previous.durationSeconds += leg.durationSeconds;
      previous.geometry = null;
      previous.walkEstimated = previous.walkEstimated || leg.walkEstimated;
      continue;
    }
    merged.push(leg);
  }
  return merged;
}

/**
 * Turns a forward label chain into API legs.
 *
 * Consecutive stops on one trip collapse into a single transit leg -- the
 * chain records only board and alight stops, and the intermediate stops are
 * read back out of the pattern.
 */
export function buildItinerary(
  ix: TimetableIndex,
  chain: { stopIdx: number; label: Label }[],
  ctx: {
    tr: Translator; lang: Lang; tz: string; days: readonly DayContext[];
    routeOf: (routeIdx: number) => TransitLeg["route"];
    accessLeg?: WalkLeg; egressLeg?: WalkLeg;
    /**
     * The same live delays the search ran with, parallel to `days` -- see
     * `RaptorQuery.shift`. MUST be the identical value: the position lookup
     * below pins a label to its trip position by matching the label's own
     * recorded epoch against the trip's time at that position, and a label
     * written by a shifted search matches nothing in an unshifted timetable.
     * Passing the wrong one (or omitting it) does not throw -- it silently
     * drops the leg, exactly the defect the `plan.test.ts` realtime cases
     * guard against.
     */
    shift?: (TimetableShift | undefined)[];
    /**
     * Subtracted from a walk leg's raw label-to-label time span before it is
     * reported as `durationSeconds`. A footpath's stored `seconds` already
     * bakes in the boarding buffer (`transferMinSeconds` at build time -- see
     * `footpaths.ts`'s `finalizeSeconds(walkSeconds + opts.transferMinSeconds)`
     * for street walks and same-station transfers alike), so the raw
     * difference between two labels' arrival epochs across a walk leg is the
     * walk PLUS that buffer, not the walk alone. The buffer is a planning
     * safety margin so the next boarding is comfortably makeable; it is not
     * time actually spent walking, so a client rendering "3 min walk" should
     * not see it folded in.
     *
     * REQUIRED, not defaulted: defaulting to 0 (report the raw,
     * buffer-inclusive span) would let a caller that forgot to pass it
     * silently ship padded walk times -- a wrong number in a response
     * instead of a compile error at the call site. Pass the same
     * `transferMinSeconds` used for the RAPTOR query to strip the buffer back
     * out; pass `0` explicitly if a caller genuinely has no buffer (e.g. a
     * query run with `transferMinSeconds: 0`). Floored at 0 so a walk shorter
     * than the configured buffer (impossible in practice, since the buffer
     * was added on top of a non-negative walk, but conceivable if a caller
     * passes a mismatched value) can never report a negative duration.
     */
    transferMinSeconds: number;
  },
): Itinerary {
  const legs: Leg[] = [];
  if (ctx.accessLeg !== undefined) legs.push(ctx.accessLeg);
  const buffer = ctx.transferMinSeconds;

  for (let i = 1; i < chain.length; i++) {
    const entry = chain[i]!;
    const prev = chain[i - 1]!;
    const label = entry.label;

    if (label.kind === "walk") {
      const sameStation = stationOf(ix, prev.stopIdx) === stationOf(ix, entry.stopIdx);
      legs.push({
        type: "walk",
        from: placeOfStop(ix, prev.stopIdx, ctx.tr, ctx.lang),
        to: placeOfStop(ix, entry.stopIdx, ctx.tr, ctx.lang),
        // Footpaths carry no distance in the index (only travel seconds --
        // see FootpathArrays), so this is a straight-line estimate between
        // the two stops' own coordinates, not a real one -- but it must be
        // an actual number, not 0: 0 is a false MEASUREMENT (it aggregates
        // into `walkMeters`, so a multi-transfer itinerary with real walking
        // would report "0 m"), not an honest absence of one. The same
        // detour factor the access/egress helper uses for its own
        // straight-line fallback keeps every estimated walk leg in a
        // response consistent with every other one.
        distanceMeters: Math.round(
          haversineMeters(
            [ix.stopLat[prev.stopIdx]!, ix.stopLon[prev.stopIdx]!],
            [ix.stopLat[entry.stopIdx]!, ix.stopLon[entry.stopIdx]!],
          ) * WALK_DETOUR_FACTOR,
        ),
        // The walk's OWN recorded span (boardEpoch -> arrivalEpoch), not
        // `label.arrivalEpoch - prev.label.arrivalEpoch`: those agree for a
        // forward-native walk label (relaxFootpaths always sets
        // `boardEpoch: predecessor.arrivalEpoch`, since a forward walk is
        // relaxed immediately on arrival, no slack possible) but can diverge
        // for a `reconstructReverseChain`-converted one. A reverse arrive-by
        // search reports the LATEST feasible time for each leg, chained
        // backward from the deadline; two adjacent legs can therefore have
        // slack between them (the earlier leg's rider could have left later
        // and still made every downstream connection), and that slack is
        // not walking time. Reading the label's own two instants sidesteps
        // the question entirely, in both directions.
        durationSeconds: Math.max(0, label.arrivalEpoch - label.boardEpoch - buffer),
        geometry: null,
        // Real (not estimated) exactly when this footpath came from an
        // index whose footpaths were actually routed through Valhalla AND
        // it is not a same-station interchange -- a same-station pair's
        // duration is always the configured `sameStationSeconds +
        // transferMinSeconds` constant (see `footpaths.ts`'s
        // `stationPeers` use), never a routed street walk, regardless of
        // `footpathsRouted`. See `stationOf`'s own doc comment for why
        // comparing it for both endpoints is the correct same-station test.
        walkEstimated: !(ix.footpathsRouted && !sameStation),
      });
      continue;
    }

    const t = label.tripIdx;
    const p = ix.patternOfTrip[t]!;
    const stopFrom = ix.patternStopOffset[p]!;
    const stopTo = ix.patternStopOffset[p + 1]!;
    const timeFrom = ix.tripTimeOffset[t]!;
    // A loop pattern can revisit the same stop id more than once; matching
    // on stop id alone would pick the FIRST occurrence in the pattern
    // regardless of which one this
    // label actually boarded/alighted at. Matching each position's OWN
    // scheduled absolute time against the label's recorded boardEpoch /
    // arrivalEpoch (via the label's own dayIdx, exactly why `ctx.days` is
    // threaded through) pins the unique occurrence RAPTOR actually used.
    const day = ctx.days[label.dayIdx];
    // The delay the SEARCH applied to this trip, so the comparison below is
    // made against the same times RAPTOR wrote the label from. Zero whenever
    // the search was schedule-only, which makes this the original expression.
    const delay = ctx.shift?.[label.dayIdx]?.delay?.[t] ?? 0;

    let boardPos = -1;
    let alightPos = -1;
    if (day !== undefined) {
      for (let j = stopFrom; j < stopTo; j++) {
        const s = ix.patternStops[j]!;
        const pos = j - stopFrom;
        if (boardPos < 0) {
          if (s === label.boardStop
            && day.baseEpoch + ix.departureTime[timeFrom + pos]! + delay === label.boardEpoch) {
            boardPos = pos;
          }
        } else if (s === entry.stopIdx
          && day.baseEpoch + ix.arrivalTime[timeFrom + pos]! + delay === label.arrivalEpoch) {
          alightPos = pos;
          break;
        }
      }
    }
    // The label was written while traversing this pattern on this day, so
    // both positions exist; the guard turns an impossible state (a bad
    // dayIdx, or a synthetic label whose times don't actually appear on the
    // trip) into a dropped leg rather than a negative-length slice.
    if (boardPos < 0 || alightPos < 0) continue;

    legs.push({
      ...transitLegOf(
        ix, t, boardPos, alightPos, label.boardEpoch, label.arrivalEpoch, ctx,
        label.boardEpoch - delay, label.arrivalEpoch - delay),
      // Filled by `transit/alternatives.ts`'s `annotateAlternatives` once the
      // response's itineraries are final.
      alternatives: [],
    });
  }

  if (ctx.egressLeg !== undefined) legs.push(ctx.egressLeg);

  const mergedLegs = mergeAdjacentWalkLegs(legs);

  const transitLegs = mergedLegs.filter((l): l is TransitLeg => l.type === "transit");
  const walkLegs = mergedLegs.filter((l): l is WalkLeg => l.type === "walk");

  // Anchored on the reconstructed chain's own two endpoints -- not on
  // whichever leg happens to be first/last in `legs` -- because a
  // transit-legs-only computation goes wrong two ways: it would produce an
  // empty string (and a NaN duration, via `Date.parse("")`) for a chain with
  // no transit leg at all (a genuinely reachable case -- round 0 can be pure
  // access/walk, e.g. the destination is directly within walking distance),
  // and it would silently ignore a trailing walk leg's time -- either a
  // chain-internal footpath after the last ride, or the caller's own
  // `egressLeg` -- when the chain's final leg is a walk.
  // `chain[0]` is always the access label (round 0 or later's starting
  // point) and `chain[last]` is wherever the search actually arrived;
  // `accessLeg`/`egressLeg`, when supplied, extend those two edges outward
  // to the traveler's literal coordinate origin/destination. This also keeps
  // `durationSeconds` an honest sum of every leg's time, including any
  // leading or trailing walk, rather than only the transit portion.
  const chainStart = chain[0];
  const chainEnd = chain[chain.length - 1];
  const departureEpoch = chainStart !== undefined
    ? chainStart.label.arrivalEpoch - (ctx.accessLeg?.durationSeconds ?? 0)
    : undefined;
  const arrivalEpoch = chainEnd !== undefined
    ? chainEnd.label.arrivalEpoch + (ctx.egressLeg?.durationSeconds ?? 0)
    : undefined;

  const departureTime = departureEpoch !== undefined ? toIso(departureEpoch, ctx.tz) : "";
  const arrivalTime = arrivalEpoch !== undefined ? toIso(arrivalEpoch, ctx.tz) : "";

  const walkSeconds = walkLegs.reduce((n, l) => n + l.durationSeconds, 0);
  const walkMeters = walkLegs.reduce((n, l) => n + l.distanceMeters, 0);

  return {
    departureTime,
    arrivalTime,
    durationSeconds: departureEpoch !== undefined && arrivalEpoch !== undefined
      ? Math.max(0, arrivalEpoch - departureEpoch)
      : 0,
    // Transfers, not legs: three transit legs means two changes.
    transfers: Math.max(0, transitLegs.length - 1),
    walkSeconds,
    walkMeters,
    // Overwritten by `routes/plan.ts`'s `annotateRealtime`, after this
    // itinerary is built -- see this field's own doc comment.
    transferAtRisk: null,
    legs: mergedLegs,
  };
}
