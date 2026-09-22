import type { TimetableIndex } from "./index.js";
import { zeroDelay, type TimetableShift } from "./shift.js";
import {
  type CalendarRow, activeServiceIds, serviceInstants,
} from "./calendar.js";
import {
  headwayFor, patternTravelOffset, requiredTransferSeconds,
  validateTransferContract, type TransferMargin,
} from "./headway.js";

export interface DayContext {
  dateYmd: number;
  /** Epoch seconds of this service day's time origin (noon − 12 h). */
  baseEpoch: number;
  /** 1 when the trip's service runs on this day. Indexed by trip index. */
  activeTrip: Uint8Array;
}

/**
 * The current service day and the previous one, each with a per-trip active
 * mask. Building the mask once per query costs one pass over 261,634 trips
 * and replaces a service lookup inside the inner loop.
 */
export function buildDayContexts(
  index: TimetableIndex, calendar: readonly CalendarRow[], at: Date, tz: string,
): DayContext[] {
  return serviceInstants(at, tz).map((instant) => {
    const active = activeServiceIds(calendar, instant.dateYmd, tz);
    const activeServiceIdx = new Uint8Array(index.serviceIds.length);
    for (let s = 0; s < index.serviceIds.length; s++) {
      if (active.has(index.serviceIds[s]!)) activeServiceIdx[s] = 1;
    }
    const activeTrip = new Uint8Array(index.nTrips);
    for (let t = 0; t < index.nTrips; t++) {
      const s = index.tripServiceIdx[t]!;
      if (s >= 0 && activeServiceIdx[s] === 1) activeTrip[t] = 1;
    }
    return { dateYmd: instant.dateYmd, baseEpoch: instant.baseEpoch, activeTrip };
  });
}

export interface Label {
  arrivalEpoch: number;
  kind: "access" | "transit" | "walk";
  /** Stop this label was reached from; -1 for access. Kept for readability
   * and debugging only -- see `predecessor` below for what reconstruction
   * must actually follow. */
  fromStop: number;
  tripIdx: number;
  dayIdx: number;
  boardStop: number;
  boardEpoch: number;
  /**
   * Direct reference to the exact `Label` object this label was extended
   * from -- by boarding a trip (transit labels) or by walking a footpath
   * (walk labels) -- at the moment this label was created. `null` for access
   * labels, which start a journey with no predecessor.
   *
   * This is the ONLY field itinerary reconstruction may use to walk a
   * journey backwards. `fromStop` (plus `rounds[k][fromStop]`) looks like an
   * equivalent way to find the predecessor, but it is not: `rounds[k]` is a
   * live, mutable array while a round is still being computed (transit
   * arrivals and footpath relaxations keep overwriting entries at a stop as
   * better labels are found), so a later, unrelated improvement at that same
   * stop can silently replace the very label this one was built from by the
   * time anyone looks it up. `predecessor` pins the exact object instead of
   * re-deriving it from a stop id that may have moved on -- it can never go
   * stale, because object references don't get overwritten out from under
   * you the way array slots do.
   */
  predecessor: Label | null;
}

export interface RaptorAccess {
  stopIdx: number;
  secondsToReach: number;
}

