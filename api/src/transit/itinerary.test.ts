import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTestIndex } from "./testIndex.js";
import { runRaptor, type DayContext, type Label } from "./raptor.js";
import { runRaptorReverse, type ReverseLabel } from "./raptorReverse.js";
import type { TimetableIndex } from "./index.js";
import { toIso } from "./calendar.js";
import { Translator } from "../db/i18n.js";
import { haversineMeters } from "../geo.js";
import {
  paretoRounds, reconstructForward, reconstructReverse, reconstructReverseChain,
  buildItinerary, hasRiddenReverse, mergeAdjacentWalkLegs, type TransitLeg, type WalkLeg, type Leg,
} from "./itinerary.js";

const BASE = 1_787_000_000;
const TZ = "Asia/Jerusalem";
const oneDay = (n: number): DayContext[] =>
  [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: new Uint8Array(n).fill(1) }];

// A Translator backed by an empty `translations` table -- these tests only
// care about reconstruction, not i18n, so every name round-trips to its raw
// feed text (see Translator.resolve's documented fallback).
function makeTranslator(): Translator {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE translations (trans_id TEXT, lang TEXT, translation TEXT)");
  return Translator.load(db);
}

const routeOf = (routeIdx: number): TransitLeg["route"] =>
  ({ id: `r${routeIdx}`, agencyId: null, shortName: null, longName: null, type: 3, color: null });

/**
 * `makeTestIndex` (shared with the RAPTOR suites) only populates the fields
 * RAPTOR itself reads -- patterns, times, footpaths -- since that is all it
 * needs. `buildItinerary` additionally reads stop/trip metadata that RAPTOR
 * never touches (names, coordinates, ids, headsigns, route/direction
 * indices), so every index used with `buildItinerary` in this file goes
 * through this wrapper to fill those in with deterministic placeholder
 * values.
 */
function withMeta(base: TimetableIndex): TimetableIndex {
  // Distinct, non-zero coordinates per stop -- not (0, 0) for every stop --
  // so a walk leg's haversine-based distanceMeters (see buildItinerary) is
  // actually exercised rather than trivially zero for every pair.
  const stopLat = new Float64Array(base.nStops);
  const stopLon = new Float64Array(base.nStops);
  for (let s = 0; s < base.nStops; s++) {
    stopLat[s] = 32.0 + s * 0.01;
    stopLon[s] = 34.7 + s * 0.01;
  }
  return {
    ...base,
    stopIds: Array.from({ length: base.nStops }, (_, s) => `s${s}`),
    stopNames: Array.from({ length: base.nStops }, (_, s) => `Stop ${s}`),
    stopLat, stopLon,
    tripIds: Array.from({ length: base.nTrips }, (_, t) => `t${t}`),
    tripHeadsigns: new Array<string | null>(base.nTrips).fill(null),
    tripNumbers: new Array<string | null>(base.nTrips).fill(null),
    tripRouteIdx: new Int32Array(base.nTrips),
    tripDirection: new Int8Array(base.nTrips),
  };
}

function buildIx(
  nStops: number,
  trips: { stops: number[]; dep: number[]; arr: number[] }[],
  foot?: [number, number, number][],
  opts?: { stopParent?: Int32Array; footpathsRouted?: boolean },
): TimetableIndex {
  return withMeta(makeTestIndex(nStops, trips, foot, opts));
}

// ---------------------------------------------------------------------------
// paretoRounds
// ---------------------------------------------------------------------------

test("paretoRounds keeps only strictly improving rounds", () => {
  const rounds = [
    [null],
    [{ arrivalEpoch: 1000 } as never],
    [{ arrivalEpoch: 1000 } as never], // no improvement: dropped
    [{ arrivalEpoch: 900 } as never],
  ];
  const out = paretoRounds(rounds, [{ stopIdx: 0, secondsToReach: 0 }]);
  assert.deepEqual(out.map((o) => o.round), [1, 3]);
});

test("paretoRounds accounts for egress walking time", () => {
  const rounds = [[null], [{ arrivalEpoch: 1000 } as never]];
  const out = paretoRounds(rounds, [{ stopIdx: 0, secondsToReach: 120 }]);
  assert.equal(out[0]!.arrivalEpoch, 1120);
});

// A walk-only label that arrives EARLIEST must not suppress the boarded
// labels behind it -- no matter which round it happens to land in. `/plan`
// drops walk-only itineraries outright, so letting one set `bestSoFar`
// deletes every journey a rider could actually take -- measured on the real
// feed as an empty response for a query that has a perfectly good bus.
//
// Round number cannot substitute for this check: a round-index cutoff
// instead of a real predicate does not work.
// RAPTOR's `best[]` never regresses, so a walk-only value that wins round 0
// is still present, unchanged, at every later round's own arg-min too (see
// `paretoRounds`' own doc comment) -- skipping round 0 just re-discovers the
// identical walk-only value at round 1. `accept` has to look at the label
// itself, not at which round it's in.
test("paretoRounds' accept predicate rejects a walk-only label no matter which round it wins", () => {
  // Round 0 reaches the destination at 100 but never boarded anything;
  // round 1 at 200, boarded; round 2 at 150, boarded.
  const rounds = [
    [{ arrivalEpoch: 100, ridden: false }],
    [{ arrivalEpoch: 200, ridden: true }],
    [{ arrivalEpoch: 150, ridden: true }],
  ];
  const destinations = [{ stopIdx: 0, secondsToReach: 0 }];

  // Default (no accept): round 0 wins and suppresses everything after it.
  const all = paretoRounds(rounds, destinations);
  assert.deepEqual(all.map((p) => p.round), [0]);

  // accept: round 0's label is rejected outright -- it neither appears NOR
  // sets `bestSoFar` -- so round 1 is emitted and round 2 improves on it.
  const ridden = paretoRounds(rounds, destinations, { accept: (l) => l.ridden });
  assert.deepEqual(ridden.map((p) => p.round), [1, 2]);
});

