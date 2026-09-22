import type { TimetableIndex } from "./index.js";
import type { DayContext } from "./raptor.js";

/** Median seconds between consecutive active departures, per pattern per hour
 *  of the service day. `HOURS` entries per pattern, flat.
 *
 *  32-bit, not 16-bit. A `Uint16Array` would wrap every gap above 65535 s,
 *  which would invert the entire rule at the one place it matters most: a
 *  pattern whose only two active departures are ~18 hours apart is the most
 *  expensive miss in the feed, and it would be handed a small buffer instead
 *  of the cap -- a gap of exactly 65536 s stored as 0, meaning no margin at
 *  all. Gaps that large
 *  are ordinary (this feed's departures run to 105787 s, so a first-and-last
 *  pair can be over 100000 s apart), and silently truncating one is a modulo
 *  of a GTFS time, which this codebase does not do anywhere. The cost is
 *  ~828 KB per service day for this feed's 6,901 patterns instead of ~414 KB;
 *  two days are memoised at a time. */
export type HeadwayTable = Uint32Array;

export const HOURS = 30; // service days legitimately exceed 24 h
/** "No measurable gap" -- takes the cap. 4,294,967,295 s is roughly 136
 *  years, so no gap between two departures of one service day can reach it
 *  and a real headway can never be mistaken for an absent measurement. A
 *  16-bit sentinel, 65535, would itself be a perfectly reachable gap, which
 *  is why this one is deliberately absurd rather than merely large -- and not
 *  simply "larger than any gap a service day can produce" (`HOURS` hours is
 *  108000 s): gaps are measured between ALL active departures, and only the
 *  EARLIER departure of a pair has to fall inside `[0, HOURS)` for the gap to
 *  be recorded, so a gap itself can exceed 108000 s. The sentinel is safe by
 *  four orders of magnitude either way. */
export const NO_HEADWAY = 0xffffffff;

/**
 * How far into the pattern, in seconds, position `pos` sits -- the value
 * `buildPatterns` stored in `patternTravelSeconds`, which see for why it
 * exists and what it costs.
 *
 * SUBTRACT IT BEFORE EVERY `headwayFor` LOOKUP. `buildHeadwayTable` buckets
 * each gap by the hour of the departure at the pattern's FIRST stop, so the
 * table is keyed in first-stop time; a rider boarding at position `pos` is
 * doing so `patternTravelSeconds` later than the first-stop departure of the
 * same trip. Passing the raw boarding instant asks the table about the wrong
 * hour, which is a real, measured defect and not a rounding concern -- see
 * `patternTravelSeconds`'s own comment for the numbers.
 *
 * A one-line function rather than an inlined index expression at each of the
 * three call sites (both RAPTOR passes and `routes/plan.ts`), so the reason
 * lives in one place and a fourth caller cannot quietly omit the shift.
 */
export function patternTravelOffset(ix: TimetableIndex, p: number, pos: number): number {
  // `pos` is a position within pattern `p`, so `patternStopOffset[p] + pos`
  // is inside p's slice of `patternStops` and of the parallel array here.
  return ix.patternTravelSeconds[ix.patternStopOffset[p]! + pos]!;
}

export interface TransferConfig {
  baseSeconds: number;
  factor: number;
  capSeconds: number;
}

/**
 * The headway-scaled transfer contract `RaptorQuery.transfer`/
 * `ReverseQuery.transfer` accept, and every downstream consumer takes the
 * same shape for (`routes/plan.ts`'s `requiredMarginFor`/
 * `computeTransferAtRisk`/`annotateRealtime`, and the one `transfer` object
 * built per request there). Named, rather than spelled out at each of those
 * call sites, so the CONSTRUCTION site -- `routes/plan.ts`'s single
 * `const transfer: TransferMargin = {...}` -- is the one place a mistyped
 * field gets caught, instead of only at whichever consumer happens to read
 * that field.
 */
export interface TransferMargin {
  cfg: TransferConfig;
  headway: readonly HeadwayTable[];
}

/**
 * Median of a small array of gap seconds. Sorted ascending first: gaps are
 * collected in departure order, which is not the same as value order. Even
 * length averages the two middle values, rounded to fit the integer table.
 */
