import { test } from "node:test";
import assert from "node:assert/strict";
import { runRaptorReverse, type ReverseLabel, type ReverseResult } from "./raptorReverse.js";
import { runRaptor, type DayContext } from "./raptor.js";
import type { TimetableIndex } from "./index.js";
import { makeTestIndex } from "./testIndex.js";
// Imported for the RAPTOR side of the comparison only -- the oracle below
// derives the headway rule itself and never calls into this module.
import { buildHeadwayTable, type TransferConfig } from "./headway.js";

/**
 * Differential test for the reverse pass: runRaptorReverse vs. an exhaustive
 * brute-force oracle over many random small networks, computing the LATEST
 * feasible departure for each transfer count. The mirror of
 * `raptor.oracle.test.ts`, which is what actually found the forward pass's
 * six defects (three of them Critical) that eleven hand-written tests missed
 * entirely -- this file exists so the same class of silent wrong answer gets
 * caught here too, instead of shipping.
 *
 * WHAT THIS HARNESS DOES AND DOES NOT PROVE, with the headway margin in the
 * mix. At a ZERO factor it is still an exact optimality guarantee,
 * and the off-switch test below pins that a zero factor is label-for-label
 * identical to omitting `transfer`. At a NON-ZERO factor it proves
 * CONSISTENCY, not optimality: the reverse pass keeps one label per stop, and
 * under a headway margin two labels that tie (or nearly tie) on departure are
 * no longer equally useful, because the margin an incoming vehicle owes
 * depends on WHICH service that label goes on to board. The oracle prunes the
 * same way, so the two agree because they are wrong together. See
 * `runRaptorReverse`'s comment on the reverse pass's own hour-bucketing
 * limitation for the worked example, and read it before concluding either
 * side has a bug.
 *
 * WHICH HARNESS COVERS WHICH PROPERTY, because the two below are not
 * interchangeable and a reader should not have to reverse-engineer it.
 * `oracleExtraSeconds` restates the reverse pass's READINESS WINDOW -- the
 * widening that exists because reverse cannot know the hour it is charging
 * for -- so the property test structurally CANNOT detect an error in the
 * window rule itself; it would follow the implementation into the same
 * mistake. What it does cover is everything else: the direction of the
 * inequality, which service the margin is measured against, which end is
 * exempt, and which service day's table is read. The window is constrained
 * instead by the cross-check further down, whose `forwardExtraSeconds` is
 * POINTWISE and independent -- it fails if the window is ever too narrow
 * (optimistic), and by construction cannot fail if it is too wide. The
 * too-wide side is pinned by the named readiness-window regression below,
 * and its cost is stated in `extraAlightingSeconds`'s own comment in
 * `raptorReverse.ts`.
 *
 * Deterministic seed 20260822, 4000 trials (see `TRIALS` below, which records
 * what that count was measured against) -- chosen to
 * run in well under a second while still exercising dwell times, multi-day
 * calendars, loop routes (a stop appearing twice in a pattern), footpaths
 * with both pre-expanded and raw destinations, exact departure/arrival ties,
 * two DayContexts competing on one pattern, trip filters, and a headway
 * margin at several factors including zero, mixed randomly per trial from the
 * same seed.
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

// ---------------------------------------------------------------- oracle
type Net = {
  nStops: number; trips: Trip[]; foot: [number, number, number][];
  days: { baseEpoch: number; active: number[] }[];
  destinations: { stopIdx: number; secondsToReach: number }[];
  origins: { stopIdx: number; secondsToReach: number }[];
  arriveByEpoch: number; maxRounds: number; transferMinSeconds: number;
  /** `0` restores today's flat behaviour exactly. */
  transferFactor: number;
  transferCapSeconds: number;
  /** When false, `q.transfer` is left off the query entirely -- absent must
   *  be exactly as inert as a zero factor. */
  passTransfer: boolean;
  filtered: number[]; // trip indices excluded (empty => no filter)
};

// ---------------------------------------------------------------- the rule, re-derived
// Everything down to `oracleExtraSeconds` is an independent restatement of
// the margin rule and of the reverse pass's own physics, written from the
// random network's trip times. It must NOT call `headway.ts`: an oracle that asked
// the implementation what the headway was would only prove the
// implementation agrees with itself.
//
// What is taken from the index is the pattern *grouping* (`patternOfTrip`)
// and nothing else -- a structural fact this file already depends on to run
// RAPTOR at all, and one no restatement of the headway rule could sensibly
// re-derive.

const ORACLE_HOURS = 30; // service days legitimately run past midnight