// Pins per-DESTINATION granularity, not per-round: production's actual shape
// is a single round holding a walk-only label at one destination stop AND a
// genuinely boarded label at a DIFFERENT destination stop, SIMULTANEOUSLY --
// see plan.test.ts's `serveWalkDominance` fixture, where round 1 holds stop
// 2000's walk-only label and stop 8000's boarded T7 label at the same time.
// If the accept check were hoisted out of the inner loop -- rejecting the
// whole ROUND whenever its best-by-arrival label happens to be walk-only,
// rather than rejecting that LABEL specifically -- this round would produce
// no pick at all, even though a perfectly good boarded label sits right next
// to the rejected one. Filtering the earlier test alone cannot catch that: it
// only ever has one destination stop per round.
test("paretoRounds' accept predicate rejects per label, not per round", () => {
  // One round, two destination stops: stop 0 arrives first (50) but never
  // boarded anything; stop 1 arrives later (150) but did.
  const rounds = [
    [{ arrivalEpoch: 50, ridden: false }, { arrivalEpoch: 150, ridden: true }],
  ];
  const destinations = [
    { stopIdx: 0, secondsToReach: 0 },
    { stopIdx: 1, secondsToReach: 0 },
  ];

  // accept rejects stop 0's label specifically -- stop 1's survives and wins
  // the round's pick, even though it arrives later.
  const picks = paretoRounds(rounds, destinations, { accept: (l) => l.ridden });
  assert.deepEqual(picks, [{ round: 0, stopIdx: 1, arrivalEpoch: 150 }]);
});

// The existing arriveBy and reverse-probe route tests prove `hasRiddenReverse`
// does not reject EVERYTHING, but none of them construct the case where it
// actually rejects -- a chain that terminates in "egress" without ever
// passing through "transit", i.e. a walk-only reverse candidate that would
// otherwise win a round's pick in `paretoRounds`' `accept` gate (`routes/
// plan.ts`'s `arriveBy` branch passes `(c) => hasRiddenReverse(c.src)`). Built
// directly, ReverseLabel-shaped, rather than run through a search -- the
// terminator was verified correct by inspection, so this closes a coverage
// gap rather than chasing a suspected bug.
test("hasRiddenReverse rejects a walk-only reverse chain", () => {
  const egress: ReverseLabel = {
    departureEpoch: 1000, kind: "egress", toStop: -1, tripIdx: -1, dayIdx: -1,
    patternPos: -1, alightStop: -1, alightEpoch: 1000, predecessor: null,
  };
  const walkOnly: ReverseLabel = {
    departureEpoch: 900, kind: "walk", toStop: 5, tripIdx: -1, dayIdx: -1,
    patternPos: -1, alightStop: -1, alightEpoch: 900, predecessor: egress,
  };
  assert.equal(hasRiddenReverse(walkOnly), false);

  // Contrast, same shape otherwise: a walk off a TRANSIT label is accepted --
  // rejection is about the chain's provenance (did it ever board something),
  // not about the label being examined having `kind: "walk"` itself.
  const transit: ReverseLabel = {
    departureEpoch: 800, kind: "transit", toStop: 5, tripIdx: 0, dayIdx: 0,
    patternPos: 0, alightStop: 5, alightEpoch: 900, predecessor: null,
  };
  const walkOffTransit: ReverseLabel = {
    departureEpoch: 900, kind: "walk", toStop: 6, tripIdx: -1, dayIdx: -1,
    patternPos: -1, alightStop: -1, alightEpoch: 900, predecessor: transit,
  };
  assert.equal(hasRiddenReverse(walkOffTransit), true);
});

// ---------------------------------------------------------------------------
// reconstructForward: hand-written cases
// ---------------------------------------------------------------------------

test("reconstructs a single-leg chain back to the access label", () => {
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 1);
  assert.ok(chain);
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "transit"]);
  assert.deepEqual(chain.map((c) => c.stopIdx), [0, 1]);
});

test("reconstructs a two-leg chain through the transfer stop", () => {
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [1, 2], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 2, 2)!;
  assert.deepEqual(chain.map((c) => c.stopIdx), [0, 1, 2]);
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "transit", "transit"]);
});

// A walk label points back within the same round, not the previous one.
test("reconstructs a chain ending in a footpath", () => {
  const ix = makeTestIndex(3,
    [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }],
    [[1, 2, 300]],
  );
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "transit", "walk"]);
});

