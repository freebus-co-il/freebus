import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestIndex as makeIndex } from "../transit/testIndex.js";
import { buildIndex } from "../transit/index.js";
import { buildFixtureDb } from "../testing/fixture.js";
import { baseEpochOfYmd } from "../transit/calendar.js";
import { config } from "../config.js";
import {
  buildTripLookup, resolveJourney, resolveSnapshot, predictFromCalls, predictFromDistance,
} from "./match.js";
import type { RealtimeJourney, RealtimeCall } from "./types.js";
import type { TimetableIndex } from "../transit/index.js";
import type { DayContext } from "../transit/raptor.js";

const TZ = config.timezone;
const SERVICE_YMD = 20260824;
const SERVICE_DATE = "2026-08-24";

/** Epoch seconds for `gtfsSeconds` into the service day named by `ymd`. */
function epochOn(ymd: number, gtfsSeconds: number): number {
  return baseEpochOfYmd(ymd, TZ) + gtfsSeconds;
}

/**
 * A `DayContext` (or the `Pick` `resolveJourney` actually needs) for `ymd`.
 * Every trip is active unless `activeTripIdxs` says otherwise -- most tests
 * aren't exercising the day mask itself, so the default keeps them focused
 * on what they're actually testing.
 */
function dayOn(ymd: number, nTrips: number, activeTripIdxs?: readonly number[]): DayContext {
  const activeTrip = new Uint8Array(nTrips);
  if (activeTripIdxs === undefined) activeTrip.fill(1);
  else for (const t of activeTripIdxs) activeTrip[t] = 1;
  return { dateYmd: ymd, baseEpoch: baseEpochOfYmd(ymd, TZ), activeTrip };
}

/** A `StopPrediction` for a stop this trip's pattern visits exactly once --
 * the common, non-loop case every test in this file except the loop test
 * itself exercises. */
function unambiguous(expectedArrival: number): { expectedArrival: number; ambiguous: boolean } {
  return { expectedArrival, ambiguous: false };
}

/**
 * A minimal `RealtimeJourney`, overridable per test. `calls` defaults to a
 * single call so a journey is never dropped by `parseVisit`'s own "no
 * calls" rule (that rule lives in siri.ts, not here, but an empty-calls
 * fixture would make failures in these tests harder to read).
 */
function makeJourney(overrides: Partial<RealtimeJourney> & { calls?: RealtimeCall[] } = {}): RealtimeJourney {
  return {
    lineRef: "R1",
    directionId: 0,
    dataFrameRef: SERVICE_DATE,
    datedVehicleJourneyRef: null,
    originAimedDeparture: epochOn(SERVICE_YMD, 28800),
    operatorRef: null,
    publishedLineName: null,
    vehicleRef: null,
    confidence: null,
    lat: null,
    lon: null,
    recordedAt: null,
    calls: [{ stopCode: "S0", order: 1, expectedArrival: epochOn(SERVICE_YMD, 28800) }],
    // SIRI-SM carries no distance; the SIRI-VM tests below override it.
    distanceFromStart: null,
    ...overrides,
  };
}

/** Attaches the fields `makeTestIndex` doesn't set but `match.ts` needs. */
function withRealtimeFields(
  ix: TimetableIndex,
  fields: { routeIds: string[]; tripRouteIdx: number[]; tripDirection: number[]; stopCodes: (string | null)[] },
): TimetableIndex {
  ix.routeIds = fields.routeIds;
  ix.tripRouteIdx = Int32Array.from(fields.tripRouteIdx);
  ix.tripDirection = Int8Array.from(fields.tripDirection);
  ix.stopCodes = fields.stopCodes;
  return ix;
}

test("resolves a journey by route, direction and scheduled start", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(lookup, ix, makeJourney(), dayOn(SERVICE_YMD, ix.nTrips));
  assert.notEqual(resolved, null);
  assert.equal(resolved!.tripIdx, 0);
  assert.equal(resolved!.journey.lineRef, "R1");
});