function oracleMedian(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * The pattern's NOMINAL travel seconds from its first stop to each of its
 * stops, taken from its pointwise-earliest trip -- the mirror of
 * `isLastServiceOfDay`'s pointwise-LATEST criterion below, and computed over
 * ALL of the pattern's trips rather than only the active ones, because the
 * offset is a property of the timetable's shape and is fixed once per feed
 * rather than per service day.
 */
function oraclePatternOffsets(
  net: Net, patternOfTrip: Int32Array, pattern: number,
): number[] {
  let first: Trip | null = null;
  for (let t = 0; t < net.trips.length; t++) {
    if (patternOfTrip[t] !== pattern) continue;
    const cand = net.trips[t]!;
    if (first === null) { first = cand; continue; }
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
 * The gap magnitude is read at the pattern's first stop and is exact
 * everywhere (trips never overtake); the HOUR is not, and a naive oracle
 * could easily assume it was -- exactly the trap where both sides bucket at
 * the first stop and agree with each other rather than with the
 * rule. The tabulation is shifted here while `headway.ts` shifts the lookup
 * instead, so the two state the same rule by opposite mechanisms.
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
    const perPos: number[][] = [];
    for (const offset of oraclePatternOffsets(net, patternOfTrip, p)) {
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

/** `required(headway)` for one hour bucket, clamped between the
 *  base and the cap, with an unmeasured hour taking the cap DIRECTLY (it is
 *  the absence of a measurement, never a large real headway, so it is never
 *  multiplied by the factor). */
function oracleRequired(net: Net, headway: number): number {
  const scaled = headway === Infinity ? net.transferCapSeconds : net.transferFactor * headway;
  return Math.round(Math.min(Math.max(scaled, net.transferMinSeconds), net.transferCapSeconds));
}

/**
 * The seconds of margin an alighting rider owes ON TOP of what the deadline
 * already subtracts, for a connection onto a service departing
 * `boardingSecondsIntoDay` seconds into ITS OWN service day, on pattern
 * `patternIdx`.
 *
 * Derived from the reverse direction's physics, not from the forward code.
 * The rule charges `required(headway(pattern, hour(b)))` where `b` is the
 * instant the rider is READY to board -- and in reverse `b` is precisely what
 * the deadline is being computed to determine, so it cannot be read off. The
 * only `b` values that can ever bind are within `capSeconds - baseSeconds` of
 * the departure (anything earlier already has more slack than the rule can
 * demand at its ceiling), so the reverse rule charges the largest margin any
 * hour that window touches can demand. That is exact whenever the window sits
 * inside one hour -- the overwhelmingly common case -- and deliberately
 * conservative when an hour boundary falls inside it, which is the direction
 * a bucketed margin is permitted to be wrong in.
 */
function oracleExtraSeconds(
  net: Net, hw: number[][][], patternIdx: number, patternPos: number,
  boardingSecondsIntoDay: number,
): number {
  if (net.transferFactor === 0) return 0; // the off switch, unconditionally
  const widest = net.transferCapSeconds - net.transferMinSeconds;
  const hFrom = Math.floor((boardingSecondsIntoDay - widest) / 3600); // never modulo a GTFS time
  const hTo = Math.floor(boardingSecondsIntoDay / 3600);
  let required = 0;
  for (let h = hFrom; h <= hTo; h++) {
    const headway = h < 0 || h >= ORACLE_HOURS
      ? Infinity
      : hw[patternIdx]![patternPos]![h]!;
    const r = oracleRequired(net, headway);
    if (r > required) required = r;
  }
  return Math.max(0, required - net.transferMinSeconds);
}

/**
 * Is `trip` a LAST SERVICE of its pattern on day `dayIdx` -- one that no
 * other active, non-excluded trip of the same pattern departs later than, at
 * any position along it?
 *
 * This states "the pattern has no later trip on that service day",
 * from the network's own departure times and deliberately WITHOUT a
 * boarding position. It does not need one: trips within a pattern never
 * overtake, so a trip that departs later at ANY position departs no earlier
 * at EVERY position, and the answer is the same wherever the rider boards.
 * Written as "no member departs later anywhere" rather than "this is the
 * highest-indexed active trip" so that two feed-identical trips both qualify
 * -- and so that this file states the condition in its own terms rather than
 * in terms of `patternTrips` ordering, which is the implementation's
 * representation of it.
 */
function isLastServiceOfDay(
  net: Net, patternOfTrip: Int32Array, excluded: ReadonlySet<number>,
  trip: number, dayIdx: number,
): boolean {
  const day = net.days[dayIdx]!;
  const mine = net.trips[trip]!;
  const pattern = patternOfTrip[trip]!;
  for (let u = 0; u < net.trips.length; u++) {
    if (patternOfTrip[u] !== pattern) continue;
    if (day.active[u] !== 1 || excluded.has(u)) continue;
    const other = net.trips[u]!;
    for (let i = 0; i < other.dep.length; i++) {
      if (other.dep[i]! > mine.dep[i]!) return false;
    }
  }
  return true;
}

/**
 * Exhaustive enumeration of every legal journey state, walked backward in
 * time from the destinations. State = (stop, latest-allowable-departure,
 * kind, trips-remaining-used-so-far, the boarding this state still has to
 * make). Expand by alighting any trip on any day at any occurrence of the
 * stop (searching earlier positions on that same trip for a boarding stop),
 * and by taking at most one footpath immediately before a transit-or-egress
 * leg (never before a walk -- the "no chaining" rule `raptorReverse.ts`
 * implements). Dedupe on the exact tuple to halt. Returns oracle[k][stop] =
 * max departure using AT MOST k trips (-Infinity if unreachable).
 *
 * `onward` is what the headway margin is measured against, and it is the one
 * piece of state the FORWARD oracle does not need. Forward charges the margin
 * at the boarding itself, where the pattern being boarded is in hand; reverse
 * decides how late a vehicle may arrive, and the answer depends on which
 * service the rider is transferring TO -- which is in this state's future,
 * one leg along the chain (or two, across a single footpath). `null` means
 * the state boards nothing more (it walks straight to the destination, or is
 * the egress itself), so no vehicle can be missed and no margin is owed.
 */
function oracle(net: Net, patternOfTrip: Int32Array, nPatterns: number): number[][] {
  const K = net.maxRounds;
  const hw = net.days.map((_, d) => oracleHeadway(net, d, patternOfTrip, nPatterns));
  const bestBy: number[][] = [];
  for (let k = 0; k <= K; k++) bestBy.push(new Array<number>(net.nStops).fill(-Infinity));

  const seenBest = new Map<string, number>();
  type Onward = {
    pattern: number; day: number; dep: number; trip: number; pos: number;
  } | null;
  type S = {
    stop: number; time: number; kind: "egress" | "transit" | "walk"; k: number; onward: Onward;
  };
  const stack: S[] = [];
  // The key deliberately does NOT include `onward`: `runRaptorReverse` stores
  // exactly one label per stop per round, so two states that reach a stop at
  // the same time but go on to board different services cannot both survive
  // there, however differently useful they are to an incoming vehicle. The
  // oracle prunes identically so the two sides stay comparable -- see this
  // file's header on what a non-zero factor therefore does and does not
  // prove.
  const push = (s: S): void => {
    const key = `${s.stop}|${s.kind}|${s.k}`;
    const prev = seenBest.get(key);
    if (prev !== undefined && prev >= s.time) return;
    seenBest.set(key, s.time); stack.push(s);
    if (s.time > bestBy[s.k]![s.stop]!) bestBy[s.k]![s.stop] = s.time;
  };

  for (const d of net.destinations) {
    push({
      stop: d.stopIdx, time: net.arriveByEpoch - d.secondsToReach, kind: "egress", k: 0,
      onward: null,
    });
  }

  const excluded = new Set(net.filtered);

  while (stack.length > 0) {
    const st = stack.pop()!;
    // --- alight a trip: find every occurrence of st.stop as position j on
    // any active, non-excluded trip whose arrival is within the (buffered)
    // deadline, then push a state for every earlier boarding position i<j.
    if (st.k < K) {
      // Reaching this branch IS the incoming vehicle: a rider only alights
      // something they rode. That is what makes the journey's own initial
      // boarding exempt without a separate test -- nothing ever
      // alights into it, so no deadline is ever computed against it. It is
      // the LAST boarding this backward walk reaches, not the first.
      // The margin yields at the last service of the day. If the
      // onward service is one no later trip of its pattern follows on that
      // service day, then a rider refused this connection is not moved to a
      // later trip -- they lose the journey. The rule charges the flat base
      // buffer alone there, which is exactly the pre-branch requirement.
      //
      // Stated on the ONWARD trip, not on the pattern being alighted, for
      // the same reason the margin itself is: what missing this connection
      // costs is a wait for the next departure of the service being
      // transferred TO, and "there is no next departure" is a fact about
      // that same service.
      const extra = st.onward === null
        || isLastServiceOfDay(net, patternOfTrip, excluded, st.onward.trip, st.onward.day)
        ? 0
        : oracleExtraSeconds(
          net, hw[st.onward.day]!, st.onward.pattern, st.onward.pos,
          st.onward.dep - net.days[st.onward.day]!.baseEpoch,
        );
      const deadline = st.time - (st.kind === "transit" ? net.transferMinSeconds : 0) - extra;
      for (let d = 0; d < net.days.length; d++) {
        const day = net.days[d]!;
        for (let t = 0; t < net.trips.length; t++) {
          if (day.active[t] !== 1) continue;
          if (excluded.has(t)) continue;
          const tr = net.trips[t]!;
          for (let j = 0; j < tr.stops.length; j++) {
            if (tr.stops[j] !== st.stop) continue;
            if (day.baseEpoch + tr.arr[j]! > deadline) continue;
            for (let i = j - 1; i >= 0; i--) {
              const dep = day.baseEpoch + tr.dep[i]!;
              push({
                stop: tr.stops[i]!, time: dep, kind: "transit", k: st.k + 1,
                onward: { pattern: patternOfTrip[t]!, day: d, dep, trip: t, pos: i },
              });
            }
          }
        }
      }
    }
    // --- one footpath: from a transit leg or an egress leg always, never
    // chained onto another walk (raptorReverse.ts relaxes footpaths from
    // round-0 egress labels too, mirroring the forward pass's round-0 fix).
    // The walk carries the boarding forward unchanged: the rider still has to
    // catch the same service, they just approach it on foot, and the footpath
    // seconds already bake in the base buffer.
    const canWalk = st.kind === "transit" || st.kind === "egress";
    if (canWalk) {
      for (const [f, to, secs] of net.foot) {
        if (f !== st.stop) continue;
        push({ stop: to, time: st.time - secs, kind: "walk", k: st.k, onward: st.onward });
      }
    }
  }

  for (let k = 1; k <= K; k++) {
    for (let s = 0; s < net.nStops; s++) {
      if (bestBy[k - 1]![s]! > bestBy[k]![s]!) bestBy[k]![s] = bestBy[k - 1]![s]!;
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
    rawDestinations: boolean; wideDay: boolean;
    /**
     * Emit every footpath in both directions at the same cost, which is what
     * `buildFootpaths` actually produces today (haversine is symmetric, and
     * same-station peers are a flat constant). The main trial leaves this
     * off, because the reverse pass is compared there against an oracle that
     * models reverse walks exactly as `relaxFootpathsReverse` does -- reading
     * the s->t edge to price a t->s walk. The forward/reverse cross-check
     * cannot leave it off: with a one-directional edge the two passes
     * genuinely disagree about whether the walk exists at all, which is the
     * KNOWN DIRECTIONAL APPROXIMATION `relaxFootpathsReverse` documents and
     * has nothing to do with the headway margin.
     */
    symmetricFoot?: boolean;
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
      // `wideDay` spreads a pattern's trips across the whole service day
      // rather than the first hour, so that a pattern's headway differs
      // between hour buckets and the margin genuinely steps as the boarding
      // instant moves -- without it every candidate boarding lands in hour 0
      // or 1 and the hour dimension of the rule is never exercised at all.
      let t = opts.wideDay
        ? ri(0, 90) * 900
        : ri(0, 12) * 300 + (opts.multiDay && rnd() < 0.4 ? 86400 : 0);
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
      const secs = ri(1, 4) * 300;
      foot.push([a, b, secs]);
      if (opts.symmetricFoot === true) foot.push([b, a, secs]);
    }
  }

  const days: { baseEpoch: number; active: number[] }[] = [];
  const nDays = opts.multiDay ? 2 : 1;
  for (let d = 0; d < nDays; d++) {
    const active: number[] = [];
    for (let t = 0; t < trips.length; t++) active.push(rnd() < 0.75 ? 1 : 0);
    days.push({ baseEpoch: d === 0 ? BASE : BASE - 86400, active });
  }

  const origins: { stopIdx: number; secondsToReach: number }[] = [];
  const nOrigins = ri(1, 2);
  for (let i = 0; i < nOrigins; i++) {
    origins.push({ stopIdx: ri(0, nStops - 1), secondsToReach: ri(0, 3) * 300 });
  }

  const rawDestinations: { stopIdx: number; secondsToReach: number }[] = [];
  const nDest = ri(1, 2);
  for (let i = 0; i < nDest; i++) {
    rawDestinations.push({ stopIdx: ri(0, nStops - 1), secondsToReach: ri(0, 3) * 300 });
  }

  // Unless testing raw (unexpanded) destinations, emulate the real caller:
  // the egress list for a destination point already contains every stop
  // within walking radius, one footpath hop out -- mirroring the forward
  // oracle's `rawOrigins` knob, moved to the destination side since
  // destinations seed round 0 in reverse the way origins do in forward.
  let destinations = rawDestinations;
  if (opts.foot && !opts.rawDestinations) {
    const m = new Map<number, number>();
    for (const d of rawDestinations) {
      const c = m.get(d.stopIdx);
      if (c === undefined || d.secondsToReach < c) m.set(d.stopIdx, d.secondsToReach);
    }
    for (const d of rawDestinations) {
      for (const [f, t, secs] of foot) {
        if (f !== d.stopIdx) continue;
        const v = d.secondsToReach + secs;
        const c = m.get(t);
        if (c === undefined || v < c) m.set(t, v);
      }
    }
    destinations = [...m].map(([stopIdx, secondsToReach]) => ({ stopIdx, secondsToReach }));
  }

  const filtered: number[] = [];
  if (rnd() < 0.25) {
    for (let t = 0; t < trips.length; t++) if (rnd() < 0.2) filtered.push(t);
  }

  // `0` is weighted into the factor set so that most trials still exercise
  // today's exact behaviour -- with a zero factor the reverse pass must be
  // byte-identical to its flat-buffer behaviour.
  const transferMinSeconds = [0, 0, 60, 120, 300][ri(0, 4)]!;
  const transferFactor = [0, 0, 0.25, 0.5, 1][ri(0, 4)]!;

  return {
    nStops, trips, foot: opts.foot ? foot : [], days, origins, destinations,
    // A deadline in the same band the trips occupy, so a wide service day
    // still produces reachable journeys instead of a network entirely after
    // the deadline.
    arriveByEpoch: BASE + (opts.wideDay ? ri(2, 94) * 900 : ri(-4, 8) * 300),
    maxRounds: ri(2, 4),
    transferMinSeconds,
    transferFactor,
    transferCapSeconds: Math.max(transferMinSeconds, [300, 600, 900][ri(0, 2)]!),
    // A zero factor must be inert; so must leaving `transfer` off the query
    // altogether, which is how every existing caller runs.
    passTransfer: transferFactor !== 0 || rnd() < 0.5,
    filtered,
  };
}

function toDays(net: Net): DayContext[] {
  return net.days.map((d, i) => ({
    dateYmd: 20260824 + i, baseEpoch: d.baseEpoch, activeTrip: Uint8Array.from(d.active),
  }));
}

function run(net: Net, ix: TimetableIndex): ReverseResult {
  const excluded = new Set(net.filtered);
  const days = toDays(net);
  const cfg: TransferConfig = {
    baseSeconds: net.transferMinSeconds,
    factor: net.transferFactor,
    capSeconds: net.transferCapSeconds,
  };
  return runRaptorReverse(ix, {
    origins: [], destinations: net.destinations, // no origins => no bound pruning
    arriveByEpoch: net.arriveByEpoch, days,
    maxRounds: net.maxRounds, transferMinSeconds: net.transferMinSeconds,
    tripFilter: net.filtered.length > 0 ? (t: number) => !excluded.has(t) : undefined,
    // One table per DayContext: headway is per service day, and
    // "yesterday, 25:30" is a different row of a different day's table from
    // "today, 01:30".
    transfer: net.passTransfer
      ? { cfg, headway: days.map((day) => buildHeadwayTable(ix, day)) }
      : undefined,
  });
}

function fmt(v: number): string { return v === -Infinity ? "none" : String(v); }

function compareAllStops(net: Net): string[] {
  const ix = makeTestIndex(net.nStops, net.trips, net.foot);
  const res = run(net, ix);
  const orc = oracle(net, ix.patternOfTrip, ix.nPatterns);
  const out: string[] = [];
  for (let k = 0; k <= net.maxRounds; k++) {
    const row = res.rounds[k] ?? res.rounds[res.rounds.length - 1]!;
    for (let s = 0; s < net.nStops; s++) {
      const l = row[s];
      const got = l === null || l === undefined ? -Infinity : l.departureEpoch;
      const want = orc[k]![s]!;
      if (got !== want) {
        out.push(`k=${k} stop=${s} raptor=${fmt(got)} oracle=${fmt(want)} ${got < want ? "[RAPTOR MISSED]" : "[RAPTOR TOO OPTIMISTIC]"}`);
      }
    }
  }
  return out;
}

// Deterministic seed -- see the module doc comment above.
const SEED = 20260822;
/**
 * 4000, chosen from mutation testing at this file's seed, not merely picked.
 *
 * Fewer trials are too weak: mutating the OUTER pattern-index tie-break in
 * `runRaptorReverse` SURVIVES 1,500 trials, only failing at
 * roughly a 1-in-8,000 rate -- 400 trials would have perhaps a 5% chance of
 * catching it, which is not a test, it is a coin flip.
 *
 * Charging the margin against the pattern ALIGHTED FROM -- the
 * single likeliest way to get this task wrong -- first disagrees at trial
 * 2428, so anything below that count would ship it green; 4000 catches it
 * with margin.
 *
 * Deliberately NOT higher, though 12000 was measured. Be precise about what
 * that costs, since the count alone reads like a coverage claim: never
 * charging the margin across a footpath first disagrees at trial 4023, so
 * this count does NOT catch it and 12000 did. It is not raised for it,
 * because that mutant dies deterministically at the named "survives a
 * footpath" regression below, as does the alighted-pattern one at "the
 * margin is charged against the service being transferred TO". The named
 * regressions are the real guard; the random trials are here to find the
 * defect nobody thought to name, and 4000 buys that at a third of 12000's
 * cost, which is what keeps the committed suite fast. Two further mutants
 * survive 40,000 trials and are covered by named regressions for the same
 * reason. Raise it, not lower it, if a future mutant proves to survive this
 * AND cannot be pinned deterministically.
 */
const TRIALS = 4000;

test("property: runRaptorReverse matches a brute-force oracle across many random networks", () => {
  const rnd = mulberry32(SEED);
  for (let n = 0; n < TRIALS; n++) {
    const opts = {
      multiDay: rnd() < 0.35,
      loops: rnd() < 0.35,
      dwell: rnd() < 0.35,
      foot: rnd() < 0.6,
      rawDestinations: rnd() < 0.3,
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
  // exactly, and that promise has to hold in BOTH directions or `arriveBy`
  // would quietly diverge from `departAfter` the moment the switch is thrown.
  // For the SAME network, threading a zero-factor `transfer` through the
  // query must produce label-for-label the same result as leaving `transfer`
  // off entirely, which is how every caller without the headway feature
  // configured runs.
  const rnd = mulberry32(SEED + 1);
  for (let n = 0; n < 3000; n++) {
    const opts = {
      multiDay: rnd() < 0.35, loops: rnd() < 0.35, dwell: rnd() < 0.35,
      foot: rnd() < 0.6, rawDestinations: rnd() < 0.3, wideDay: rnd() < 0.3,
    };
    const net = genNet(rnd, opts);
    const ix = makeTestIndex(net.nStops, net.trips, net.foot);
    const off = run({ ...net, transferFactor: 0, passTransfer: true }, ix);
    const absent = run({ ...net, transferFactor: 0, passTransfer: false }, ix);
    for (let k = 0; k < off.rounds.length; k++) {
      for (let st = 0; st < net.nStops; st++) {
        const a = off.rounds[k]![st];
        const b = absent.rounds[k]![st];
        assert.equal(
          a === null || a === undefined ? null : a.departureEpoch,
          b === null || b === undefined ? null : b.departureEpoch,
          `trial ${n} k=${k} stop=${st}: a zero factor changed the result\nnet=${JSON.stringify(net)}`,
        );
        assert.equal(a?.kind ?? null, b?.kind ?? null, `trial ${n} k=${k} stop=${st}: kind differs`);
        assert.equal(a?.tripIdx ?? null, b?.tripIdx ?? null, `trial ${n} k=${k} stop=${st}: trip differs`);
        assert.equal(a?.alightEpoch ?? null, b?.alightEpoch ?? null, `trial ${n} k=${k} stop=${st}: alighting differs`);
      }
    }
  }
});

// ---------------------------------------------------------------- the cross-check
// The reverse oracle above and `runRaptorReverse` are both written from the
// same reading of the rule, by the same hand, in the same sitting. If that
// reading has the inequality backwards, or measures the margin against the
// wrong service, they agree with each other and say nothing. This section
// checks the reverse pass against the FORWARD side instead -- the rule as
// `raptor.ts` applies it, restated here independently the way
// `raptor.oracle.test.ts` states it, and the forward pass itself run as a
// referee.

/**
 * The forward pass's own margin, pointwise: the rider is READY at
 * `secondsIntoDay`, and the rule charges what the pattern's headway demands
 * in the hour that instant falls in. One hour, not a window -- forward knows
 * exactly when the rider is ready, so it never has to widen.
 */
function forwardExtraSeconds(
  net: Net, hw: number[][][], patternIdx: number, patternPos: number,
  secondsIntoDay: number,
): number {
  if (net.transferFactor === 0) return 0;
  const hour = Math.floor(secondsIntoDay / 3600); // never modulo a GTFS time
  const headway = hour < 0 || hour >= ORACLE_HOURS
    ? Infinity
    : hw[patternIdx]![patternPos]![hour]!;
  return Math.max(0, oracleRequired(net, headway) - net.transferMinSeconds);
}

function describeReverse(label: ReverseLabel | null): string {
  const parts: string[] = [];
  for (let cur = label; cur !== null; cur = cur.predecessor) {
    parts.push(
      cur.kind === "transit"
        ? `ride trip ${cur.tripIdx} (day ${cur.dayIdx}) dep ${cur.departureEpoch} -> stop ${cur.alightStop} arr ${cur.alightEpoch}`
        : `${cur.kind} dep ${cur.departureEpoch} -> stop ${cur.toStop} at ${cur.alightEpoch}`,
    );
  }
  return parts.join("\n    then ");
}

/**
 * Every interchange in the journey `label` heads, checked against the rule as
 * the FORWARD pass applies it: a rider who alights at `A`, is ready to board
 * at `b` (plus the base buffer, or plus the footpath seconds which already
 * bake it in), may take a departure at `D` only when
 * `b + extra(onward pattern, hour(b)) <= D`.
 *
 * A violation means the reverse pass offered a connection the forward pass
 * would refuse -- it is optimistic about an interchange, which is the one
 * thing this feature may never be. The converse is NOT asserted anywhere and
 * must not be: the reverse pass is deliberately the stricter of the two at an
 * hour boundary (see `extraAlightingSeconds`), so forward legitimately
 * accepts connections reverse declines.
 */
function reverseConnectionViolations(
  net: Net, ix: TimetableIndex, hw: number[][][][], label: ReverseLabel,
): { violations: string[]; interchanges: number } {
  const out: string[] = [];
  // How many interchanges this journey actually put to the test. Returned,
  // not merely counted, because the loop below `continue`s past every
  // non-transit link: if the generator ever stopped producing journeys with
  // two transit legs, `out` would be empty on every trial and the caller's
  // assertion would pass having checked NOTHING. Claim 2 already has
  // `roundTrips` guarding exactly that failure; claim 1 had nothing.
  let interchanges = 0;
  const excluded = new Set(net.filtered);
  for (let cur: ReverseLabel | null = label; cur !== null; cur = cur.predecessor) {
    if (cur.kind !== "transit") continue;
    // The rider alights this ride at `alightStop` at `alightEpoch` and
    // continues on whatever `predecessor` holds there.
    let next = cur.predecessor;
    let ready = cur.alightEpoch + net.transferMinSeconds;
    if (next !== null && next.kind === "walk") {
      // A walk's own seconds already bake in the base buffer, so they replace
      // it rather than adding to it -- and the boarding to protect is one
      // link further along.
      ready = cur.alightEpoch + (next.alightEpoch - next.departureEpoch);
      next = next.predecessor;
    }
    if (next === null || next.kind !== "transit") continue; // walks to the destination: nothing boarded
    interchanges++;
    const day = net.days[next.dayIdx]!;
    const pattern = ix.patternOfTrip[next.tripIdx]!;
    // `next.patternPos` is the position the onward boarding happens at --
    // recorded on the label because a loop pattern visits a stop more than
    // once, so it cannot be recovered from the stop id alone. The margin is
    // a property of (pattern, POSITION, hour), see `oracleHeadway`.
    const extra = forwardExtraSeconds(
      net, hw[next.dayIdx]!, pattern, next.patternPos, ready - day.baseEpoch,
    );
    if (ready + extra > next.departureEpoch) {
      // The forward rule itself yields to the flat base buffer
      // when nothing later runs on the onward pattern that service day, so a
      // connection that fails the scaled margin is still one forward accepts
      // provided the rider is ready by the departure. The condition is
      // sufficient for the forward pass's own test ("no trip departs the
      // boarding position at or after `ready`"): every other active trip of
      // the pattern departs no later than this one anywhere, and this one
      // departs before `ready`, so none of them reaches `ready` either.
      if (ready <= next.departureEpoch
        && isLastServiceOfDay(net, ix.patternOfTrip, excluded, next.tripIdx, next.dayIdx)) {
        continue;
      }
      out.push(
        `alighting at stop ${cur.alightStop} at ${cur.alightEpoch}: ready ${ready} + margin ${extra} ` +
        `> onward departure ${next.departureEpoch} (pattern ${pattern}, day ${next.dayIdx})`,
      );
    }
  }
  return { violations: out, interchanges };
}

test("cross-check: forward and reverse accept the same journeys -- reverse never offers a connection, or a departure, the forward pass refuses", () => {
  // Two claims, both about the SAME journey rather than about which journey
  // is optimal. Optimality is off the table at a non-zero factor in both
  // directions (the hour-bucketing approximation, and `runRaptorReverse`'s
  // reverse-specific instance of it): the two passes prune differently and genuinely disagree
  // about which of several legal journeys is best. What must never differ is
  // whether a given journey is LEGAL.
  //
  //  1. Every interchange the reverse pass built satisfies the forward rule,
  //     restated independently above.
  //  2. A departure the reverse pass offers is one the forward pass can
  //     honour: started at that instant, from that stop, forward reaches a
  //     destination by the same deadline within the same number of trips.
  //
  // Claim 2 is the weaker of the two on its own (forward might get there by
  // some other route), which is why claim 1 checks the actual legs.
  const rnd = mulberry32(SEED + 2);
  let journeys = 0;
  let roundTrips = 0;
  // Claim 1's own vacuity guard -- see `reverseConnectionViolations`.
  let interchangesChecked = 0;
  for (let n = 0; n < 4000; n++) {
    const opts = {
      multiDay: rnd() < 0.35, loops: rnd() < 0.35, dwell: rnd() < 0.35,
      foot: rnd() < 0.6, rawDestinations: rnd() < 0.3, wideDay: rnd() < 0.3,
      symmetricFoot: true,
    };
    const gen = genNet(rnd, opts);
    // A zero factor makes this trial vacuous -- the whole point is the margin.
    const net: Net = {
      ...gen,
      transferFactor: gen.transferFactor === 0 ? 0.25 : gen.transferFactor,
      passTransfer: true,
    };
    const ix = makeTestIndex(net.nStops, net.trips, net.foot);
    const days = toDays(net);
    const cfg: TransferConfig = {
      baseSeconds: net.transferMinSeconds,
      factor: net.transferFactor,
      capSeconds: net.transferCapSeconds,
    };
    const headway = days.map((day) => buildHeadwayTable(ix, day));
    const hw = net.days.map((_, d) => oracleHeadway(net, d, ix.patternOfTrip, ix.nPatterns));
    const excluded = new Set(net.filtered);
    const tripFilter = net.filtered.length > 0 ? (t: number) => !excluded.has(t) : undefined;

    const rev = run(net, ix);

    for (let k = 0; k <= net.maxRounds; k++) {
      const row = rev.rounds[k] ?? rev.rounds[rev.rounds.length - 1]!;
      for (const o of net.origins) {
        const label = row[o.stopIdx];
        if (label === null || label === undefined) continue;
        journeys++;

        const { violations: bad, interchanges } = reverseConnectionViolations(net, ix, hw, label);
        interchangesChecked += interchanges;
        assert.equal(
          bad.length, 0,
          `trial ${n} (seed ${SEED + 2}) k=${k} origin stop ${o.stopIdx}: the reverse pass built a ` +
          `connection the forward rule refuses:\n  ${bad.join("\n  ")}\n  reverse journey:\n    ${describeReverse(label)}` +
          `\n  net=${JSON.stringify(net)}`,
        );

        // Claim 2: hand the departure back to the forward pass.
        if (k === 0) continue; // a pure walk to the destination: no boarding to honour
        const fwd = runRaptor(ix, {
          origins: [{ stopIdx: o.stopIdx, secondsToReach: 0 }], destinations: [],
          departAfterEpoch: label.departureEpoch, days,
          maxRounds: k, transferMinSeconds: net.transferMinSeconds, tripFilter,
          transfer: { cfg, headway },
        });
        const fwdRow = fwd.rounds[k] ?? fwd.rounds[fwd.rounds.length - 1]!;
        let arrived: number | null = null;
        for (const d of net.destinations) {
          const l = fwdRow[d.stopIdx];
          if (l === null || l === undefined) continue;
          if (l.arrivalEpoch + d.secondsToReach > net.arriveByEpoch) continue;
          arrived = l.arrivalEpoch + d.secondsToReach;
          break;
        }
        roundTrips++;
        assert.notEqual(
          arrived, null,
          `trial ${n} (seed ${SEED + 2}) k=${k}: the reverse pass offered a departure from stop ` +
          `${o.stopIdx} at ${label.departureEpoch} making ${net.arriveByEpoch}, but the forward ` +
          `pass cannot honour it in ${k} trips.\n  reverse journey:\n    ${describeReverse(label)}` +
          `\n  forward best at each destination: ` +
          net.destinations.map((d) => {
            const l = fwdRow[d.stopIdx];
            return `stop ${d.stopIdx} -> ${l === null || l === undefined ? "none" : l.arrivalEpoch + d.secondsToReach}`;
          }).join(", ") +
          `\n  net=${JSON.stringify(net)}`,
        );
      }
    }
  }
  // Guards against the whole trial silently becoming vacuous -- a generator
  // change that stopped producing reachable origins would otherwise leave
  // this test passing with nothing checked.
  assert.ok(journeys > 2000, `expected the cross-check to see many journeys, saw ${journeys}`);
  assert.ok(roundTrips > 1000, `expected many round trips, saw ${roundTrips}`);
  // Claim 1 is the one that inspects actual legs, and it is the one that can
  // go quietly vacuous: a journey with a single transit leg has no
  // interchange to violate anything, and `journeys`/`roundTrips` above count
  // such journeys happily -- they guard claim 2, which needs no interchange
  // at all.
  //
  // The threshold is 150 because the MEASURED value is 245, and that number
  // is worth stating rather than hiding behind a round one: across 4,000
  // trials and several thousand journeys, claim 1 puts only ~245
  // interchanges to the test. It is a real check, not a vacuous one, but it
  // is roughly an order of magnitude thinner than the counters above it
  // imply, because most generated journeys are a single ride. Raise the
  // generator's interchange density, not this threshold, if that thinness
  // ever needs fixing.
  assert.ok(
    interchangesChecked > 150,
    `expected the cross-check to inspect many interchanges, saw ${interchangesChecked}`,
  );
});

// ---------------------------------------------------------------- targeted regressions
// Hand-picked reproducers for the defect categories a reverse pass is prone
// to mirroring from a forward implementation -- see the header comment
// above. Each regression below documents its own defect inline.

test("regression: an exact arrival tie keeps the later-indexed, later-departing trip, not an earlier one chosen by raw epoch", () => {
  // Pattern [0,1,2]. Trip A departs stop 1 at 3000, arrives stop 2 at 4200.
  // Trip B also arrives stop 2 at 4200 (a tie), but departs stop 1 later, at
  // 3300. Pattern order places A before B (A <= B pointwise). Alighting at
  // stop 2 with a deadline of 4200, comparing candidates by raw arrival
  // epoch can't see that B (the later pattern-local index) should be
  // preferred -- only comparing pattern-local index picks the trip that
  // lets an earlier position depart as late as possible.
  const ix = makeTestIndex(3, [
    { stops: [0, 1, 2], dep: [2100, 3000, 4200], arr: [2100, 3000, 4200] }, // A
    { stops: [0, 1, 2], dep: [2400, 3300, 4200], arr: [2400, 3300, 4200] }, // B
  ], []);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4200,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.departureEpoch, BASE + 3300);
});

test("regression: an exact departure tie at the boarding position also resolves by pattern-local index", () => {
  // Both trips depart stop 0 at the same instant; B (the later index) has a
  // later arrival at stop 1, which is fine to prefer here since it is B's
  // OWN later arrival, still within the deadline, that gets chosen. This
  // guards the same comparison from the other side (a tie at the position
  // being searched FROM, not the alighting position).
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [3000, 3900], arr: [3000, 3900] }, // A
    { stops: [0, 1], dep: [3000, 4200], arr: [3000, 4200] }, // B
  ], []);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4200,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 3000);
  assert.equal(res.rounds[1]![0]!.alightEpoch, BASE + 4200);
});

test("regression: two DayContexts competing on one pattern merge by departure, never by comparing arrival across days as the tie-break", () => {
  // One pattern, two trips, each active on only one of two days. In
  // absolute-epoch terms, trip0 (today) departs LATER (2400) but arrives
  // SOONER (3100) than trip1 (yesterday), which departs EARLIER (1000) but
  // arrives LATER (3199) -- the two trips "cross" once mapped onto the same
  // absolute timeline. Both satisfy the deadline. The mirrored bug would
  // pick a cross-day winner by comparing ARRIVAL (the criterion the intra-
  // day search naturally sorts by), which favours trip1's 3199 as "closer to
  // the deadline"; but the quantity RAPTOR reverse actually optimises for is
  // DEPARTURE, so the correct winner is trip0, whose 2400 beats trip1's
  // 1000, regardless of which one's arrival looks more attractive.
  const ix = makeTestIndex(3, [
    { stops: [0, 1, 2], dep: [2400, 3000, 3100], arr: [2400, 3000, 3100] }, // trip0: today
    { stops: [0, 1, 2], dep: [87400, 88000, 89599], arr: [87400, 88000, 89599] }, // trip1: yesterday
  ], []);
  const days: DayContext[] = [
    { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 0]) },
    { dateYmd: 20260824, baseEpoch: BASE - 86400, activeTrip: Uint8Array.from([0, 1]) },
  ];
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 3200,
    days, maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 2400);
});

