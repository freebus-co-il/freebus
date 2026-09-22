import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTestIndex } from "./testIndex.js";
import type { TimetableIndex } from "./index.js";
import type { DayContext } from "./raptor.js";
import { Translator } from "../db/i18n.js";
import { toIso } from "./calendar.js";
import { findSegments, type SegmentRoute } from "./segments.js";

const BASE = 1_787_000_000; // arbitrary service-day origin (a Monday, in spirit)
const TZ = "Asia/Jerusalem";

const oneDay = (n: number): DayContext[] =>
  [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: new Uint8Array(n).fill(1) }];

// Same fixture-metadata pattern `itinerary.test.ts` uses: `makeTestIndex`
// only fills in what RAPTOR itself reads, so every field `findSegments`
// additionally needs (ids, headsigns, route/direction indices) is added here.
function withMeta(base: TimetableIndex, routeIdx?: Int32Array): TimetableIndex {
  return {
    ...base,
    stopIds: Array.from({ length: base.nStops }, (_, s) => `s${s}`),
    tripIds: Array.from({ length: base.nTrips }, (_, t) => `t${t}`),
    tripHeadsigns: new Array<string | null>(base.nTrips).fill(null),
    tripNumbers: new Array<string | null>(base.nTrips).fill(null),
    tripRouteIdx: routeIdx ?? new Int32Array(base.nTrips),
    tripDirection: new Int8Array(base.nTrips),
  };
}

function buildIx(
  nStops: number,
  trips: { stops: number[]; dep: number[]; arr: number[] }[],
  routeIdx?: Int32Array,
): TimetableIndex {
  return withMeta(makeTestIndex(nStops, trips), routeIdx);
}

// An empty `translations` table -- these tests care about the lookup, not
// i18n, so every headsign round-trips to its raw (here: null) value.
function makeTranslator(): Translator {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE translations (trans_id TEXT, lang TEXT, translation TEXT)");
  return Translator.load(db);
}

const routeOf = (routeIdx: number): SegmentRoute =>
  ({ id: `r${routeIdx}`, agencyId: null, shortName: null, longName: null, type: 3, color: null });

function ctx(): { tr: Translator; lang: "he"; tz: string; routeOf: typeof routeOf } {
  return { tr: makeTranslator(), lang: "he", tz: TZ, routeOf };
}

test("a pair served by three different routes returns all three, in departure order", () => {
  // Stop 1 = FROM, stop 2 = TO. Each trip's stop sequence differs (an extra
  // stop before or after the shared FROM->TO subsegment), so `buildPatterns`
  // puts them in three DIFFERENT patterns -- this exercises the merge
  // across `ix.stopPatterns` entries, not just ordering within one pattern's
  // own `patternTrips`. Departure order deliberately does not match route
  // index or pattern-discovery order, so a bug that forgot the final
  // cross-pattern sort would show up as a reordering here.
  const ix = buildIx(4, [
    { stops: [1, 2], dep: [4200, 4800], arr: [4200, 4800] }, // pattern A, mid
    { stops: [0, 1, 2], dep: [3000, 3600, 4100], arr: [3000, 3600, 4100] }, // pattern B, earliest
    { stops: [1, 2, 3], dep: [5400, 6000, 6600], arr: [5400, 6000, 6600] }, // pattern C, latest
  ], Int32Array.from([1, 0, 2]));

  const out = findSegments(ix, oneDay(3), 1, 2, BASE, ctx(), { resultsLimit: 10 });
  assert.deepEqual(out.map((d) => d.tripId), ["t1", "t0", "t2"]);
  assert.deepEqual(out.map((d) => d.route.id), ["r0", "r1", "r2"]);
  assert.deepEqual(out.map((d) => d.departureTime), [
    toIso(BASE + 3600, TZ), toIso(BASE + 4200, TZ), toIso(BASE + 5400, TZ),
  ]);
});

test("a pattern that serves to before from is excluded", () => {
  // Pattern visits stop 1 (would-be `to`) before stop 0 (would-be `from`):
  // the pair 0 -> 1 must find nothing on it.
  const ix = buildIx(2, [{ stops: [1, 0], dep: [3600, 4200], arr: [3600, 4200] }]);
  const out = findSegments(ix, oneDay(1), 0, 1, BASE, ctx(), { resultsLimit: 10 });
  assert.deepEqual(out, []);
});

test("a loop pattern visiting from twice yields both, each paired with the correct later to", () => {
  // Stops: 0=FROM, 1=TO, 2=mid, 0=FROM again, 1=TO again.
  const ix = buildIx(3, [
    { stops: [0, 1, 2, 0, 1], dep: [0, 100, 200, 300, 400], arr: [0, 100, 200, 300, 400] },
  ]);
  const out = findSegments(ix, oneDay(1), 0, 1, BASE, ctx(), { resultsLimit: 10 });
  assert.equal(out.length, 2);
  // First visit (pos 0) pairs with the TO at pos 1, not the one at pos 4.
  assert.equal(out[0]!.departureTime, toIso(BASE + 0, TZ));
  assert.equal(out[0]!.arrivalTime, toIso(BASE + 100, TZ));
  assert.equal(out[0]!.numStops, 1);
  // Second visit (pos 3) pairs with the TO at pos 4.
  assert.equal(out[1]!.departureTime, toIso(BASE + 300, TZ));
  assert.equal(out[1]!.arrivalTime, toIso(BASE + 400, TZ));
  assert.equal(out[1]!.numStops, 1);
});