test("a journey for an unknown line resolves to null", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  // No trip is keyed under "R404" at all.
  const resolved = resolveJourney(
    lookup, ix, makeJourney({ lineRef: "R404" }), dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.equal(resolved, null);
});

test("a journey's directionId selects the same-direction trip, not a same-time trip running the other way", () => {
  // Same route, same scheduled start, two trips differing ONLY in
  // direction, both active today. A journey with directionId 0 (what
  // siri.ts's parseDirectionRef produces from SIRI's DirectionRef "1") must
  // resolve to the direction-0 trip, never the direction-1 one.
  const ix = withRealtimeFields(
    makeIndex(2, [
      { stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] },
      { stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] },
    ]),
    { routeIds: ["R1"], tripRouteIdx: [0, 0], tripDirection: [0, 1], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(
    lookup, ix, makeJourney({ directionId: 0 }), dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.notEqual(resolved, null);
  assert.equal(resolved!.tripIdx, 0);
  assert.equal(ix.tripDirection[resolved!.tripIdx], 0);
});

test("a duplicate stop_code resolves via the trip's own stop sequence", () => {
  // Stop 1 and stop 2 share stop_code "DUP". The resolved trip (route R1)
  // visits stop 1, not stop 2 -- stop 2 belongs to an unrelated pattern on
  // a different route. A call naming "DUP" must land on stop 1: picking
  // stop 2 instead would attach a real prediction to a stop the bus never
  // reaches, exactly the "wrong bus" failure the design forbids.
  const ix = withRealtimeFields(
    makeIndex(3, [
      { stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }, // R1, trip 0
      { stops: [0, 2], dep: [28800, 28860], arr: [28800, 28860] }, // R2, trip 1
    ]),
    {
      routeIds: ["R1", "R2"],
      tripRouteIdx: [0, 1],
      tripDirection: [0, 0],
      stopCodes: ["S0", "DUP", "DUP"],
    },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(
    lookup, ix,
    makeJourney({
      lineRef: "R1",
      calls: [{ stopCode: "DUP", order: 2, expectedArrival: epochOn(SERVICE_YMD, 28860) }],
    }),
    dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.notEqual(resolved, null);
  assert.equal(resolved!.tripIdx, 0);
  assert.deepEqual(
    [...resolved!.byStopIdx.entries()], [[1, unambiguous(epochOn(SERVICE_YMD, 28860))]],
  );
});

test("a scheduled start that matches no trip resolves to null", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  // Off by one minute from the trip's actual scheduled origin departure
  // (28800). Per the design, this must NOT fall back to "close enough" --
  // a near-miss on time is exactly the fuzzy match the design forbids.
  const resolved = resolveJourney(
    lookup, ix,
    makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28860) }),
    dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.equal(resolved, null);
});

