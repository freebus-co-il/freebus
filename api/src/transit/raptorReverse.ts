import type { TimetableIndex } from "./index.js";
import { zeroDelay, type TimetableShift } from "./shift.js";
import type { DayContext, RaptorAccess } from "./raptor.js";
import {
  headwayFor, patternTravelOffset, requiredTransferSeconds,
  validateTransferContract, type TransferMargin,
} from "./headway.js";

export interface ReverseLabel {
  /** The latest departure from this stop that still makes the deadline. */
  departureEpoch: number;
  kind: "egress" | "transit" | "walk";
  /** Stop this label leads onward to, toward the destination; -1 for egress. */
  toStop: number;
  tripIdx: number;
  dayIdx: number;
  /**
   * For a transit label, the position within its pattern that
   * `departureEpoch` is the departure from; -1 for walk and egress labels.
   *
   * Recorded rather than re-derived because it cannot be re-derived cheaply
   * or even unambiguously: a loop pattern visits the same stop more than
   * once, so "which position of this pattern is this label's stop" has no
   * single answer, and the scan below knows it for free. The headway table is
   * keyed on the hour of a pattern's departure from its FIRST stop, so
   * pricing the margin for an onward boarding needs to know how far down the
   * pattern that boarding is -- see `patternTravelOffset`.
   */
  patternPos: number;
  alightStop: number;
  alightEpoch: number;
  /**
   * Direct reference to the exact `ReverseLabel` this one was built to reach
   * -- the destination-ward continuation that was already known at the
   * moment this label was created: the label read at the alighting stop
   * while a trip was held (transit labels), or the label walked from (walk
   * labels). `null` for egress labels, which are the destination-ward end of
   * the chain.
   *
   * Mirrors `Label.predecessor` in `raptor.ts` with the direction reversed:
   * there it points toward the origin (the label a leg was extended FROM);
   * here it points toward the destination (the label a leg was extended TO
   * satisfy). Either way, it is the ONLY field itinerary reconstruction may
   * use to walk a journey -- looking up a stop's currently-stored label in
   * `rounds[k]` is unsafe for the identical reason it is on the forward
   * side: `rounds[k]` is still being mutated while a round computes, so a
   * later, unrelated improvement at that stop can silently replace the
   * exact label this one was built from.
   */
  predecessor: ReverseLabel | null;
}

export interface ReverseQuery {
  origins: RaptorAccess[];
  destinations: RaptorAccess[];
  arriveByEpoch: number;
  days: DayContext[];
  /** maxTransfers + 1. */
  maxRounds: number;
  transferMinSeconds: number;
  tripFilter?: (tripIdx: number) => boolean;
  /**
   * Live delays, one entry per `days` entry -- the exact contract
   * `RaptorQuery.shift` documents, and the same arrays: a query that runs both
   * passes builds the shift once and hands the same value to each.
   *
   * Absent means a schedule-only reverse search -- what a caller with no
   * realtime store does.
   */
  shift?: (TimetableShift | undefined)[];
  /**
   * Absent, or a zero factor, means today's flat `transferMinSeconds` and
   * nothing else -- every existing caller omits this and must keep behaving
   * exactly as it did. Identical contract to `RaptorQuery.transfer`, and
   * `runRaptorReverse` enforces the same three halves of it at entry:
   * `headway[d]` is the table for `days[d]` (headway is a property of a
   * service DAY), `cfg.baseSeconds` must equal
   * `transferMinSeconds` (the value footpath edges bake in, and the value the
   * extra margin is measured on top of), and `capSeconds` may not sit below
   * `baseSeconds`.
   */
  transfer?: TransferMargin;
}

export interface ReverseResult {
  /** rounds[k][stop] is the best label departing this stop in at most k trips. */
  rounds: (ReverseLabel | null)[][];
}

/**
 * The mirror of `earliestTripOnDay`: the latest trip on pattern `p`,
 * restricted to a single `day`, whose arrival at position `pos` is no later
 * than `deadlineEpoch`. Returns the trip's pattern-local index (its position
 * within `patternTrips`) alongside it.
 *
 * Restricted to one day for the same reason `earliestTripOnDay` is: the
 * overtaking-split ordering that makes the binary search (and the
 * pattern-local index comparison in `runRaptorReverse` below) valid is a
 * per-service-day-local invariant. Two different DayContexts have unrelated
 * absolute times, so comparing trips across days by pattern-local index
 * would be meaningless; only comparing their (day-independent) absolute
 * ARRIVAL epochs across days is legitimate, which is why `runRaptorReverse`
 * merges results from different days through `best`/`cur`, not through this
 * function.
 */