test("regression: a loop route (a stop appearing twice in one pattern) is walked backward without confusing the two occurrences", () => {
  const ix = makeTestIndex(3, [
    { stops: [0, 1, 0], dep: [1000, 1300, 1600], arr: [1000, 1300, 1600] },
  ], []);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 1400,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  // Only the FIRST occurrence of stop 0 (position 0) can board a trip that
  // alights at stop 1 (position 1) by BASE+1400; the second occurrence
  // (position 2) is downstream of the destination on this trip and must not
  // be treated as an equally valid boarding point.
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 1000);
});

test("regression: a footpath reachable directly from the destination lets a journey end with a walk", () => {
  // Stop 1 is on no trip at all; the only way to reach the destination
  // (stop 0) from stop 1 is a footpath straight into the destination's own
  // round-0 egress label, with zero trips ridden -- the reverse mirror of
  // the forward pass's round-0-footpath-relaxation fix.
  const ix = makeTestIndex(3, [{ stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] }], [[0, 1, 300]]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 1, secondsToReach: 0 }], destinations: [{ stopIdx: 0, secondsToReach: 0 }],
    arriveByEpoch: BASE + 3600,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[0]![1]!.departureEpoch, BASE + 3300);
  assert.equal(res.rounds[0]![1]!.kind, "walk");
});

