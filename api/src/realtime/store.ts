import type { ResolvedJourney, MatchStats, StopPrediction, UnscheduledRun } from "./match.js";
import type { RealtimeSource } from "./types.js";

export type RealtimeHealth = "disabled" | "ok" | "stale" | "failing";

export interface RealtimeStatus {
  health: RealtimeHealth;
  /**
   * Which feed this process is configured to read, or `null` when realtime
   * is disabled entirely. Reported even before the first successful poll --
   * an operator looking at a silent process needs to know which source it
   * would have used.
   */
  source: RealtimeSource | null;
  ageSeconds: number | null;
  journeys: number;
  resolved: number;
  unresolved: number;
  /**
   * Journeys that matched a trip (route + direction + scheduled start +
   * day) but resolved zero calls -- a `realtime` block whose fields are all
   * `null` on every leg, indistinguishable from "never got here" anywhere
   * else in this response. See `MatchStats.resolvedWithNoCalls`'s own doc
   * comment: a wrong stop-code join can make EVERY
   * journey resolve this way at once, and `resolved`/`unresolved` alone
   * would report a healthy 100% match rate throughout.
   */
  resolvedWithNoCalls: number;
  /** Diagnostic only -- see `MatchStats.nearMissCount`'s own doc comment.
   *  Never affects resolution itself. */
  nearMissCount: number;
  /** Of `resolved`, buses matched to an empty slot within 15 min rather than
   *  exactly -- see `MatchStats.attached`. */
  attached: number;
  /** Buses shown as unscheduled runs -- see `MatchStats.unscheduled`. */
  unscheduled: number;
}

/**
 * One fully-built, indexed snapshot. Never mutated after construction --
 * `RealtimeStore.replace()` builds a new one from scratch off to the side
 * and only then assigns it, so a reader in between two `replace()` calls
 * always sees one complete generation, never a partial one.
 */
interface Snapshot {
  byTripIdx: Map<number, ResolvedJourney>;
  /**
   * `${tripIdx}:${stopIdx}` -> predicted arrival (plus ambiguity).
   * Flattened out of every `ResolvedJourney.byStopIdx` here so a lookup is
   * one map access instead of "find the journey, then its map".
   */
  byTripStop: Map<string, StopPrediction>;
  /** Unscheduled runs, held OUTSIDE `byTripIdx`/`byTripStop` so no per-trip
   *  read can return one. Predictions already anchor-gated. */
  unscheduled: UnscheduledRun[];
  unscheduledByStop: Map<number, { run: UnscheduledRun; prediction: StopPrediction }[]>;
  stats: MatchStats;
  fetchedAt: number;
}

function tripStopKey(tripIdx: number, stopIdx: number): string {
  return `${tripIdx}:${stopIdx}`;
}

/**
 * Of the time since a bus was placed at its reported position, the share
 * assumed lost -- halfway between "it kept to the timetable's pace" (0) and
 * "it has not moved since" (1).
 *
 * Replayed against the raw feed on the 2026-09-10 weekday peak (2,005 arrivals
 * on six lines), and against observed arrivals:
 *
 *   share   0-2 min out   2-5 min out   5-10 min out
 *   0       38 s          79 s          146 s
 *   0.5     41 s          69 s          128 s
 *   1       64 s          72 s          115 s
 *
 * 0.5 is never the worst and has the smallest bias close in (+19 s / +2 s),
 * which is where a rider decides whether to run for it.
 */
const STALL_SHARE = 0.5;

/**
 * An anchored prediction as of `now`: the stored ETA pushed back by the
 * stalled share of the time since `anchorAt`, and never at or before `now`
 * -- the bus has not been seen past this stop, so it has not arrived. Whole
 * seconds, so the ISO timestamps built from it keep their existing format.
 */
function anchoredArrival(expectedArrival: number, anchorAt: number, now: number): number {
  const stalled = STALL_SHARE * Math.max(0, now - anchorAt);
  return Math.max(Math.round(expectedArrival + stalled), Math.floor(now) + 1);
}

