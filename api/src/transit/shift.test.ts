import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTestIndex } from "./testIndex.js";
import { tripDelays, buildShift, shiftsFor, type DelayJourney } from "./shift.js";
import type { DayContext } from "./raptor.js";

/** A day context in which every trip runs, based at epoch 0 for easy arithmetic. */
function dayAll(nTrips: number, baseEpoch = 0): DayContext {
  return { dateYmd: 20260918, baseEpoch, activeTrip: new Uint8Array(nTrips).fill(1) };
}

function journey(tripIdx: number, preds: [number, number][]): DelayJourney {
  return {
    tripIdx,
    byStopIdx: new Map(preds.map(([stopIdx, expectedArrival]) => [stopIdx, { expectedArrival }])),
  };
}

test("tripDelays takes the median of the per-stop delays", () => {
  // One trip over stops 0,1,2 arriving at 100, 200, 300.
  const ix = makeTestIndex(3, [{ stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] }]);
  // Predictions 60 s, 120 s and 90 s late -> median 90.
  const delay = tripDelays(ix, [journey(0, [[0, 160], [1, 320], [2, 390]])], dayAll(1));
  assert.equal(delay[0], 90);
});

test("tripDelays ignores a single wildly mis-joined stop", () => {
  // The stop-code join is inference, so one bad stop must not
  // move the answer -- that is the whole reason this is a median, not a mean.
  const ix = makeTestIndex(3, [{ stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] }]);
  const delay = tripDelays(ix, [journey(0, [[0, 160], [1, 260], [2, 99_999]])], dayAll(1));
  assert.equal(delay[0], 60);
});

test("tripDelays clamps a vehicle running early to zero", () => {
  // A bus reported as EARLY is never something this planner promises a rider.
  const ix = makeTestIndex(3, [{ stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] }]);
  const delay = tripDelays(ix, [journey(0, [[0, 40], [1, 140], [2, 240]])], dayAll(1));
  assert.equal(delay[0], 0);
});

test("tripDelays leaves a trip with no live journey at zero", () => {
  const ix = makeTestIndex(3, [
    { stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] },
    { stops: [0, 1, 2], dep: [500, 600, 700], arr: [500, 600, 700] },
  ]);
  const delay = tripDelays(ix, [journey(0, [[1, 260]])], dayAll(2));
  assert.equal(delay[0], 60);
  assert.equal(delay[1], 0);
});

test("tripDelays skips a journey whose trip does not run on this day", () => {
  const ix = makeTestIndex(3, [{ stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] }]);
  const day: DayContext = { dateYmd: 20260918, baseEpoch: 0, activeTrip: new Uint8Array(1) };
  const delay = tripDelays(ix, [journey(0, [[1, 260]])], day);
  assert.equal(delay[0], 0);
});

test("tripDelays measures against the day's own base epoch", () => {
  const ix = makeTestIndex(3, [{ stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] }]);
  const base = 1_700_000_000;
  const delay = tripDelays(ix, [journey(0, [[1, base + 260]])], dayAll(1, base));
  assert.equal(delay[0], 60);
});

test("buildShift reorders a pattern whose trip is delayed past the next one", () => {
  // Three trips on one pattern, ten minutes apart. Delay the first by 25 min
  // and it belongs after both of the others.
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [1000, 1600], arr: [1000, 1600] },
    { stops: [0, 1], dep: [1600, 2200], arr: [1600, 2200] },
    { stops: [0, 1], dep: [2200, 2800], arr: [2200, 2800] },
  ]);
  assert.deepEqual([...ix.patternTrips], [0, 1, 2]);

  const shift = buildShift(ix, [journey(0, [[0, 2500]])], dayAll(3));
  assert.notEqual(shift, null);
  assert.deepEqual([...shift!.patternTrips], [1, 2, 0]);
  assert.equal(shift!.delay[0], 1500);
});

test("buildShift keeps shifted departures non-decreasing at every position", () => {
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [1000, 1600], arr: [1000, 1600] },
    { stops: [0, 1], dep: [1600, 2200], arr: [1600, 2200] },
    { stops: [0, 1], dep: [2200, 2800], arr: [2200, 2800] },
  ]);
  const shift = buildShift(ix, [journey(0, [[0, 2500]])], dayAll(3))!;

  for (let pos = 0; pos < 2; pos++) {
    let previous = -Infinity;
    for (const t of shift.patternTrips) {
      const at = ix.departureTime[ix.tripTimeOffset[t]! + pos]! + shift.delay[t]!;
      assert.ok(at >= previous, `position ${pos} went backwards at trip ${t}`);
      previous = at;
    }
  }
});

test("buildShift reverts a pattern whose trips cannot be ordered under their delays", () => {
  // Two trips whose RUNNING TIMES differ, so the gap between them varies by
  // position: 900 s, 1100 s, then 1489 s. Neither overtakes the other, so they
  // share one pattern.
  const ix = makeTestIndex(3, [
    { stops: [0, 1, 2], dep: [100, 600, 959], arr: [100, 600, 959] },
    { stops: [0, 1, 2], dep: [1000, 1700, 2448], arr: [1000, 1700, 2448] },
  ]);
  assert.equal(ix.patternTripOffset.length - 1, 1, "expected one pattern");

  // Delay the first by 1000 s -- more than the gap at position 0, less than at
  // position 1. The gap flips sign at some positions and not others, which no
  // reordering can fix.
  const shift = buildShift(ix, [journey(0, [[0, 1100]])], dayAll(2));

  // The pattern is reverted whole: scheduled order, and no delay survives.
  assert.equal(shift, null);
});