test("regression: an origin with no route to the destination stays unreachable across every round", () => {
  const ix = makeTestIndex(3, [{ stops: [1, 2], dep: [3600, 4200], arr: [3600, 4200] }], []);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1]) }],
    maxRounds: 4, transferMinSeconds: 0,
  });
  for (const round of res.rounds) assert.equal(round[0], null);
  // Confirm this isn't a stub always returning null: stop 1 IS reachable.
  assert.equal(res.rounds[1]![1]!.departureEpoch, BASE + 3600);
});

test("regression: a trip that only arrives after the deadline is rejected outright, even with no alternative", () => {
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] }]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  for (const round of res.rounds) assert.equal(round[0], null);
});

// ---------------------------------------------------------------- the headway margin
// One named test per way the mirrored rule can be got wrong. Each was
// mutation-checked: the implementation was changed to the stated mistake and
// the test confirmed to fail by name. Two of them (the per-day table and the
// readiness window) exist because their mutants survive 40,000 random trials
// -- the property test above cannot be relied on for either.

/** Shorthand: one service day, everything active, a headway margin attached. */
function reverseWithMargin(
  ix: TimetableIndex,
  opts: {
    nTrips: number; destinations: { stopIdx: number; secondsToReach: number }[];
    arriveByEpoch: number; maxRounds: number; transferMinSeconds: number;
    factor: number; capSeconds: number; days?: DayContext[];
  },
): ReverseResult {
  const days = opts.days ?? [{
    dateYmd: 20260824, baseEpoch: BASE, activeTrip: new Uint8Array(opts.nTrips).fill(1),
  }];
  return runRaptorReverse(ix, {
    origins: [], destinations: opts.destinations, arriveByEpoch: opts.arriveByEpoch, days,
    maxRounds: opts.maxRounds, transferMinSeconds: opts.transferMinSeconds,
    transfer: {
      cfg: {
        baseSeconds: opts.transferMinSeconds, factor: opts.factor, capSeconds: opts.capSeconds,
      },
      headway: days.map((day) => buildHeadwayTable(ix, day)),
    },
  });
}

