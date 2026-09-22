import { test } from "node:test";
import assert from "node:assert/strict";
import { runRaptorReverse } from "./raptorReverse.js";
import type { DayContext } from "./raptor.js";
import { makeTestIndex } from "./testIndex.js";
import { buildShift } from "./shift.js";
import { buildHeadwayTable, type TransferConfig } from "./headway.js";

/**
 * Hand-written tests, kept as readable documentation of intent -- mirroring
 * `raptor.test.ts`'s five simplest cases with every comparison flipped. As
 * with the forward suite, these are not the primary correctness evidence:
 * `raptorReverse.oracle.test.ts`'s differential oracle is. (The forward
 * suite's eleven hand-written tests caught none of the six defects fixed in
 * `raptor.ts`; a brute-force oracle caught all of them.)
 */

const BASE = 1_787_000_000;
const oneDay = (n: number): DayContext[] =>
  [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: new Uint8Array(n).fill(1) }];

test("finds the latest direct trip that still arrives in time", () => {
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
    { stops: [0, 1], dep: [10800, 11400], arr: [10800, 11400] },
  ]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 8000,
    days: oneDay(3), maxRounds: 3, transferMinSeconds: 0,
  });
  // The 10800 trip arrives too late; the 7200 one is the latest that works.
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 7200);
});

test("a two-leg journey appears in round 2", () => {
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
  assert.equal(res.rounds[1]![0], null);
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 3600);
});

test("respects the minimum transfer time in reverse", () => {
  const ix = makeTestIndex(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [3000, 3600], arr: [3000, 3600] },
    // Departs 60 s after the 4200 arrival — too tight with a 120 s buffer.
    { stops: [1, 2], dep: [4260, 4800], arr: [4260, 4800] },
  ]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days: oneDay(3), maxRounds: 3, transferMinSeconds: 120,
  });
  // Must fall back to the earlier feeder arriving at 3600.
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 3000);
});

test("walks backwards along a footpath", () => {
  const ix = makeTestIndex(3,
    [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }],
    [[2, 1, 300]],
  );
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 3600);
});

test("returns nothing when nothing arrives in time", () => {
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] }]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  for (const round of res.rounds) assert.equal(round[0], null);
});

// ------------------------------------------------------------ last service
// The reverse half of the last-service rule. Reverse cannot ask forward's
// question ("does anything depart at or after `ready`" -- `ready` is what it
// is solving for), so it asks a sufficient one instead: does anything on the
// onward pattern run later at all, that service day? See
// `raptorReverse.ts`'s `lastTripsOnDay` for why that is the conservative
// direction, and for why reverse is allowed to be.

const MARGIN_CFG: TransferConfig = { baseSeconds: 60, factor: 0.25, capSeconds: 600 };

/** Feeder stop 0 -> stop 1 arriving 4200; `onward` departures from stop 1
 *  to stop 2, each 600 s long. */
function reverseInterchange(onward: number[]) {
  const trips = [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    ...onward.map((dep) => ({ stops: [1, 2], dep: [dep, dep + 600], arr: [dep, dep + 600] })),
  ];
  return { ix: makeTestIndex(3, trips), days: oneDay(trips.length) };
}

test("the margin yields when the onward service is the day's last", () => {
  // One onward departure at 4380: no gap to measure, so NO_HEADWAY, so the
  // full 600 s cap. Charging it would put the feeder's deadline at 3780 and
  // this feeder arrives 4200 -- no journey at all. There is no later onward
  // trip to be moved onto, so the rule falls back to the flat 60 s buffer
  // and the departure survives.
  const { ix, days } = reverseInterchange([4380]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 3600);
});

test("the margin still binds when a later onward trip exists", () => {
  // The same 4380 connection, but the pattern also runs at 8000 -- so the
  // 3620 s gap is measurable, `required` is the 600 s cap for a real reason,
  // and refusing this connection costs the rider an hour rather than the
  // journey. Reverse charges the margin, the feeder misses the deadline, and
  // (the 8000 trip arriving past 5000) nothing is offered within the
  // deadline. Without this contrast the test above would pass against an
  // implementation that simply stopped charging the margin.
  const { ix, days } = reverseInterchange([4380, 8000]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![0], null);
});