export interface RaptorQuery {
  origins: RaptorAccess[];
  destinations: RaptorAccess[];
  departAfterEpoch: number;
  days: DayContext[];
  /** maxTransfers + 1. */
  maxRounds: number;
  transferMinSeconds: number;
  tripFilter?: (tripIdx: number) => boolean;
  /**
   * Absent, or a zero factor, means today's flat `transferMinSeconds` and
   * nothing else -- every existing caller omits this and must keep behaving
   * exactly as it did.
   *
   * `headway[d]` is the table for `days[d]`, one per DayContext: headway is a
   * property of a service DAY, so "yesterday at 25:30" and "today
   * at 01:30" are different rows of different tables even though they are the
   * same wall-clock instant. `cfg.baseSeconds` must be `transferMinSeconds` --
   * that is the value footpath edges already bake in, and the value the extra
   * margin is measured on top of.
   */
  transfer?: TransferMargin;
  /**
   * "Every one of `origins` is a rider ALREADY ABOARD a vehicle." Absent
   * (the default, and what every `/plan` query passes) means the ordinary
   * rule: an origin is someone standing at a stop, and their first boarding
   * is exempt from the headway margin because there is no
   * incoming vehicle that could be late.
   *
   * `/plan/onboard` is the case where there is one. It seeds one origin per
   * stop the rider's current trip still reaches, timed at that vehicle's own
   * (delay-adjusted) arrival there, so the very next boarding is a
   * connection off a vehicle that can be -- and by then usually is -- late.
   * Left exempt, the margin would be waived on precisely the connection that
   * endpoint exists to protect.
   *
   * QUERY-LEVEL, not per-origin, because the property is a property of the
   * QUERY: every seed of an onboard search shares it by construction, and a
   * search mixing aboard and on-foot origins has no meaning here (a rider is
   * either on the bus or not).
   *
   * It changes the boarding check in TWO places, both below:
   *
   *  1. `arrivedOnVehicle` -- by PROVENANCE, reaching the round-0 access
   *     labels these origins produce and the walk labels round 0 relaxes out
   *     of them, and no other label kind. This is the headway-scaled margin,
   *     and it IS inert at `factor === 0`, because the whole
   *     margin is.
   *  2. the `base` expression -- the FLAT `transferMinSeconds` a transit
   *     label already owes, which an on-vehicle access label owes for the
   *     same physical reason (get off one vehicle, get on another). This one
   *     never consults `transfer` and is therefore **NOT inert at `factor ===
   *     0`**: measured, same network, `factor: 0`, a departure 30 s after the
   *     access instant gives `boardEpoch 4190` without the flag and `4500`
   *     with it.
   *
   * That is correct rather than a leak: the flat buffer IS the pre-headway
   * rule for a transfer, so at `factor === 0` an onboard connection is
   * charged exactly what the pre-headway planner charged every transfer, and
   * no more. `TRANSFER_HEADWAY_FACTOR=0` restores pre-headway behaviour for
   * `/plan`, which never sets this flag at all, byte for byte.
   */
  originsOnVehicle?: boolean;
  /**
   * Live delays, one entry per `days` entry (index-for-index), or absent for a
   * schedule-only search -- which is what a caller with no realtime store does.
   *
   * Parallel to `days` rather than a single shift for the same reason
   * `transfer.headway` is: a delay belongs to a SERVICE DAY. Shifting a trip
   * by today's delay would corrupt its position in the previous-day context
   * `buildDayContexts` also searches for post-midnight queries.
   *
   * An individual entry may be `undefined` (that day has nothing live), which
   * is the ordinary answer for the previous-day context.
   *
   * See `transit/shift.ts` for how one is built and why re-ordering a
   * pattern's trips is enough to keep this file's binary search valid.
   */
  shift?: (TimetableShift | undefined)[];
}

export interface RaptorResult {
  /** rounds[k][stop] is the best label reachable in at most k trips. */
  rounds: (Label | null)[][];
}

/**
 * The earliest trip on pattern `p` boardable at position `pos` no earlier
 * than `readyEpoch`, restricted to a single `day`. Returns the trip's
 * position within `patternTrips` (its "pattern-local index") alongside the
 * trip and its absolute departure.
 *
 * Restricted to one day deliberately: the overtaking-split ordering that
 * makes the binary search valid is a per-service-day-local
 * invariant — trip k's departure at this position is <= trip k+1's *within
 * that same day's calendar*. Two different DayContexts have unrelated
 * absolute departures (a service running "yesterday at 25:30" has nothing in
 * common, ordering-wise, with one running "today at 01:30"), so comparing
 * across days by raw epoch would silently abandon a strictly better trip
 * (see `runRaptor`'s per-day traversal for how results are merged back
 * across days instead — through arrival comparisons, which are always
 * meaningful across days).
 *
 * After the search, the scan skips trips whose service does not run today —
 * about 60% of them on a typical day — so it walks forward a couple of
 * entries on average.
 *
 * `fallbackEpoch` is the last-service fallback rule, folded into this one
 * pass rather than bolted on as a second call. It defaults to `readyEpoch`,
 * which makes this function behave EXACTLY as it always has -- the binary
 * search runs at the same instant, the first qualifying trip is returned
 * immediately, and `fallback` below is never consulted. That default is what
 * every caller without a headway margin (including every caller at
 * `TRANSFER_HEADWAY_FACTOR=0`) gets.
 *
 * When it is passed, and it is always <= `readyEpoch`, the meaning is: "the
 * earliest trip at or after `readyEpoch`, or -- if this pattern has NONE
 * left today -- the earliest one at or after `fallbackEpoch` instead."
 * Refusing every remaining trip does not move a rider to a later one at the
 * last service of the day, it deletes their journey, so the margin yields to
 * the flat buffer there (see the boarding check in `runRaptor` for the full
 * reasoning and the floor this may never go below).
 *
 * Folded in, and not written as `search(ready) ?? search(base)`, for a
 * measured reason: the two-call form costs a SECOND binary search on every
 * boarding check against an exhausted pattern, which is most of them late in
 * the service day, and measured +12.6 ms on the median real-feed query whose
 * answer did not even change. This form still does exactly one binary
 * search. The extra linear work is bounded by the trips departing in
 * [`fallbackEpoch`, `readyEpoch`), a window at most `capSeconds -
 * baseSeconds` wide.
 */