test("the margin is charged against the service being transferred TO, not the one alighted from", () => {
  // Feeder pattern A (stops 0->1) runs about every minute; onward pattern B
  // (stops 1->2) runs once an hour. What missing the interchange costs is a
  // wait for B, so B's headway is what sets the margin -- and a mirror of the
  // forward pass written by pattern-matching reaches for the pattern
  // currently being SCANNED, which here is A.
  //
  //   A departs stop 0 at 3000, 3480, 3540, 3600, 3660 -> 60 s median in both
  //     hour 0 and hour 1, so A's margin would be nil.
  //   B departs stop 1 at 3700 and 7300 -> a 3600 s gap in hour 1, and hour 0
  //     unmeasured, so B's margin is the 600 s cap either way: 540 s on top
  //     of the 60 s base.
  //
  // Boarding B at 3700 therefore needs an arrival by 3700 - 60 - 540 = 3100,
  // which only A's 3000 departure makes. Charging A's headway instead would
  // accept the arrival at 3640 and report a departure of 3540.
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3000, 3100], arr: [3000, 3100] },
    { stops: [0, 1], dep: [3480, 3580], arr: [3480, 3580] },
    { stops: [0, 1], dep: [3540, 3640], arr: [3540, 3640] },
    { stops: [0, 1], dep: [3600, 3700], arr: [3600, 3700] },
    { stops: [0, 1], dep: [3660, 3760], arr: [3660, 3760] },
    { stops: [1, 2], dep: [3700, 4000], arr: [3700, 4000] },
    { stops: [1, 2], dep: [7300, 7600], arr: [7300, 7600] },
  ], []);
  const res = reverseWithMargin(ix, {
    nTrips: 7, destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4000, maxRounds: 3,
    transferMinSeconds: 60, factor: 1, capSeconds: 600,
  });
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 3000);
  assert.equal(res.rounds[2]![0]!.alightEpoch, BASE + 3100);
});