test("calls for stops not on the trip are dropped, the rest survive", () => {
  // The resolved trip (route R1) visits stops 0 and 1 only. Stop 2 belongs
  // to a different trip's pattern and shares no stop_code collision with
  // anything on R1 -- a call naming it is simply wrong (a data glitch, or a
  // call meant for a different vehicle) and must be dropped without
  // failing the whole journey.
  const ix = withRealtimeFields(
    makeIndex(3, [
      { stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }, // R1, trip 0
      { stops: [2], dep: [30000], arr: [30000] }, // unrelated trip 1
    ]),
    {
      routeIds: ["R1", "R2"],
      tripRouteIdx: [0, 1],
      tripDirection: [0, 0],
      stopCodes: ["S0", "S1", "S2"],
    },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(
    lookup, ix,
    makeJourney({
      lineRef: "R1",
      calls: [
        { stopCode: "S1", order: 2, expectedArrival: epochOn(SERVICE_YMD, 28860) },
        { stopCode: "S2", order: 3, expectedArrival: epochOn(SERVICE_YMD, 29000) },
      ],
    }),
    dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.notEqual(resolved, null);
  assert.equal(resolved!.tripIdx, 0);
  assert.deepEqual(
    [...resolved!.byStopIdx.entries()], [[1, unambiguous(epochOn(SERVICE_YMD, 28860))]],
  );
});

// The regression test for the whole fix: two trips share
// (route_id, direction_id, origin departure) -- the feed does this whenever
// the same physical service repeats across service_ids, one per calendar
// date (verified against data/gtfs.sqlite: 58,433 keys collide this way).
// The service date is what tells them apart. resolveSnapshot must pick the
// DayContext matching the journey's own dataFrameRef and resolve to
// whichever trip is active THERE, never the lowest trip index.
test("two same-key trips on different service days resolve to the trip whose service runs on the journey's dataFrameRef date", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [
      { stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }, // trip 0: runs the 24th
      { stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }, // trip 1: runs the 25th
    ]),
    { routeIds: ["R1"], tripRouteIdx: [0, 0], tripDirection: [0, 0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const day24 = dayOn(20260824, ix.nTrips, [0]);
  const day25 = dayOn(20260825, ix.nTrips, [1]);

  const journey = makeJourney({
    dataFrameRef: "2026-08-25",
    originAimedDeparture: epochOn(20260825, 28800),
  });
  const { resolved, stats } = resolveSnapshot(lookup, ix, [journey], [day25, day24]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.tripIdx, 1);
  assert.deepEqual(stats, {
    resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

test("resolves a journey whose scheduled departure is past midnight (>86400 GTFS seconds)", () => {
  // The feed's max departure_time is 105787; a naive `% 86400` would map
  // 90000 to 3600 and silently break this trip's realtime matching.
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [90000, 90100], arr: [90000, 90100] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(
    lookup, ix,
    makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 90000) }),
    dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.notEqual(resolved, null);
  assert.equal(resolved!.tripIdx, 0);
});

test("a journey with no scheduled origin departure resolves to null", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(
    lookup, ix, makeJourney({ originAimedDeparture: null }), dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.equal(resolved, null);
});

test("resolveSnapshot treats a missing, malformed, or calendar-impossible dataFrameRef as unresolved, never a guess or a crash", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const journeys = [
    makeJourney({ dataFrameRef: null }),
    makeJourney({ dataFrameRef: "24-08-2026" }), // wrong format
    makeJourney({ dataFrameRef: "2026-13-45" }), // well-formed, no such date
  ];
  const { resolved, stats } = resolveSnapshot(lookup, ix, journeys, [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.equal(resolved.length, 0);
  assert.deepEqual(stats, {
    resolved: 0, unresolved: 3, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

test("resolveSnapshot counts resolved and unresolved journeys in MatchStats", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const journeys = [makeJourney(), makeJourney({ lineRef: "R404" })];
  const { resolved, stats } = resolveSnapshot(lookup, ix, journeys, [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.equal(resolved.length, 1);
  assert.deepEqual(stats, {
    resolved: 1, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

test("a stop visited twice on a loop keeps the soonest-ordered call", () => {
  // Stop 0 is both the start and the loop-back point. Two calls resolve to
  // it; the array deliberately lists the LATER pass (order 3) before the
  // EARLIER one (order 1), so a correct result proves the tie-break reads
  // `order`, not array position.
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1, 0], dep: [28800, 28860, 29000], arr: [28800, 28860, 29000] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const resolved = resolveJourney(
    lookup, ix,
    makeJourney({
      calls: [
        { stopCode: "S0", order: 3, expectedArrival: epochOn(SERVICE_YMD, 29000) },
        { stopCode: "S1", order: 2, expectedArrival: epochOn(SERVICE_YMD, 28860) },
        { stopCode: "S0", order: 1, expectedArrival: epochOn(SERVICE_YMD, 28800) },
      ],
    }),
    dayOn(SERVICE_YMD, ix.nTrips),
  );
  assert.notEqual(resolved, null);
  assert.deepEqual(
    [...resolved!.byStopIdx.entries()],
    [
      // Stop 0: visited twice on this trip's pattern (positions 0 and 2) --
      // `ambiguous: true`. The VALUE is still the soonest call (order 1,
      // 28800), unchanged for the departures board; `/plan` is the
      // consumer that must refuse it (see match.ts's own doc comment).
      [0, { expectedArrival: epochOn(SERVICE_YMD, 28800), ambiguous: true }],
      // Stop 1: visited once -- unambiguous.
      [1, { expectedArrival: epochOn(SERVICE_YMD, 28860), ambiguous: false }],
    ],
  );
});

test("resolveSnapshot counts a resolved journey with zero surviving calls separately", () => {
  // The journey matches route/direction/day/scheduled-start exactly (a
  // real, correct trip match) but every one of its calls names a stop_code
  // this trip's pattern doesn't carry -- e.g. the ministry's join key
  // assumption is wrong, or a stale/corrupt call. `resolved`
  // alone cannot distinguish this from a journey that also got useful
  // calls; `resolvedWithNoCalls` is the one instrument that can.
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const journeys = [makeJourney({ calls: [
    { stopCode: "NOT-ON-TRIP", order: 1, expectedArrival: epochOn(SERVICE_YMD, 28800) },
  ] })];
  const { resolved, stats } = resolveSnapshot(lookup, ix, journeys, [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.equal(resolved.length, 1, "the trip match itself is still a resolution");
  assert.equal(resolved[0]!.byStopIdx.size, 0);
  assert.deepEqual(stats, {
    resolved: 1, unresolved: 0, resolvedWithNoCalls: 1, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

// ---------------------------------------------------------------------
// Pass 2: buses whose start is not exactly a timetable slot.
// Two runs of one route, 08:00 and 08:30, 1 km apart stop to stop.
// ---------------------------------------------------------------------

function twoRunIndex(): TimetableIndex {
  return withRealtimeFields(
    makeIndex(2, [
      { stops: [0, 1], dep: [28800, 29400], arr: [28800, 29400], dist: [0, 1000] },
      { stops: [0, 1], dep: [30600, 31200], arr: [30600, 31200], dist: [0, 1000] },
    ]),
    { routeIds: ["R1"], tripRouteIdx: [0, 0], tripDirection: [0, 0], stopCodes: ["S0", "S1"] },
  );
}

test("pass 2: a bus 4 min off an empty slot takes that slot's trip", () => {
  const ix = twoRunIndex();
  const lookup = buildTripLookup(ix);
  const retimed = makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 + 240), vehicleRef: "retimed" });
  const { resolved, unscheduled, stats } = resolveSnapshot(lookup, ix, [retimed], [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.deepEqual(resolved.map((r) => [r.tripIdx, r.journey.vehicleRef]), [[0, "retimed"]]);
  assert.equal(unscheduled.length, 0);
  assert.deepEqual(stats, {
    resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 1, unscheduled: 0,
  });
});

test("pass 2: a bus whose nearest slot already has its own bus becomes an unscheduled run on that trip", () => {
  // The 2026-09-13 case: a 20:10 bus beside a 20:15 slot that had its own.
  const ix = twoRunIndex();
  const lookup = buildTripLookup(ix);
  const onTime = makeJourney({ vehicleRef: "on-time", calls: [], distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 29100) });
  // Starts 07:55 against the 08:00 template; at its own origin at 07:56.
  const extra = makeJourney({
    originAimedDeparture: epochOn(SERVICE_YMD, 28800 - 300), vehicleRef: "extra",
    calls: [], distanceFromStart: 0, recordedAt: epochOn(SERVICE_YMD, 28800 - 240),
  });
  const { resolved, unscheduled, stats } = resolveSnapshot(
    lookup, ix, [onTime, extra], [dayOn(SERVICE_YMD, ix.nTrips)], predictFromDistance,
  );
  assert.deepEqual(resolved.map((r) => r.journey.vehicleRef), ["on-time"]);
  assert.equal(unscheduled.length, 1);
  const run = unscheduled[0]!;
  assert.equal(run.templateTripIdx, 0);
  assert.equal(run.offsetSeconds, -300);
  assert.equal(run.serviceBaseEpoch, baseEpochOfYmd(SERVICE_YMD, TZ));
  // Its own timetable is the template shifted 5 min earlier (07:55 -> 08:05);
  // seen at its origin a minute after its own start, it is 60 s late.
  assert.equal(run.byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 29400 - 300 + 60));
  assert.equal(stats.attached, 0);
  assert.equal(stats.unscheduled, 1);
  assert.equal(stats.unresolved, 0);
});

test("pass 2: two buses claiming one empty slot -- the nearer takes it, the other is unscheduled", () => {
  const ix = twoRunIndex();
  const lookup = buildTripLookup(ix);
  const far = makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 - 180), vehicleRef: "b" });
  const near = makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 + 120), vehicleRef: "a" });
  // Listed far-first, so the result proves ordering by distance, not by input.
  const { resolved, unscheduled } = resolveSnapshot(lookup, ix, [far, near], [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.deepEqual(resolved.map((r) => [r.tripIdx, r.journey.vehicleRef]), [[0, "a"]]);
  assert.deepEqual(unscheduled.map((u) => [u.templateTripIdx, u.offsetSeconds, u.journey.vehicleRef]), [[0, -180, "b"]]);
});

test("pass 2: an exact match keeps its slot even when an off-slot bus is listed first", () => {
  const ix = twoRunIndex();
  const lookup = buildTripLookup(ix);
  const extra = makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 - 120), vehicleRef: "extra" });
  const exact = makeJourney({ vehicleRef: "exact" });
  const { resolved, unscheduled } = resolveSnapshot(lookup, ix, [extra, exact], [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.deepEqual(resolved.map((r) => r.journey.vehicleRef), ["exact"]);
  assert.deepEqual(unscheduled.map((u) => u.journey.vehicleRef), ["extra"]);
});

test("pass 2: more than 15 min from every slot stays unresolved, and counts as a near miss within the hour", () => {
  const ix = twoRunIndex();
  const lookup = buildTripLookup(ix);
  // 07:44: 16 min before 08:00, 46 min before 08:30.
  const early = makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 - 960) });
  const otherRoute = makeJourney({ lineRef: "R404" });
  const { resolved, unscheduled, stats } = resolveSnapshot(lookup, ix, [early, otherRoute], [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.equal(resolved.length, 0);
  assert.equal(unscheduled.length, 0);
  assert.deepEqual(stats, {
    resolved: 0, unresolved: 2, resolvedWithNoCalls: 0, nearMissCount: 1, attached: 0, unscheduled: 0,
  });
});

test("pass 2 never guesses between two trips that share a start time exactly", () => {
  // Pass 1 refuses two active trips on one key; pass 2 must not quietly pick
  // one of them at distance 0.
  const ix = withRealtimeFields(
    makeIndex(2, [
      { stops: [0, 1], dep: [28800, 29400], arr: [28800, 29400] },
      { stops: [0, 1], dep: [28800, 29400], arr: [28800, 29400] },
    ]),
    { routeIds: ["R1"], tripRouteIdx: [0, 0], tripDirection: [0, 0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const { resolved, unscheduled } = resolveSnapshot(lookup, ix, [makeJourney()], [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.equal(resolved.length, 0);
  assert.equal(unscheduled.length, 0);
});

// Pass 1 fails at distance 0 only when TWO OR MORE
// trips are active on that key -- that is pass 1's own ambiguity, and pass 2
// must not resolve it by guessing a neighbour just because the neighbour
// happens to be alone. Two trips share the 08:00 slot exactly; a third sits
// at 08:05. Before this fix, `nearestSlot` skipped the distance-0 pair and
// happily returned the 08:05 neighbour, silently attaching the journey to a
// trip it never claimed to run.
test("pass 2 never guesses a neighbour when the exact slot itself is ambiguous", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [
      { stops: [0, 1], dep: [28800, 29400], arr: [28800, 29400] }, // 08:00, trip A
      { stops: [0, 1], dep: [28800, 29400], arr: [28800, 29400] }, // 08:00, trip B (same key as A)
      { stops: [0, 1], dep: [29100, 29700], arr: [29100, 29700] }, // 08:05, trip C -- empty, 5 min away
    ]),
    { routeIds: ["R1"], tripRouteIdx: [0, 0, 0], tripDirection: [0, 0, 0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const { resolved, unscheduled, stats } = resolveSnapshot(
    lookup, ix, [makeJourney()], [dayOn(SERVICE_YMD, ix.nTrips)],
  );
  assert.equal(resolved.length, 0, "not resolved -- the exact slot is ambiguous, not empty");
  assert.equal(unscheduled.length, 0, "not unscheduled either -- no slot was ever legitimately claimed");
  assert.equal(stats.unresolved, 1);
});

test("resolveSnapshot: a bus a few minutes off a slot is matched by pass 2, not merely counted", () => {
  // Trip 0 departs 28800. +120 s takes the empty slot; +400 s finds it taken
  // and becomes an unscheduled run; R404 has no route bucket at all.
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const journeys = [
    makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 + 120), vehicleRef: "near" }),
    makeJourney({ originAimedDeparture: epochOn(SERVICE_YMD, 28800 + 400), vehicleRef: "farther" }),
    makeJourney({ lineRef: "R404" }),
  ];
  const { resolved, unscheduled, stats } = resolveSnapshot(lookup, ix, journeys, [dayOn(SERVICE_YMD, ix.nTrips)]);
  assert.deepEqual(resolved.map((r) => r.journey.vehicleRef), ["near"]);
  assert.deepEqual(unscheduled.map((u) => [u.journey.vehicleRef, u.offsetSeconds]), [["farther", 400]]);
  assert.deepEqual(stats, {
    resolved: 1, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 1, unscheduled: 1,
  });
});

test("buildIndex populates stopCodes parallel to stopIds", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-idx-rt-"));
  const link = buildFixtureDb(dir);
  const ix = buildIndex(link);
  assert.equal(ix.stopCodes.length, ix.stopIds.length);
  assert.equal(ix.stopCodes[ix.stopIdToIdx.get("1000")!], "38831");
  assert.equal(ix.stopCodes[ix.stopIdToIdx.get("2000")!], "38832");
  // Station 3000 has no stop_code in the fixture.
  assert.equal(ix.stopCodes[ix.stopIdToIdx.get("3000")!], null);
  assert.equal(ix.stopCodes[ix.stopIdToIdx.get("4000")!], "38834");
});

// ---------------------------------------------------------------------
// SIRI-VM: predictions derived from a vehicle position, not read off the
// feed. Stride publishes no ETAs at all, so these exercise
// the whole substitute mechanism: bracket the vehicle between two stops by
// its shape distance, interpolate the scheduled time there, and propagate
// that one delay forward.
// ---------------------------------------------------------------------

/** Three stops at 0 / 1000 / 2000 m, scheduled 10:00 / 10:10 / 10:20. */
function distanceTripIndex(dist: number[] = [0, 1000, 2000]): TimetableIndex {
  return withRealtimeFields(
    makeIndex(3, [{
      stops: [0, 1, 2],
      dep: [36000, 36600, 37200],
      arr: [36000, 36600, 37200],
      dist,
    }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [1], stopCodes: ["S0", "S1", "S2"] },
  );
}

/** A SIRI-VM journey: no calls, no direction, a distance instead. */
function vmJourney(over: Partial<RealtimeJourney> = {}): RealtimeJourney {
  return makeJourney({
    directionId: null,
    calls: [],
    originAimedDeparture: epochOn(SERVICE_YMD, 36000),
    ...over,
  });
}

test("predictFromDistance: a vehicle between two stops propagates its delay downstream", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);

  // 500 m is halfway from stop 0 to stop 1, i.e. scheduled 10:05. Reported
  // at 10:08 => running 180 s late.
  const j = vmJourney({ distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 36480) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);

  // Stop 0 is behind the vehicle: predicting its arrival is meaningless,
  // and a departures board showing one would be actively misleading.
  assert.equal(byStopIdx.has(0), false);
  assert.equal(byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 36600 + 180));
  assert.equal(byStopIdx.get(2)!.expectedArrival, epochOn(SERVICE_YMD, 37200 + 180));
});

test("predictFromDistance: a vehicle running early yields a negative delay", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);
  // Halfway (scheduled 10:05) but reported at 10:03 => 120 s early.
  const j = vmJourney({ distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 36180) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);
  assert.equal(byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 36600 - 120));
});

test("predictFromDistance: distance 0 means at the origin, so the delay is the departure delay", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);
  // Sitting at stop 0 (scheduled 10:00) at 10:02 => 120 s late.
  const j = vmJourney({ distanceFromStart: 0, recordedAt: epochOn(SERVICE_YMD, 36120) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);
  assert.equal(byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 36600 + 120));
  assert.equal(byStopIdx.get(2)!.expectedArrival, epochOn(SERVICE_YMD, 37200 + 120));
});

test("predictFromDistance: a bus waiting at its origin before its start time is on time, not early", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);
  // Parked at stop 0 (scheduled 10:00) at 09:58. Buses do not leave their
  // origin early, so this is not "120 s early" -- seen live on 2026-09-13 as
  // lines 238 and 2 showing five minutes early while still at the terminal.
  const j = vmJourney({ distanceFromStart: 0, recordedAt: epochOn(SERVICE_YMD, 35880) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);
  assert.equal(byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 36600));
  assert.equal(byStopIdx.get(2)!.expectedArrival, epochOn(SERVICE_YMD, 37200));
});

test("predictFromDistance: each prediction records when the bus was at its reported position", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);
  // Halfway to stop 1, reported at 10:08. That report IS the moment the bus
  // was there, so it is what a later reader measures elapsed time from.
  const j = vmJourney({ distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 36480) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);
  assert.equal(byStopIdx.get(1)!.anchorAt, epochOn(SERVICE_YMD, 36480));
  assert.equal(byStopIdx.get(2)!.anchorAt, epochOn(SERVICE_YMD, 36480));
});

