import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestIndex } from "../transit/testIndex.js";
import { runRaptor, type DayContext } from "../transit/raptor.js";
import { reconstructForward, buildItinerary, type Itinerary } from "../transit/itinerary.js";
import type { TimetableIndex } from "../transit/index.js";
import {
  doorDepartureEpoch, reanchorDeparture, reoptimiseBounded, reoptimiseItinerary,
} from "./reoptimise.js";
import { toIso } from "../transit/calendar.js";

const BASE = 1_787_000_000;
const TZ = "Asia/Jerusalem";
const oneDay = (n: number): DayContext[] =>
  [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: new Uint8Array(n).fill(1) }];

const routeOf = () => ({ id: "R", agencyId: null, shortName: "R", longName: null, type: 3, color: null });

/**
 * `makeTestIndex` (shared with the RAPTOR suites) only populates the fields
 * RAPTOR itself reads -- patterns, times, footpaths. `buildItinerary`
 * additionally reads stop/trip metadata RAPTOR never touches (names,
 * coordinates, ids, headsigns, route/direction indices); see the identical
 * wrapper in `itinerary.test.ts`, which this mirrors for the same reason.
 */
function withMeta(base: TimetableIndex): TimetableIndex {
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
): TimetableIndex {
  return withMeta(makeTestIndex(nStops, trips, foot));
}

function planOn(
  ix: TimetableIndex, days: DayContext[], departAfterEpoch: number,
): { itinerary: Itinerary; build: (c: never) => Itinerary } {
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch, days, maxRounds: 3, transferMinSeconds: 0,
  });
  const chain = reconstructForward(ix, res.rounds, 1, 2)!;
  const build = (c: never): Itinerary => buildItinerary(ix, c, {
    tr: { resolve: (r: string | null) => r } as never, lang: "he", tz: TZ, days,
    routeOf, transferMinSeconds: 0,
  });
  return { itinerary: build(chain as never), build };
}

test("doorDepartureEpoch is the first boarding, less the walks before it", () => {
  const it: Itinerary = {
    departureTime: "2026-08-24T07:00:00+03:00",
    arrivalTime: "2026-08-24T08:10:00+03:00",
    durationSeconds: 4200, transfers: 0, walkSeconds: 180, walkMeters: 200,
    legs: [
      { type: "walk", from: { type: "coordinate", lat: 0, lon: 0 },
        to: { type: "stop", lat: 0, lon: 0, stopId: "a" },
        distanceMeters: 200, durationSeconds: 180, geometry: null, walkEstimated: true },
      { type: "transit", route: routeOf(), tripId: "T", headsign: null, tripNumber: null, directionId: 0,
        from: { stop: { type: "stop", lat: 0, lon: 0, stopId: "a" },
                departureTime: "2026-08-24T08:00:00+03:00", scheduledDepartureTime: "2026-08-24T08:00:00+03:00", stopSequence: 0 },
        to: { stop: { type: "stop", lat: 0, lon: 0, stopId: "b" },
              arrivalTime: "2026-08-24T08:10:00+03:00", scheduledArrivalTime: "2026-08-24T08:10:00+03:00", stopSequence: 1 },
        numStops: 1, intermediateStops: [], geometry: null, geometryFallback: false, realtime: null, alternatives: [] },
    ],
    transferAtRisk: null,
  };
  // 08:00 boarding minus a 3-minute walk = leave at 07:57, not the 07:00 query.
  assert.equal(doorDepartureEpoch(it), Date.parse("2026-08-24T07:57:00+03:00") / 1000);
});

test("doorDepartureEpoch returns null for a walk-only itinerary", () => {
  const it: Itinerary = {
    departureTime: "2026-08-24T07:00:00+03:00", arrivalTime: "2026-08-24T07:05:00+03:00",
    durationSeconds: 300, transfers: 0, walkSeconds: 300, walkMeters: 300,
    legs: [{ type: "walk", from: { type: "coordinate", lat: 0, lon: 0 },
             to: { type: "coordinate", lat: 0, lon: 0 },
             distanceMeters: 300, durationSeconds: 300, geometry: null, walkEstimated: true }],
    transferAtRisk: null,
  };
  assert.equal(doorDepartureEpoch(it), null);
});