test("the journey's own initial boarding is exempt -- the LAST boarding the backward walk reaches, not the first", () => {
  // The same network, asked for a journey that starts AT the interchange.
  // Standing at stop 1, the rider is the one thing the margin cannot insure:
  // there is no incoming vehicle to be late, so they are exempt and
  // may take B's 3700 departure at 3700 exactly.
  //
  // This is the half of the mirror that is easy to put on the wrong end. In
  // reverse, boarding B at stop 1 is the FIRST leg processed and the LAST leg
  // travelled; a mirror that charged the margin when the label was built --
  // the natural place, and where a "fold it into the label" implementation
  // would put it -- would push this to 3160 and make every arriveBy answer
  // needlessly early. Round 2's assertion above pins the other end: the same
  // boarding, reached from a feeder, IS charged.
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3000, 3100], arr: [3000, 3100] },
    { stops: [0, 1], dep: [3480, 3580], arr: [3480, 3580] },
    { stops: [0, 1], dep: [3540, 3640], arr: [3540, 3640] },
    { stops: [0, 1], dep: [3600, 3700], arr: [3600, 3700] },
    { stops: [0, 1], dep: [3660, 3760], arr: [3660, 3760] },
    { stops: [1, 2], dep: [3700, 4000], arr: [3700, 4000] },
    { stops: [1, 2], dep: [7300, 7600], arr: [7300, 7600] },
  ], []);
  const res = reverseWithMargin(ix, {
    nTrips: 7, destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4000, maxRounds: 3,
    transferMinSeconds: 60, factor: 1, capSeconds: 600,
  });
  assert.equal(res.rounds[1]![1]!.departureEpoch, BASE + 3700);
  assert.equal(res.rounds[1]![1]!.kind, "transit");
});