/**
 * How old a report may already be, when fetched, and still be anchored.
 *
 * Anchoring reads elapsed time as a bus standing still, which is only true
 * when that time is recent. On an old report it is mostly lag: anchoring
 * Stride's 13-23 minute-old positions pushed the 2026-09-10 replay from 118 s
 * to 334 s at 2-5 min out. And an old report may place a bus short of a stop
 * it has long since passed, so it must not get the "never before now" floor
 * either -- that would pin a gone bus to the board.
 *
 * Five minutes sits above the fresh body of the raw feed (other operators'
 * p75 45-86 s) and below its lagging tail (Egged's reports ran ~21 min late on
 * 2026-09-13 18:47Z; 9-15% of all reports at a weekday peak are over 10 min).
 * In the weekday replay a 120, 300 or 600 s limit scored identically, so the
 * limit costs nothing on fresh data and exists for the outages and ghosts.
 * Keyed on the report, not the feed: a fresh Stride report is anchored too.
 */
export const ANCHOR_MAX_REPORT_AGE_SECONDS = 300;

/** Whether a journey's report was fresh enough, when fetched, to anchor. An
 *  unknown report time is not. See ANCHOR_MAX_REPORT_AGE_SECONDS. */
function isAnchorable(recordedAt: number | null, fetchedAt: number): boolean {
  return recordedAt !== null && fetchedAt - recordedAt <= ANCHOR_MAX_REPORT_AGE_SECONDS;
}

/** The prediction as stored: its anchor kept only when anchorable. */
function gateAnchor(prediction: StopPrediction, anchorable: boolean): StopPrediction {
  return anchorable || prediction.anchorAt === undefined
    ? prediction
    : { expectedArrival: prediction.expectedArrival, ambiguous: prediction.ambiguous };
}

/**
 * The latest resolved SIRI snapshot, held in memory. `store.ts` never
 * parses JSON and never performs I/O -- fetching and resolving is
 * `poller.ts`'s job; this class only holds state and answers lookups.
 *
 * `replace()` mirrors `IndexManager`: the new snapshot is built completely
 * off to the side, then swapped in as a single reference assignment, so a
 * reader calling `predictionFor`/`journeyFor`/`status` between two
 * `replace()` calls always observes one whole generation or the other, and
 * a failed or partial fetch (`poller.ts`'s problem, not this class's)
 * simply never calls `replace()` at all -- the previous snapshot survives
 * untouched.
 */
export class RealtimeStore {
  private snapshot: Snapshot | null = null;