test("reconstruction returns null for an unreached stop", () => {
  const ix = makeTestIndex(3, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(reconstructForward(ix, res.rounds, 1, 2), null);
});

// ---------------------------------------------------------------------------
// The core invariant this guards: predecessor is an object
// reference, not a stop-id lookup. `raptor.oracle.test.ts`'s regression test
// for a walk label's stale predecessor is the minimal reproducer for the
// 3.1%-of-walk-labels defect: a
// walk label's `fromStop` names a stop whose CURRENTLY STORED label (in
// `rounds[k]`) has since been overwritten by an unrelated, better arrival --
// so looking it up live would silently substitute the wrong leg.
// ---------------------------------------------------------------------------

test("reconstructForward follows predecessor object identity, not a stale rounds[k][fromStop] lookup", () => {
  // Trip0 reaches stop 1 via transit at 50; trip1 reaches stop 2 via transit
  // at 100. A footpath 1->2 (30s) then improves stop 2 to a WALK arrival of
  // 80 (50+30 < 100), overwriting stop 2's own stored round-1 label from
  // transit@100 to walk@80. A second footpath 2->3 (20s) is sourced from the
  // ORIGINAL transit@100 visit at stop 2 (captured before that overwrite),
  // not a live re-read of stop 2's now-overwritten current label.
  const ix = makeTestIndex(4, [
    { stops: [0, 1], dep: [0, 50], arr: [0, 50] },
    { stops: [0, 2], dep: [0, 100], arr: [0, 100] },
  ], [[1, 2, 30], [2, 3, 20]]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE,
    days: oneDay(2), maxRounds: 2, transferMinSeconds: 0,
  });
  const r1 = res.rounds[1]!;

  // Confirm the setup: stop 2's own live round-1 label DID get overwritten
  // to the cheaper walk (this is not itself a bug -- see raptor.ts).
  assert.equal(r1[2]!.kind, "walk");
  assert.equal(r1[2]!.arrivalEpoch, BASE + 80);

  const chain = reconstructForward(ix, res.rounds, 1, 3)!;
  assert.ok(chain);
  assert.deepEqual(chain.map((c) => c.stopIdx), [0, 2, 3]);
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "transit", "walk"]);
  // The stop-2 leg must be the ORIGINAL transit@100 arrival, not the stale
  // walk@80 currently sitting in `rounds[1][2]`.
  assert.equal(chain[1]!.label.arrivalEpoch, BASE + 100);
  assert.notEqual(chain[1]!.label, r1[2], "must not have re-looked-up rounds[1][2]");
});

// ---------------------------------------------------------------------------
// reconstructReverse / reconstructReverseChain
// ---------------------------------------------------------------------------

test("reconstructReverse walks predecessor toward the destination, already in travel order", () => {
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [1, 2], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 6000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructReverse(ix, res.rounds, 2, 0)!;
  assert.ok(chain);
  assert.deepEqual(chain.map((c) => c.stopIdx), [0, 1, 2]);
  assert.deepEqual(chain.map((c) => c.label.kind), ["transit", "transit", "egress"]);
  assert.equal(chain[0]!.label.departureEpoch, BASE + 3600);
  assert.equal(chain[1]!.label.departureEpoch, BASE + 4500);
});

test("reconstructReverseChain converts a reverse chain into forward-shaped legs", () => {
  const ix = buildIx(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [1, 2], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const days = oneDay(2);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 6000,
    days, maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructReverseChain(ix, res.rounds, 2, 0)!;
  assert.ok(chain);
  assert.deepEqual(chain.map((c) => c.stopIdx), [0, 1, 2]);
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "transit", "transit"]);
  assert.equal(chain[0]!.label.arrivalEpoch, BASE + 3600);
  assert.equal(chain[1]!.label.arrivalEpoch, BASE + 4200);
  assert.equal(chain[2]!.label.arrivalEpoch, BASE + 5100);

  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  assert.equal(itin.departureTime, toIso(BASE + 3600, TZ));
  assert.equal(itin.arrivalTime, toIso(BASE + 5100, TZ));
  assert.equal(itin.transfers, 1);
  assert.equal(itin.legs.length, 2);
});

test("reconstructReverseChain converts a trailing reverse walk correctly, even with slack before it", () => {
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }],
    [[2, 1, 300]],
  );
  const days = oneDay(1);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days, maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructReverseChain(ix, res.rounds, 1, 0)!;
  assert.ok(chain);
  assert.deepEqual(chain.map((c) => c.stopIdx), [0, 1, 2]);
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "transit", "walk"]);

  // The bus arrives at stop 1 at 4200, but the reverse search only needs to
  // depart on the footpath by 4700 (300s before the 5000 deadline) -- 500s of
  // genuine slack, not walking time. The walk label's OWN span (boardEpoch ->
  // arrivalEpoch) is still exactly the footpath's 300s; only the raw
  // arrival-to-arrival difference across the chain (800s) is inflated by
  // that slack, which is exactly why buildItinerary must not use it.
  const walk = chain[2]!.label;
  assert.equal(walk.arrivalEpoch - chain[1]!.label.arrivalEpoch, 800, "chain-adjacent gap includes slack");
  assert.equal(walk.arrivalEpoch - walk.boardEpoch, 300, "the label's own span is the true walk duration");

  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  const walkLeg = itin.legs.find((l) => l.type === "walk")!;
  assert.equal(walkLeg.durationSeconds, 300, "the reported walk duration must not include the slack");
});