test("the margin survives a footpath: a rider who walks to the interchange still owes the onward service's headway", () => {
  // Alight at stop 3, walk 300 s to stop 1, board B (hourly) at 3700. The
  // walk's own seconds already bake in the base buffer, so the deadline at
  // stop 3 is (3700 - 300) - 540 = 2860, not 3400. The boarding to protect is
  // two links along the reverse chain -- the walk label's predecessor -- and
  // an implementation that only looks at the label in hand sees a walk, finds
  // no trip on it, and charges nothing.
  const ix = makeTestIndex(4, [
    { stops: [0, 3], dep: [2760, 2860], arr: [2760, 2860] },
    { stops: [0, 3], dep: [3300, 3400], arr: [3300, 3400] },
    { stops: [1, 2], dep: [3700, 4000], arr: [3700, 4000] },
    { stops: [1, 2], dep: [7300, 7600], arr: [7300, 7600] },
  ], [[1, 3, 300]]);
  const res = reverseWithMargin(ix, {
    nTrips: 4, destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4000, maxRounds: 3,
    transferMinSeconds: 60, factor: 1, capSeconds: 600,
  });
  assert.equal(res.rounds[1]![3]!.kind, "walk");
  assert.equal(res.rounds[1]![3]!.departureEpoch, BASE + 3400);
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 2760);
});

