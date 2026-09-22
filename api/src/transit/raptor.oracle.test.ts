import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatterns, type TripTimes } from "./patterns.js";
import type { TimetableIndex } from "./index.js";
import { runRaptor, type DayContext, type RaptorResult } from "./raptor.js";
// Imported for the RAPTOR side of the comparison only -- the oracle below
// derives the headway rule itself and never calls into this module.
import { buildHeadwayTable, type TransferConfig } from "./headway.js";

/**
 * Differential test: runRaptor vs. an exhaustive brute-force oracle over many
 * random small networks.
 *
 * This harness is what actually found five real defects in `raptor.ts` — two
 * Critical (a departure tie inside a pattern keeping the later-arriving trip;
 * DayContexts compared by raw epoch, which is only valid within one day) and
 * three more (an overtaking split that ignored arrivals; footpaths never
 * relaxed from a round-0 access label; a footpath phase that could chain two
 * walks together) — none of which the hand-written example tests in
 * `raptor.test.ts` caught. Eleven hand-written tests found zero of these;
 * this harness found all five in a couple thousand random trials. It is kept
 * here, permanently, at a much lower trial count so `npm test` stays fast,
 * specifically so the next silent wrong answer in this file gets caught the
 * same way instead of shipping.
 *
 * WHAT THIS HARNESS DOES AND DOES NOT PROVE, with the headway margin in the
 * mix. At a ZERO factor it is still an exact optimality guarantee:
 * RAPTOR must return the best journey the timetable allows, and the
 * off-switch test below additionally pins that a zero factor is
 * label-for-label identical to omitting `transfer` entirely. At a NON-ZERO
 * factor it proves CONSISTENCY, not optimality. The margin steps at each
 * hour boundary, so a later arrival can demand a smaller margin and
 * prune-by-earliest-arrival stops being a true dominance relation -- and the
 * oracle prunes the same way, so the two agree *because they are wrong
 * together*, not because neither is wrong. The cost of that is deliberately
 * accepted and is pinned, with a worked 7300-second counterexample, by
 * `raptor.test.ts`'s "KNOWN LIMITATION" test. Read that test's comment before
 * concluding either side has a bug there.
 *
 * A second, measured blind spot, recorded so nobody assumes more coverage
 * than exists: this generator is a weak net for anything that depends on a
 * single headway VALUE being wrong. Instrumented over the 400 trials below,
 * the margin is charged at ~17,000 boardings, of which only ~7 sit on a
 * headway where a 16-bit table's truncation would have changed `required` --
 * and none of those 7 happened to be on a best journey's critical path, so
 * the harness stayed green against a table that stored an 18-hour gap as
 * zero. `headway.test.ts` guards that directly instead.
 *
 * Deterministic seed 20260822, 400 trials (see `TRIALS` below) — chosen to
 * run in well under a second while still exercising dwell times, multi-day
 * calendars, loop routes, footpaths with both pre-expanded and raw origins,
 * and trip filters, mixed randomly per trial from the same seed.
 */

// ---------------------------------------------------------------- PRNG
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Trip = { stops: number[]; dep: number[]; arr: number[] };

// ---------------------------------------------------------------- index build
// Same shape as raptor.test.ts's local `makeIndex` (deliberately duplicated,
// not shared -- see raptor.test.ts's header note that extracting a common
// fixture helper is a later task).
function makeIndex(nStops: number, trips: Trip[], foot: [number, number, number][]): TimetableIndex {
  const tripTimes: TripTimes[] = trips.map((t) => ({
    stops: Int32Array.from(t.stops),
    departures: Int32Array.from(t.dep),
    arrivals: Int32Array.from(t.arr),
  }));
  const patterns = buildPatterns(tripTimes);

  const tripTimeOffset = new Int32Array(trips.length + 1);
  for (let i = 0; i < trips.length; i++) tripTimeOffset[i + 1] = tripTimeOffset[i]! + trips[i]!.stops.length;
  const total = tripTimeOffset[trips.length]!;
  const arrivalTime = new Int32Array(total);
  const departureTime = new Int32Array(total);
  for (let i = 0; i < trips.length; i++) {
    arrivalTime.set(tripTimes[i]!.arrivals, tripTimeOffset[i]!);
    departureTime.set(tripTimes[i]!.departures, tripTimeOffset[i]!);
  }

  const counts = new Int32Array(nStops);
  for (let p = 0; p < patterns.nPatterns; p++) {
    for (let i = patterns.patternStopOffset[p]!; i < patterns.patternStopOffset[p + 1]!; i++) {
      counts[patterns.patternStops[i]!]!++;
    }
  }
  const stopPatternOffset = new Int32Array(nStops + 1);
  for (let s = 0; s < nStops; s++) stopPatternOffset[s + 1] = stopPatternOffset[s]! + counts[s]!;
  const stopPatterns = new Int32Array(stopPatternOffset[nStops]!);
  const stopPatternPos = new Int32Array(stopPatternOffset[nStops]!);
  const fill = stopPatternOffset.slice(0, nStops);
  for (let p = 0; p < patterns.nPatterns; p++) {
    const from = patterns.patternStopOffset[p]!;
    for (let i = from; i < patterns.patternStopOffset[p + 1]!; i++) {
      const s = patterns.patternStops[i]!;
      const at = fill[s]!;
      stopPatterns[at] = p; stopPatternPos[at] = i - from; fill[s] = at + 1;
    }
  }

  const footOffset = new Int32Array(nStops + 1);
  const perStop = new Map<number, [number, number][]>();
  for (const [f, t, s] of foot) {
    const b = perStop.get(f);
    if (b === undefined) perStop.set(f, [[t, s]]); else b.push([t, s]);
  }
  const footTarget: number[] = []; const footSeconds: number[] = [];
  for (let s = 0; s < nStops; s++) {
    footOffset[s] = footTarget.length;
    for (const [t, secs] of perStop.get(s) ?? []) { footTarget.push(t); footSeconds.push(secs); }
  }
  footOffset[nStops] = footTarget.length;

  return {
    ...patterns, nStops, nTrips: trips.length,
    tripTimeOffset, arrivalTime, departureTime,
    stopPatterns, stopPatternPos, stopPatternOffset,
    footOffset, footTarget: Int32Array.from(footTarget), footSeconds: Int32Array.from(footSeconds),
  } as unknown as TimetableIndex;
}