// ---------------------------------------------------------------------------
// The buffer-inclusion decision (see the module's doc comment on
// `ctx.transferMinSeconds`): a footpath's stored seconds already fold in the
// boarding buffer, so buildItinerary must be able to strip it back out. The
// field is REQUIRED (a compile-time error at the call site beats a silently
// padded walk time in a response), so there is no "default" case left to
// test -- only "the caller passed 0" vs. "the caller passed the real buffer".
// ---------------------------------------------------------------------------

test("a walk leg's durationSeconds reports the raw span when told there is no buffer", () => {
  // Footpath cost 260s = a 200s walk + a 60s buffer baked in at footpath-
  // build time (see footpaths.ts's finalizeSeconds(walkSeconds + buffer)).
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [0, 100], arr: [0, 100] }],
    [[1, 2, 260]],
  );
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 2, transferMinSeconds: 60,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  const walk = itin.legs.find((l) => l.type === "walk")!;
  assert.equal(walk.durationSeconds, 260, "ctx.transferMinSeconds: 0 => raw span reported");
});

test("a walk leg's durationSeconds excludes the boarding buffer when told the buffer size", () => {
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [0, 100], arr: [0, 100] }],
    [[1, 2, 260]],
  );
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 2, transferMinSeconds: 60,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 60,
  });
  const walk = itin.legs.find((l) => l.type === "walk")!;
  assert.equal(walk.durationSeconds, 200, "the buffer must be stripped, leaving the walk itself");
});

test("a walk leg's distanceMeters is a real straight-line estimate, not a false 0", () => {
  // stop 1 -> stop 2 is a genuine footpath; withMeta gives every stop
  // distinct coordinates, so this must be a real, non-zero, computed
  // distance -- 0 would be a false MEASUREMENT (it aggregates into
  // walkMeters), not an honest "we don't know".
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [0, 100], arr: [0, 100] }],
    [[1, 2, 300]],
  );
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 2, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  const walk = itin.legs.find((l) => l.type === "walk")!;
  assert.ok(walk.distanceMeters > 0, "must not be the earlier false 0");
  // Same detour factor (1.35) the access/egress helper applies to its own
  // straight-line fallback (see src/walking/valhalla.ts's straightLineWalk),
  // over the same two stops' own coordinates -- computed independently here
  // rather than duplicating buildItinerary's internal constant by value.
  const expected = Math.round(
    haversineMeters([ix.stopLat[1]!, ix.stopLon[1]!], [ix.stopLat[2]!, ix.stopLon[2]!]) * 1.35,
  );
  assert.equal(walk.distanceMeters, expected);
  // `walkEstimated` now describes the DURATION's provenance, not the
  // distance's -- this index's footpaths were never attached as routed
  // (`buildIx` here defaults `footpathsRouted: false`, matching `buildIndex`
  // and `IndexManager`'s own "claims nothing until told otherwise" default),
  // so the duration is still the footpath-matrix/straight-line estimate.
  assert.equal(walk.walkEstimated, true, "this index's footpaths were never attached as routed");
  assert.equal(itin.walkMeters, expected, "walkMeters must aggregate the real estimate, not 0");
});

// ---------------------------------------------------------------------------
// walkEstimated on a mid-itinerary transfer leg: real (false) exactly when
// the index's footpaths were routed by Valhalla AND the pair is not a
// same-station interchange. See `stationOf`'s doc comment in itinerary.ts
// for why comparing it for both endpoints is the correct same-station test.
// ---------------------------------------------------------------------------

test("a street transfer leg reports walkEstimated false on a routed index", () => {
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [0, 100], arr: [0, 100] }],
    [[1, 2, 300]],
    { footpathsRouted: true },
  );
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 2, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  const walk = itin.legs.find((l) => l.type === "walk")!;
  assert.equal(
    walk.walkEstimated, false,
    "footpaths were routed by Valhalla and stops 1/2 are not in the same station",
  );
});

test("a same-station interchange reports walkEstimated true even on a routed index", () => {
  // Stop 2's parent is stop 1: the same footpath pair as the tests above,
  // but now a same-station interchange rather than a street transfer --
  // its duration is always the configured sameStationSeconds +
  // transferMinSeconds constant (footpaths.ts), never a routed street walk,
  // regardless of the index's own footpathsRouted mode.
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [0, 100], arr: [0, 100] }],
    [[1, 2, 300]],
    { footpathsRouted: true, stopParent: Int32Array.from([-1, -1, 1]) },
  );
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 2, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  const walk = itin.legs.find((l) => l.type === "walk")!;
  assert.equal(
    walk.walkEstimated, true,
    "a same-station interchange is always the configured constant, never routed, regardless of footpathsRouted",
  );
});

// ---------------------------------------------------------------------------
// Loop-pattern disambiguation: a stop that appears twice in one pattern.
// Matching purely by stop id picks the FIRST occurrence regardless of which
// one was actually ridden.
// ---------------------------------------------------------------------------