function latestTripOnDay(
  ix: TimetableIndex, p: number, pos: number, deadlineEpoch: number,
  day: DayContext, tripFilter: ((t: number) => boolean) | undefined,
  patternTrips: Int32Array, delay: Int32Array,
): { tripIdx: number; patternPos: number; arriveEpoch: number } | null {
  const from = ix.patternTripOffset[p]!;
  const to = ix.patternTripOffset[p + 1]!;
  const target = deadlineEpoch - day.baseEpoch;

  // First trip whose arrival at `pos` is strictly AFTER target; every trip
  // before it arrives no later than target.
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const trip = patternTrips[mid]!;
    if (ix.arrivalTime[ix.tripTimeOffset[trip]! + pos]! + delay[trip]! > target) hi = mid;
    else lo = mid + 1;
  }

  for (let j = lo - 1; j >= from; j--) {
    const trip = patternTrips[j]!;
    if (day.activeTrip[trip] !== 1) continue;
    if (tripFilter !== undefined && !tripFilter(trip)) continue;
    const arr = day.baseEpoch
      + ix.arrivalTime[ix.tripTimeOffset[trip]! + pos]! + delay[trip]!;
    return { tripIdx: trip, patternPos: j, arriveEpoch: arr };
  }
  return null;
}

/**
 * Reverse mirror of `relaxFootpaths` in `raptor.ts`: relaxes footpaths once,
 * from a fixed list of (stop, label) pairs, writing newly-improved walk
 * labels into `target` and appending improved stops to `marked`.
 *
 * Direction flip: a forward walk ADDS footpath seconds to an arrival: "if you
 * can be at `s` by `label.arrivalEpoch`, you can be at `t` by
 * `arrivalEpoch + footSeconds`." A reverse walk SUBTRACTS them from a
 * deadline: "if you must depart `s` no later than `label.departureEpoch`,
 * you must depart `t` no later than `departureEpoch - footSeconds`" (earlier,
 * to leave time for the walk).
 *
 * Same snapshot discipline as the forward version: `from` must be a snapshot
 * taken before this call (round 0's own egress labels, or the round's
 * `visited` map), never a live re-read of `target`, or one walk could chain
 * into another and silently double-count/omit the transfer-buffer-free
 * nature of a walk-to-walk hop (excluded by design, same as forward).
 *
 * A walk also replaces a same-round TIE against a transit label, for the
 * identical reason the forward version does: at an exact departure tie, a
 * walk label is weakly dominant for onward alighting because it already
 * carries the boarding buffer, while a transit label still owes
 * `transferMinSeconds` before an earlier trip's arrival can feed it.
 *
 * KNOWN DIRECTIONAL APPROXIMATION -- read this before enabling Valhalla in
 * production.
 *
 * The traveller here walks FROM `t` TO `s` (they must leave `t` early enough
 * to reach `s` by `label.departureEpoch`). The cost this loop subtracts is
 * `ix.footSeconds[i]`, which is the cost of the edge s->t, not t->s. Those
 * are read from `s`'s slice of the footpath arrays, which is the only slice
 * indexable from `s`; the t->s edge exists too, but it lives in `t`'s slice
 * and there is no index from (t, s) to its position.
 *
 * IT IS EXACTLY CORRECT TODAY, for both kinds of edge this index contains:
 *
 *  - straight-line edges are `haversine * DETOUR / speed + transferMin`,
 *    and haversine is symmetric, so dur(s->t) == dur(t->s) identically;
 *  - station-peer edges are a flat `sameStationSeconds + transferMin`
 *    regardless of the pair, so they are symmetric by construction.
 *
 * IT BECOMES WRONG THE MOMENT `buildFootpaths` SOURCES DURATIONS FROM
 * VALHALLA -- which is the intended production configuration. Real
 * pedestrian routing is NOT symmetric: one-way stairs, a footbridge
 * reachable from one side only, and any elevation-aware costing all produce
 * dur(s->t) != dur(t->s). This loop would then charge the wrong direction's
 * duration, and the reverse search would return departures that are a little
 * too early or a little too late on exactly those pairs. The error is
 * bounded by the asymmetry of a single sub-`WALK_MAX_METERS` walk, so it is
 * a small inaccuracy rather than a broken answer -- but it is a real one,
 * and it is silent.
 *
 * The correct fix is a reverse footpath index: a second CSR structure keyed
 * by TARGET, so `t`'s incoming edges (and therefore the t->s duration) are
 * addressable from `s`. That is a genuine index to build, size and keep in
 * step with the forward one on every rebuild, not a local change, so it is
 * deliberately NOT done here. Do it as part of enabling Valhalla, and delete
 * this comment when it lands.
 */