// ---------------------------------------------------------------- oracle
type Net = {
  nStops: number; trips: Trip[]; foot: [number, number, number][];
  days: { baseEpoch: number; active: number[] }[];
  origins: { stopIdx: number; secondsToReach: number }[];
  departAfterEpoch: number; maxRounds: number; transferMinSeconds: number;
  /** `0` restores today's flat behaviour exactly. */
  transferFactor: number;
  transferCapSeconds: number;
  /** When false, `q.transfer` is left off the query entirely -- absent must
   *  be exactly as inert as a zero factor. */
  passTransfer: boolean;
  /** "These origins are riders already aboard a vehicle" -- `/plan/onboard`'s
   *  own query shape. Sampled by `genNet` so the flag is exercised across the
   *  whole random corpus rather than only at the three hand-built points
   *  `raptor.test.ts` pins. It changes exactly two terms of the rule, both
   *  restated below independently rather than read off the implementation:
   *  an access-kind state now owes the base buffer (it is a rider stepping
   *  OFF one vehicle, which is the same physical act a transit-kind state
   *  already pays for), and `hasRidden` is true from the start (the
   *  first-boarding exemption exists because a first boarding has no
   *  incoming vehicle to be late -- here it has one, and it is the reason
   *  the query was asked). */
  originsOnVehicle: boolean;
  filtered: number[]; // trip indices excluded (empty => no filter)
};

// ---------------------------------------------------------------- the rule, re-derived
// Everything from here to `oracleExtraSeconds` is a deliberate, independent
// restatement of the margin rule from the random network's own trip
// departure times. It must NOT call `headway.ts`: if the oracle asked the
// implementation what the headway was, this test would only prove the
// implementation agrees with itself, which is precisely the failure mode
// this harness exists to prevent.
//
// What is taken from the index is the pattern *grouping* (`patternOfTrip`)
// and nothing else. That is a structural fact about the network -- same stop
// sequence, no overtaking -- which this file already depends on to run
// RAPTOR at all, which `patterns.test.ts` and the regression test below
// test in their own right, and which no restatement of the headway rule
// could sensibly re-derive. The rule itself -- active departures in
// departure order, each consecutive pair contributing one gap attributed to
// the hour bucket of the EARLIER departure, median per bucket, clamp between
// base and cap, unmeasured takes the cap -- is written out here from the
// spec.

const ORACLE_HOURS = 30; // service days legitimately run past midnight