test("only trips active on the service day appear", () => {
  const ix = buildIx(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const days: DayContext[] = [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([0, 1]) }];
  const out = findSegments(ix, days, 0, 1, BASE, ctx(), { resultsLimit: 10 });
  assert.deepEqual(out.map((d) => d.tripId), ["t1"]);
});

test("a departure past 86400 appears in the right place and is not wrapped", () => {
  const ix = buildIx(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    // 91800 = 25:30 -- a real GTFS time past midnight, must not be modulo'd.
    { stops: [0, 1], dep: [91800, 92400], arr: [91800, 92400] },
  ]);
  const out = findSegments(ix, oneDay(2), 0, 1, BASE, ctx(), { resultsLimit: 10 });
  assert.deepEqual(out.map((d) => d.tripId), ["t0", "t1"]);
  // BASE + 91800: the raw GTFS seconds, not wrapped into a second calendar day.
  assert.equal(out[1]!.departureTime, toIso(BASE + 91800, TZ));
});

test("results caps the list; the cap keeps the earliest entries", () => {
  const ix = buildIx(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [4800, 5400], arr: [4800, 5400] },
    { stops: [0, 1], dep: [6000, 6600], arr: [6000, 6600] },
  ]);
  const out = findSegments(ix, oneDay(3), 0, 1, BASE, ctx(), { resultsLimit: 2 });
  assert.deepEqual(out.map((d) => d.tripId), ["t0", "t1"]);
});

test("a pair with no service returns an empty array", () => {
  const ix = buildIx(2, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const days: DayContext[] = [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([0]) }];
  const out = findSegments(ix, days, 0, 1, BASE, ctx(), { resultsLimit: 10 });
  assert.deepEqual(out, []);
});

// The whole reason `days` carries two entries: a trip whose service ran
// YESTERDAY is still findable from a query issued after midnight today, the
// same rule `/plan` and the departures board apply.
test("a trip whose service runs on the previous service day but departs after midnight is found", () => {
  const ix = buildIx(2, [
    // 91800 = 25:30 on the PREVIOUS service day.
    { stops: [0, 1], dep: [91800, 92400], arr: [91800, 92400] },
  ]);
  const yesterdayBase = BASE - 86400;
  const days: DayContext[] = [
    // "Today" (query day): this trip's service does not run today.
    { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([0]) },
    // "Yesterday": the trip's service ran, and 25:30 is still ahead of `now`.
    { dateYmd: 20260824, baseEpoch: yesterdayBase, activeTrip: Uint8Array.from([1]) },
  ];
  // Query instant: 01:00 on the query day, i.e. yesterdayBase + 91800 - 1800.
  const afterEpoch = yesterdayBase + 90000;
  const out = findSegments(ix, days, 0, 1, afterEpoch, ctx(), { resultsLimit: 10 });
  assert.deepEqual(out.map((d) => d.tripId), ["t0"]);
  // yesterdayBase + 91800 -- the trip's real absolute departure instant.
  assert.equal(out[0]!.departureTime, toIso(yesterdayBase + 91800, TZ));
});

// The cap test above uses three trips sharing one pattern (`stops: [0, 1]`),
// so it never exercises truncation ACROSS patterns -- two plausible-looking
// but wrong optimisations both pass it: slicing to `resultsLimit` before the
// final sort, and stopping the outer per-pattern loop once `candidates.
// length >= resultsLimit`. Both drop a genuinely-earliest departure whenever
// it lives in whichever pattern happens to be scanned LAST, so that is
// exactly where this test puts it: three different patterns sharing the
// FROM->TO subsegment (stop 1 -> stop 2, via extra stops before/after, same
// trick `findSegments`'s own three-different-routes test uses), built in an
// order that makes the pattern holding the EARLIEST departure the last one
// `ix.stopPatterns` reaches for stop 1.
test("results caps across patterns, not just within one pattern's own trips", () => {
  const ix = buildIx(4, [
    { stops: [1, 2], dep: [9000, 9100], arr: [9000, 9100] }, // pattern 0 (scanned first): latest
    { stops: [0, 1, 2], dep: [7900, 8000, 8100], arr: [7900, 8000, 8100] }, // pattern 1: mid
    { stops: [1, 2, 3], dep: [100, 200, 300], arr: [100, 200, 300] }, // pattern 2 (scanned LAST): earliest
  ]);
  const out = findSegments(ix, oneDay(3), 1, 2, BASE, ctx(), { resultsLimit: 2 });
  // Correct earliest two overall are t2 (100, pattern 2) and t1 (8000,
  // pattern 1) -- t0 (9000, pattern 0) must be dropped despite being
  // scanned first. Either wrong optimisation instead keeps t0 and t1,
  // because both decide "enough candidates" before pattern 2 is ever
  // reached.
  assert.deepEqual(out.map((d) => d.tripId), ["t2", "t1"]);
  assert.deepEqual(out.map((d) => d.departureTime), [toIso(BASE + 100, TZ), toIso(BASE + 8000, TZ)]);
});