test("a trip the tripFilter excludes is not the day's last service", () => {
  // A MUTATION SURVIVOR, pinned. Deleting the `tripFilter` guard from
  // `lastTripsOnDay` leaves all 18 reverse-oracle tests green at 4,000
  // trials and every other named regression green with it: the oracle models
  // the case correctly, but `genNet` only filters on 25% of trials at 20% of
  // trips, so "the pattern's last trip is the filtered one, AND that changes
  // the margin" is a shape it essentially never draws. This test draws it
  // deliberately -- the same remedy this file's other survivors get, rather
  // than biasing the generator toward one hand-picked shape.
  //
  // Same fixture as "the margin still binds when a later onward trip exists"
  // (departures at 4380 and 8000, so the 3620 s gap is measurable and the
  // margin is the full 600 s cap), with the 8000 trip EXCLUDED by the
  // filter. A rider cannot board what the filter refuses, so 4380 is the
  // day's last service as far as this query is concerned and the margin must
  // yield -- exactly as it does when 8000 does not exist at all.
  //
  // Note the headway TABLE still measures the 3620 s gap: `buildHeadwayTable`
  // reads the service-day mask, not the query's filter. That is what makes
  // this a real test rather than a tautology -- the margin genuinely wants
  // 600 s here, and only the fallback lets the connection through.
  const { ix, days } = reverseInterchange([4380, 8000]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    arriveByEpoch: BASE + 5000,
    days, maxRounds: 3, transferMinSeconds: 60,
    // Trip 2 is the 8000 departure (trip 0 is the feeder, trip 1 is 4380).
    tripFilter: (t: number) => t !== 2,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![0]!.departureEpoch, BASE + 3600);
});

test("the alighting deadline is priced for the hour the ONWARD boarding happens in", () => {
  // The reverse half of the position-shift fix, pinned deterministically
  // because the reverse oracle does not reach it at 4,000 trials -- its
  // generator rarely puts a pattern's travel time across an hour boundary
  // with different headways on each side. Same shape as `raptor.test.ts`'s
  // "the margin is charged for the hour the rider BOARDS in".
  //
  // Onward pattern P = [0,1,2,3] leaves stop 0 at 10800 / 11400 / 14400 and
  // takes 4800 s to reach stop 2, where this rider joins it. Its two gaps
  // (600 s and 3000 s) both belong to hour 3, median 1800, so hour 3 asks
  // 450 s; hour 4 holds only the day's last departure, so it asks the full
  // 600 s cap.
  //
  // The rider catches P's 16200 departure from stop 2. That instant reads as
  // hour 4 on their own clock and as hour 3 once shifted back to first-stop
  // time (16200 - 4800 = 11400), and the rule wants hour 3: 450 s, so a
  // feeder may arrive as late as 16200 - 60 - 390 = 15750. Feeder F arrives
  // 15700 and makes it, so the departure from stop 4 survives.
  //
  // Pricing the unshifted 16200 charges hour 4's cap instead, moving the
  // deadline to 15600 -- 100 s too early for F, and the journey disappears.
  const trips = [
    { stops: [0, 1, 2, 3], dep: [10800, 13200, 15600, 16200], arr: [10800, 13200, 15600, 16200] },
    { stops: [0, 1, 2, 3], dep: [11400, 13800, 16200, 16800], arr: [11400, 13800, 16200, 16800] },
    { stops: [0, 1, 2, 3], dep: [14400, 16800, 19200, 19800], arr: [14400, 16800, 19200, 19800] },
    { stops: [4, 2], dep: [15000, 15700], arr: [15000, 15700] }, // feeder F
  ];
  const ix = makeTestIndex(5, trips);
  const days = oneDay(trips.length);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 4, secondsToReach: 0 }],
    destinations: [{ stopIdx: 3, secondsToReach: 0 }],
    arriveByEpoch: BASE + 16800,
    days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![4]!.departureEpoch, BASE + 15000);
});

// --- realtime shift ---------------------------------------------------------

test("a late trip no longer arrives in time, so reverse takes the earlier one", () => {
  // Mirror of the forward case: the 7200 bus would be the latest that still
  // makes an arriveBy of 7800, but it is running 20 min late, so the rider has
  // to take the 3600 instead.
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const shift = buildShift(ix, [{
    tripIdx: 1,
    byStopIdx: new Map([[0, { expectedArrival: BASE + 8400 }]]),
  }], oneDay(2)[0]!)!;
  assert.equal(shift.delay[1], 1200);

  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 7800,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
    shift: [shift],
  });
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 3600);
});

test("reverse rides a late trip on its shifted times", () => {
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
  ]);
  const shift = buildShift(ix, [{
    tripIdx: 0,
    byStopIdx: new Map([[0, { expectedArrival: BASE + 4200 }]]),
  }], oneDay(1)[0]!)!;
  assert.equal(shift.delay[0], 600);

  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 4800,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
    shift: [shift],
  });
  // Departs 600 s later than the timetable says, because the bus is 600 s late.
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 4200);
});

test("omitting the shift leaves the reverse search unchanged", () => {
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const res = runRaptorReverse(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    arriveByEpoch: BASE + 7800,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![0]!.departureEpoch, BASE + 7200);
});