function oracleMedian(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * The pattern's NOMINAL travel seconds from its first stop to each of its
 * stops, taken from the pattern's first trip -- the pointwise-earliest one,
 * which is what `buildPatterns` puts first and which this file identifies by
 * its own comparison rather than by reading the index's ordering.
 *
 * Computed over ALL of the pattern's trips, never only the active ones: the
 * offset is a property of the timetable's shape and is fixed once per feed,
 * not per service day.
 */
function oraclePatternOffsets(
  net: Net, patternOfTrip: Int32Array, pattern: number,
): number[] {
  let first: Trip | null = null;
  for (let t = 0; t < net.trips.length; t++) {
    if (patternOfTrip[t] !== pattern) continue;
    const cand = net.trips[t]!;
    if (first === null) { first = cand; continue; }
    // Pointwise-earliest, interleaving departure and arrival at each stop --
    // the pattern invariant guarantees one of any two trips dominates the
    // other, so "earliest at the first differing value" is a total order.
    for (let i = 0; i < cand.dep.length; i++) {
      if (cand.dep[i]! !== first.dep[i]!) {
        if (cand.dep[i]! < first.dep[i]!) first = cand;
        break;
      }
      if (cand.arr[i]! !== first.arr[i]!) {
        if (cand.arr[i]! < first.arr[i]!) first = cand;
        break;
      }
    }
  }
  if (first === null) return [];
  const origin = first.dep[0]!;
  return first.dep.map((d) => d - origin);
}

/**
 * `hw[pattern][position][hour]` for one service day: the median gap between
 * consecutive ACTIVE departures of that pattern, attributed to the hour a
 * rider BOARDING AT THAT POSITION would be boarding in. `Infinity` means no
 * gap was attributed to the hour -- an hour with no departure, or one holding
 * only the day's last departure -- which takes the cap, never the base.
 *
 * The gap MAGNITUDE is read at the pattern's first stop and is exact
 * everywhere: trips within a pattern never overtake, so consecutive
 * departures are the same distance apart at every position along it. The
 * HOUR is not, and a naive oracle could easily assume it was -- which is
 * exactly the trap: if both this oracle and the implementation bucketed at
 * the first stop, they would agree with each other while disagreeing with
 * the rule. A gap belongs to the hour the rider boards in, and that is
 * `dep[0] + travel offset to this position`.
 *
 * Note the mechanism is deliberately the OPPOSITE of the implementation's.
 * `headway.ts` keeps one table per (pattern, hour) keyed in first-stop time
 * and shifts the LOOKUP back by the offset; this oracle shifts the
 * TABULATION forward and looks up at the raw boarding hour. Same rule, and
 * neither can inherit the other's mistake.
 */
function oracleHeadway(
  net: Net, dayIdx: number, patternOfTrip: Int32Array, nPatterns: number,
): number[][][] {
  const day = net.days[dayIdx]!;
  const depsByPattern: number[][] = Array.from({ length: nPatterns }, () => []);
  for (let t = 0; t < net.trips.length; t++) {
    if (day.active[t] !== 1) continue; // per-service-day mask
    depsByPattern[patternOfTrip[t]!]!.push(net.trips[t]!.dep[0]!);
  }

  const out: number[][][] = [];
  for (let p = 0; p < nPatterns; p++) {
    const deps = [...depsByPattern[p]!].sort((a, b) => a - b);
    const offsets = oraclePatternOffsets(net, patternOfTrip, p);
    const perPos: number[][] = [];
    for (const offset of offsets) {
      const byHour: number[][] = Array.from({ length: ORACLE_HOURS }, () => []);
      for (let i = 0; i + 1 < deps.length; i++) {
        const hour = Math.floor((deps[i]! + offset) / 3600); // never modulo a GTFS time
        if (hour >= ORACLE_HOURS) continue;
        byHour[hour]!.push(deps[i + 1]! - deps[i]!);
      }
      perPos.push(byHour.map((gaps) => (gaps.length === 0 ? Infinity : oracleMedian(gaps))));
    }
    out.push(perPos);
  }
  return out;
}

/**
 * The seconds of margin this network's rule demands ON TOP of what the
 * boarding check already charges: `required(headway) - baseSeconds`, floored
 * at zero. Floored because boarding may only ever become HARDER -- the
 * dominance argument in `raptor.ts` depends on that and so does termination.
 *
 * The floor is not decoration: `requiredTransferSeconds` genuinely returns
 * BELOW `baseSeconds` when `capSeconds < baseSeconds`, because the clamp
 * applies the cap last. `genNet` never generates that combination (it is
 * refused at boot), so the dedicated test in `raptor.test.ts` covers it
 * instead -- but the floor is written here too so the two sides state the
 * same rule.
 */
function oracleExtraSeconds(
  net: Net, hw: number[][][], patternIdx: number, patternPos: number,
  secondsIntoDay: number, hasRidden: boolean,
): number {
  if (net.transferFactor === 0) return 0; // the off switch, unconditionally
  // The margin insures against a LATE INCOMING VEHICLE, so it is
  // charged only once the traveller has actually ridden one. The first
  // boarding of a journey has no feeder to be late, and charging it there
  // costs a full headway for nothing.
  if (!hasRidden) return 0;
  const hour = Math.floor(secondsIntoDay / 3600); // never modulo a GTFS time
  const headway = hour < 0 || hour >= ORACLE_HOURS
    ? Infinity
    : hw[patternIdx]![patternPos]![hour]!;
  // Unmeasured takes the cap directly; it is never multiplied by the factor,
  // because it is the absence of a measurement, not a large real headway.
  const scaled = headway === Infinity ? net.transferCapSeconds : net.transferFactor * headway;
  const required = Math.round(
    Math.min(Math.max(scaled, net.transferMinSeconds), net.transferCapSeconds),
  );
  return Math.max(0, required - net.transferMinSeconds);
}

/**
 * Exhaustive enumeration of every legal journey state, with no cleverness.
 * State = (stop, absolute arrival time, kind, trips used). Expand by boarding
 * any trip on any day at any occurrence of the stop, and by taking at most one
 * footpath immediately after a transit OR access leg (never after a walk --
 * that's the "no chaining" design `raptor.ts` implements). Dedupe on the
 * exact tuple to halt. Returns oracle[k][stop] = min arrival using AT MOST k
 * trips.
 */
function oracle(net: Net, patternOfTrip: Int32Array, nPatterns: number): number[][] {
  const K = net.maxRounds;
  const hw = net.days.map((_, d) => oracleHeadway(net, d, patternOfTrip, nPatterns));
  const bestBy: number[][] = [];
  for (let k = 0; k <= K; k++) bestBy.push(new Array<number>(net.nStops).fill(Infinity));

  const seenBest = new Map<string, number>();
  type S = { stop: number; time: number; kind: "access" | "transit" | "walk"; k: number };
  const stack: S[] = [];
  const push = (s: S): void => {
    const key = `${s.stop}|${s.kind}|${s.k}`;
    const prev = seenBest.get(key);
    if (prev !== undefined && prev <= s.time) return;
    seenBest.set(key, s.time); stack.push(s);
    if (s.time < bestBy[s.k]![s.stop]!) bestBy[s.k]![s.stop] = s.time;
  };

  for (const o of net.origins) {
    push({ stop: o.stopIdx, time: net.departAfterEpoch + o.secondsToReach, kind: "access", k: 0 });
  }

  const excluded = new Set(net.filtered);

  // Which trips belong to which pattern. The last-service fallback below is
  // stated PER PATTERN ("has this pattern a later trip today?"), so the enumeration
  // has to be grouped that way; `patternOfTrip` is the same structural fact
  // about the network this file already takes from the index (see the note
  // above `oracleHeadway`), and nothing about the rule itself is imported.
  const tripsOfPattern: number[][] = Array.from({ length: nPatterns }, () => []);
  for (let t = 0; t < net.trips.length; t++) tripsOfPattern[patternOfTrip[t]!]!.push(t);

  while (stack.length > 0) {
    const st = stack.pop()!;
    // --- board a trip
    if (st.k < K) {
      // The candidate boarding instant, before the headway-scaled margin: a
      // transit label still owes the base buffer, a walk label already had it
      // baked into its footpath seconds, an access label never owed it.
      const base = st.time + (st.kind === "transit"
        || (net.originsOnVehicle && st.kind === "access") ? net.transferMinSeconds : 0);
      // "Has this traveller ridden a vehicle yet?" Derived
      // here from the trip COUNT, which is the honest statement of the rule
      // and is deliberately a different mechanism from the one `raptor.ts`
      // must use: RAPTOR carries round-0 labels forward through `prev.slice()`
      // and so cannot read a round index, and has to walk a label's
      // predecessor instead. `k > 0` holds exactly when at least one trip has
      // been boarded, since only a transit expansion increments it and a
      // footpath carries it through unchanged -- so an access-rooted walk,
      // the case `label.kind === "access"` alone would miss, is still k === 0.
      // ...unless this query's own origins are riders already ON a vehicle
      // (`/plan/onboard`), in which case there is a feeder from the very
      // first boarding: the one the rider is sitting on.
      const hasRidden = st.k > 0 || net.originsOnVehicle;
      for (let d = 0; d < net.days.length; d++) {
        const day = net.days[d]!;
        for (let p = 0; p < nPatterns; p++) {
          const members = tripsOfPattern[p]!
            .filter((t) => day.active[t] === 1 && !excluded.has(t));
          if (members.length === 0) continue;
          // Every trip of a pattern runs the same stop sequence, so any
          // member names the positions `st.stop` occupies on all of them.
          const stops = net.trips[members[0]!]!.stops;
          for (let i = 0; i < stops.length; i++) {
            if (stops[i] !== st.stop) continue;
            // The margin is a property of (pattern, POSITION, hour, service
            // day) ONLY -- never of the trip that ends up boarded, which
            // would be circular (a larger margin pushes the search to a later
            // trip, whose headway may differ, which changes the margin). The
            // hour comes from the candidate instant `base` expressed in THIS
            // day's service-day seconds, not from wall clock and not from
            // `ready`. It is computed INSIDE the position loop because the
            // hour a rider boards in depends on how far down the pattern they
            // are boarding -- see `oracleHeadway`.
            const ready = base + oracleExtraSeconds(
              net, hw[d]!, p, i, base - day.baseEpoch, hasRidden,
            );
            // The margin YIELDS at the last service of the day.
            // If nothing on this pattern departs this position, on this
            // service day, at or after `ready`, then demanding `ready` does
            // not move the rider to a later trip -- it deletes the journey.
            // The rule falls back to the flat `base`, which is exactly the
            // pre-branch requirement, so boarding never becomes easier than
            // it already was. Stated here from the network's own departure
            // times, per pattern.
            const hasLaterTrip = members
              .some((t) => day.baseEpoch + net.trips[t]!.dep[i]! >= ready);
            const threshold = hasLaterTrip ? ready : base;
            for (const t of members) {
              const tr = net.trips[t]!;
              if (day.baseEpoch + tr.dep[i]! < threshold) continue;
              for (let j = i + 1; j < tr.stops.length; j++) {
                push({ stop: tr.stops[j]!, time: day.baseEpoch + tr.arr[j]!, kind: "transit", k: st.k + 1 });
              }
            }
          }
        }
      }
    }
    // --- one footpath: from a transit leg always, from access because
    // raptor.ts now relaxes footpaths from round-0 access labels too, never
    // chained onto another walk.
    const canWalk = st.kind === "transit" || st.kind === "access";
    if (canWalk) {
      for (const [f, to, secs] of net.foot) {
        if (f !== st.stop) continue;
        push({ stop: to, time: st.time + secs, kind: "walk", k: st.k });
      }
    }
  }

  for (let k = 1; k <= K; k++) {
    for (let s = 0; s < net.nStops; s++) {
      if (bestBy[k - 1]![s]! < bestBy[k]![s]!) bestBy[k]![s] = bestBy[k - 1]![s]!;
    }
  }
  return bestBy;
}

// ---------------------------------------------------------------- generator
const BASE = 1_787_000_000;

function genNet(
  rnd: () => number,
  opts: {
    multiDay: boolean; loops: boolean; dwell: boolean; foot: boolean;
    rawOrigins: boolean; wideDay: boolean;
  },
): Net {
  const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
  const nStops = ri(4, 8);

  const nPatterns = ri(2, 5);
  const trips: Trip[] = [];
  for (let p = 0; p < nPatterns; p++) {
    const len = ri(2, Math.min(5, nStops));
    const seq: number[] = [];
    for (let i = 0; i < len; i++) seq.push(ri(0, nStops - 1));
    if (opts.loops && rnd() < 0.5 && seq.length >= 3) seq[seq.length - 1] = seq[0]!; // loop route
    const nTrips = ri(1, 4);
    for (let q = 0; q < nTrips; q++) {
      const dep: number[] = []; const arr: number[] = [];
      // `wideDay` spreads a pattern's trips across a whole service day
      // instead of the first hour. Without it this generator cannot produce a
      // gap anywhere near 65536 s, which is the band where an undersized
      // headway table would silently truncate -- a gap of exactly 65536 s
      // stored in a `Uint16Array` reads back as 0, inverting the rule at the
      // single most expensive miss there is. The narrow generator's only
      // large gaps (the ~86400 s multi-day jump) truncate to values that
      // still exceed every generated `capSeconds / factor` and so clamp to
      // the same answer either way, which is why that band needs deliberate
      // coverage rather than being left to chance.
      // Two clusters, deliberately straddling 65536 s, so that gaps between
      // a pattern's trips land in the band where a 16-bit table wraps. A
      // uniform spread over the day puts a
      // gap in the band that actually changes `required` about once per 330
      // trials, far too rare for a 400-trial suite. Biasing the INPUT
      // distribution toward a known-dangerous region is a property-test
      // generator doing its job; nothing about the oracle's own rule changes.
      // The departure grid is a coverage decision rather than an
      // arbitrary one. The margin STEPPING at an hour boundary is the whole
      // subject of the hour-bucketing approximation, and of the
      // position-shift rule -- so a grid that puts every generated gap in
      // one or two hour buckets cannot exercise either. A narrower grid
      // limited to `ri(0, 12) * 300` (0-3600 s, plus wideDay's two tight
      // clusters) produces gaps in only 4 buckets with a single interior
      // boundary in the entire distribution, while a grid modeled on the
      // reverse harness's `ri(0, 90) * 900` reaches 25. Same class of
      // harness, wildly different coverage, if the grid is chosen carelessly.
      //
      // Both branches span a wide range without losing what a narrow grid is
      // for: the ordinary branch spans six hours on a 900 s grid, and
      // wideDay keeps BOTH clusters straddling 65536 s (the band where a
      // 16-bit table would silently wrap -- see the note above) while adding
      // a uniform whole-day third.
      let t = opts.wideDay
        ? (rnd() < 0.35
          ? ri(0, 12) * 300
          : rnd() < 0.54 ? 65400 + ri(0, 40) * 30 : ri(0, 90) * 900)
        : ri(0, 24) * 900 + (opts.multiDay && rnd() < 0.4 ? 86400 : 0);
      for (let i = 0; i < len; i++) {
        const a = t;
        const dwell = opts.dwell ? ri(0, 2) * 60 : 0;
        arr.push(a); dep.push(a + dwell);
        t = a + dwell + ri(1, 4) * 300;
      }
      trips.push({ stops: seq, dep, arr });
    }
  }

  const foot: [number, number, number][] = [];
  if (opts.foot) {
    const nFoot = ri(0, 4);
    for (let i = 0; i < nFoot; i++) {
      const a = ri(0, nStops - 1); const b = ri(0, nStops - 1);
      if (a === b) continue;
      foot.push([a, b, ri(1, 4) * 300]);
    }
  }

  const days: { baseEpoch: number; active: number[] }[] = [];
  const nDays = opts.multiDay ? 2 : 1;
  for (let d = 0; d < nDays; d++) {
    const active: number[] = [];
    for (let t = 0; t < trips.length; t++) active.push(rnd() < 0.75 ? 1 : 0);
    days.push({ baseEpoch: d === 0 ? BASE : BASE - 86400, active });
  }

  const rawOrigins: { stopIdx: number; secondsToReach: number }[] = [];
  const nOrigins = ri(1, 2);
  for (let i = 0; i < nOrigins; i++) {
    rawOrigins.push({ stopIdx: ri(0, nStops - 1), secondsToReach: ri(0, 3) * 300 });
  }

  // Unless testing raw (unexpanded) origins, emulate the real caller: the
  // access list from an origin point already contains every stop within
  // walking radius, one footpath hop out.
  let origins = rawOrigins;
  if (opts.foot && !opts.rawOrigins) {
    const m = new Map<number, number>();
    for (const o of rawOrigins) {
      const c = m.get(o.stopIdx);
      if (c === undefined || o.secondsToReach < c) m.set(o.stopIdx, o.secondsToReach);
    }
    for (const o of rawOrigins) {
      for (const [f, t, secs] of foot) {
        if (f !== o.stopIdx) continue;
        const v = o.secondsToReach + secs;
        const c = m.get(t);
        if (c === undefined || v < c) m.set(t, v);
      }
    }
    origins = [...m].map(([stopIdx, secondsToReach]) => ({ stopIdx, secondsToReach }));
  }

  const filtered: number[] = [];
  if (rnd() < 0.25) {
    for (let t = 0; t < trips.length; t++) if (rnd() < 0.2) filtered.push(t);
  }

  // `0` is weighted into the factor set so that most trials still exercise
  // today's exact behaviour -- with a zero factor the planner must be
  // byte-identical to its flat-buffer behaviour, which is the
  // strongest differential guarantee available here and nearly free.
  const transferMinSeconds = [0, 0, 60, 120, 300][ri(0, 4)]!;
  const transferFactor = [0, 0, 0.25, 0.5, 1][ri(0, 4)]!;

  return {
    nStops, trips, foot: opts.foot ? foot : [], days, origins,
    departAfterEpoch: BASE + ri(-4, 8) * 300,
    maxRounds: ri(2, 4),
    transferMinSeconds,
    transferFactor,
    transferCapSeconds: Math.max(transferMinSeconds, [300, 600, 900][ri(0, 2)]!),
    // A zero factor must be inert; so must leaving `transfer` off the query
    // altogether, which is how every existing caller runs.
    passTransfer: transferFactor !== 0 || rnd() < 0.5,
    originsOnVehicle: rnd() < 0.35,
    filtered,
  };
}

function toDays(net: Net): DayContext[] {
  return net.days.map((d, i) => ({
    dateYmd: 20260824 + i, baseEpoch: d.baseEpoch, activeTrip: Uint8Array.from(d.active),
  }));
}

function run(net: Net, ix: TimetableIndex): RaptorResult {
  const excluded = new Set(net.filtered);
  const days = toDays(net);
  const cfg: TransferConfig = {
    baseSeconds: net.transferMinSeconds,
    factor: net.transferFactor,
    capSeconds: net.transferCapSeconds,
  };
  return runRaptor(ix, {
    origins: net.origins, destinations: [], // no destinations => no bound pruning
    departAfterEpoch: net.departAfterEpoch, days,
    maxRounds: net.maxRounds, transferMinSeconds: net.transferMinSeconds,
    tripFilter: net.filtered.length > 0 ? (t: number) => !excluded.has(t) : undefined,
    originsOnVehicle: net.originsOnVehicle,
    // One table per DayContext: headway is per service day, and
    // "yesterday, 25:30" is a different row of a different day's table from
    // "today, 01:30".
    transfer: net.passTransfer
      ? { cfg, headway: days.map((day) => buildHeadwayTable(ix, day)) }
      : undefined,
  });
}

function fmt(v: number): string { return v === Infinity ? "none" : String(v); }

function compareAllStops(net: Net): string[] {
  const ix = makeIndex(net.nStops, net.trips, net.foot);
  const res = run(net, ix);
  const orc = oracle(net, ix.patternOfTrip, ix.nPatterns);
  const out: string[] = [];
  for (let k = 0; k <= net.maxRounds; k++) {
    const row = res.rounds[k] ?? res.rounds[res.rounds.length - 1]!;
    for (let s = 0; s < net.nStops; s++) {
      const l = row[s];
      const got = l === null || l === undefined ? Infinity : l.arrivalEpoch;
      const want = orc[k]![s]!;
      if (got !== want) {
        out.push(`k=${k} stop=${s} raptor=${fmt(got)} oracle=${fmt(want)} ${got > want ? "[RAPTOR MISSED]" : "[RAPTOR TOO OPTIMISTIC]"}`);
      }
    }
  }
  return out;
}

// Deterministic seed, low trial count -- see the module doc comment above.
const SEED = 20260822;
/**
 * 400, measured against this harness's own mutants rather than chosen.
 *
 * The last-service fallback, deleted outright, disagrees at trial 0 -- this
 * count catches it many times over. Two other mutants need naming, because
 * both survive this count:
 *
 *  - The boarding check's GATE, narrowed from `base <= currentDep` back to
 *    `ready <= currentDep` (which skips the fallback whenever the scan
 *    already holds a later trip), first disagrees at trial **2433**.
 *  - The POSITION SHIFT, dropped from `extraBoardingSeconds` so
 *    the table is read at the rider's raw boarding instant rather than
 *    shifted back to first-stop time, first disagrees at trial **8175** --
 *    and would disagree at NO trial count at all if this oracle bucketed
 *    gaps at the pattern's first stop the way an implementation easily
 *    could: the oracle making the identical assumption as the code under
 *    test is exactly what lets a defect like this hide indefinitely,
 *    regardless of trial count.
 *
 * Neither raises this count, on the reasoning
 * `raptorReverse.oracle.test.ts`'s own TRIALS comment sets out: both die
 * deterministically in `raptor.test.ts` ("the fallback is reachable even
 * when the scan already holds a later trip" and "the margin is charged for
 * the hour the rider BOARDS in"), and named regressions are the real guard.
 * These trials are here to find the defect nobody thought to name. Raise it,
 * never lower it, if a future mutant survives this AND cannot be pinned
 * deterministically.
 */
const TRIALS = 400;

test("property: RAPTOR matches a brute-force oracle across many random networks", () => {
  const rnd = mulberry32(SEED);
  for (let n = 0; n < TRIALS; n++) {
    const opts = {
      multiDay: rnd() < 0.35,
      loops: rnd() < 0.35,
      dwell: rnd() < 0.35,
      foot: rnd() < 0.6,
      rawOrigins: rnd() < 0.3,
      wideDay: rnd() < 0.3,
    };
    const net = genNet(rnd, opts);
    const diffs = compareAllStops(net);
    assert.equal(
      diffs.length, 0,
      `trial ${n} (opts=${JSON.stringify(opts)}) disagreed with the oracle:\n` +
        diffs.slice(0, 5).join("\n") +
        `\nnet=${JSON.stringify(net)}`,
    );
  }
});

test("the off switch is exact: a zero factor and an absent `transfer` give identical labels", () => {
  // `TRANSFER_HEADWAY_FACTOR=0` promises to restore today's planner
  // exactly. The trial loop above already runs many zero-factor networks
  // against the oracle, but this pins the stronger, cheaper form of the same
  // claim directly: for the SAME network, threading a zero-factor `transfer`
  // through the query must produce label-for-label the same result as leaving
  // `transfer` off entirely, which is how every caller without the headway
  // feature configured runs. No brute-force oracle here, so it can afford many more networks.
  const rnd = mulberry32(SEED + 1);
  for (let n = 0; n < 3000; n++) {
    const opts = {
      multiDay: rnd() < 0.35, loops: rnd() < 0.35, dwell: rnd() < 0.35,
      foot: rnd() < 0.6, rawOrigins: rnd() < 0.3, wideDay: rnd() < 0.3,
    };
    const net = genNet(rnd, opts);
    const ix = makeIndex(net.nStops, net.trips, net.foot);
    const off = run({ ...net, transferFactor: 0, passTransfer: true }, ix);
    const absent = run({ ...net, transferFactor: 0, passTransfer: false }, ix);
    for (let k = 0; k < off.rounds.length; k++) {
      for (let st = 0; st < net.nStops; st++) {
        const a = off.rounds[k]![st];
        const b = absent.rounds[k]![st];
        assert.equal(
          a === null || a === undefined ? null : a.arrivalEpoch,
          b === null || b === undefined ? null : b.arrivalEpoch,
          `trial ${n} k=${k} stop=${st}: a zero factor changed the result\nnet=${JSON.stringify(net)}`,
        );
        assert.equal(a?.kind ?? null, b?.kind ?? null, `trial ${n} k=${k} stop=${st}: kind differs`);
        assert.equal(a?.tripIdx ?? null, b?.tripIdx ?? null, `trial ${n} k=${k} stop=${st}: trip differs`);
        assert.equal(a?.boardEpoch ?? null, b?.boardEpoch ?? null, `trial ${n} k=${k} stop=${st}: boarding differs`);
      }
    }
  }
});

// ---------------------------------------------------------------- targeted regressions
// One test per defect found by the oracle above, using minimal
// reproducers, so a future regression names the specific bug instead of just
// "the oracle disagreed".

test("regression: an exact departure tie keeps the earlier-indexed, not later-arriving, trip", () => {
  // Pattern [0,1,2]. Trip A departs stop 1 at 3000, arrives stop 2 at 3300.
  // Trip B also departs stop 1 at 3000 (a tie), but arrives stop 2 at 4200.
  // Pattern order places A before B (A <= B pointwise). Riding B from stop 0,
  // the traveller could switch to A at stop 1 (same departure, earlier
  // arrival); comparing by departure epoch alone can't see that tie should
  // still swap, but comparing by pattern-local index does.
  const ix = makeIndex(3, [
    { stops: [0, 1, 2], dep: [2100, 3000, 3300], arr: [2100, 3000, 3300] }, // A
    { stops: [0, 1, 2], dep: [2700, 3000, 4200], arr: [2700, 3000, 4200] }, // B
  ], []);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 900 }, { stopIdx: 1, secondsToReach: 300 }],
    destinations: [], departAfterEpoch: BASE + 1500,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![2]!.arrivalEpoch, BASE + 3300);
});

