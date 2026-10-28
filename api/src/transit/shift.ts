import type { TimetableIndex } from "./index.js";
import type { DayContext } from "./raptor.js";

/**
 * The slice of `RealtimeStore` this module needs. Structural, like
 * `DelayJourney`, so a test can hand in two methods instead of a live store
 * with a poller behind it.
 */
export interface DelaySource {
  journeys(): Iterable<DelayJourney>;
  snapshotId(): number | null;
}

/**
 * The shape this module needs from a resolved SIRI journey: which trip it is,
 * and what it predicts at each stop it resolved. `RealtimeStore`'s own
 * `ResolvedJourney` satisfies it structurally, so nothing has to adapt at the
 * call site -- and a test can supply two fields instead of a whole store.
 */
export interface DelayJourney {
  tripIdx: number;
  byStopIdx: Map<number, { expectedArrival: number }>;
}

/**
 * A live delay applied to the timetable, as RAPTOR reads it.
 *
 * `delay` is a UNIFORM per-trip shift: one constant added to every arrival and
 * every departure of that trip.
 *
 * A uniform shift does NOT, on its own, guarantee that re-sorting restores the
 * ordering. Shifting trips
 * A and B by different constants moves the gap `B_i - A_i` by a CONSTANT
 * `dA - dB` at every position -- so the gap's sign flips only at the positions
 * where it was narrower than that constant. When two trips have identical
 * running times their gap is the same at every position and the sign flips
 * everywhere at once (a clean reorder); when their running times DIFFER the
 * gap varies, and a large enough delay difference flips it at some positions
 * and not others. That is a genuine crossing, and no permutation fixes it.
 * `shift.invariant.test.ts` generates exactly that case.
 *
 * Measured on the real feed, this is rare to the point of absence: 5,300
 * delayed trips across 2,279 touched patterns produced ZERO conflicting
 * patterns, because trips sharing a pattern have near-identical running times.
 * So rather than splitting patterns -- which would change `nPatterns` and
 * invalidate every pattern-keyed structure in the index -- `buildShift`
 * DETECTS a pattern it cannot order and reverts it: that pattern keeps its
 * scheduled order and its trips keep a zero delay. The invariant then holds by
 * construction, and the cost is that a conflicting pattern falls back to
 * exactly today's schedule-only behaviour. See `conflictingPatterns`.
 *
 * That is why `patternTrips` is the only structure here. `patternTripOffset`,
 * `patternStops`, `patternStopOffset`, `patternOfTrip`, `stopPatterns`,
 * `stopPatternPos`, `stopPatternOffset` and `patternTravelSeconds` are all
 * untouched and shared with the base index: without splits, nothing about a
 * pattern changes except the ORDER of the trips inside its existing slice.
 *
 * Carried as a delay array rather than as shifted copies of `departureTime`
 * and `arrivalTime` for a measured reason: those two arrays are 21.77M entries
 * each on this feed, so copying them would cost 166 MB per snapshot against
 * this array's 2.3 MB.
 */
export interface TimetableShift {
  /** Seconds to add to every time of trip `t`. Zero for a trip with no live
   *  prediction, which is the overwhelming majority. Never negative. */
  delay: Int32Array;
  /** `ix.patternTrips`, re-sorted within each pattern's existing slice on the
   *  shifted times. Same length and same `patternTripOffset` as the base. */
  patternTrips: Int32Array;
  /**
   * How many patterns could not be ordered under their delays and were
   * reverted to the schedule (see above). Expected to be 0 on this feed;
   * surfaced so that "realtime re-planning quietly stopped working for a
   * chunk of the network" is visible rather than inferred.
   */
  conflictingPatterns: number;
}

/**
 * Stop index -> its FIRST position in trip `t`'s stop sequence.
 *
 * First, not every, because `byStopIdx` is itself keyed by stop index and has
 * already collapsed a stop a loop route visits twice; taking the first
 * position is the same choice the store made when it wrote the entry.
 */