function relaxFootpathsReverse(
  ix: TimetableIndex, from: readonly { stop: number; label: ReverseLabel }[],
  best: Float64Array, target: (ReverseLabel | null)[], marked: number[],
): void {
  for (const { stop: s, label } of from) {
    const foFrom = ix.footOffset[s]!;
    const foTo = ix.footOffset[s + 1]!;
    for (let i = foFrom; i < foTo; i++) {
      const t = ix.footTarget[i]!;
      const dep = label.departureEpoch - ix.footSeconds[i]!;
      const bestAtT = best[t]!;
      // Invariant mirrors the forward version: best[t] is finite only when
      // target[t] already holds a ReverseLabel recording that exact
      // departure, so `target[t]!` below is safe whenever the tie branch is
      // reached.
      const improves = dep > bestAtT;
      const upgradesTie = dep === bestAtT && target[t]!.kind === "transit";
      if (improves || upgradesTie) {
        best[t] = dep;
        target[t] = {
          departureEpoch: dep, kind: "walk", toStop: s,
          tripIdx: -1, dayIdx: -1, patternPos: -1,
          alightStop: -1, alightEpoch: label.departureEpoch,
          predecessor: label,
        };
        marked.push(t);
      }
    }
  }
}

/**
 * The boarding a rider alighting onto this label still has to catch -- the
 * one whose headway the margin is measured against -- or `null` when the
 * label boards nothing more.
 *
 * This is the reverse mirror of `raptor.ts`'s `arrivedOnVehicle`, and it
 * points the other way for a reason worth stating plainly. Forward asks a
 * label "have you already ridden something?", because the margin insures
 * against a LATE INCOMING VEHICLE and the answer lives in the label's PAST.
 * Reverse already knows the answer to that question -- it is only ever asked
 * while an incoming vehicle is being matched, which is what makes the
 * journey's own initial boarding exempt without a separate test (nothing
 * ever alights into it, so no deadline is ever computed against it).
 * What reverse does not know, and has to look up, is WHICH service the rider
 * is transferring TO, and that lives in the label's FUTURE.
 *
 * Reading one link of the chain is enough, and exact, for the same reason the
 * forward version gives: a walk label's predecessor is never itself a walk.
 * `relaxFootpathsReverse` is only ever sourced from a snapshot of round-0
 * EGRESS labels or from a round's `visited` TRANSIT labels, and its doc
 * comment explains why chaining two walks is excluded by design. If that ever
 * changed, silently returning `null` here would stop charging the margin --
 * making boarding EASIER, the one direction this feature may never be wrong
 * in -- so the impossible case throws instead of being assumed away.
 */
function onwardBoarding(label: ReverseLabel): ReverseLabel | null {
  if (label.kind === "transit") return label;
  // Egress: the journey ends on foot at the destination. Nothing is boarded,
  // so there is no vehicle to miss and no margin to owe.
  if (label.kind === "egress") return null;
  const next = label.predecessor;
  if (next === null || next.kind === "egress") return null;
  if (next.kind !== "transit") {
    throw new Error("runRaptorReverse: a walk label's predecessor is itself a walk");
  }
  return next;
}

/**
 * Do these two trips of the same pattern depart identically at every
 * position? Used only to decide whether `a` counts as a LAST SERVICE
 * alongside `b` (see `lastTripsOnDay`); `patternLength` is `b`'s pattern's
 * stop count, which is `a`'s too since they share a pattern.
 *
 * Pattern order guarantees `a <= b` pointwise when `a` precedes `b` in
 * `patternTrips`, so equality here is exactly "b does not depart later than
 * a anywhere" -- the only thing the last-service test needs to know.
 */
function sameDeparturesEverywhere(
  ix: TimetableIndex, a: number, b: number, patternLength: number,
  delay: Int32Array,
): boolean {
  const fromA = ix.tripTimeOffset[a]!;
  const fromB = ix.tripTimeOffset[b]!;
  const da = delay[a]!;
  const db = delay[b]!;
  for (let i = 0; i < patternLength; i++) {
    if (ix.departureTime[fromA + i]! + da !== ix.departureTime[fromB + i]! + db) return false;
  }
  return true;
}