test("regression: a trip on a different DayContext with an earlier absolute departure is not preferred over a same-day trip that arrives sooner", () => {
  // One pattern, two trips: today's trip departs later (absolute) than
  // yesterday's late-running trip, but arrives sooner. The DayContext
  // ordering invariant only holds within a single day's calendar, so
  // comparing the two trips' raw absolute departures across days and taking
  // the smaller one is not valid; each day must be searched independently and
  // merged by ARRIVAL.
  const ix = makeIndex(3, [
    { stops: [0, 1, 2], dep: [1560, 2520, 2820], arr: [1560, 2520, 2820] }, // today
    { stops: [0, 1, 2], dep: [87960, 88320, 89520], arr: [87960, 88320, 89520] }, // yesterday
  ], []);
  const days: DayContext[] = [
    { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 0]) },
    { dateYmd: 20260824, baseEpoch: BASE - 86400, activeTrip: Uint8Array.from([0, 1]) },
  ];
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }, { stopIdx: 1, secondsToReach: 0 }],
    destinations: [], departAfterEpoch: BASE + 900, days, maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![2]!.arrivalEpoch, BASE + 2820);
});

test("regression: trips ordered by departure but crossing in arrival (dwell difference) are split into separate patterns", () => {
  const a: Trip = { stops: [0, 1, 2], dep: [1320, 2520, 3000], arr: [1200, 2520, 3000] };
  const b: Trip = { stops: [0, 1, 2], dep: [2160, 2580, 3300], arr: [2100, 2460, 3180] };
  const set = buildPatterns([
    { stops: Int32Array.from(a.stops), departures: Int32Array.from(a.dep), arrivals: Int32Array.from(a.arr) },
    { stops: Int32Array.from(b.stops), departures: Int32Array.from(b.dep), arrivals: Int32Array.from(b.arr) },
  ]);
  assert.equal(set.nPatterns, 2, "trips crossing in arrival despite ordered departures must split");

  const ix = makeIndex(3, [a, b], []);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [], departAfterEpoch: BASE + 300,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 2460);
});