function earliestTripOnDay(
  ix: TimetableIndex, p: number, pos: number, readyEpoch: number,
  day: DayContext, tripFilter: ((t: number) => boolean) | undefined,
  patternTrips: Int32Array, delay: Int32Array,
  fallbackEpoch: number = readyEpoch,
): { tripIdx: number; patternPos: number; departEpoch: number } | null {
  const from = ix.patternTripOffset[p]!;
  const to = ix.patternTripOffset[p + 1]!;
  const target = readyEpoch - day.baseEpoch;
  // The binary search runs at the EARLIER of the two instants, so the scan
  // below sees every trip either of them could accept. With no fallback the
  // two are the same number and this is the original search verbatim.
  const fallbackTarget = fallbackEpoch - day.baseEpoch;

  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const trip = patternTrips[mid]!;
    if (ix.departureTime[ix.tripTimeOffset[trip]! + pos]! + delay[trip]! >= fallbackTarget) hi = mid;
    else lo = mid + 1;
  }

  // The best boarding under the FLAT rule, remembered while looking for one
  // that satisfies the full margin. Only ever returned if the scan runs out
  // without finding the latter.
  let fallback: { tripIdx: number; patternPos: number; departEpoch: number } | null = null;

  for (let j = lo; j < to; j++) {
    const trip = patternTrips[j]!;
    if (day.activeTrip[trip] !== 1) continue;
    if (tripFilter !== undefined && !tripFilter(trip)) continue;
    const depSeconds = ix.departureTime[ix.tripTimeOffset[trip]! + pos]! + delay[trip]!;
    const found = { tripIdx: trip, patternPos: j, departEpoch: day.baseEpoch + depSeconds };
    if (depSeconds >= target) return found;
    // Below the margin but at or above the flat floor: the first such trip
    // is the earliest the fallback could ever offer, and pattern order means
    // no later one can beat it.
    if (fallback === null) fallback = found;
  }
  return fallback;
}

/**
 * Relaxes footpaths once, from a fixed list of (stop, label) pairs, writing
 * newly-improved walk labels into `target` and appending improved stops to
 * `marked`. Shared by the round-0 access relaxation and each round's
 * transit-arrival relaxation below.
 *
 * The caller passes a snapshot taken *before* this call, not a live stop-id
 * list re-read during it: reading `target[s]` live, mid-loop, would let an
 * earlier iteration's walk (which may itself have overwritten `target[s]`
 * for some stop reached from an earlier `s`) feed straight into the next
 * iteration, chaining two walks into one and double-charging the transfer
 * buffer. A walk-to-walk hop is just a longer walk, which the footpath
 * radius deliberately already excludes, so chaining must not happen
 * implicitly here either.
 *
 * A walk also replaces a same-round TIE, not just a strict improvement: at
 * an exact arrival tie, a walk label is USUALLY dominant for onward boarding
 * over a transit label, because footpath seconds already fold in the
 * boarding buffer while a transit arrival still owes `transferMinSeconds`
 * before it can board again. Only ever accepting it when the CURRENTLY
 * stored label is transit-kind (never walk-kind, never access-kind) means
 * a given stop upgrades at most once this way -- transit-to-walk is a
 * one-way, monotone move, so this cannot loop.
 *
 * "Usually", not "always": under a headway-scaled margin, the upgrade is
 * not always safe. The two labels have DIFFERENT candidate boarding instants
 * -- `A` for the walk, `A + transferMinSeconds` for the transit -- which can
 * fall either side of an hour boundary, and the margin is bucketed by hour.
 * With `A = 3599` in an unmeasured hour the walk is charged the cap (ready
 * 4139) while the transit label, whose candidate instant is 3659 in a
 * 60-second hour, is charged nothing (ready 3659): preferring the walk is
 * then strictly worse for onward boarding.
 *
 * This is the SECOND instance of the hour-bucketing approximation -- the
 * first being prune-by-earliest-arrival itself -- and it is accepted on the
 * same terms. Termination is untouched, because the upgrade is still
 * one-way and monotone; the loss is conservative, because the journey that
 * survives still satisfies the margin rule. See `extraBoardingSeconds`'s own
 * comment (and the "KNOWN LIMITATION" test in raptor.test.ts) before
 * "fixing" it.
 */