/**
 * The trips of pattern `p` that are a LAST SERVICE on `day` -- active,
 * accepted by `tripFilter`, and departing no earlier than every other such
 * trip at every position along the pattern. Answers "the pattern has no
 * later trip on that service day" for the ONWARD service a rider
 * is transferring to.
 *
 * Almost always a single trip: the day's last departure. It is a set, not a
 * trip, because a feed may hold two trips of one pattern with identical
 * times, and both of them are then equally the last service -- pinning only
 * the higher-indexed one would charge a full margin to a rider boarding the
 * other, which the forward pass (whose test is "does anything depart at or
 * after `ready`", not "is this the highest-indexed trip") would not.
 *
 * Deliberately POSITION-INDEPENDENT, which is what lets reverse ask the
 * question at all: reverse knows which trip the rider boards onward but not,
 * cheaply, which position of its pattern they board it at (a loop pattern
 * visits a stop more than once). It does not need to. Trips within a pattern
 * never overtake, so a trip that departs later at any position departs no
 * earlier at every position, and "nothing runs later on this pattern today"
 * has the same answer wherever the rider boards.
 *
 * "Today" is load-bearing and easy to skim past: `day` is ONE `DayContext`,
 * so this answers "no later trip on THIS service day", never "no later trip
 * anywhere". A pattern running at 24:30 on the previous service day and
 * again at 08:00 on the current one is a last service on the previous day's
 * context, and the fallback fires there. Conservative (the flat rule is the
 * floor) and unavoidable without comparing trips across service days, which
 * `latestTripOnDay` refuses for ordering reasons -- but it means the margin
 * is silently inert for such patterns in the post-midnight window.
 */
function lastTripsOnDay(
  ix: TimetableIndex, p: number, day: DayContext,
  tripFilter: ((t: number) => boolean) | undefined,
  patternTrips: Int32Array, delay: Int32Array,
): Set<number> {
  const from = ix.patternTripOffset[p]!;
  const to = ix.patternTripOffset[p + 1]!;
  const length = ix.patternStopOffset[p + 1]! - ix.patternStopOffset[p]!;

  const out = new Set<number>();
  let last = -1;
  for (let j = to - 1; j >= from; j--) {
    const trip = patternTrips[j]!;
    if (day.activeTrip[trip] !== 1) continue;
    if (tripFilter !== undefined && !tripFilter(trip)) continue;
    if (last < 0) { last = trip; out.add(trip); continue; }
    // Walking backward, the first trip that departs EARLIER than the last
    // one anywhere ends the run -- and so does every trip before it, by
    // pattern order.
    if (!sameDeparturesEverywhere(ix, trip, last, length, delay)) break;
    out.add(trip);
  }
  return out;
}