test("predictFromDistance: a bus waiting at its origin is anchored at its start time, not at its report", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);
  // Reported at 09:58, due out at 10:00. Waiting until 10:00 is the plan,
  // not a stall, so no time before 10:00 may count as the bus falling behind.
  const j = vmJourney({ distanceFromStart: 0, recordedAt: epochOn(SERVICE_YMD, 35880) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);
  assert.equal(byStopIdx.get(1)!.anchorAt, epochOn(SERVICE_YMD, 36000));
});

test("predictFromCalls: an operator's own ETA carries no anchor", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const j = makeJourney({
    directionId: 1, originAimedDeparture: epochOn(SERVICE_YMD, 36000),
    calls: [{ stopCode: "S1", order: 2, expectedArrival: epochOn(SERVICE_YMD, 36700) }],
  });
  const byStopIdx = predictFromCalls(ix, lookup, 0, j, dayOn(SERVICE_YMD, ix.nTrips));
  assert.equal(byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 36700));
  assert.equal(byStopIdx.get(1)!.anchorAt, undefined);
});

test("predictFromDistance: a null distance yields nothing — 0 and null are not the same", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const j = vmJourney({ distanceFromStart: null, recordedAt: epochOn(SERVICE_YMD, 36120) });
  assert.equal(predictFromDistance(ix, lookup, 0, j, dayOn(SERVICE_YMD, ix.nTrips)).size, 0);
});