test("buildItinerary disambiguates a repeated stop in a loop pattern by matching the label's recorded time, not just its id", () => {
  // Single trip, pattern [0, 1, 2, 1, 3]. The traveller reaches stop 1
  // directly (access) at BASE+1200 -- too late for the first departure from
  // stop 1 (1100) but in time for the second (1500). The board must resolve
  // to the SECOND occurrence (position 3), riding straight to stop 3 with no
  // intermediate stops -- not the first occurrence (position 1), which would
  // wrongly claim a 3-stop ride through stop 2 and back through stop 1.
  const ix = buildIx(4, [{
    stops: [0, 1, 2, 1, 3],
    dep: [1000, 1100, 1300, 1500, 1700],
    arr: [1000, 1090, 1200, 1400, 1600],
  }]);
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 1, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 1200, days, maxRounds: 2, transferMinSeconds: 0,
  });
  const label = res.rounds[1]![3]!;
  assert.equal(label.kind, "transit");
  assert.equal(label.boardEpoch, BASE + 1500);
  assert.equal(label.arrivalEpoch, BASE + 1600);

  const chain = reconstructForward(ix, res.rounds, 1, 3)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  const leg = itin.legs.find((l): l is TransitLeg => l.type === "transit")!;
  assert.equal(leg.from.stopSequence, 3, "must board at the SECOND occurrence of stop 1");
  assert.equal(leg.to.stopSequence, 4);
  assert.equal(leg.numStops, 1);
  assert.equal(leg.intermediateStops.length, 0);
});

// ---------------------------------------------------------------------------
// departureTime / arrivalTime must be anchored on the chain itself, not only
// on transit legs -- otherwise a transit-less (pure walk/access) chain
// produces "" and a NaN duration, and a chain ending in a walk silently
// drops that walk's time from arrivalTime.
// ---------------------------------------------------------------------------

test("buildItinerary reports a real arrival/duration for a transit-less (walk-only) chain", () => {
  const ix = buildIx(2, [], [[0, 1, 300]]);
  const days = oneDay(0);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 1, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 0, 1)!;
  assert.deepEqual(chain.map((c) => c.label.kind), ["access", "walk"]);
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  assert.equal(itin.departureTime, toIso(BASE, TZ));
  assert.equal(itin.arrivalTime, toIso(BASE + 300, TZ));
  assert.equal(itin.durationSeconds, 300);
  assert.equal(itin.transfers, 0);
});

test("buildItinerary's arrivalTime includes a trailing chain-internal walk after the last ride", () => {
  const ix = buildIx(3,
    [{ stops: [0, 1], dep: [0, 100], arr: [0, 100] }],
    [[1, 2, 300]],
  );
  const days = oneDay(1);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE, days, maxRounds: 2, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const itin = buildItinerary(ix, chain, {
    tr: makeTranslator(), lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0,
  });
  // The last ride arrives at 100; the trailing walk adds 300 more.
  assert.equal(itin.arrivalTime, toIso(BASE + 400, TZ));
});

function walkLeg(from: number, to: number, distanceMeters: number, durationSeconds: number, walkEstimated: boolean): WalkLeg {
  return {
    type: "walk",
    from: { type: "coordinate", lat: from, lon: from },
    to: { type: "coordinate", lat: to, lon: to },
    distanceMeters, durationSeconds, walkEstimated,
    geometry: "not-null-before-merge",
  };
}

test("mergeAdjacentWalkLegs collapses two consecutive walk legs into one", () => {
  // This is the access-leg-then-round-0-footpath shape `buildItinerary`
  // produces: `accessLeg` bookended onto a chain whose first real hop is
  // itself a walk (RAPTOR's round-0 footpath relaxation can land somewhere
  // other than the access point before ever boarding).
  const legs: Leg[] = [walkLeg(0, 1, 100, 60, false), walkLeg(1, 2, 200, 120, true)];
  const merged = mergeAdjacentWalkLegs(legs);
  assert.equal(merged.length, 1);
  const [leg] = merged as [WalkLeg];
  assert.equal(leg.from.lat, 0);
  assert.equal(leg.to.lat, 2);
  assert.equal(leg.distanceMeters, 300);
  assert.equal(leg.durationSeconds, 180);
  // `false || true` -- estimated if EITHER half was, since the merged leg is
  // no more reliable than its least reliable half.
  assert.equal(leg.walkEstimated, true);
  // Not a naive concatenation of two stale halves -- re-routed fresh instead.
  assert.equal(leg.geometry, null);
});

test("mergeAdjacentWalkLegs leaves a transit leg between two walks untouched", () => {
  const ride: TransitLeg = {
    type: "transit",
    route: { id: "r1", agencyId: null, shortName: "1", longName: null, type: 3, color: null },
    tripId: "t1", headsign: null, tripNumber: null, directionId: 0,
    from: { stop: { type: "stop", lat: 1, lon: 1 }, departureTime: "",
            scheduledDepartureTime: "", stopSequence: 0 },
    to: { stop: { type: "stop", lat: 2, lon: 2 }, arrivalTime: "",
          scheduledArrivalTime: "", stopSequence: 1 },
    numStops: 1, intermediateStops: [], geometry: null, geometryFallback: true, realtime: null,
    alternatives: [],
  };
  const legs: Leg[] = [walkLeg(0, 1, 100, 60, false), ride, walkLeg(2, 3, 100, 60, false)];
  const merged = mergeAdjacentWalkLegs(legs);
  assert.deepEqual(merged, legs);
});

test("mergeAdjacentWalkLegs collapses three consecutive walk legs into one", () => {
  const legs: Leg[] = [walkLeg(0, 1, 10, 5, false), walkLeg(1, 2, 20, 10, false), walkLeg(2, 3, 30, 15, false)];
  const merged = mergeAdjacentWalkLegs(legs);
  assert.equal(merged.length, 1);
  const [leg] = merged as [WalkLeg];
  assert.equal(leg.from.lat, 0);
  assert.equal(leg.to.lat, 3);
  assert.equal(leg.distanceMeters, 60);
  assert.equal(leg.durationSeconds, 30);
});