/**
 * The seconds of margin `q.transfer` demands ON TOP of what the deadline
 * already subtracts, for a rider alighting a vehicle and connecting onto
 * `patternIdx`, which departs at `departEpoch` on `days[dayIdx]`.
 *
 * The physical rule is one statement, and both passes have to satisfy the
 * same one: a rider READY to board at instant `b` may take a departure at `D`
 * only when `b + extra(pattern, hour(b)) <= D`. Forward is handed `b` (it is
 * the arrival plus the base buffer) and evaluates the rule pointwise.
 * Reverse is handed `D` and has to produce the latest `b` -- so it cannot
 * read `hour(b)` off anything, because `b` is what it is being asked for.
 *
 * `extra` is a step function of that hour, and the step can go DOWN as `b`
 * gets later (a sparse hour followed by a frequent one), so the constraint is
 * not monotone in `b` and cannot simply be inverted. What is true is that the
 * margin can only ever bind within `capSeconds - baseSeconds` of `D`: a
 * readiness instant further back than that already has more slack than the
 * rule can demand even at its ceiling. So this charges the largest margin any
 * hour that window touches can demand, which
 *
 *  - is EXACT whenever the window sits inside a single hour, which is the
 *    overwhelmingly common case (the window is 540 s wide at the shipped
 *    defaults, so it takes an interchange landing within nine minutes of an
 *    hour boundary, with materially different frequency on each side of it,
 *    to be anything else); and
 *  - errs CONSERVATIVELY otherwise -- charging the sparse hour's margin to a
 *    connection that would have landed in the frequent one. Boarding gets
 *    harder, never easier, which is the invariant this whole feature rests
 *    on, and this margin scheme already accepts exactly this class of
 *    bucketing loss.
 *
 * Three properties carried over from the forward pass's
 * `extraBoardingSeconds`, all still load-bearing:
 *
 * 1. It is never negative -- `Math.max(0, ...)` is what guarantees that, not
 *    `requiredTransferSeconds`, whose clamp applies the cap LAST and so
 *    genuinely returns below `baseSeconds` when `capSeconds < baseSeconds`.
 *    `runRaptorReverse` refuses that `cfg` at entry and this floor is the
 *    last line of defence.
 * 2. It does not depend on which trip is alighted -- only on (pattern of the
 *    onward service, hour, service day). Deriving it from the trip found
 *    would be circular, exactly as it would be for the forward pass's margin.
 * 3. The hours come from service-day seconds of the ONWARD service's own day,
 *    never from wall clock -- which is why `days[dayIdx].baseEpoch` is
 *    subtracted, and why `dayIdx` is the onward label's day rather than the
 *    day of the trip currently being scanned. Those differ whenever a
 *    connection crosses a service-day boundary, and "yesterday at 25:30" and
 *    "today at 01:30" are different rows of different tables.
 *
 * EXPORTED, and reused verbatim by `routes/plan.ts`'s `requiredMarginFor`,
 * for a reason worth stating: an `arriveBy` itinerary (and any `departAfter`
 * one `reoptimise.ts` swapped onto a reverse-pass chain) was built by THIS
 * pass, which charges THIS window-maximum rule at each alighting -- not the
 * forward pass's pointwise `extraBoardingSeconds`. `computeTransferAtRisk`
 * has to compare a live prediction against the SAME rule the search that
 * produced the itinerary actually used, or its verdict can disagree with
 * that search (see that function's own doc comment for the concrete case
 * this was found from). Re-deriving this rule in `plan.ts` instead of
 * importing it would let the two drift the way `validateTransferContract`'s
 * own doc comment warns a duplicated invariant always eventually does.
 */
export function extraAlightingSeconds(
  ix: TimetableIndex,
  transfer: NonNullable<ReverseQuery["transfer"]>, days: readonly DayContext[],
  patternIdx: number, patternPos: number, dayIdx: number, departEpoch: number,
): number {
  // `dayIdx` was written by this pass from its own `q.days` loop index, and
  // `runRaptorReverse` refuses a query whose `headway` is not exactly
  // parallel to `days`, so both entries exist.
  const table = transfer.headway[dayIdx]!;
  const day = days[dayIdx]!;
  const cfg = transfer.cfg;

  // Widest margin the rule can demand anywhere; `cfg.capSeconds >=
  // cfg.baseSeconds` is validated at entry, so this is non-negative.
  const widest = cfg.capSeconds - cfg.baseSeconds;
  // Shifted back to first-stop time before ANY bucketing: the table is keyed
  // on the hour of a pattern's departure from its first stop, and this
  // boarding is `patternTravelOffset` seconds downstream of it. The whole
  // readiness window moves with it, so the shift belongs here, once, ahead of
  // both bucket bounds -- see `patternTravelOffset`.
  const latest = departEpoch - day.baseEpoch - patternTravelOffset(ix, patternIdx, patternPos);
  const hFrom = Math.floor((latest - widest) / 3600); // never modulo a GTFS time
  const hTo = Math.floor(latest / 3600);

  let required = 0;
  for (let h = hFrom; h <= hTo; h++) {
    // Probing at the top of hour `h`: `headwayFor` buckets by
    // `floor(seconds / 3600)`, and out-of-range hours (this loop can reach
    // hour -1, when the readiness window opens before the onward service
    // day's own origin) report no measurement and take the cap, which is the
    // conservative answer and the same one the forward pass gets there.
    const r = requiredTransferSeconds(headwayFor(table, patternIdx, h * 3600), cfg);
    if (r > required) required = r;
  }
  return Math.max(0, required - cfg.baseSeconds);
}