test("the margin reads the ONWARD service's day table, not the scanned trip's", () => {
  // Survives 40,000 random trials, so it is pinned here instead.
  //
  // The feeder runs today; the onward service is a late-night one belonging
  // to YESTERDAY's service day, departing at 24:26:40 (88000 s into that day)
  // -- 1600 s into today in absolute terms. Headway is a property of a
  // service day, so the margin must be read from yesterday's
  // table at hour 24, where the onward pattern runs every 300 s and owes
  // 300 - 60 = 240 s on top of the base. Reading today's table at hour 0
  // instead finds a pattern with no active trips at all, takes the cap, and
  // charges 540 s -- pushing the answer to the earlier feeder.
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [900, 1000], arr: [900, 1000] },
    { stops: [0, 1], dep: [1200, 1300], arr: [1200, 1300] },
    { stops: [1, 2], dep: [88000, 88300], arr: [88000, 88300] },
    { stops: [1, 2], dep: [88300, 88600], arr: [88300, 88600] },
    { stops: [1, 2], dep: [88600, 88900], arr: [88600, 88900] },
  ], []);
  const res = reverseWithMargin(ix, {
    nTrips: 5, destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 1900, maxRounds: 3,
    transferMinSeconds: 60, factor: 1, capSeconds: 600,
    days: [
      { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1, 0, 0, 0]) },
      { dateYmd: 20260824, baseEpoch: BASE - 86400, activeTrip: Uint8Array.from([0, 0, 1, 1, 1]) },
    ],
  });
  assert.equal(res.rounds[1]![1]!.departureEpoch, BASE + 1600);
  assert.equal(res.rounds[1]![1]!.dayIdx, 1);
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 1200);
});

test("the margin covers the whole readiness window, not just the departure's own hour", () => {
  // Also survives 40,000 random trials.
  //
  // Forward is handed the instant the rider is ready and charges that hour's
  // margin. Reverse is handed the departure and has to produce the readiness
  // instant, so it cannot read the hour off anything -- and the margin steps
  // at the boundary. Here the onward pattern departs stop 1 at 100, 3700,
  // 3760 and 3820: hour 0 holds a single 3600 s gap (the 600 s cap, 540 s on
  // top of the base) and hour 1 holds 60 s gaps (nothing on top).
  //
  // The rider boards at 3700. Ready at 3160 they are in hour 0 and owe 540 s;
  // ready at 3700 they are in hour 1 and owe nothing. Reverse charges the
  // larger, so the deadline is 3100 and the feeder arriving at 3640 is
  // refused. That refusal is DELIBERATE and conservative: the forward pass,
  // handed the 3640 arrival, computes hour 1 and does accept it. Both
  // journeys are legal; reverse declines to be the one that guesses which
  // side of the boundary the rider will land on. This is accepted exactly
  // in this direction -- boarding gets harder, never easier.
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3000, 3100], arr: [3000, 3100] },
    { stops: [0, 1], dep: [3540, 3640], arr: [3540, 3640] },
    { stops: [1, 2], dep: [100, 400], arr: [100, 400] },
    { stops: [1, 2], dep: [3700, 4000], arr: [3700, 4000] },
    { stops: [1, 2], dep: [3760, 4060], arr: [3760, 4060] },
    { stops: [1, 2], dep: [3820, 4120], arr: [3820, 4120] },
  ], []);
  const res = reverseWithMargin(ix, {
    nTrips: 6, destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4000, maxRounds: 3,
    transferMinSeconds: 60, factor: 1, capSeconds: 600,
  });
  assert.equal(res.rounds[1]![1]!.departureEpoch, BASE + 3700);
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 3000);
});

test("the margin short-circuit is not taken at an exact tie between the deadline and the held trip's arrival", () => {
  // The alighting check skips pricing the margin when the buffer-only
  // deadline is ALREADY below the held trip's arrival, since a non-negative
  // margin can only move it further below. That skip has a boundary, and the
  // boundary is load-bearing: at an exact EQUALITY the check must still run,
  // because a later-indexed trip tying on arrival is the one that departs
  // later further back along the pattern (the property `regression: an exact
  // arrival tie ...` above pins from the other direction). Weakening the
  // short-circuit from `<` to `<=` silently keeps the earlier trip, and
  // nothing else in this file notices.
  //
  //   Pattern p = [0,1,2]: trip A departs 2000 and trip B departs 2400, and
  //     they TIE arriving stop 1 at 3000. A alights stop 2 at 4000, B at 4200.
  //   R takes stop 2 -> the destination at 4000; Q takes stop 1 -> the
  //     destination at 3000.
  //
  // Round 2 scans p from stop 2, holds A there (B arrives too late for R),
  // then reaches stop 1 where the deadline Q imposes is 3000 and A's arrival
  // is 3000 exactly. Running the check swaps in B and reports a departure of
  // 2400; skipping it keeps A and reports 2000, an unnecessary 400 s earlier.
  //
  // No `transfer` here on purpose: the short-circuit gates the margin, but
  // its own boundary is a property of the flat buffer and must hold whether
  // or not the feature is switched on.
  const ix = makeTestIndex(5, [
    { stops: [0, 1, 2], dep: [2000, 3000, 4000], arr: [2000, 3000, 4000] }, // A
    { stops: [0, 1, 2], dep: [2400, 3000, 4200], arr: [2400, 3000, 4200] }, // B
    { stops: [2, 4], dep: [4000, 4500], arr: [4000, 4500] },                // R
    { stops: [1, 4], dep: [3000, 3500], arr: [3000, 3500] },                // Q
  ], []);
  const res = runRaptorReverse(ix, {
    origins: [], destinations: [{ stopIdx: 4, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4500,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1, 1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.departureEpoch, BASE + 3000);
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 2400);
  assert.equal(res.rounds[2]![0]!.alightStop, 1);
});

test("the transfer contract is refused loudly, in exactly the terms the forward pass refuses it", () => {
  // A caller that gets any of these wrong must find out from BOTH passes or
  // the two directions disagree about which queries are even legal.
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const days: DayContext[] = [
    { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([1]) },
    { dateYmd: 20260824, baseEpoch: BASE - 86400, activeTrip: Uint8Array.from([1]) },
  ];
  const base = {
    origins: [], destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000, days, maxRounds: 2, transferMinSeconds: 60,
  };
  const table = buildHeadwayTable(ix, days[0]!);

  assert.throws(
    () => runRaptorReverse(ix, {
      ...base, transfer: { cfg: { baseSeconds: 60, factor: 0.25, capSeconds: 600 }, headway: [table] },
    }),
    /1 tables for 2 days/,
  );
  assert.throws(
    () => runRaptorReverse(ix, {
      ...base,
      transfer: { cfg: { baseSeconds: 120, factor: 0.25, capSeconds: 600 }, headway: [table, table] },
    }),
    /must equal transferMinSeconds/,
  );
  assert.throws(
    () => runRaptorReverse(ix, {
      ...base,
      transfer: { cfg: { baseSeconds: 60, factor: 0.25, capSeconds: 30 }, headway: [table, table] },
    }),
    /an inverted clamp makes boarding easier/,
  );
});

// ---------------------------------------------------------------- provenance
test("a transit label's predecessor is the exact continuation label it was matched against, not a re-lookup by stop id", () => {
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [1, 2], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 6000,
    days: [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 1]) }],
    maxRounds: 3, transferMinSeconds: 0,
  });
  const leg0 = res.rounds[2]![0]!;
  assert.equal(leg0.departureEpoch, BASE + 3600);
  assert.equal(leg0.alightStop, 1);
  // predecessor must be the round-1 label at stop 1 (the trip alighted onto
  // stop 1 then continuing via trip 2 to stop 2), a direct object reference.
  const stop1Label = res.rounds[1]![1]!;
  assert.equal(leg0.predecessor, stop1Label);
  assert.equal(leg0.predecessor!.departureEpoch, BASE + 4500);
});