test("reanchorDeparture rewrites departure and duration but not the legs", () => {
  const ix = buildIx(3, [{ stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] }]);
  const { itinerary } = planOn(ix, oneDay(1), BASE + 600);
  const before = JSON.stringify(itinerary.legs);
  const after = reanchorDeparture(itinerary, TZ);
  assert.equal(JSON.stringify(after.legs), before, "legs must not change");
  assert.equal(
    Date.parse(after.departureTime) / 1000,
    Date.parse((after.legs[0] as { from: { departureTime: string } }).from.departureTime) / 1000,
  );
  assert.equal(
    after.durationSeconds,
    (Date.parse(after.arrivalTime) - Date.parse(after.departureTime)) / 1000,
  );
});

// THE CASE STEP ONE CANNOT FIX, and the whole reason the reverse pass exists.
// Two trips arrive at 4200: an early slow one leaving at 3600, and a later
// express leaving at 4000. Re-anchoring alone reports 3600; the traveller can
// actually leave at 4000.
test("reoptimiseItinerary finds a later departure with the same arrival", () => {
  const ix = buildIx(3, [
    { stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] },  // slow
    { stops: [0, 2], dep: [4000, 4200], arr: [4000, 4200] },  // express
  ]);
  const days = oneDay(2);
  const { itinerary, build } = planOn(ix, days, BASE + 600);
  const anchored = reanchorDeparture(itinerary, TZ);
  assert.equal(Date.parse(anchored.departureTime) / 1000, BASE + 3600, "baseline is the slow trip");

  const improved = reoptimiseItinerary(anchored, {
    ix, tz: TZ,
    reverseQuery: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }],
      destinations: [{ stopIdx: 2, secondsToReach: 0 }],
      days, transferMinSeconds: 0,
    },
    buildFrom: build as never,
  });
  assert.equal(Date.parse(improved.departureTime) / 1000, BASE + 4000, "should take the express");
  assert.equal(improved.arrivalTime, anchored.arrivalTime, "arrival must not change");
  assert.equal(improved.transfers, anchored.transfers, "transfers must not change");
});

test("reoptimiseItinerary keeps the original when no later departure exists", () => {
  const ix = buildIx(3, [{ stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] }]);
  const days = oneDay(1);
  const { itinerary, build } = planOn(ix, days, BASE + 600);
  const anchored = reanchorDeparture(itinerary, TZ);
  const out = reoptimiseItinerary(anchored, {
    ix, tz: TZ,
    reverseQuery: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }],
      destinations: [{ stopIdx: 2, secondsToReach: 0 }],
      days, transferMinSeconds: 0,
    },
    buildFrom: build as never,
  });
  assert.equal(out.departureTime, anchored.departureTime);
  assert.equal(out.arrivalTime, anchored.arrivalTime);
});