test("predictFromDistance: a vehicle past the last stop yields nothing, never an extrapolation", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const j = vmJourney({ distanceFromStart: 9999, recordedAt: epochOn(SERVICE_YMD, 36120) });
  assert.equal(predictFromDistance(ix, lookup, 0, j, dayOn(SERVICE_YMD, ix.nTrips)).size, 0);
});

test("predictFromDistance: a trip with no shape distances yields nothing", () => {
  // The -1 sentinel, on every row: a small share of the real feed's stop_times
  // lack shape_dist_traveled, and a trip made only of those cannot place a
  // vehicle at all.
  const ix = distanceTripIndex([-1, -1, -1]);
  const lookup = buildTripLookup(ix);
  const j = vmJourney({ distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 36120) });
  assert.equal(predictFromDistance(ix, lookup, 0, j, dayOn(SERVICE_YMD, ix.nTrips)).size, 0);
});

test("predictFromDistance: a gap in the shape distances is skipped, not treated as distance 0", () => {
  // Middle stop has no distance. The vehicle at 1500 m still brackets
  // correctly between stop 0 (0 m) and stop 2 (2000 m).
  const ix = distanceTripIndex([0, -1, 2000]);
  const lookup = buildTripLookup(ix);
  const day = dayOn(SERVICE_YMD, ix.nTrips);
  // 1500/2000 of the way from 10:00 to 10:20 => scheduled 10:15. Reported
  // at 10:16 => 60 s late.
  const j = vmJourney({ distanceFromStart: 1500, recordedAt: epochOn(SERVICE_YMD, 36960) });
  const byStopIdx = predictFromDistance(ix, lookup, 0, j, day);
  assert.equal(byStopIdx.get(2)!.expectedArrival, epochOn(SERVICE_YMD, 37200 + 60));
});