/**
 * Forward RAPTOR with every comparison flipped: labels carry the latest
 * feasible departure, patterns are walked from a marked position backward
 * toward the start, and `best` is maximised rather than minimised. It reads
 * the same index arrays as the forward pass and allocates no additional
 * index or memory -- the reason RAPTOR was chosen over CSA for `arriveBy`.
 *
 * A KNOWN LIMITATION mirroring the forward pass's hour-bucketing
 * approximation -- read this before trusting an `arriveBy`
 * departure to be the latest one that exists.
 *
 * The forward pass stores one label per stop and loses nothing by it: the
 * margin a label owes is charged at the BOARDING, from the pattern being
 * boarded, so a label's usefulness is fully described by its arrival and
 * kind, and an earlier arrival dominates (the hour-boundary
 * exception aside). Reverse has no such luck. The margin an incoming vehicle
 * owes depends on which service the stored label goes on to BOARD, so two
 * labels at one stop are no longer ranked by departure alone -- and this pass
 * keeps only the latest-departing one.
 *
 * Worked example. At stop X, service P1 departs 1000 with no margin and P2
 * departs 1100 with a 600 s one; both reach the destination in time. This
 * pass keeps P2 (it departs later), so an incoming vehicle must arrive by
 * 1100 - 60 - 600 = 440. Via P1 it could have arrived by 940, and the forward
 * pass finds exactly that journey. The `arriveBy` answer is therefore a
 * departure that is too EARLY -- never one that is too late.
 *
 * That direction is the whole point: every journey this pass returns
 * genuinely satisfies the margin rule, so the planner is never optimistic
 * about a connection. Fixing it properly means ranking labels by a pair
 * (departure, and the deadline that departure imposes on a feeder), which
 * multiplies the label state exactly as the forward pass's equivalent fix
 * would. It is accepted on the same terms, and it is why the differential harness in
 * `raptorReverse.oracle.test.ts` proves consistency rather than optimality
 * once the factor is non-zero.
 */