// EDGE CASE: a walk-only itinerary has no
// transit leg to re-board, and `transfers` collapses "0 transit legs" and "1
// transit leg" to the same value (0) via `Math.max(0, transitLegs.length -
// 1)`. Without a guard, `reoptimiseItinerary` would run a 1-round reverse
// search against a walk-only itinerary and could, in principle, replace it
// with an unrelated transit journey that happens to share both the arrival
// instant and a transfer count of 0. `doorDepartureEpoch` returning null is
// the existing signal that there is nothing to re-board from, so
// `reoptimiseItinerary` must bail out on it exactly as `reanchorDeparture`
// already does.
test("reoptimiseItinerary leaves a walk-only itinerary unchanged", () => {
  const ix = buildIx(3, [{ stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] }]);
  const walkOnly: Itinerary = {
    departureTime: "2026-08-24T07:00:00+03:00", arrivalTime: "2026-08-24T07:05:00+03:00",
    durationSeconds: 300, transfers: 0, walkSeconds: 300, walkMeters: 300,
    legs: [{ type: "walk", from: { type: "coordinate", lat: 0, lon: 0 },
             to: { type: "coordinate", lat: 0, lon: 0 },
             distanceMeters: 300, durationSeconds: 300, geometry: null, walkEstimated: true }],
    transferAtRisk: null,
  };
  const out = reoptimiseItinerary(walkOnly, {
    ix, tz: TZ,
    reverseQuery: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }],
      destinations: [{ stopIdx: 2, secondsToReach: 0 }],
      days: oneDay(1), transferMinSeconds: 0,
    },
    buildFrom: () => { throw new Error("must not be called for a walk-only itinerary"); },
  });
  assert.equal(out, walkOnly);
});

// Regression coverage: the acceptance rule in
// `reoptimiseItinerary` must reject a candidate whose transfer count is
// merely NOT WORSE (fewer-or-equal) and accept only an EXACTLY EQUAL one --
// see the module's own doc comment for why ("no worse" would let a
// fewer-transfer candidate silently collapse into another Pareto member the
// forward pass's own round structure already produces separately). This
// test fails if that `!==` check is ever relaxed to something like
// `candidate.transfers > itinerary.transfers`.
//
// Seed: a hand-built 1-transfer itinerary arriving at BASE+2000. `ix`
// contains no trips for that 2-trip journey at all -- only a single DIRECT
// (0-transfer) trip, also arriving at exactly BASE+2000, departing LATER
// (BASE+1700) than the seed's own door departure (BASE+1000). The reverse
// pass genuinely surfaces that direct trip as a candidate (same arrival,
// later departure) -- the correct code must still reject it, because its
// transfer count (0) does not equal the seed's (1).
test("reoptimiseItinerary rejects a same-arrival candidate with a different transfer count", () => {
  const ix = buildIx(3, [{ stops: [0, 2], dep: [1700, 2000], arr: [1700, 2000] }]);
  const seed: Itinerary = {
    departureTime: toIso(BASE + 1000, TZ),
    arrivalTime: toIso(BASE + 2000, TZ),
    durationSeconds: 1000, transfers: 1, walkSeconds: 0, walkMeters: 0,
    legs: [
      { type: "transit", route: routeOf(), tripId: "seedA", headsign: null, tripNumber: null, directionId: 0,
        from: { stop: { type: "stop", lat: 0, lon: 0, stopId: "a" },
                departureTime: toIso(BASE + 1000, TZ),
                scheduledDepartureTime: toIso(BASE + 1000, TZ), stopSequence: 0 },
        to: { stop: { type: "stop", lat: 0, lon: 0, stopId: "b" },
              arrivalTime: toIso(BASE + 1500, TZ),
              scheduledArrivalTime: toIso(BASE + 1500, TZ), stopSequence: 1 },
        numStops: 1, intermediateStops: [], geometry: null, geometryFallback: false, realtime: null, alternatives: [] },
      { type: "transit", route: routeOf(), tripId: "seedB", headsign: null, tripNumber: null, directionId: 0,
        from: { stop: { type: "stop", lat: 0, lon: 0, stopId: "b" },
                departureTime: toIso(BASE + 1600, TZ),
                scheduledDepartureTime: toIso(BASE + 1600, TZ), stopSequence: 0 },
        to: { stop: { type: "stop", lat: 0, lon: 0, stopId: "c" },
              arrivalTime: toIso(BASE + 2000, TZ),
              scheduledArrivalTime: toIso(BASE + 2000, TZ), stopSequence: 1 },
        numStops: 1, intermediateStops: [], geometry: null, geometryFallback: false, realtime: null, alternatives: [] },
    ],
    transferAtRisk: null,
  };

  const out = reoptimiseItinerary(seed, {
    ix, tz: TZ,
    reverseQuery: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }],
      destinations: [{ stopIdx: 2, secondsToReach: 0 }],
      days: oneDay(1), transferMinSeconds: 0,
    },
    buildFrom: (chain) => buildItinerary(ix, chain, {
      tr: { resolve: (r: string | null) => r } as never, lang: "he", tz: TZ,
      days: oneDay(1), routeOf, transferMinSeconds: 0,
    }),
  });

  assert.equal(out.transfers, 1, "the fewer-transfer direct trip must be rejected");
  assert.equal(out.departureTime, seed.departureTime, "departure must not change");
  assert.equal(out.arrivalTime, seed.arrivalTime);
});