function stopPositions(ix: TimetableIndex, t: number): Map<number, number> {
  const p = ix.patternOfTrip[t]!;
  const from = ix.patternStopOffset[p]!;
  const to = ix.patternStopOffset[p + 1]!;
  const at = new Map<number, number>();
  for (let i = from; i < to; i++) {
    const s = ix.patternStops[i]!;
    if (!at.has(s)) at.set(s, i - from);
  }
  return at;
}

/**
 * The per-trip delay array.
 *
 * One trip's delay is the MEDIAN of `predicted - scheduled` over the stops its
 * journey resolved. Median rather than the newest or the nearest stop because
 * the stop-code join is inference, not observation: a single mis-joined stop
 * can be wildly wrong, and the median is the estimator that ignores it rather
 * than being dragged by it.
 *
 * Clamped at zero. A vehicle reported as running EARLY is never something this
 * planner will promise a rider -- the same rule `computeTransferAtRisk`
 * already states for transfers, applied here to boarding.
 *
 * Measured against `day.baseEpoch`, so a journey is only ever compared with
 * the service day it actually belongs to; a trip not running on `day` is
 * skipped entirely. See `buildShifts` for why that matters.
 */
/**
 * Beyond this, a "delay" is not a delay -- it is a mismatch, and applying it
 * would shove a trip out of the search entirely.
 *
 * The case that produced this bound, seen on the real feed: `buildDayContexts`
 * searches today AND the previous service day, and ~1,600 trips run on both.
 * A live journey always belongs to TODAY's run, so measuring it against the
 * PREVIOUS day's `baseEpoch` yields roughly +86,400 s -- a positive number
 * that clamps right through the `> 0` test and silently corrupts that trip's
 * position in the previous-day context. Two hours is far past anything a bus
 * in this feed is ever legitimately late by (the worst observed at rush hour
 * is ~20 minutes) and far below a day, so it separates the two cleanly.
 */
export const MAX_PLAUSIBLE_DELAY_SECONDS = 7_200;

export function tripDelays(
  ix: TimetableIndex, journeys: Iterable<DelayJourney>, day: DayContext,
): Int32Array {
  const delay = new Int32Array(ix.nTrips);
  const deltas: number[] = [];

  for (const j of journeys) {
    const t = j.tripIdx;
    if (t < 0 || t >= ix.nTrips) continue;
    if (day.activeTrip[t] !== 1) continue;

    const positions = stopPositions(ix, t);
    const off = ix.tripTimeOffset[t]!;
    deltas.length = 0;
    for (const [stopIdx, prediction] of j.byStopIdx) {
      const pos = positions.get(stopIdx);
      if (pos === undefined) continue;
      deltas.push(prediction.expectedArrival - (day.baseEpoch + ix.arrivalTime[off + pos]!));
    }
    if (deltas.length === 0) continue;

    deltas.sort((a, b) => a - b);
    const mid = deltas.length >> 1;
    const median = deltas.length % 2 === 1
      ? deltas[mid]!
      : (deltas[mid - 1]! + deltas[mid]!) / 2;
    if (median > 0 && median <= MAX_PLAUSIBLE_DELAY_SECONDS) delay[t] = Math.round(median);
  }
  return delay;
}

/**
 * Lexicographic comparison of two trips on SHIFTED times, interleaving each
 * position's departure and arrival.
 *
 * Deliberately the same ordering `patterns.ts`'s `compareTimes` establishes at
 * build time, evaluated on shifted values instead of scheduled ones -- the
 * order RAPTOR's binary search depends on has to be re-established in exactly
 * the terms it was created in, or the search is reading one ordering while the
 * data holds another.
 */
function compareShifted(
  ix: TimetableIndex, delay: Int32Array, nStops: number, a: number, b: number,
): number {
  const offA = ix.tripTimeOffset[a]!;
  const offB = ix.tripTimeOffset[b]!;
  const da = delay[a]!;
  const db = delay[b]!;
  for (let i = 0; i < nStops; i++) {
    const depA = ix.departureTime[offA + i]! + da;
    const depB = ix.departureTime[offB + i]! + db;
    if (depA !== depB) return depA - depB;
    const arrA = ix.arrivalTime[offA + i]! + da;
    const arrB = ix.arrivalTime[offB + i]! + db;
    if (arrA !== arrB) return arrA - arrB;
  }
  return 0;
}