function relaxFootpaths(
  ix: TimetableIndex, from: readonly { stop: number; label: Label }[],
  best: Float64Array, target: (Label | null)[], marked: number[],
): void {
  for (const { stop: s, label } of from) {
    const foFrom = ix.footOffset[s]!;
    const foTo = ix.footOffset[s + 1]!;
    for (let i = foFrom; i < foTo; i++) {
      const t = ix.footTarget[i]!;
      const arr = label.arrivalEpoch + ix.footSeconds[i]!;
      const bestAtT = best[t]!;
      // Invariant: best[t] is finite only when target[t] already holds a
      // Label recording that exact arrival (every writer of `best` writes
      // the paired label array in the same step), so `target[t]!` below is
      // safe whenever the tie branch is even reached.
      const improves = arr < bestAtT;
      const upgradesTie = arr === bestAtT && target[t]!.kind === "transit";
      if (improves || upgradesTie) {
        best[t] = arr;
        target[t] = {
          arrivalEpoch: arr, kind: "walk", fromStop: s,
          tripIdx: -1, dayIdx: -1, boardStop: -1, boardEpoch: label.arrivalEpoch,
          predecessor: label,
        };
        marked.push(t);
      }
    }
  }
}

/**
 * Has the traveller holding this label already ridden a vehicle? The
 * headway-scaled margin insures against a LATE INCOMING VEHICLE, so it is
 * charged only when there is one; on a journey's first boarding
 * the rider walked from their origin and controls when they leave, and
 * charging them a margin there costs a full headway to insure against
 * nothing.
 *
 * `kind !== "access"` is NOT the test, and getting this wrong is the whole
 * point of the function existing. Round 0 relaxes footpaths from its own
 * access labels, producing WALK labels that have ridden nothing; `cur =
 * prev.slice()` then carries those forward into every later round, so a
 * walk-kind label sitting in `rounds[3]` may still be a rider who has not
 * boarded anything yet. The round index is no help either, for the same
 * reason. Only the label's own provenance answers the question.
 *
 * Reading one link of the chain is enough, and exact: a walk label's
 * predecessor is never itself a walk. `relaxFootpaths` is only ever sourced
 * from a snapshot of round-0 ACCESS labels or from a round's `visited`
 * TRANSIT labels, and its doc comment explains at length why chaining two
 * walks is excluded by design. The comparison is written against `"access"`
 * rather than for `"transit"` so that a future walk-to-walk chain, if one
 * were ever introduced, would fall on the charge-the-margin side -- boarding
 * getting harder is the safe direction to be wrong in here.
 *
 * `originsOnVehicle` (see `RaptorQuery`) inverts the answer for exactly the
 * two label shapes that descend from this query's own origins -- an access
 * label, and a walk label whose predecessor is one -- because for an onboard
 * query those origins ARE riders on a vehicle. It is threaded in rather than
 * read off the label because the fact lives in the QUESTION, not in the
 * label: a round-0 access label is structurally identical whether it was
 * seeded by "I am standing here" or by "my bus reaches here at 08:14", and
 * only the caller knows which. Every other label kind is unaffected: a
 * transit label already answers `true`, and a walk label off a transit one
 * already did too.
 *
 * See also `itinerary.ts`'s `hasRidden`/`hasRiddenReverse`: a second
 * provenance oracle answering the same underlying question -- has this
 * chain's rider boarded a vehicle -- for a different purpose (rejecting
 * walk-only itineraries outright) and by a full chain walk to
 * the access/egress bookend rather than this function's one-link read. The
 * two must keep agreeing; not merged deliberately -- this file's per-round
 * search runs on a hot path where the one-link shortcut above (justified by
 * the walk-never-follows-walk invariant) is worth keeping, and this branch
 * leaves raptor.ts untouched regardless.
 */
function arrivedOnVehicle(label: Label, originsOnVehicle: boolean): boolean {
  if (label.kind === "transit") return true;
  if (label.kind !== "walk") return originsOnVehicle; // access: nothing ridden yet, unless aboard
  const from = label.predecessor;
  if (from === null) return false;
  return from.kind !== "access" || originsOnVehicle;
}