// THE BOUND, and the invariant that makes it safe to have one. Reoptimisation
// is the expensive half of this feature -- a second reverse RAPTOR pass per
// itinerary, measured at 107/136/206/321/453/590 ms for 1..6 returned Pareto
// members on the live feed -- so it is applied only to the first
// `planConfig.reoptimiseMaxItineraries` members. What must NOT be bounded is
// re-anchoring: an itinerary past the bound still has to report its own first
// boarding, never the query instant, or the bound would quietly reintroduce
// the exact bug this feature exists to fix.
//
// Same network as "finds a later departure with the same arrival" above: a
// slow trip leaving at 3600 and an express leaving at 4000, both arriving at
// 4200, queried at 600.
test("reoptimiseBounded reoptimises within the bound and re-anchors past it", () => {
  const ix = buildIx(3, [
    { stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] },  // slow
    { stops: [0, 2], dep: [4000, 4200], arr: [4000, 4200] },  // express
  ]);
  const days = oneDay(2);
  const { itinerary, build } = planOn(ix, days, BASE + 600);
  // The raw forward chain reports the QUERY INSTANT, which is the regression.
  assert.equal(Date.parse(itinerary.departureTime) / 1000, BASE + 600);

  const deps = {
    ix, tz: TZ,
    reverseQuery: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }],
      destinations: [{ stopIdx: 2, secondsToReach: 0 }],
      days, transferMinSeconds: 0,
    },
    buildFrom: build as never,
  };

  const within = reoptimiseBounded(0, 3, itinerary, deps);
  assert.equal(Date.parse(within.departureTime) / 1000, BASE + 4000,
    "position 0 of 3 must be fully reoptimised onto the express");

  const past = reoptimiseBounded(3, 3, itinerary, deps);
  assert.equal(Date.parse(past.departureTime) / 1000, BASE + 3600,
    "position 3 of 3 must still be re-anchored on its own boarding");
  assert.equal(past.arrivalTime, within.arrivalTime, "arrival is untouched either way");
  assert.equal(
    past.durationSeconds,
    (Date.parse(past.arrivalTime) - Date.parse(past.departureTime)) / 1000,
    "duration must follow the re-anchored departure",
  );
});

// A bound of 0 is a valid configuration (PLAN_REOPTIMISE_MAX_ITINERARIES=0)
// and must still leave every itinerary re-anchored -- never at the query
// instant. Guards against the bound ever being implemented as "skip both
// steps".
test("reoptimiseBounded still re-anchors when the bound is zero", () => {
  const ix = buildIx(3, [{ stops: [0, 2], dep: [3600, 4200], arr: [3600, 4200] }]);
  const days = oneDay(1);
  const { itinerary, build } = planOn(ix, days, BASE + 600);
  const out = reoptimiseBounded(0, 0, itinerary, {
    ix, tz: TZ,
    reverseQuery: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }],
      destinations: [{ stopIdx: 2, secondsToReach: 0 }],
      days, transferMinSeconds: 0,
    },
    buildFrom: () => { throw new Error("must not run a reverse pass at a bound of 0"); },
  });
  assert.equal(Date.parse(out.departureTime) / 1000, BASE + 3600);
});