// ===========================================================================
// PROPERTY TESTS
//
// The lesson of this whole project: hand-written, example-based tests found
// zero of the six defects fixed in raptor.ts/raptorReverse.ts. Differential
// and property testing over many random networks found all of them. This
// harness generates many small, deterministic random networks (loops, dwell
// times, footpaths, multi-day calendars), reconstructs every reachable
// (round, stop) chain in both directions, and checks the invariants a
// itinerary consumer actually depends on -- directly against the index's own
// raw arrays, not by re-deriving buildItinerary's logic in a way that could
// share its bugs.
//
// Deterministic seed 20260822, 300 trials per
// direction (600 total). Each trial reconstructs and validates every
// reachable (round, stop) pair, not just one, so this runs in ~75-105ms per
// direction -- slower than the plain-RAPTOR oracle suites' 13-15ms, but
// still comfortably sub-second -- since networks are capped at 8
// stops and 5 patterns.
// ===========================================================================

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Trip = { stops: number[]; dep: number[]; arr: number[] };
type NetOpts = { multiDay: boolean; loops: boolean; dwell: boolean; foot: boolean };
type Net = {
  nStops: number; trips: Trip[]; foot: [number, number, number][];
  days: DayContext[];
  points: { stopIdx: number; secondsToReach: number }[];
  maxRounds: number; transferMinSeconds: number;
};

const PROP_BASE = 1_787_000_000;