/**
 * True when every consecutive pair in `order` dominates the next pointwise, in
 * BOTH arrays, at every position -- the exact invariant `raptor.ts`'s binary
 * search rests on.
 *
 * Consecutive pairs are sufficient: pointwise `<=` is transitive, so an
 * ordering in which each neighbour dominates the next is totally ordered.
 */
function ordered(
  ix: TimetableIndex, delay: Int32Array, nStops: number, order: readonly number[],
): boolean {
  for (let j = 1; j < order.length; j++) {
    const a = order[j - 1]!;
    const b = order[j]!;
    const offA = ix.tripTimeOffset[a]!;
    const offB = ix.tripTimeOffset[b]!;
    const da = delay[a]!;
    const db = delay[b]!;
    for (let i = 0; i < nStops; i++) {
      if (ix.departureTime[offA + i]! + da > ix.departureTime[offB + i]! + db) return false;
      if (ix.arrivalTime[offA + i]! + da > ix.arrivalTime[offB + i]! + db) return false;
    }
  }
  return true;
}

/**
 * The shift for one service day, or `null` when no trip running that day has a
 * live delay -- which is the answer on a previous-day context, on a feed with
 * realtime disabled, and at any hour with nothing late. `null` rather than an
 * all-zero shift so the caller can pass nothing at all to RAPTOR and take the
 * untouched path, byte for byte.
 *
 * Only patterns actually holding a delayed trip are re-sorted; the rest of
 * `patternTrips` is copied through. Measured on the real feed, a rush-hour
 * snapshot touches 2,279 of 6,881 patterns and the re-sort costs ~124 ms --
 * paid once per realtime snapshot, not once per request (see `shiftsFor`).
 */
export function buildShift(
  ix: TimetableIndex, journeys: Iterable<DelayJourney>, day: DayContext,
): TimetableShift | null {
  const delay = tripDelays(ix, journeys, day);

  const touched = new Set<number>();
  for (let t = 0; t < delay.length; t++) {
    if (delay[t] !== 0) touched.add(ix.patternOfTrip[t]!);
  }
  if (touched.size === 0) return null;

  const patternTrips = Int32Array.from(ix.patternTrips);
  let conflictingPatterns = 0;
  for (const p of touched) {
    const from = ix.patternTripOffset[p]!;
    const to = ix.patternTripOffset[p + 1]!;
    const nStops = ix.patternStopOffset[p + 1]! - ix.patternStopOffset[p]!;
    const slice = Array.from(patternTrips.subarray(from, to));
    slice.sort((a, b) => compareShifted(ix, delay, nStops, a, b));

    // Sorting is necessary but not sufficient -- see `TimetableShift`'s own
    // doc comment for the case where trips with different running times cannot
    // be ordered under their delays at all. Revert such a pattern whole: its
    // scheduled order comes back, and every trip in it loses its delay, so the
    // pattern behaves exactly as it would with realtime re-planning disabled. Clearing
    // the delays is safe to do per pattern because a trip belongs to exactly
    // one pattern (`patternOfTrip`), so this can never disturb another.
    if (ordered(ix, delay, nStops, slice)) {
      patternTrips.set(slice, from);
    } else {
      conflictingPatterns++;
      for (let j = from; j < to; j++) delay[ix.patternTrips[j]!] = 0;
    }
  }

  // Reverting may have cleared the last delay in the snapshot.
  if (delay.every((d) => d === 0)) return null;
  return { delay, patternTrips, conflictingPatterns };
}

/**
 * A shared all-zero delay array, so a schedule-only search adds `0` at each
 * time read instead of branching on whether a shift exists. Memoised by length
 * rather than allocated per query: this is `nTrips` entries (2.3 MB on the
 * real feed) and a query would otherwise allocate one per service day, in both
 * passes.
 *
 * Never handed out for writing -- `buildShift` always allocates its own.
 */