function median(gaps: number[]): number {
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Walks every pattern's trip slice once and takes its active trips in
 * departure order. Each consecutive pair of active trips contributes one
 * gap, `dep[i+1] - dep[i]`, attributed to the hour bucket of the EARLIER
 * departure -- the hour a rider would be boarding in. `headway[p][hour]` is
 * the median of the gaps attributed to that hour.
 *
 * A gap is deliberately NOT measured only between two trips that happen to
 * share an hour bucket: under a same-bucket-only rule, a service running
 * exactly every 60 minutes has one trip per bucket, never two, so it would
 * report no
 * measurable headway anywhere, and a 40-minute service would flicker between
 * measured and unmeasurable depending on where the hour boundary happened to
 * fall. The gap belongs to the hour you would be boarding in, not to a pair
 * of trips that happen to share a bucket.
 *
 * The last active trip of the day contributes no gap (there is no next
 * departure); its hour, if no earlier trip also lands there, is left
 * unmeasured and reports `NO_HEADWAY` -- correct, because missing the last
 * service of the day is the most expensive miss there is.
 *
 * `patternTrips` is already totally ordered by departure within a pattern
 * (`buildPatterns` splits any pattern that would violate this), so the
 * active departures collected per pattern come out in departure order with
 * no sort needed here.
 */
export function buildHeadwayTable(ix: TimetableIndex, day: DayContext): HeadwayTable {
  const table = new Uint32Array(ix.nPatterns * HOURS).fill(NO_HEADWAY);

  for (let p = 0; p < ix.nPatterns; p++) {
    // p ranges over [0, nPatterns), which patternTripOffset is sized for.
    const from = ix.patternTripOffset[p]!;
    const to = ix.patternTripOffset[p + 1]!;

    const deps: number[] = [];
    for (let i = from; i < to; i++) {
      // i ranges over [from, to), a slice of patternTrips reserved for
      // pattern p, so it is always in bounds here.
      const trip = ix.patternTrips[i]!;
      if (day.activeTrip[trip] !== 1) continue; // per-service-day mask

      // The pattern's FIRST stop position. Trips within a pattern never
      // overtake one another, so the gap between two trips is identical at
      // every stop along the pattern -- reading it here is exact, not an
      // approximation.
      deps.push(ix.departureTime[ix.tripTimeOffset[trip]!]!);
    }

    const byHour: number[][] = Array.from({ length: HOURS }, () => []);
    for (let i = 0; i + 1 < deps.length; i++) {
      const gap = deps[i + 1]! - deps[i]!;
      const hour = Math.floor(deps[i]! / 3600); // never modulo a GTFS time
      if (hour >= HOURS) continue; // beyond this feed's modelled range; row stays unmeasured
      byHour[hour]!.push(gap);
    }

    for (let h = 0; h < HOURS; h++) {
      const gaps = byHour[h]!;
      if (gaps.length === 0) continue; // no gap attributed to this hour: stays NO_HEADWAY
      table[p * HOURS + h] = median(gaps);
    }
  }

  return table;
}

/**
 * Looks up the precomputed headway for `patternIdx` at the hour containing
 * `secondsIntoDay`. Out-of-range hours (before the table starts or past
 * `HOURS`) report `NO_HEADWAY`, the same conservative "no data" value an
 * in-range but sparse hour reports -- both push `requiredTransferSeconds`
 * toward the cap, never toward an unearned smaller buffer.
 */
export function headwayFor(t: HeadwayTable, patternIdx: number, secondsIntoDay: number): number {
  const hour = Math.floor(secondsIntoDay / 3600); // never modulo a GTFS time
  if (hour < 0 || hour >= HOURS) return NO_HEADWAY;
  return t[patternIdx * HOURS + hour]!;
}

/**
 * `required(headway) = clamp(baseSeconds, factor * headway, capSeconds)`,
 * except:
 *
 * - `factor === 0` short-circuits to `baseSeconds` unconditionally, for
 *   every `headwaySeconds` including `NO_HEADWAY`. This is the off switch
 *   the whole differential guarantee rests on: with it, this function must
 *   behave exactly like today's flat `transferMinSeconds`.
 * - Otherwise, `NO_HEADWAY` maps to `capSeconds` *before* the factor would
 *   be applied -- it is never multiplied by `factor`, because it does not
 *   represent a large-but-real headway, only the absence of a measurement,
 *   and the worst case (the day's last departure, or an hour with none at
 *   all) is exactly what deserves the cap.
 *
 * Returns below `baseSeconds` in exactly one case, which callers must know
 * about: `capSeconds < baseSeconds`. The clamp applies the cap LAST, so a
 * misconfigured ceiling below the floor wins, and the result is a buffer
 * SMALLER than today's flat rule -- the one thing this feature must never
 * do, since `raptor.ts`'s tie-break dominance argument (and with it the
 * footpath phase's termination) rests on boarding only ever getting harder.
 * `config.ts` refuses that combination at boot and `runRaptor` floors the
 * margin at zero regardless.
 */
export function requiredTransferSeconds(headwaySeconds: number, cfg: TransferConfig): number {
  if (cfg.factor === 0) return cfg.baseSeconds;

  const scaled = headwaySeconds === NO_HEADWAY
    ? cfg.capSeconds
    : cfg.factor * headwaySeconds;

  const clamped = Math.min(Math.max(scaled, cfg.baseSeconds), cfg.capSeconds);
  return Math.round(clamped);
}

/**
 * Memoised per `(index, dateYmd)`. Keying the outer map on the index object
 * itself means every table dies with the bundle on a feed swap -- there is
 * no way for a stale table to survive past its index, because nothing can
 * look one up without the index object that produced it.
 *
 * Bounded to a handful of dates per index: `buildDayContexts` only ever asks
 * about the current and previous service day, but a long-running process
 * touches both every query, so an unbounded map would still be small --
 * this cap just makes that an explicit guarantee rather than an accident.
 */
const MAX_DATES_PER_INDEX = 8;
const tableCache = new WeakMap<TimetableIndex, Map<number, HeadwayTable>>();

export function headwayTableFor(ix: TimetableIndex, day: DayContext): HeadwayTable {
  let byDate = tableCache.get(ix);
  if (byDate === undefined) {
    byDate = new Map();
    tableCache.set(ix, byDate);
  }

  const cached = byDate.get(day.dateYmd);
  if (cached !== undefined) return cached;

  const table = buildHeadwayTable(ix, day);
  byDate.set(day.dateYmd, table);
  if (byDate.size > MAX_DATES_PER_INDEX) {
    // Map iteration order is insertion order, so this evicts the oldest entry.
    const oldest = byDate.keys().next().value as number;
    byDate.delete(oldest);
  }
  return table;
}

/**
 * Every half of the `transfer` contract both RAPTOR passes depend on,
 * checked once per query rather than per boarding.
 *
 * It lives here, and not once in each pass, because the two must refuse a
 * caller in exactly the same terms. `raptorReverse.oracle.test.ts` asserts
 * that they do -- but an assertion that two copies agree only fails AFTER
 * someone has already edited one of them, and the failure it produces names
 * the test rather than the divergence. A single function is the structural
 * version of the same guarantee: there is nothing left to drift.
 *
 * Each check earns its place:
 *
 *  - A `headway` array that is not exactly parallel to `days` would make the
 *    margin quietly vanish for a service day. Falling back to the flat buffer
 *    on a length mismatch was the other option and is worse: it disables the
 *    feature for some days and leaves no trace, which is precisely how this
 *    planner's past defects hid.
 *  - A `baseSeconds` that is not `transferMinSeconds` measures the margin
 *    against the wrong floor on EVERY boarding. This is the most dangerous
 *    of the three.
 *  - `config.ts` already refuses `capSeconds < baseSeconds` at boot, but both
 *    passes are called directly by tests and by the planner with a
 *    caller-supplied `cfg`, and an inverted clamp is the one input that can
 *    drive `requiredTransferSeconds` below the base -- leaving each pass's
 *    `Math.max(0, ...)` floor as the only thing between a bad `cfg` and a
 *    negative margin, which would make boarding EASIER and break the
 *    dominance argument the passes' termination rests on. The invariant
 *    belongs local to the functions that depend on it, not only to the
 *    process that usually supplies it.
 *
 * `fnName` is the caller's own name, so the thrown message still points at
 * the entry point the caller actually used.
 */
export function validateTransferContract(
  fnName: string,
  cfg: TransferConfig,
  headway: readonly HeadwayTable[],
  days: readonly DayContext[],
  transferMinSeconds: number,
): void {
  if (headway.length !== days.length) {
    throw new Error(
      `${fnName}: transfer.headway has ${headway.length} tables for ${days.length} days`,
    );
  }
  if (cfg.baseSeconds !== transferMinSeconds) {
    throw new Error(
      `${fnName}: transfer.cfg.baseSeconds (${cfg.baseSeconds}) must equal ` +
      `transferMinSeconds (${transferMinSeconds}) -- the margin is measured on top of it`,
    );
  }
  if (cfg.capSeconds < cfg.baseSeconds) {
    throw new Error(
      `${fnName}: transfer.cfg.capSeconds (${cfg.capSeconds}) must be at least ` +
      `baseSeconds (${cfg.baseSeconds}) -- an inverted clamp makes boarding easier`,
    );
  }
}