test("predictFromDistance: a null recordedAt yields nothing — there is no instant to compare", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const j = vmJourney({ distanceFromStart: 500, recordedAt: null });
  assert.equal(predictFromDistance(ix, lookup, 0, j, dayOn(SERVICE_YMD, ix.nTrips)).size, 0);
});

test("resolveJourney recovers the direction from the route when the source omits it", () => {
  // Stride never reports a direction; every route in this feed has exactly
  // one, so the route determines it.
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  assert.equal(lookup.directionByRouteId.get("R1"), 1);

  const resolved = resolveJourney(
    lookup, ix,
    vmJourney({ distanceFromStart: 0, recordedAt: epochOn(SERVICE_YMD, 36000) }),
    dayOn(SERVICE_YMD, ix.nTrips),
    predictFromDistance,
  );
  assert.notEqual(resolved, null);
  assert.equal(resolved!.tripIdx, 0);
});

test("resolveJourney refuses to guess when a route carries two directions", () => {
  // Not observed in this feed (all 7,753 routes have one direction), but the
  // exact key must degrade to "unresolved", never to a plausible guess.
  const ix = withRealtimeFields(
    makeIndex(3, [
      { stops: [0, 1], dep: [36000, 36600], arr: [36000, 36600], dist: [0, 1000] },
      { stops: [1, 0], dep: [36000, 36600], arr: [36000, 36600], dist: [0, 1000] },
    ]),
    { routeIds: ["R1"], tripRouteIdx: [0, 0], tripDirection: [0, 1], stopCodes: ["S0", "S1", "S2"] },
  );
  const lookup = buildTripLookup(ix);
  assert.equal(lookup.directionByRouteId.get("R1"), null);

  assert.equal(resolveJourney(
    lookup, ix,
    vmJourney({ distanceFromStart: 0, recordedAt: epochOn(SERVICE_YMD, 36000) }),
    dayOn(SERVICE_YMD, ix.nTrips),
    predictFromDistance,
  ), null);
});