test("regression: a footpath is relaxed from a round-0 access label, not only from transit arrivals", () => {
  // Stop 1 is on no trip at all; the only way to reach it is a footpath
  // straight from the origin's access label, with zero trips ridden.
  const ix = makeIndex(3, [{ stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] }], [[0, 1, 300]]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 3000,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[0]![1]!.arrivalEpoch, BASE + 3300);
  assert.equal(res.rounds[0]![1]!.kind, "walk");
});

test("regression: the footpath phase does not chain two walks together in one round", () => {
  // Stop 1 and stop 2 are both reached by transit this round; walking
  // 1->2 beats stop 2's own transit arrival, but that improved walk label
  // must not itself be walked onward to stop 3 -- only the ORIGINAL transit
  // arrival at stop 2 may source a walk, and a walk-to-walk hop is excluded
  // entirely by design (a walk-to-walk hop is just a longer walk, which the
  // footpath radius already excludes).
  const ix = makeIndex(5, [
    { stops: [0, 1], dep: [3600, 3660], arr: [3600, 3660] }, // reaches stop 1 at 3660
    { stops: [0, 2], dep: [3600, 9000], arr: [3600, 9000] }, // reaches stop 2 at 9000
  ], [[1, 2, 300], [2, 3, 300]]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 3000,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  const r1 = res.rounds[1]!;
  // Stop 2 does get a cheaper WALK label from stop 1 (3660 + 300 = 3960) --
  // that's a legitimate single hop off a transit-derived stop and is not
  // itself the bug.
  assert.equal(r1[2]!.arrivalEpoch, BASE + 3960);
  assert.equal(r1[2]!.kind, "walk");
  // But stop 3 must NOT be reachable by chaining that walk onward: the only
  // non-chained route to stop 3 is via stop 2's genuine TRANSIT arrival
  // (9000) + one walk (300) = 9300, not 3660 + 300 + 300 = 4260.
  assert.equal(r1[3]!.arrivalEpoch, BASE + 9300);
});

// ---------------------------------------------------------------- footpath-visited regressions
// A provenance bug the `visited` broadening amplified, and a sixth,
// narrower gap in the same area.

test("regression: a walk label's predecessor is the exact label it was built from, even after that stop's own stored label is later overwritten", () => {
  // Two independent trips from the origin: trip0 reaches stop 1 via transit
  // at 50; trip1 reaches stop 2 via transit at 100. A footpath 1->2 (30s)
  // then improves stop 2 to a WALK arrival of 80 (50+30 < 100), overwriting
  // stop 2's own stored round-1 label from transit@100 to walk@80. A second
  // footpath 2->3 (20s) is sourced from `visited`'s entry for stop 2, which
  // is stop 2's ORIGINAL transit@100 visit captured before that overwrite --
  // not a live re-read of stop 2's (now-overwritten) current label.
  const ix = makeIndex(4, [
    { stops: [0, 1], dep: [0, 50], arr: [0, 50] },
    { stops: [0, 2], dep: [0, 100], arr: [0, 100] },
  ], [[1, 2, 30], [2, 3, 20]]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 2, transferMinSeconds: 0,
  });
  const r1 = res.rounds[1]!;

  // Stop 2's own round-1 label did get overwritten to the cheaper walk.
  assert.equal(r1[2]!.arrivalEpoch, BASE + 80);
  assert.equal(r1[2]!.kind, "walk");

  // Stop 3's walk label names stop 2 as `fromStop`...
  const stop3 = r1[3]!;
  assert.equal(stop3.arrivalEpoch, BASE + 120);
  assert.equal(stop3.fromStop, 2);
  // ...but the label it was ACTUALLY built from is stop 2's original transit
  // arrival (100), captured directly -- not stop 2's current stored label
  // (which is walk@80, a completely different object, by the time anyone
  // looks). A reconstruction that naively followed `rounds[k][fromStop]`
  // instead of `predecessor` would silently substitute the wrong leg here.
  assert.equal(stop3.predecessor!.kind, "transit");
  assert.equal(stop3.predecessor!.arrivalEpoch, BASE + 100);
  assert.notEqual(stop3.predecessor, r1[stop3.fromStop]);
});