  /**
   * @param maxAgeSeconds `REALTIME_MAX_AGE_SECONDS`: a snapshot
   *   older than this is treated as absent, in every read method. Stale
   *   predictions are worse than none -- a rider trusts them.
   * @param now Epoch seconds. Defaults to the wall clock for production
   *   use; tests inject a fixed (or steppable) function so staleness
   *   checks are deterministic rather than racing the real clock.
   */
  constructor(
    /**
     * Which feed this store's predictions come from. Fixed for the
     * process's lifetime: the source is chosen once at config time and
     * never swapped at runtime.
     */
    private readonly source: RealtimeSource,
    private readonly maxAgeSeconds: number,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  /** The stored ETA, anchored on now when it still carries an anchor --
   *  `replace()` strips the anchor from any report that was already old, and
   *  an operator's own ETA never had one. */
  private arrivalOf(entry: StopPrediction): number {
    if (entry.anchorAt === undefined) return entry.expectedArrival;
    return anchoredArrival(entry.expectedArrival, entry.anchorAt, this.now());
  }

  /**
   * Replaces the whole snapshot atomically: everything above this method's
   * one assignment to `this.snapshot` builds the replacement without
   * touching the field the readers below actually see.
   */
  replace(
    resolved: ResolvedJourney[], stats: MatchStats, fetchedAt: number,
    unscheduled: readonly UnscheduledRun[] = [],
  ): void {
    const byTripIdx = new Map<number, ResolvedJourney>();
    const byTripStop = new Map<string, StopPrediction>();
    for (const rj of resolved) {
      byTripIdx.set(rj.tripIdx, rj);
      const anchorable = isAnchorable(rj.journey.recordedAt, fetchedAt);
      for (const [stopIdx, prediction] of rj.byStopIdx) {
        byTripStop.set(tripStopKey(rj.tripIdx, stopIdx), gateAnchor(prediction, anchorable));
      }
    }

    const runs: UnscheduledRun[] = [];
    const unscheduledByStop = new Map<number, { run: UnscheduledRun; prediction: StopPrediction }[]>();
    for (const run of unscheduled) {
      const anchorable = isAnchorable(run.journey.recordedAt, fetchedAt);
      const byStopIdx = new Map<number, StopPrediction>();
      for (const [stopIdx, prediction] of run.byStopIdx) byStopIdx.set(stopIdx, gateAnchor(prediction, anchorable));
      const stored = { ...run, byStopIdx };
      runs.push(stored);
      for (const [stopIdx, prediction] of byStopIdx) {
        const bucket = unscheduledByStop.get(stopIdx);
        if (bucket === undefined) unscheduledByStop.set(stopIdx, [{ run: stored, prediction }]);
        else bucket.push({ run: stored, prediction });
      }
    }
    this.snapshot = { byTripIdx, byTripStop, unscheduled: runs, unscheduledByStop, stats, fetchedAt };
  }

  /**
   * The current snapshot if one exists AND is within `maxAgeSeconds` of
   * `this.now()`; `null` otherwise, for any reason -- never received one,
   * or it has gone stale. Every read method goes through this single
   * choke point so "stale is absent" can't be forgotten in one of them.
   */
  private fresh(): Snapshot | null {
    if (this.snapshot === null) return null;
    return this.now() - this.snapshot.fetchedAt <= this.maxAgeSeconds ? this.snapshot : null;
  }

  /** Null when there is no fresh data, for any reason. Ignores
   * `StopPrediction.ambiguous` -- this is the departures-board accessor,
   * which genuinely wants "the next vehicle due at this physical stop"
   * regardless of which lap of a loop produced it
   * (see `match.ts`'s `resolveCalls` for the full reasoning). `/plan` must
   * NOT use this method -- see `unambiguousPredictionFor`. */
  predictionFor(tripIdx: number, stopIdx: number): number | null {
    const entry = this.fresh()?.byTripStop.get(tripStopKey(tripIdx, stopIdx));
    return entry === undefined ? null : this.arrivalOf(entry);
  }

  /**
   * Like `predictionFor`, but `null` whenever this stop is `ambiguous` --
   * visited more than once on the trip's own pattern -- in addition to
   * every reason `predictionFor` already returns `null` for. A `/plan` leg
   * has a specific pattern position (one particular lap); a stop's `/plan`
   * consumer cannot tell WHICH visit `predictionFor`'s single "soonest"
   * value came from, and attaching it anyway risks a wrong-lap prediction,
   * which the design forbids more strongly than reporting nothing
   * (`match.ts:186`). This is the ONLY method `routes/plan.ts` may use for
   * a leg's board/alight prediction; the departures board keeps using
   * `predictionFor`, unchanged.
   */
  unambiguousPredictionFor(tripIdx: number, stopIdx: number): number | null {
    const entry = this.fresh()?.byTripStop.get(tripStopKey(tripIdx, stopIdx));
    if (entry === undefined) return null;
    return entry.ambiguous ? null : this.arrivalOf(entry);
  }

  /** This store's clock, in epoch seconds -- the same instant every read
   *  method judges freshness by, so a route comparing a report's age against
   *  it agrees with what the store itself would answer. */
  nowSeconds(): number {
    return this.now();
  }

  /** Which feed this store carries. Available even with no snapshot yet, so
   *  a leg's annotation can name its source before the first poll lands. */
  get feedSource(): RealtimeSource { return this.source; }

  journeyFor(tripIdx: number): ResolvedJourney | null {
    return this.fresh()?.byTripIdx.get(tripIdx) ?? null;
  }

  /** Every unscheduled run predicting `stopIdx`, with its (anchored) arrival
   *  there. Empty when there is no fresh snapshot. */
  unscheduledAtStop(stopIdx: number): { run: UnscheduledRun; arrival: number }[] {
    const entries = this.fresh()?.unscheduledByStop.get(stopIdx) ?? [];
    return entries.map(({ run, prediction }) => ({ run, arrival: this.arrivalOf(prediction) }));
  }

  /**
   * The unscheduled runs on `routeId` still on the road -- at least one
   * predicted stop still AHEAD of `this.now()` (its anchored arrival has not
   * passed yet), not merely a run that carries some prediction. A report
   * older than `ANCHOR_MAX_REPORT_AGE_SECONDS` gets no anchor floor at
   * `replace()` time (see `gateAnchor`), so `arrivalOf` returns its bare
   * `expectedArrival` -- which can already be behind the clock while the bus
   * itself is still within `maxVehicleAgeSeconds` and every stop count still
   * positive. Without this check a run that has plainly finished would stay
   * pinned to the top of `/routes/:id/trips` forever. Empty when there is
   * no fresh snapshot.
   */
  unscheduledOnRoute(routeId: string): UnscheduledRun[] {
    const now = this.now();
    return (this.fresh()?.unscheduled ?? [])
      .filter((run) => run.journey.lineRef === routeId
        && [...run.byStopIdx.values()].some((prediction) => this.arrivalOf(prediction) > now));
  }

  /**
   * An identity for the current snapshot, or `null` when there is no fresh
   * one. Changes exactly when `replace()` swaps a new generation in.
   *
   * Exists so a reader can cache something expensive derived from the whole
   * snapshot and know when to rebuild it -- `transit/shift.ts` builds the
   * delay-shifted timetable view once per generation rather than once per
   * request, which is the difference between ~145 ms every 20 s and ~145 ms
   * on every `/plan`.
   *
   * `fetchedAt` rather than a counter because it is already the field
   * `replace()` stamps and `fresh()` judges staleness by: a generation and its
   * id cannot drift apart if they are the same number.
   */
  snapshotId(): number | null {
    return this.fresh()?.fetchedAt ?? null;
  }

  /** Every journey in the fresh snapshot -- nothing once it is stale, the
   *  same as every other read. For a caller with no trip id to look up: a
   *  line's map wants whichever of the line's buses are on the road. */
  journeys(): Iterable<ResolvedJourney> {
    return this.fresh()?.byTripIdx.values() ?? [];
  }

  /**
   * `now` is a caller-supplied instant, not `this.now()` -- a route handler
   * that already computed "now" for its own response, or a test, reports
   * status for that exact instant without depending on (or having to
   * control) the store's own injected clock.
   *
   * CAUTION -- this means `status(now)` and `predictionFor`/`journeyFor`
   * (which always use `this.now()`, never a caller-supplied value) can
   * disagree if the two clocks are not kept in step: a caller that passes
   * a `now` newer than what `this.now()` currently returns can see
   * `status().health === "ok"` in the same instant `predictionFor` is
   * already answering `null` (or the reverse, briefly, near the staleness
   * boundary). Production wiring should derive both from the SAME instant
   * -- e.g. `store.status(Date.now() / 1000)` while the store's own `now`
   * is also the wall clock -- to avoid this in practice.
   *
   * Counts are reported from the last snapshot even when it has gone
   * stale: an operator diagnosing a stuck poller wants to see what it last
   * held and how old it is, not a count reset to zero indistinguishable
   * from "never received anything" (`"disabled"`).
   *
   * `"failing"` is never produced here: this class never performs I/O and
   * so has no visibility into poll failures -- `SiriPoller.consecutiveFailures`
   * is where that comes from; a caller combines the two.
   */
  status(now: number): RealtimeStatus {
    if (this.snapshot === null) {
      return {
        health: "disabled", source: this.source, ageSeconds: null, journeys: 0,
        resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
      };
    }
    const ageSeconds = now - this.snapshot.fetchedAt;
    const health: RealtimeHealth = ageSeconds > this.maxAgeSeconds ? "stale" : "ok";
    const { resolved, unresolved, resolvedWithNoCalls, nearMissCount } = this.snapshot.stats;
    const attached = this.snapshot.stats.attached ?? 0;
    const unscheduled = this.snapshot.stats.unscheduled ?? 0;
    return {
      health, source: this.source, ageSeconds, journeys: resolved + unresolved + unscheduled,
      resolved, unresolved, resolvedWithNoCalls, nearMissCount, attached, unscheduled,
    };
  }

  /**
   * Fully resets the store to its NEVER-received-anything state, as
   * distinct from letting a snapshot merely go stale. This is for exactly
   * one caller: `IndexManager`'s `onIndexSwap` hook, wired up wherever this
   * store is constructed (see `realtime/wiring.ts`) -- a snapshot resolved
   * against a `TimetableIndex` that has just been superseded describes a
   * world that no longer exists (the same trip INDEX can now name a
   * completely different trip), so its `resolved`/`unresolved` counts are
   * not merely old, they are about trips that may not even be the ones
   * those numbers now imply.
   *
   * DELIBERATELY DIFFERENT from ordinary staleness, where `status()` keeps
   * reporting the last snapshot's counts on purpose (see that method's own
   * comment: an operator diagnosing a stuck poller wants to see what it
   * last held). Ordinary staleness means "the SAME index, just an old
   * answer" -- the counts still describe something real. `clear()` means
   * "a DIFFERENT index now, and nothing has been resolved against it yet"
   * -- so every count goes to zero and `status()` reports `"disabled"`,
   * exactly like a store that has never received anything, until the next
   * successful poll resolves fresh data against the new index.
   */
  clear(): void {
    this.snapshot = null;
  }
}