function genNet(rnd: () => number, opts: NetOpts): Net {
  const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
  const nStops = ri(4, 8);

  const nPatterns = ri(2, 5);
  const trips: Trip[] = [];
  for (let p = 0; p < nPatterns; p++) {
    const len = ri(2, Math.min(5, nStops));
    const seq: number[] = [];
    for (let i = 0; i < len; i++) seq.push(ri(0, nStops - 1));
    if (opts.loops && rnd() < 0.5 && seq.length >= 3) seq[seq.length - 1] = seq[0]!;
    const nTrips = ri(1, 4);
    for (let q = 0; q < nTrips; q++) {
      const dep: number[] = []; const arr: number[] = [];
      let t = ri(0, 12) * 300 + (opts.multiDay && rnd() < 0.4 ? 86400 : 0);
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

  const days: DayContext[] = [];
  const nDays = opts.multiDay ? 2 : 1;
  for (let d = 0; d < nDays; d++) {
    const active = new Uint8Array(trips.length);
    for (let t = 0; t < trips.length; t++) active[t] = rnd() < 0.75 ? 1 : 0;
    days.push({
      dateYmd: 20260824 + d,
      baseEpoch: d === 0 ? PROP_BASE : PROP_BASE - 86400,
      activeTrip: active,
    });
  }

  const points: { stopIdx: number; secondsToReach: number }[] = [];
  const nPoints = ri(1, 2);
  for (let i = 0; i < nPoints; i++) {
    points.push({ stopIdx: ri(0, nStops - 1), secondsToReach: ri(0, 3) * 300 });
  }

  return {
    nStops, trips, foot: opts.foot ? foot : [], days, points,
    maxRounds: ri(2, 4),
    transferMinSeconds: [0, 0, 60, 120, 300][ri(0, 4)]!,
  };
}

/**
 * Validates a forward-shaped `{ stopIdx, label }[]` chain (whether produced
 * directly by `reconstructForward` or converted by `reconstructReverseChain`)
 * against the index's own raw pattern/footpath arrays -- independent of
 * however `buildItinerary` itself locates board/alight positions, since this
 * re-derives them from scratch.
 */
function validateChain(ix: TimetableIndex, days: readonly DayContext[], chain: { stopIdx: number; label: Label }[]): void {
  assert.ok(chain.length >= 1, "chain must be non-empty");
  assert.equal(chain[0]!.label.kind, "access", "chain must start with an access label");

  for (let i = 1; i < chain.length; i++) {
    const entry = chain[i]!;
    const prev = chain[i - 1]!;
    const label = entry.label;

    assert.ok(
      label.arrivalEpoch >= prev.label.arrivalEpoch,
      `step ${i}: arrival (${label.arrivalEpoch}) precedes the previous leg's end (${prev.label.arrivalEpoch})`,
    );

    if (label.kind === "walk") {
      assert.notEqual(prev.label.kind, "walk", `step ${i}: walk immediately follows a walk`);
      // A reverse-converted chain can have slack between two legs (the
      // reverse search reports each leg's LATEST feasible time, so an
      // earlier leg's actual completion can precede a later walk's
      // necessary start) -- so the walk's true duration is its OWN span
      // (boardEpoch -> arrivalEpoch), not the raw gap between adjacent
      // chain entries. Contiguity (not starting before the previous leg
      // ended) is still required, just not zero-slack equality.
      assert.ok(
        label.boardEpoch >= prev.label.arrivalEpoch,
        `step ${i}: walk started (${label.boardEpoch}) before the previous leg ended (${prev.label.arrivalEpoch})`,
      );
      const from = prev.stopIdx;
      const to = entry.stopIdx;
      const walkDuration = label.arrivalEpoch - label.boardEpoch;
      // A genuine forward walk label stores its edge under footOffset[from]
      // (relaxFootpaths always relaxes FROM the already-known stop). A
      // reverse-converted one is the mirror: relaxFootpathsReverse reads the
      // edge from footOffset[toStop] (the already-known, destination-ward
      // stop -- `to` here) and targets the newly-reached stop (`from` here),
      // reusing the forward s->t edge's cost for what is physically a t->s
      // walk. This validator is shared by both directions (see its doc
      // comment), so it doesn't know which produced any given entry --
      // checking both orientations is what makes it correct for either.
      let matched = false;
      for (let e = ix.footOffset[from]!; e < ix.footOffset[from + 1]!; e++) {
        if (ix.footTarget[e] === to && ix.footSeconds[e] === walkDuration) { matched = true; break; }
      }
      if (!matched) {
        for (let e = ix.footOffset[to]!; e < ix.footOffset[to + 1]!; e++) {
          if (ix.footTarget[e] === from && ix.footSeconds[e] === walkDuration) { matched = true; break; }
        }
      }
      assert.ok(matched, `step ${i}: walk ${from}->${to} (${walkDuration}s) not in footpath arrays (either orientation)`);
    } else {
      const t = label.tripIdx;
      const p = ix.patternOfTrip[t]!;
      const stopFrom = ix.patternStopOffset[p]!;
      const stopTo = ix.patternStopOffset[p + 1]!;
      const timeFrom = ix.tripTimeOffset[t]!;
      const day = days[label.dayIdx];
      assert.ok(day !== undefined, `step ${i}: label.dayIdx (${label.dayIdx}) out of range`);

      let boardPos = -1;
      let alightPos = -1;
      for (let j = stopFrom; j < stopTo; j++) {
        const s = ix.patternStops[j]!;
        const pos = j - stopFrom;
        if (boardPos < 0) {
          if (s === label.boardStop && day!.baseEpoch + ix.departureTime[timeFrom + pos]! === label.boardEpoch) {
            boardPos = pos;
          }
        } else if (s === entry.stopIdx && day!.baseEpoch + ix.arrivalTime[timeFrom + pos]! === label.arrivalEpoch) {
          alightPos = pos;
          break;
        }
      }
      assert.ok(boardPos >= 0, `step ${i}: board position not found for trip ${t}`);
      assert.ok(alightPos >= 0, `step ${i}: alight position not found for trip ${t}`);
      assert.ok(boardPos < alightPos, `step ${i}: board (${boardPos}) must precede alight (${alightPos})`);
      assert.ok(
        label.boardEpoch >= prev.label.arrivalEpoch,
        `step ${i}: boarded (${label.boardEpoch}) before the previous leg ended (${prev.label.arrivalEpoch})`,
      );
    }
  }
}

/** Cross-checks buildItinerary's own output against the chain it was built from. */
function validateItinerary(ix: TimetableIndex, tr: Translator, days: readonly DayContext[], chain: { stopIdx: number; label: Label }[]): void {
  const itin = buildItinerary(ix, chain, { tr, lang: "he", tz: TZ, days, routeOf, transferMinSeconds: 0 });

  const last = chain[chain.length - 1]!;
  const first = chain[0]!;
  assert.equal(itin.arrivalTime, toIso(last.label.arrivalEpoch, TZ), "arrivalTime must match the chain's own final label");
  assert.equal(itin.departureTime, toIso(first.label.arrivalEpoch, TZ), "departureTime must match the chain's own access label");

  const transitCount = chain.slice(1).filter((c) => c.label.kind === "transit").length;
  assert.equal(itin.transfers, Math.max(0, transitCount - 1));
  // One leg per non-access chain entry: a silently dropped leg (e.g. from a
  // board/alight position that failed to resolve) would show up here as a
  // length mismatch.
  assert.equal(itin.legs.length, chain.length - 1);

  // distanceMeters must be a real (straight-line-estimated) measurement, not
  // a false 0: any walk leg that actually took time must also cover ground.
  // withMeta gives every stop distinct, non-zero coordinates precisely so
  // this can be checked meaningfully rather than vacuously.
  for (const leg of itin.legs) {
    if (leg.type === "walk" && leg.durationSeconds > 0) {
      assert.ok(leg.distanceMeters > 0, "a walk leg that took time must report non-zero distance");
    }
  }
}

const SEED = 20260822;
const TRIALS = 300;

test("property: reconstructForward + buildItinerary agree with the index for every reachable (round, stop), forward pass", () => {
  const rnd = mulberry32(SEED);
  const tr = makeTranslator();
  let checked = 0;

  for (let n = 0; n < TRIALS; n++) {
    const opts = {
      multiDay: rnd() < 0.35, loops: rnd() < 0.35, dwell: rnd() < 0.35, foot: rnd() < 0.6,
    };
    const net = genNet(rnd, opts);
    const ix = buildIx(net.nStops, net.trips, net.foot);
    const res = runRaptor(ix, {
      origins: net.points, destinations: [], // no destinations => no bound pruning
      departAfterEpoch: PROP_BASE + 300,
      days: net.days, maxRounds: net.maxRounds, transferMinSeconds: net.transferMinSeconds,
    });

    for (let k = 0; k < res.rounds.length; k++) {
      for (let s = 0; s < net.nStops; s++) {
        const label = res.rounds[k]![s];
        if (label === null || label === undefined) continue;

        const chain = reconstructForward(ix, res.rounds, k, s);
        assert.ok(chain, `trial ${n}: reconstructForward(${k}, ${s}) unexpectedly null`);
        assert.equal(
          chain[chain.length - 1]!.stopIdx, s,
          `trial ${n}: chain must end at the requested stop`,
        );
        validateChain(ix, net.days, chain);
        validateItinerary(ix, tr, net.days, chain);
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `expected substantial coverage, only checked ${checked} chains`);
});

test("property: reconstructReverseChain + buildItinerary agree with the index for every reachable (round, stop), reverse pass", () => {
  const rnd = mulberry32(SEED + 1);
  const tr = makeTranslator();
  let checked = 0;

  for (let n = 0; n < TRIALS; n++) {
    const opts = {
      multiDay: rnd() < 0.35, loops: rnd() < 0.35, dwell: rnd() < 0.35, foot: rnd() < 0.6,
    };
    const net = genNet(rnd, opts);
    const ix = buildIx(net.nStops, net.trips, net.foot);
    const res = runRaptorReverse(ix, {
      origins: [], destinations: net.points, // no origins => no bound pruning
      arriveByEpoch: PROP_BASE + 6000,
      days: net.days, maxRounds: net.maxRounds, transferMinSeconds: net.transferMinSeconds,
    });

    for (let k = 0; k < res.rounds.length; k++) {
      for (let s = 0; s < net.nStops; s++) {
        const label = res.rounds[k]![s];
        if (label === null || label === undefined) continue;

        const raw = reconstructReverse(ix, res.rounds, k, s);
        assert.ok(raw, `trial ${n}: reconstructReverse(${k}, ${s}) unexpectedly null`);
        assert.equal(raw[0]!.stopIdx, s, "raw reverse chain must start at the requested stop");
        assert.equal(raw[raw.length - 1]!.label.kind, "egress", "raw reverse chain must end in an egress label");
        validateRawReverseChain(ix, raw);

        const chain = reconstructReverseChain(ix, res.rounds, k, s);
        assert.ok(chain, `trial ${n}: reconstructReverseChain(${k}, ${s}) unexpectedly null`);
        // Same stop sequence as the raw chain, position for position: the
        // conversion RELABELS each entry (a leg-leaving-a-stop becomes a
        // leg-arriving-at-the-next-stop) rather than dropping any position --
        // the raw chain's trailing egress entry's stop id survives as the
        // converted chain's final entry, just reinterpreted; only the
        // egress *label* is discarded, not its stop.
        assert.deepEqual(chain.map((c) => c.stopIdx), raw.map((c) => c.stopIdx));
        assert.equal(chain[0]!.label.arrivalEpoch, raw[0]!.label.departureEpoch);
        // The degenerate case (raw.length === 1) is the stop itself being an
        // egress bookend with no real leg before it -- e.g. it's already
        // within egress distance of the destination -- so there is no
        // "last real leg" to cross-check against.
        if (raw.length >= 2) {
          const lastReal = raw[raw.length - 2]!;
          assert.equal(chain[chain.length - 1]!.label.arrivalEpoch, lastReal.label.alightEpoch);
        }

        validateChain(ix, net.days, chain);
        validateItinerary(ix, tr, net.days, chain);
        checked++;
      }
    }
  }
  assert.ok(checked > 300, `expected substantial coverage, only checked ${checked} chains`);
});

/** Structural sanity on the raw ReverseLabel chain, before conversion. */
function validateRawReverseChain(ix: TimetableIndex, chain: { stopIdx: number; label: ReverseLabel }[]): void {
  for (let i = 0; i < chain.length - 1; i++) {
    const entry = chain[i]!;
    const next = chain[i + 1]!;
    const label = entry.label;
    assert.equal(label.toStop, next.stopIdx, `step ${i}: predecessor's stop must equal toStop`);
    assert.ok(label.departureEpoch <= label.alightEpoch, `step ${i}: departure after alight`);
    if (label.kind === "walk") {
      if (i > 0) assert.notEqual(chain[i - 1]!.label.kind, "walk", `step ${i}: walk immediately follows a walk`);
      // `relaxFootpathsReverse` reads the edge from `footOffset[s]` where `s`
      // is the ALREADY-known, destination-ward stop (== `next.stopIdx` /
      // `toStop` here) and writes the new label at the footpath's target
      // (== `entry.stopIdx`) -- i.e. it reuses the forward s->t edge's cost
      // for what is physically a t->s walk, the same way the forward pass
      // stores an edge under its origin. So the edge to look up lives under
      // `next.stopIdx`'s block, targeting `entry.stopIdx` -- backward from
      // where a forward walk's edge would be, matching this label's own
      // reversed direction.
      let matched = false;
      for (let e = ix.footOffset[next.stopIdx]!; e < ix.footOffset[next.stopIdx + 1]!; e++) {
        if (ix.footTarget[e] === entry.stopIdx
          && ix.footSeconds[e] === label.alightEpoch - label.departureEpoch) { matched = true; break; }
      }
      assert.ok(matched, `step ${i}: reverse walk ${entry.stopIdx}->${next.stopIdx} not in footpath arrays`);
    }
  }
}