export function runRaptorReverse(ix: TimetableIndex, q: ReverseQuery): ReverseResult {
  // The same contract `runRaptor` enforces, enforced by the same function:
  // a caller that gets it wrong must be refused identically by both passes,
  // or the two directions disagree about which queries are even legal.
  if (q.transfer !== undefined) {
    validateTransferContract(
      "runRaptorReverse", q.transfer.cfg, q.transfer.headway, q.days, q.transferMinSeconds,
    );
  }
  // Hoisted out of the round loop, exactly as the forward pass does it:
  // resolving the off switch to a single value here keeps the innermost
  // alighting check to one test.
  const transfer = q.transfer !== undefined && q.transfer.cfg.factor !== 0 ? q.transfer : null;

  // Memoised `lastTripsOnDay`, keyed by (day, pattern). The last-service test
  // is asked once per alighting check against a headway-scaled margin, which is
  // the innermost loop in this file; the answer depends only on the pattern,
  // the service day and `q.tripFilter`, all fixed for the whole query. Never
  // touched at `factor === 0` (`transfer` is null there), so the off switch
  // pays nothing for it and stays byte-exact.
  const lastTripCache = new Map<number, Set<number>>();
  const lastTripsFor = (dayIdx: number, p: number): Set<number> => {
    const key = dayIdx * ix.nPatterns + p;
    const cached = lastTripCache.get(key);
    if (cached !== undefined) return cached;
    // `dayIdx` came off a label this pass wrote from its own `q.days` loop
    // index, so it indexes `q.days`.
    const dayShift = q.shift?.[dayIdx];
    const built = lastTripsOnDay(
      ix, p, q.days[dayIdx]!, q.tripFilter,
      dayShift?.patternTrips ?? ix.patternTrips, dayShift?.delay ?? zeroDelay(ix.nTrips));
    lastTripCache.set(key, built);
    return built;
  };

  const best = new Float64Array(ix.nStops).fill(-Infinity);
  const rounds: (ReverseLabel | null)[][] = [];

  const round0: (ReverseLabel | null)[] = new Array<ReverseLabel | null>(ix.nStops).fill(null);
  rounds.push(round0);

  let marked: number[] = [];
  for (const dest of q.destinations) {
    const t = q.arriveByEpoch - dest.secondsToReach;
    if (t > best[dest.stopIdx]!) {
      best[dest.stopIdx] = t;
      round0[dest.stopIdx] = {
        departureEpoch: t, kind: "egress", toStop: -1,
        tripIdx: -1, dayIdx: -1, patternPos: -1, alightStop: -1, alightEpoch: t,
        predecessor: null,
      };
      marked.push(dest.stopIdx);
    }
  }

  // Footpaths are also relaxed from round 0's own egress labels, once,
  // before round 1 builds its pattern queue -- otherwise a journey could
  // never END with a walk to the destination (e.g. the useful alighting stop
  // is a footpath away from the destination's egress point, not the egress
  // point itself), mirroring the forward pass's round-0 relaxation exactly.
  const round0Snapshot = marked
    .map((s) => ({ stop: s, label: round0[s] }))
    .filter((x): x is { stop: number; label: ReverseLabel } => x.label !== null && x.label !== undefined);
  relaxFootpathsReverse(ix, round0Snapshot, best, round0, marked);

  // Lower bound on any useful departure: nothing departing earlier than the
  // best known origin departure can improve it. Updated as rounds run.
  const originBound = (): number => {
    let bound = -Infinity;
    for (const o of q.origins) {
      const v = best[o.stopIdx]! - o.secondsToReach;
      if (v > bound) bound = v;
    }
    return bound;
  };

  for (let k = 1; k <= q.maxRounds && marked.length > 0; k++) {
    const prev = rounds[k - 1]!;
    // Carried forward, not reset to null -- round k means "reachable in AT
    // MOST k trips," the same invariant the forward pass relies on.
    const cur: (ReverseLabel | null)[] = prev.slice();
    rounds.push(cur);

    // Queue each pattern once, at the LATEST marked position on it (the
    // mirror of the forward pass queuing at the earliest).
    const queue = new Map<number, number>();
    for (const s of marked) {
      const from = ix.stopPatternOffset[s]!;
      const to = ix.stopPatternOffset[s + 1]!;
      for (let i = from; i < to; i++) {
        const p = ix.stopPatterns[i]!;
        const pos = ix.stopPatternPos[i]!;
        const existing = queue.get(p);
        if (existing === undefined || pos > existing) queue.set(p, pos);
      }
    }
    marked = [];

    // Every stop visited this round while a trip was held, whether or not
    // the visit beat that stop's all-time best -- mirrors the forward
    // pass's `visited` map exactly, including why it exists: footpath
    // sourcing below reads from here (deduped to one best-per-stop), not
    // from `marked` or a live re-read of `cur`, so a walk can never chain
    // onto another walk within the same round.
    const visited = new Map<number, ReverseLabel>();

    const bound = originBound();

    for (const [p, startPos] of queue) {
      const stopFrom = ix.patternStopOffset[p]!;

      // Traversed once per DayContext, holding a trip from that day only --
      // the mirror of the forward pass's per-day traversal, for the same
      // reason: the pattern-local index comparison below is only valid
      // within one day's calendar.
      for (let d = 0; d < q.days.length; d++) {
        const day = q.days[d]!;
        // This service day's live view, or the schedule when none was given.
        // See `RaptorQuery.shift` in `raptor.ts` for why this is per day.
        const dayShift = q.shift?.[d];
        const delay = dayShift?.delay ?? zeroDelay(ix.nTrips);
        const patternTrips = dayShift?.patternTrips ?? ix.patternTrips;

        let tripIdx = -1;
        // Position of the held trip within patternTrips ("pattern-local
        // index"); -1 sentinel means "no trip held yet". Comparing by this
        // index, preferring the LARGER one, is what correctly resolves an
        // exact arrival tie in reverse: pattern order guarantees a
        // later-indexed trip is pointwise >= an earlier one (in both
        // departure and arrival), so on a tie the later index is never
        // worse and may depart strictly later further back along the
        // pattern.
        let heldPos = -1;
        let alightStop = -1;
        let alightEpoch = 0;
        // The exact ReverseLabel read from `prev[alightStop]` at the moment
        // the currently-held trip was matched -- captured directly so every
        // label built while this trip is held can point its `predecessor`
        // at it.
        let alightLabel: ReverseLabel | null = null;

        for (let i = startPos; i >= 0; i--) {
          const s = ix.patternStops[stopFrom + i]!;
          if (s < 0) continue;

          if (tripIdx >= 0) {
            const dep = day.baseEpoch
              + ix.departureTime[ix.tripTimeOffset[tripIdx]! + i]! + delay[tripIdx]!;
            // Gate the visit on `bound` before recording, same as forward:
            // a visit that could never help reach an origin in time can't
            // help via a footpath either (time only ever decreases going
            // backward from here).
            if (dep > bound) {
              const visitLabel: ReverseLabel = {
                departureEpoch: dep, kind: "transit", toStop: alightStop,
                tripIdx, dayIdx: d, patternPos: i,
                alightStop, alightEpoch, predecessor: alightLabel,
              };
              const existing = visited.get(s);
              if (existing === undefined || dep > existing.departureEpoch) {
                visited.set(s, visitLabel);
              }
              if (dep > best[s]!) {
                best[s] = dep;
                cur[s] = visitLabel;
                marked.push(s);
              }
            }
          }

          // Could a later trip be alighted here than the one being held?
          const label = prev[s];
          if (label === null || label === undefined) continue;
          const currentArr = tripIdx >= 0
            ? day.baseEpoch
              + ix.arrivalTime[ix.tripTimeOffset[tripIdx]! + i]! + delay[tripIdx]!
            : -Infinity;
          // A walk label's seconds already include the boarding buffer, so
          // the buffer is subtracted only when the adjacent label is
          // transit-kind (the mirror of the forward rule, direction flipped:
          // there it's added to a readiness, here it's subtracted from a
          // deadline).
          const buffered = label.departureEpoch
            - (label.kind === "transit" ? q.transferMinSeconds : 0);
          // Gate on the buffer-only deadline BEFORE pricing the margin. The
          // margin is non-negative and only ever moves the deadline earlier,
          // so a label that already cannot beat the held trip's arrival can
          // never beat it once the margin is charged either -- and pricing it
          // means a chain hop plus a table probe per hour of the readiness
          // window. At most positions on a pattern this skips both. It is
          // only an optimisation: the real gate below is unchanged.
          if (buffered < currentArr) continue;

          // The headway-scaled margin, charged HERE and only here. Reaching
          // this line means a vehicle is being matched into `label`, so there
          // is an incoming vehicle that could be late -- which is the whole
          // condition the margin depends on. The journey's own
          // initial boarding is therefore exempt for free: it is the LAST
          // boarding this backward walk reaches, nothing ever alights into
          // it, and no deadline is ever computed against it.
          //
          // The margin belongs to the service being transferred TO, not to
          // the one being alighted (pattern `p`, which is what a
          // pattern-matched mirror of the forward pass would have reached
          // for): what missing this connection costs is a wait for the next
          // departure of the ONWARD service. Across a walk, that boarding is
          // one link further along the chain -- see `onwardBoarding`. The
          // margin is charged for BOTH label kinds, mirroring forward, where
          // it is added to both: a walk carries the base buffer, never the
          // headway-scaled part.
          let extra = 0;
          if (transfer !== null) {
            const onward = onwardBoarding(label);
            if (onward !== null) {
              // `onward` is transit-kind, so its `tripIdx` is a real trip.
              const onwardPattern = ix.patternOfTrip[onward.tripIdx]!;
              // The margin yields at the last service of the
              // day. When nothing runs later on the onward pattern that
              // service day, refusing the connection does not move the rider
              // to a later trip -- it deletes the journey -- so the rule
              // charges the flat base buffer alone, exactly the pre-branch
              // requirement. `plan.ts` flags the result through
              // `transferAtRisk`.
              //
              // NOT an exact mirror of the forward test, and it does not
              // need to be: forward asks "does anything on this
              // pattern depart this position at or after `ready`", and
              // `ready` is the instant reverse is solving for. "Nothing
              // departs later at all" is a SUFFICIENT condition for
              // forward's -- so reverse applies the fallback only where
              // forward certainly would, and errs by charging the full
              // margin where forward might have yielded. That is the
              // conservative direction this pass is already committed to:
              // a departure reported too early, never too late.
              if (!lastTripsFor(onward.dayIdx, onwardPattern).has(onward.tripIdx)) {
                extra = extraAlightingSeconds(
                  ix, transfer, q.days, onwardPattern, onward.patternPos,
                  onward.dayIdx, onward.departureEpoch,
                );
              }
            }
          }
          const deadline = buffered - extra;

          if (deadline >= currentArr) {
            const found = latestTripOnDay(
              ix, p, i, deadline, day, q.tripFilter, patternTrips, delay);
            if (found !== null && (tripIdx < 0 || found.patternPos > heldPos)) {
              tripIdx = found.tripIdx;
              heldPos = found.patternPos;
              alightStop = s;
              alightEpoch = found.arriveEpoch;
              alightLabel = label;
            }
          }
        }
      }
    }

    // Footpath relaxation, once, from every stop this round's transit scan
    // VISITED -- see `visited` above, and `relaxFootpathsReverse`'s doc
    // comment for why that (and not `marked`, and not a live re-read of
    // `cur`) is the only safe source.
    const visitedList = [...visited].map(([stop, label]) => ({ stop, label }));
    relaxFootpathsReverse(ix, visitedList, best, cur, marked);
  }

  return { rounds };
}