/**
 * The seconds of margin `q.transfer` demands ON TOP of what the boarding
 * check already charges -- `required(headway) - cfg.baseSeconds`, floored at
 * zero -- for boarding `patternIdx` at a candidate instant `secondsIntoDay`
 * seconds into the service day being searched.
 *
 * Three properties this must keep, all of them load-bearing:
 *
 * 1. **It is never negative, and `Math.max(0, ...)` is what guarantees
 *    that.** `requiredTransferSeconds` is not itself belt-and-braces here:
 *    its clamp applies the cap LAST, so
 *    `capSeconds < baseSeconds` makes it return `capSeconds`, i.e. below the
 *    base. `config.ts` refuses that combination at boot and `runRaptor`
 *    checks `cfg.baseSeconds === q.transferMinSeconds`, but the floor below
 *    is the last line of defence and must stay.
 *
 *    It has to hold, because boarding may only ever get HARDER. The
 *    dominance argument at the top of this file (a walk label may replace a
 *    transit label at an exact arrival tie, because footpath seconds already
 *    fold in the boarding buffer) survives exactly because a label can only
 *    ever gain a non-negative term and never lose one; that argument is what
 *    makes the footpath phase terminate.
 *
 * 2. **It does not depend on which trip is boarded** -- only on (pattern,
 *    hour, service day). Deriving it from the trip actually found would be
 *    circular: a larger margin pushes the search to a later trip, whose
 *    headway may differ, which changes the margin.
 *
 * 3. **The hour comes from the candidate boarding instant**, in service-day
 *    seconds, never from wall-clock time -- which is why the caller passes
 *    `base - day.baseEpoch` and not `base`.
 *
 * 4. **It is charged only to a traveller who has already ridden something**
 *    -- see `arrivedOnVehicle` above.
 *
 * Because the margin steps at each hour boundary, a LATER arrival can demand
 * a SMALLER margin, so this file's prune-by-earliest-arrival is no longer a
 * true dominance relation. This is accepted deliberately, and the cost is
 * stated honestly: the penalty is NOT bounded by `capSeconds -
 * baseSeconds` (that bounds the readiness delta only) but by a full headway
 * of arrival, compounding across later legs. It errs only conservatively --
 * every journey returned genuinely satisfies the rule -- and
 * `raptor.test.ts`'s "KNOWN LIMITATION" test pins a worked
 * counterexample so nobody "fixes" it without reading this comment first.
 * That test covers the arrival-pruning instance; `relaxFootpaths` above documents a
 * second, distinct instance at the walk-wins-a-tie site.
 *
 * A zero factor short-circuits inside `requiredTransferSeconds`, but is
 * checked here too so that the off switch costs nothing in the inner loop.
 */
function extraBoardingSeconds(
  ix: TimetableIndex, transfer: NonNullable<RaptorQuery["transfer"]>,
  patternIdx: number, patternPos: number, dayIdx: number, secondsIntoDay: number,
): number {
  // `dayIdx` indexes `q.days`, and `runRaptor` refuses a query whose
  // `headway` is not exactly parallel to it, so this entry exists. Silently
  // falling back to the flat buffer on a length mismatch was the other
  // option and is worse: it would disable the feature for some service days
  // and leave no trace, which is precisely how this file's past defects hid.
  const table = transfer.headway[dayIdx]!;
  // Shifted back to first-stop time before the lookup -- the table is keyed
  // on the hour of a pattern's departure from its FIRST stop, and this rider
  // is boarding `patternTravelOffset` seconds downstream of that. See
  // `patternTravelOffset`; omitting it charged the wrong hour's margin on
  // 14.8% of this feed's departures.
  const required = requiredTransferSeconds(
    headwayFor(table, patternIdx, secondsIntoDay - patternTravelOffset(ix, patternIdx, patternPos)),
    transfer.cfg,
  );
  return Math.max(0, required - transfer.cfg.baseSeconds);
}