const zeroDelayCache = new Map<number, Int32Array>();
export function zeroDelay(nTrips: number): Int32Array {
  let z = zeroDelayCache.get(nTrips);
  if (z === undefined) {
    z = new Int32Array(nTrips);
    zeroDelayCache.set(nTrips, z);
  }
  return z;
}

/**
 * The shifts for a query's service days, built once per realtime snapshot and
 * shared by every request that lands in that snapshot's window.
 *
 * This is the whole reason the feature is affordable. Re-sorting the touched
 * patterns costs ~124 ms on the real feed at rush hour; the open-bus poller
 * refreshes every 20 s, so paid per snapshot that is well under a percent of
 * one core, while paid per request it would be the single most expensive thing
 * `/plan` does.
 *
 * One entry per index, not a growing map: the day set of a query is
 * effectively constant (today plus yesterday), so a new snapshot or a date
 * rollover simply replaces the entry. A `WeakMap` so a swapped-out index is
 * collectable, matching `headway.ts`'s own table cache.
 *
 * Returns `undefined` when there is nothing live at all, so the caller passes
 * nothing to RAPTOR and both passes take their untouched, schedule-only path.
 *
 * The per-stop predictions are read as stored, WITHOUT `RealtimeStore`'s
 * per-reader re-anchoring onto "now" -- that would make the result depend on
 * the instant it was asked for and defeat the caching this function exists
 * for. The error that trades away is bounded by the feed's age (tens of
 * seconds) against delays measured in hundreds.
 */
const shiftCache = new WeakMap<
  TimetableIndex, { key: string; shifts: (TimetableShift | undefined)[] }
>();

/**
 * What the most recent shift build produced, for `/meta`.
 *
 * Module-level rather than threaded out through `/plan`, because the thing
 * worth watching is a property of the SNAPSHOT, not of any one request -- and
 * because making `/meta` build a shift of its own would cost it the ~124 ms
 * this cache exists to avoid.
 *
 * `conflictingPatterns` is the one to watch: it is 0 on this feed under
 * ordinary conditions, and a number that climbs means live re-planning is
 * quietly falling back to the timetable for part of the network.
 */
let lastStats: { delayedTrips: number; conflictingPatterns: number } | null = null;

export function lastShiftStats(): { delayedTrips: number; conflictingPatterns: number } | null {
  return lastStats;
}

export function shiftsFor(
  ix: TimetableIndex, realtime: DelaySource | null, days: readonly DayContext[],
): (TimetableShift | undefined)[] | undefined {
  if (realtime === null) return undefined;
  const snapshotId = realtime.snapshotId();
  if (snapshotId === null) return undefined;

  const key = `${snapshotId}|${days.map((d) => d.dateYmd).join(",")}`;
  const cached = shiftCache.get(ix);
  // An empty array is the memo for "this snapshot has nothing live" -- it must
  // come back as `undefined` like a fresh miss would, so the caller passes
  // nothing to RAPTOR rather than an array of holes.
  if (cached !== undefined && cached.key === key) {
    return cached.shifts.length === 0 ? undefined : cached.shifts;
  }

  // `journeys()` is re-read per day rather than materialised once: it is a
  // view over the snapshot's own map, and `buildShift` filters it by the day's
  // `activeTrip` mask anyway.
  const shifts = days.map((day) => buildShift(ix, realtime.journeys(), day) ?? undefined);
  lastStats = {
    delayedTrips: shifts.reduce(
      (n, sh) => n + (sh === undefined ? 0 : sh.delay.reduce((a, d) => a + (d !== 0 ? 1 : 0), 0)), 0),
    conflictingPatterns: shifts.reduce((n, sh) => n + (sh?.conflictingPatterns ?? 0), 0),
  };
  if (shifts.every((s) => s === undefined)) {
    shiftCache.set(ix, { key, shifts: [] });
    return undefined;
  }
  shiftCache.set(ix, { key, shifts });
  return shifts;
}