test("resolveSnapshot defaults to the calls builder, leaving the SIRI-SM path untouched", () => {
  const ix = withRealtimeFields(
    makeIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]),
    { routeIds: ["R1"], tripRouteIdx: [0], tripDirection: [0], stopCodes: ["S0", "S1"] },
  );
  const lookup = buildTripLookup(ix);
  const days = [dayOn(SERVICE_YMD, ix.nTrips)];
  assert.deepEqual(
    resolveSnapshot(lookup, ix, [makeJourney()], days).stats,
    resolveSnapshot(lookup, ix, [makeJourney()], days, predictFromCalls).stats,
  );
});

test("resolveSnapshot with predictFromDistance resolves a SIRI-VM snapshot end to end", () => {
  const ix = distanceTripIndex();
  const lookup = buildTripLookup(ix);
  const j = vmJourney({ distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 36480) });
  const { resolved, stats } = resolveSnapshot(
    lookup, ix, [j], [dayOn(SERVICE_YMD, ix.nTrips)], predictFromDistance,
  );
  assert.equal(stats.resolved, 1);
  assert.equal(stats.resolvedWithNoCalls, 0);
  assert.equal(resolved[0]!.byStopIdx.get(1)!.expectedArrival, epochOn(SERVICE_YMD, 36780));
});