export function runRaptor(ix: TimetableIndex, q: RaptorQuery): RaptorResult {
  // The `transfer` contract, in one place shared with `runRaptorReverse` so
  // the two passes cannot drift into refusing callers on different terms --
  // see `validateTransferContract` for why each check exists.
  if (q.transfer !== undefined) {
    validateTransferContract(
      "runRaptor", q.transfer.cfg, q.transfer.headway, q.days, q.transferMinSeconds,
    );
  }
  // Hoisted out of the round loop: `q.transfer` is read on the innermost
  // boarding check, once per (pattern, position, day, label), and resolving
  // the off switch to a single boolean here keeps that path to one test.
  const transfer = q.transfer !== undefined && q.transfer.cfg.factor !== 0 ? q.transfer : null;
  // Resolved once here for the same reason `transfer` is: it is read on the
  // innermost boarding check. `?? false` is the ordinary `/plan` answer, so
  // an omitted flag makes this byte-for-byte `arrivedOnVehicle(label, false)`.
  const originsOnVehicle = q.originsOnVehicle ?? false;

  const best = new Float64Array(ix.nStops).fill(Infinity);
  const rounds: (Label | null)[][] = [];

  const round0: (Label | null)[] = new Array<Label | null>(ix.nStops).fill(null);
  rounds.push(round0);

  let marked: number[] = [];
  for (const origin of q.origins) {
    const t = q.departAfterEpoch + origin.secondsToReach;
    if (t < best[origin.stopIdx]!) {
      best[origin.stopIdx] = t;
      round0[origin.stopIdx] = {
        arrivalEpoch: t, kind: "access", fromStop: -1,
        tripIdx: -1, dayIdx: -1, boardStop: -1, boardEpoch: t,
        predecessor: null,
      };
      marked.push(origin.stopIdx);
    }
  }

  // Footpaths are also relaxed from round 0's own access labels, once, before
  // round 1 builds its pattern queue -- otherwise a journey could never begin
  // with a walk (e.g. the useful boarding stop is a footpath away from the
  // nearest origin access point, not the access point itself), and a stop
  // whose access time beats every transit arrival there would never
  // propagate a label at all.
  const round0Snapshot = marked
    .map((s) => ({ stop: s, label: round0[s] }))
    .filter((x): x is { stop: number; label: Label } => x.label !== null && x.label !== undefined);
  relaxFootpaths(ix, round0Snapshot, best, round0, marked);

  // Upper bound on any useful arrival: nothing arriving later than the best
  // known journey to the destination can improve it. Updated as rounds run.
  const targetBound = (): number => {
    let bound = Infinity;
    for (const d of q.destinations) {
      const v = best[d.stopIdx]! + d.secondsToReach;
      if (v < bound) bound = v;
    }
    return bound;
  };

  for (let k = 1; k <= q.maxRounds && marked.length > 0; k++) {
    const prev = rounds[k - 1]!;
    // Carried forward, not reset to null. Round k means "reachable in AT MOST
    // k trips", so a stop reached in round 1 and not improved since must still
    // be boardable from in round 3. Starting each round empty would silently
    // drop every journey whose transfer point was last improved earlier.
    const cur: (Label | null)[] = prev.slice();
    rounds.push(cur);

    // Queue each pattern once, at the earliest marked position on it.
    const queue = new Map<number, number>();
    for (const s of marked) {
      const from = ix.stopPatternOffset[s]!;
      const to = ix.stopPatternOffset[s + 1]!;
      for (let i = from; i < to; i++) {
        const p = ix.stopPatterns[i]!;
        const pos = ix.stopPatternPos[i]!;
        const existing = queue.get(p);
        if (existing === undefined || pos < existing) queue.set(p, pos);
      }
    }
    marked = [];

    // Every stop visited this round while a trip was held, whether or not the
    // visit beat that stop's all-time best -- unlike `marked`, which only
    // gets stops that DID improve on it. A visit that doesn't set a new best
    // still legitimately passed through that stop, and can still offer a
    // useful footpath onward (e.g. a loop pattern re-visiting a stop already
    // reached more cheaply by an earlier round or an access leg): the single
    // best-label-per-stop model must not let a cheaper unrelated label at a
    // stop erase the fact that a transit vehicle stopped there too. Footpath
    // sourcing below reads from this map, not from `marked`, so that case
    // still gets its one non-chained walk; `marked` itself is untouched and
    // still governs only actual improvements (what seeds next round's queue).
    //
    // Keyed by stop and kept to a single (best-arrival) entry per stop: a
    // pattern can visit the same stop many times a round (loop routes,
    // multiple days, multiple patterns through one stop), and only the best
    // of those visits can ever produce the best onward walk, so carrying the
    // others forward here would be pure waste -- measured at 6.5x redundant
    // (190,479 entries for 29,080 unique stops in one round) against the
    // real feed before this dedupe.
    const visited = new Map<number, Label>();

    const bound = targetBound();

    for (const [p, startPos] of queue) {
      const stopFrom = ix.patternStopOffset[p]!;
      const stopTo = ix.patternStopOffset[p + 1]!;
      const length = stopTo - stopFrom;

      // Traversed once per DayContext, holding a trip from that day only.
      // The overtaking-split ordering that makes the binary search valid is
      // per-service-day-local (see earliestTripOnDay), so a trip held from
      // one day can only ever be compared, position-for-position, against
      // other trips *of that same day*. Results from different days merge
      // correctly through the shared best/cur arrays below, because those
      // compare ARRIVALS, and comparing arrivals across days is legitimate
      // (an arrival is just an absolute epoch, regardless of which
      // calendar day produced it).
      for (let d = 0; d < q.days.length; d++) {
        const day = q.days[d]!;
        // The live view of this service day's timetable, or the schedule when
        // no shift was supplied for it. Both are plain arrays, so the reads
        // below cost one extra indexed load and an add -- the zero-filled
        // fallback means the no-realtime path is arithmetically identical to
        // the schedule-only computation, with no branch in the innermost loop.
        const dayShift = q.shift?.[d];
        const delay = dayShift?.delay ?? zeroDelay(ix.nTrips);
        const patternTrips = dayShift?.patternTrips ?? ix.patternTrips;

        let tripIdx = -1;
        // Position of the held trip within patternTrips ("pattern-local
        // index"); -1 sentinel means "no trip held yet". Comparing by this
        // index rather than by departure epoch is what correctly resolves an
        // exact departure tie: pattern order guarantees the earlier-indexed
        // trip is pointwise <= the later one (in both departure and arrival,
        // see patterns.ts), so on a tie the earlier index is never worse and
        // may be strictly better further along the pattern.
        let heldPos = -1;
        let boardStop = -1;
        let boardEpoch = 0;
        // The exact Label object read from `prev[boardStop]` at the moment
        // the currently-held trip was boarded -- captured directly so every
        // transit label built while this trip is held can point its
        // `predecessor` at it, rather than re-deriving it later from
        // `boardStop` (which, unlike `prev`, would be safe to re-derive too,
        // since `prev` is a previous, already-frozen round -- but capturing
        // it here keeps the same direct-reference discipline everywhere).
        let boardLabel: Label | null = null;

        for (let i = startPos; i < length; i++) {
          const s = ix.patternStops[stopFrom + i]!;
          if (s < 0) continue;

          if (tripIdx >= 0) {
            const arr = day.baseEpoch
              + ix.arrivalTime[ix.tripTimeOffset[tripIdx]! + i]! + delay[tripIdx]!;
            // Gate the visit on `bound` here, not after: a visit that could
            // never help reach the destination in time can't help via a
            // footpath either (time only ever increases from here), so
            // there is no point recording it as a walk source. Without this
            // gate, adding a destination does nothing to shrink the walk
            // phase's own workload even though it still prunes `best`/`cur`.
            if (arr < bound) {
              const visitLabel: Label = {
                arrivalEpoch: arr, kind: "transit", fromStop: boardStop,
                tripIdx, dayIdx: d, boardStop, boardEpoch, predecessor: boardLabel,
              };
              const existing = visited.get(s);
              if (existing === undefined || arr < existing.arrivalEpoch) {
                visited.set(s, visitLabel);
              }
              if (arr < best[s]!) {
                best[s] = arr;
                cur[s] = visitLabel;
                marked.push(s);
              }
            }
          }

          // Could an earlier trip be boarded here than the one being ridden?
          const label = prev[s];
          if (label === null || label === undefined) continue;
          // A walk label's seconds already include the boarding buffer (see
          // buildFootpaths); adding it again would double-charge the transfer.
          //
          // An ACCESS label owes it only when `originsOnVehicle` says this
          // query's origins are riders on a vehicle: such a rider has to get
          // off one and onto another, which is the same physical act a
          // transit-kind label already pays for. Omitting it here would
          // charge an onboard connection `required - baseSeconds` -- 60 s
          // less than the identical connection reached mid-itinerary --
          // which would leave the margin partly waived on exactly the
          // boarding `originsOnVehicle` exists to protect. It applies
          // whether or not the headway margin is enabled, because the flat
          // buffer IS the pre-headway rule for a transfer: at
          // `TRANSFER_HEADWAY_FACTOR=0` an onboard connection is charged
          // exactly what the pre-headway planner charged every transfer, no
          // more. An ordinary `/plan` query never reaches this term (the
          // flag is absent, so the expression is the original one verbatim).
          const base = label.arrivalEpoch
            + (label.kind === "transit" || (originsOnVehicle && label.kind === "access")
              ? q.transferMinSeconds : 0);
          const currentDep = tripIdx >= 0
            ? day.baseEpoch
              + ix.departureTime[ix.tripTimeOffset[tripIdx]! + i]! + delay[tripIdx]!
            : Infinity;

          // Gated on `base`, the FLOOR of what the rule can ever require,
          // not on `ready`. With `extra === 0` (and so at
          // `TRANSFER_HEADWAY_FACTOR=0`, where `transfer` is null and the two
          // are the same number) this is byte-for-byte a `ready <=
          // currentDep` gate. With `extra > 0` it widens by exactly the band
          // the last-service fallback below can reach into: a search from `ready`
          // that finds a trip can never beat the held one here (its
          // departure exceeds `currentDep`, so pattern order puts it after
          // `heldPos`), so the only thing the wider gate can change is
          // whether the fallback gets a chance to run at all.
          if (base <= currentDep) {
            // Priced INSIDE the gate, not before it: `extra` is used nowhere
            // else, and the gate rejects most (pattern, position, label)
            // triples outright, so computing it above cost a divide, a
            // multiply, a `Math.round` and a `Math.max` per rejected triple
            // in RAPTOR's innermost loop. The reverse pass has always done it
            // this way and says so at its own alighting check; this is the
            // forward mirror of that, and it changes no result -- `base <=
            // currentDep` does not read `extra`.
            //
            // The headway-scaled margin on top: non-negative, and charged
            // only to a rider who already has a vehicle that could be late
            // (see `arrivedOnVehicle`). The hour is read from
            // `base`, the candidate boarding instant, NOT from `ready` (which
            // would depend on itself) and NOT from the trip
            // `earliestTripOnDay` goes on to find (which would be circular).
            // `i` is the boarding POSITION, which
            // `extraBoardingSeconds` needs to shift `base` back to the hour
            // the table is keyed on.
            const extra = transfer !== null && arrivedOnVehicle(label, originsOnVehicle)
              ? extraBoardingSeconds(ix, transfer, p, i, d, base - day.baseEpoch)
              : 0;
            const ready = base + extra;

            // The margin yields at the last service of the day.
            // When the scaled margin refuses EVERY remaining trip on this
            // pattern, on this service day, from this position, it does not
            // push the rider onto a later trip -- the ordinary rule assumes
            // one always exists -- it deletes their journey. `earliestTripOnDay` then
            // answers with the earliest trip boardable at the flat `base`
            // instead, which is the pre-branch rule and the floor the
            // dominance argument rests on: this can never make boarding
            // easier than the planner already was, only restore it in the
            // one case where the alternative is nothing at all. Per pattern,
            // deliberately -- if a different pattern still serves the
            // connection later, the ordinary search finds that journey and
            // needs no fallback. `plan.ts` flags the result to the rider
            // through `transferAtRisk`.
            //
            // SCOPED PER `DayContext`, NOT PER PATTERN GLOBALLY, which the
            // phrase "the pattern has no later trip" does not convey on its
            // own. This runs inside the per-day loop, so "later" means later
            // ON THIS SERVICE DAY. A pattern running at 24:30 on yesterday's
            // calendar and again at 08:00 on today's has no later trip on
            // YESTERDAY's context, and the fallback fires there even though
            // the same pattern demonstrably runs again a few hours on
            // (verified on a synthetic fixture: one onward trip per service
            // day at 24:30, feeder landing 24:25). The margin is therefore
            // silently inert for such patterns in the post-midnight window.
            // It errs conservatively -- `base` is the floor, so nothing is
            // offered that the pre-branch planner would not have offered --
            // and going global would mean comparing trips across service
            // days, exactly the comparison `earliestTripOnDay` refuses for
            // ordering reasons.
            //
            // `base` is passed unconditionally: with `extra === 0` (every
            // caller at `TRANSFER_HEADWAY_FACTOR=0`, and every first
            // boarding) it equals `ready` and the call is the original one,
            // unchanged.
            const found = earliestTripOnDay(
              ix, p, i, ready, day, q.tripFilter, patternTrips, delay, base);
            if (found !== null && (tripIdx < 0 || found.patternPos < heldPos)) {
              tripIdx = found.tripIdx;
              heldPos = found.patternPos;
              boardStop = s;
              boardEpoch = found.departEpoch;
              boardLabel = label;
            }
          }
        }
      }
    }

    // Footpath relaxation, once, from every stop this round's transit scan
    // VISITED (see `visited` above) -- not from `marked` (only-improved
    // stops) and not a live re-read of `cur` by stop id, either of which
    // could pick up a walk label written by an earlier stop in this same
    // pass and chain two walks together (see relaxFootpaths' doc comment).
    // `visited` was built incrementally during the scan above and is never
    // mutated afterward, so converting it here is already working from an
    // immutable snapshot.
    const visitedList = [...visited].map(([stop, label]) => ({ stop, label }));
    relaxFootpaths(ix, visitedList, best, cur, marked);
  }

  return { rounds };
}