test("buildShift counts a reverted pattern without disturbing a healthy one", () => {
  const ix = makeTestIndex(6, [
    // Pattern A (stops 0,1,2): unorderable under the delay below.
    { stops: [0, 1, 2], dep: [100, 600, 959], arr: [100, 600, 959] },
    { stops: [0, 1, 2], dep: [1000, 1700, 2448], arr: [1000, 1700, 2448] },
    // Pattern B (stops 3,4,5): equal running times, so it reorders cleanly.
    { stops: [3, 4, 5], dep: [1000, 1300, 1600], arr: [1000, 1300, 1600] },
    { stops: [3, 4, 5], dep: [1600, 1900, 2200], arr: [1600, 1900, 2200] },
  ]);

  const shift = buildShift(ix, [
    journey(0, [[0, 1100]]),   // pattern A, unorderable
    journey(2, [[3, 1900]]),   // pattern B, 900 s late, reorders past trip 3
  ], dayAll(4))!;

  assert.equal(shift.conflictingPatterns, 1);
  assert.equal(shift.delay[0], 0, "reverted pattern's trip keeps no delay");
  assert.equal(shift.delay[1], 0);
  assert.equal(shift.delay[2], 900, "healthy pattern keeps its delay");

  const pB = ix.patternOfTrip[2]!;
  const from = ix.patternTripOffset[pB]!;
  assert.deepEqual([...shift.patternTrips.subarray(from, from + 2)], [3, 2]);
});

test("buildShift returns null when nothing is delayed", () => {
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [1000, 1600], arr: [1000, 1600] }]);
  assert.equal(buildShift(ix, [], dayAll(1)), null);
  // An on-time journey is not a delay either.
  assert.equal(buildShift(ix, [journey(0, [[0, 1000]])], dayAll(1)), null);
});

test("shiftsFor builds once per snapshot and rebuilds when it changes", () => {
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [1000, 1600], arr: [1000, 1600] },
    { stops: [0, 1], dep: [1600, 2200], arr: [1600, 2200] },
  ]);
  const days = [dayAll(2)];
  let calls = 0;
  let snapshot = 100;
  const source = {
    snapshotId: () => snapshot,
    journeys: () => { calls++; return [journey(0, [[0, 1900]])]; },
  };

  const first = shiftsFor(ix, source, days)!;
  assert.equal(calls, 1);
  assert.equal(first[0]!.delay[0], 900);

  // Same snapshot -> served from the memo, nothing rebuilt.
  assert.equal(shiftsFor(ix, source, days), first);
  assert.equal(calls, 1);

  // New snapshot -> rebuilt.
  snapshot = 200;
  const second = shiftsFor(ix, source, days)!;
  assert.equal(calls, 2);
  assert.notEqual(second, first);
});

test("shiftsFor returns undefined with no store, no snapshot, or nothing late", () => {
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [1000, 1600], arr: [1000, 1600] }]);
  const days = [dayAll(1)];

  assert.equal(shiftsFor(ix, null, days), undefined);
  assert.equal(shiftsFor(ix, { snapshotId: () => null, journeys: () => [] }, days), undefined);

  const onTime = { snapshotId: () => 7, journeys: () => [journey(0, [[0, 1000]])] };
  assert.equal(shiftsFor(ix, onTime, days), undefined);
  // And again, now served from the memo -- still undefined, not an empty array.
  assert.equal(shiftsFor(ix, onTime, days), undefined);
});

test("tripDelays rejects an implausible delay rather than clamping it through", () => {
  // The real case: buildDayContexts searches the PREVIOUS service day too, and
  // ~1,600 trips run on both. A live journey always belongs to today's run, so
  // measuring it against yesterday's baseEpoch yields about +86,400 s -- a
  // positive number that would otherwise sail through the `> 0` test and shove
  // the trip a full day out of the previous-day search.
  const ix = makeTestIndex(3, [{ stops: [0, 1, 2], dep: [100, 200, 300], arr: [100, 200, 300] }]);
  const aDayLate = tripDelays(ix, [journey(0, [[1, 200 + 86_400]])], dayAll(1));
  assert.equal(aDayLate[0], 0);

  // The boundary is honoured exactly, and an ordinary rush-hour delay -- the
  // worst observed on this feed is about 20 minutes -- is nowhere near it.
  const atLimit = tripDelays(ix, [journey(0, [[1, 200 + 7_200]])], dayAll(1));
  assert.equal(atLimit[0], 7_200);
  const pastLimit = tripDelays(ix, [journey(0, [[1, 200 + 7_201]])], dayAll(1));
  assert.equal(pastLimit[0], 0);
  const ordinary = tripDelays(ix, [journey(0, [[1, 200 + 1_200]])], dayAll(1));
  assert.equal(ordinary[0], 1_200);
});