test("regression: a walk label wins an exact arrival tie against a transit label, enabling a zero-buffer boarding", () => {
  // Stop 2 is reached at 360 two ways in the same round: via transit (a
  // direct trip from the origin, so onward boarding needs the 60s transfer
  // buffer -- ready 420) and, independently, via a footpath from stop 1's
  // earlier transit arrival at 300 (footpath cost 60, so also landing
  // exactly at 360, but as a WALK -- no extra buffer, ready 360). A third
  // trip departs stop 2 at exactly 360: boardable only from the walk-kind
  // arrival (360 <= 360), not the transit-kind one (420 > 360). If the walk
  // loses the tie, this connection -- and the destination -- is missed.
  const ix = makeIndex(4, [
    { stops: [0, 1], dep: [0, 300], arr: [0, 300] }, // reaches stop 1 at 300
    { stops: [0, 2], dep: [0, 360], arr: [0, 360] }, // reaches stop 2 at 360 (transit)
    { stops: [2, 3], dep: [360, 480], arr: [360, 480] }, // departs stop 2 at exactly 360
  ], [[1, 2, 60]]); // stop 1 -> stop 2, 60s: also lands at 360, as a walk
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1, 1]) }],
    maxRounds: 3, transferMinSeconds: 60,
  });
  // Stop 2 is a tie in VALUE (360 either way) but the walk must be the one
  // actually stored, since it's the only one that can still board onward.
  assert.equal(res.rounds[1]![2]!.arrivalEpoch, BASE + 360);
  assert.equal(res.rounds[1]![2]!.kind, "walk");
  assert.equal(res.rounds[2]![3]!.arrivalEpoch, BASE + 480);
});
