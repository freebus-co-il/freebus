import { test } from "node:test";
import assert from "node:assert/strict";
import { runRaptor, type DayContext } from "./raptor.js";
import { makeTestIndex as makeIndex } from "./testIndex.js";
import { buildShift } from "./shift.js";
import {
  buildHeadwayTable, headwayFor, NO_HEADWAY, type TransferConfig,
} from "./headway.js";

const BASE = 1_787_000_000; // arbitrary service-day origin
function oneDay(nTrips: number): DayContext[] {
  return [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip: new Uint8Array(nTrips).fill(1) }];
}

test("finds a direct trip", () => {
  const ix = makeIndex(2, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 4200);
});

test("takes a later trip when the first has already gone", () => {
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 5000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 7800);
});

// Round k is the (k-1)-transfer answer. This is the property that gives the
// Pareto set over (arrival, transfers) for free.
test("a two-leg journey appears in round 2, not round 1", () => {
  const ix = makeIndex(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [1, 2], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![2], null);
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 5100);
  assert.equal(res.rounds[2]![2]!.kind, "transit");
});

test("a transfer respects the minimum transfer time", () => {
  const ix = makeIndex(3, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    // Departs 60 s after the first arrives — unreachable with a 120 s buffer.
    { stops: [1, 2], dep: [4260, 4800], arr: [4260, 4800] },
    { stops: [1, 2], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(3), maxRounds: 3, transferMinSeconds: 120,
  });
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 5100);
});

test("walks between stops using a footpath", () => {
  const ix = makeIndex(3,
    [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }],
    [[1, 2, 300]],
  );
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![2]!.arrivalEpoch, BASE + 4500);
  assert.equal(res.rounds[1]![2]!.kind, "walk");
});

test("returns nothing when the destination is unreachable", () => {
  const ix = makeIndex(3, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 2, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(1), maxRounds: 3, transferMinSeconds: 0,
  });
  for (const round of res.rounds) assert.equal(round[2], null);
  // A stub that always returns all-null rounds would also pass the assertion
  // above. Assert a stop that IS reachable in this same network actually
  // comes back non-null, so this test can only pass against a real result.
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 4200);
});

test("skips a trip whose service does not run that day", () => {
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const days: DayContext[] = [
    { dateYmd: 20260824, baseEpoch: BASE, activeTrip: Uint8Array.from([0, 1]) },
  ];
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days, maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 7800);
});

// The whole reason DayContexts exist: a trip departing yesterday at 25:30 is
// running at 01:30 today, and must be comparable with today's trips.
test("uses a previous-service-day trip whose time exceeds 86400", () => {
  const ix = makeIndex(2, [{ stops: [0, 1], dep: [91800, 92400], arr: [91800, 92400] }]);
  const yesterdayBase = BASE - 86400;
  const days: DayContext[] = [
    { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([0]) },
    { dateYmd: 20260824, baseEpoch: yesterdayBase, activeTrip: Uint8Array.from([1]) },
  ];
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: yesterdayBase + 90000,
    days, maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, yesterdayBase + 92400);
});

test("access legs add their walking time to the departure", () => {
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 900 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    // Departing at 3000 + 900 s of walking = ready at 3900, past the 3600 trip.
    departAfterEpoch: BASE + 3000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 7800);
});

// Without carrying labels forward between rounds, stop 1 would be null in
// round 2 and this three-leg journey would never be found.
test("boards in a later round from a stop last improved in an earlier one", () => {
  const ix = makeIndex(4, [
    { stops: [0, 1], dep: [3600, 3660], arr: [3600, 3660] },
    // A long detour that reaches stop 2 without improving stop 1.
    { stops: [0, 2], dep: [3600, 9000], arr: [3600, 9000] },
    // Departs stop 1 much later, so it is only boardable in a later round.
    { stops: [1, 3], dep: [12000, 12600], arr: [12000, 12600] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 3, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(3), maxRounds: 4, transferMinSeconds: 0,
  });
  assert.equal(res.rounds[2]![3]!.arrivalEpoch, BASE + 12600);
});

test("a tripFilter excludes trips from consideration", () => {
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 3000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
    tripFilter: (t) => t !== 0,
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 7800);
});

// ------------------------------------------------- headway-scaled transfer margin
// The oracle in `raptor.oracle.test.ts` is what actually proves this rule
// correct, across hundreds of random networks. These two pin the INTENT, so
// a reader can see in one place what the feature buys: the identical
// interchange -- same feeder, same arrival, same 180 s of slack -- is refused
// onto an hourly service and accepted onto a six-minute one.

const MARGIN_CFG: TransferConfig = { baseSeconds: 60, factor: 0.25, capSeconds: 600 };

/** Feeder: stop 0 -> stop 1, arriving 4200. The connection at stop 1 departs
 *  at 4380, so the rider has 180 s of slack, of which 60 s is the flat base
 *  buffer every transfer already owes today. */
function interchange(connections: { dep: number; arr: number }[]): {
  ix: ReturnType<typeof makeIndex>; days: DayContext[];
} {
  const trips = [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    ...connections.map((c) => ({ stops: [1, 2], dep: [c.dep, c.arr], arr: [c.dep, c.arr] })),
  ];
  return { ix: makeIndex(3, trips), days: oneDay(trips.length) };
}

test("a tight interchange onto an hourly service is refused, and the next trip taken", () => {
  // Hourly: departures 4380 and 7980, one 3600 s gap, attributed to hour 1 --
  // the hour the candidate boarding instant (4200 + 60 = 4260) falls in.
  // required = clamp(60, 0.25 * 3600 = 900, 600) = 600, so the rider must be
  // at the stop by 4380 - 600 = 3780 and is not: arrival 4200 makes them
  // ready at 4800. The 4380 connection is refused and the 7980 one taken.
  const { ix, days } = interchange([{ dep: 4380, arr: 4980 }, { dep: 7980, arr: 8580 }]);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
  };

  // Without the margin this exact interchange is taken -- so it is the
  // margin, and nothing else about the fixture, that refuses it below.
  assert.equal(runRaptor(ix, q).rounds[2]![2]!.arrivalEpoch, BASE + 4980);

  const res = runRaptor(ix, {
    ...q,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  // Later, not fewer: the journey survives, on the next trip.
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 8580);
  assert.equal(res.rounds[2]![2]!.boardEpoch, BASE + 7980);
});

test("the same interchange onto a six-minute service is still accepted", () => {
  // Same feeder, same arrival at 4200, same connection departing 4380 -- only
  // the headway differs: departures 4380/4740/5100, two 360 s gaps in hour 1,
  // so required = clamp(60, 0.25 * 360 = 90, 600) = 90 and the rider is ready
  // at 4290. Missing this one costs six minutes, so it is not worth insuring
  // against, and the planner still offers it.
  const { ix, days } = interchange([
    { dep: 4380, arr: 4980 }, { dep: 4740, arr: 5340 }, { dep: 5100, arr: 5700 },
  ]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 4980);
  assert.equal(res.rounds[2]![2]!.boardEpoch, BASE + 4380);
});

// The margin insures against a late incoming vehicle. The first boarding of a
// journey has none, and charging it there costs a full headway to insure
// against nothing. These pin that rule.

/** Hourly departures at 4200 and 7800. */
function hourlyFromStop0(foot: [number, number, number][] = []) {
  return makeIndex(3, [
    { stops: [0, 1], dep: [4200, 4500], arr: [4200, 4500] },
    { stops: [0, 1], dep: [7800, 8100], arr: [7800, 8100] },
  ], foot);
}

test("the first boarding of a journey is not charged the headway margin", () => {
  // A rider standing at the stop from t=4000 boards the 4200. Charging them
  // the hourly margin (600 s, so ready at 4600) would push them to the 7800
  // and cost an hour, to protect against a feeder delay that cannot exist.
  const ix = hourlyFromStop0();
  const days = oneDay(2);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 4000, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 4500);
  assert.equal(res.rounds[1]![1]!.boardEpoch, BASE + 4200);
});

test("a first boarding reached by walking from the origin is not charged either", () => {
  // The case `label.kind === "access"` alone gets WRONG. Round 0 relaxes
  // footpaths from its own access labels, so the label at stop 0 here is
  // kind "walk" -- and `cur = prev.slice()` carries it into every later
  // round, so its round index says nothing either. This rider has still
  // ridden nothing, and must board the 4200 exactly as the one above does.
  const ix = hourlyFromStop0([[2, 0, 300]]);
  const days = oneDay(2);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 2, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 3700, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[0]![0]!.kind, "walk", "fixture must exercise the access-rooted walk");
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 4500);
  assert.equal(res.rounds[1]![1]!.boardEpoch, BASE + 4200);
});

// ...unless the rider is ALREADY ABOARD a vehicle when the query is asked.
// `/plan/onboard` seeds one origin per stop the rider's current trip still
// reaches, timed at the vehicle's own (delay-adjusted) arrival there -- so
// the incoming vehicle that an ordinary origin cannot have is exactly what
// those origins ARE. `originsOnVehicle` is how a query says so; the three tests below pin
// that it is honoured for round-0 access labels, honoured for the walk
// labels round 0 relaxes out of them, and completely inert when absent.

test("origins declared already-aboard ARE charged the margin on their first boarding", () => {
  // The mirror image of the first-boarding-exemption test above, same fixture and same instant:
  // this rider is not standing at stop 0 by choice, they are arriving there
  // on a vehicle that can be late, so the hourly margin (600 s, ready at
  // 4600) applies and the 4200 departure is out of reach. Without the flag
  // being honoured this boards the 4200 and arrives 4500.
  const ix = hourlyFromStop0();
  const days = oneDay(2);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 4000, days, maxRounds: 3, transferMinSeconds: 60,
    originsOnVehicle: true,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[1]![1]!.boardEpoch, BASE + 7800);
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 8100);
});

test("an already-aboard rider who ALIGHTS AND WALKS is charged the margin too", () => {
  // The walk-out-of-round-0 case, which `label.kind === "access"` alone gets
  // wrong in the other direction: this rider got off the vehicle at stop 2
  // and walked 300 s to stop 0, so the label doing the boarding is walk-kind
  // with an ACCESS predecessor -- and they still have a vehicle behind them
  // that could have been late. Charged, so the 4200 is out of reach.
  const ix = hourlyFromStop0([[2, 0, 300]]);
  const days = oneDay(2);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 2, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 3700, days, maxRounds: 3, transferMinSeconds: 60,
    originsOnVehicle: true,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[0]![0]!.kind, "walk", "fixture must exercise the access-rooted walk");
  assert.equal(res.rounds[1]![1]!.boardEpoch, BASE + 7800);
});

test("an already-aboard rider owes the flat transfer buffer at the stop they alight at", () => {
  // No `transfer` at all, so the headway margin is not in play: this is the
  // FLAT `transferMinSeconds` every transfer has always owed, and an onboard
  // rider stepping off one vehicle onto another owes it for the same reason a
  // mid-journey transfer does -- they have to get off and get on. Without it
  // an onboard connection is charged `required - baseSeconds`, i.e. 60 s less
  // than the identical connection inside a `/plan` itinerary.
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [4200, 4800], arr: [4200, 4800] },
    { stops: [0, 1], dep: [4500, 5100], arr: [4500, 5100] },
  ]);
  const days = oneDay(2);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 4160, days, maxRounds: 2, transferMinSeconds: 60,
  };
  // Standing at the stop from 4160, the 4200 departure is 40 s away and
  // perfectly boardable -- nothing to get off first.
  assert.equal(runRaptor(ix, q).rounds[1]![1]!.boardEpoch, BASE + 4200);
  // Arriving at 4160 ON a vehicle, those 40 s are not enough.
  assert.equal(
    runRaptor(ix, { ...q, originsOnVehicle: true }).rounds[1]![1]!.boardEpoch, BASE + 4500);
});

test("at factor 0 the flag charges the flat buffer and nothing more", () => {
  // BOTH halves are asserted here, because each is decisive on its own: a
  // single assertion using a gap that swallows the 60 s flat charge whole
  // would pass with the flag present, with it absent, and with the `base`
  // term reverted entirely -- proving nothing.
  const ix = hourlyFromStop0(); // hourly departures at 4200 and 7800
  const days = oneDay(2);
  const flat = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    days, maxRounds: 3, transferMinSeconds: 60, originsOnVehicle: true,
    transfer: {
      cfg: { ...MARGIN_CFG, factor: 0 },
      headway: days.map((day) => buildHeadwayTable(ix, day)),
    },
  };

  // NO HEADWAY MARGIN. Arriving at 4000 with 200 s to the 4200 departure:
  // the flat 60 s is charged (ready 4060) and the trip is caught. If the
  // hourly margin leaked past the `factor === 0` off switch it would ask for
  // 600 s (ready 4660) and push this rider to the 7800.
  assert.equal(
    runRaptor(ix, { ...flat, departAfterEpoch: BASE + 4000 }).rounds[1]![1]!.boardEpoch,
    BASE + 4200);
  // ...and the fixture is not vacuous about it: the IDENTICAL query at the
  // configured factor IS pushed to the 7800. Asserted here, next to the
  // claim, rather than left implicit in the test above -- at factor 0 the
  // clamp returns `baseSeconds` by arithmetic as well as by short-circuit,
  // so no single mutation of either off-switch guard can make the assertion
  // above fail, and only this contrast shows it is measuring anything.
  assert.equal(
    runRaptor(ix, {
      ...flat, departAfterEpoch: BASE + 4000,
      transfer: { cfg: MARGIN_CFG, headway: flat.transfer.headway },
    }).rounds[1]![1]!.boardEpoch,
    BASE + 7800);

  // BUT THE FLAT BUFFER IS STILL CHARGED. Arriving at 4160 with only 40 s to
  // that same departure: not enough to get off one vehicle and onto another,
  // so the 7800 it is. Without the `base` term this reads 4200.
  assert.equal(
    runRaptor(ix, { ...flat, departAfterEpoch: BASE + 4160 }).rounds[1]![1]!.boardEpoch,
    BASE + 7800);
});

test("the headway table used is the one for the day the trip is boarded on", () => {
  // Why `transfer.headway` is an array parallel to `days` and not a single
  // table. Pattern [1,2] is HOURLY on yesterday's service day and runs every
  // six minutes on today's, in the same hour-25 row -- so reading today's row
  // for a trip that belongs to yesterday's calendar picks a 90 s margin where
  // the rule demands 600 s, and boards a connection that should be refused.
  const trips = [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },       // feeder, today
    { stops: [1, 2], dep: [90720, 91320], arr: [90720, 91320] },   // yesterday: hourly...
    { stops: [1, 2], dep: [94320, 94920], arr: [94320, 94920] },   // ...next one an hour on
    { stops: [1, 2], dep: [90600, 91200], arr: [90600, 91200] },   // today: every six minutes
    { stops: [1, 2], dep: [90960, 91560], arr: [90960, 91560] },
    { stops: [1, 2], dep: [91320, 91920], arr: [91320, 91920] },
  ];
  const ix = makeIndex(3, trips);
  const days: DayContext[] = [
    { dateYmd: 20260825, baseEpoch: BASE, activeTrip: Uint8Array.from([1, 0, 0, 1, 1, 1]) },
    { dateYmd: 20260824, baseEpoch: BASE - 86400, activeTrip: Uint8Array.from([0, 1, 1, 0, 0, 0]) },
  ];
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 3000, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  // The feeder lands at BASE+4200, so the candidate boarding instant is
  // BASE+4260 -- 90660 s into YESTERDAY's service day, hour 25. Yesterday's
  // row there is 3600 s, so the margin is 600 s and the BASE+4320 departure
  // is out of reach; the next one, BASE+7920, arrives BASE+8520.
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 8520);
  // Today's hour-25 row says 360 s, a 90 s margin, which would have taken the
  // BASE+4320 departure and arrived BASE+4920. That is the wrong answer.
  assert.notEqual(res.rounds[2]![2]!.arrivalEpoch, BASE + 4920);
});

// `q.transfer` carries three things `runRaptor` cannot verify from the index,
// and every one of them fails silently rather than loudly: a missing table
// disables the margin for a whole service day, a mismatched base measures
// every margin against the wrong floor, and an inverted clamp drives
// `requiredTransferSeconds` BELOW the base -- which would make boarding
// easier than today's flat rule and break the dominance argument this file's
// termination depends on. Replacing any of these conditions with `false` left
// the entire suite green before these three tests existed.

/** A well-formed query, for the throw tests below to break one field of. */
function transferQuery() {
  const ix = makeIndex(2, [{ stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] }]);
  const days = oneDay(1);
  return {
    ix,
    q: {
      origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
      departAfterEpoch: BASE + 3000, days, maxRounds: 3, transferMinSeconds: 60,
      transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
    },
  };
}

test("a headway table per service day is required, not optional", () => {
  const { ix, q } = transferQuery();
  assert.throws(
    () => runRaptor(ix, { ...q, days: [...q.days, ...q.days] }),
    /transfer\.headway has 1 tables for 2 days/,
  );
});

test("a cfg whose base is not transferMinSeconds is refused", () => {
  // The margin is `required - baseSeconds`, and footpath edges bake in
  // `transferMinSeconds`. If the two disagree, every boarding is measured
  // against the wrong floor -- silently, and on every query.
  const { ix, q } = transferQuery();
  assert.throws(
    () => runRaptor(ix, { ...q, transfer: { ...q.transfer, cfg: { ...MARGIN_CFG, baseSeconds: 120 } } }),
    /baseSeconds \(120\) must equal transferMinSeconds \(60\)/,
  );
});

test("an inverted clamp is refused at the query boundary, not absorbed by the floor", () => {
  // `requiredTransferSeconds` applies the cap LAST, so capSeconds <
  // baseSeconds genuinely returns below the base (headway.test.ts pins that
  // directly). `config.ts` refuses it at boot, but runRaptor is called
  // directly by tests and by both planner passes with a caller-supplied cfg,
  // so the invariant is enforced here too -- rather than left to the
  // `Math.max(0, ...)` floor, which would silently swallow the nonsense.
  const { ix, q } = transferQuery();
  assert.throws(
    () => runRaptor(ix, { ...q, transfer: { ...q.transfer, cfg: { ...MARGIN_CFG, capSeconds: 30 } } }),
    /capSeconds \(30\) must be at least baseSeconds \(60\)/,
  );
});

test("KNOWN LIMITATION: hour bucketing breaks arrival dominance, and the cost is a headway, not a cap", () => {
  // READ THIS COMMENT BEFORE "FIXING" THIS. The margin is a function of the
  // boarding HOUR, so it steps at each hour boundary: a LATER arrival can
  // demand a SMALLER margin. RAPTOR prunes by arrival time, so it can keep an
  // earlier arrival that ends up strictly worse. This is accepted
  // deliberately -- it errs only conservatively, since every journey returned
  // does satisfy the rule -- and fixing it means making dominance aware of
  // the boarding hour, which multiplies label state for a narrow case.
  //
  // It is pinned here because `capSeconds - baseSeconds` (540 s with these
  // values) bounds only the READINESS delta, not the arrival delta. The
  // ARRIVAL delta is a whole headway, and compounds; here it is 7300 s.
  const trips = [
    { stops: [0, 2], dep: [3000, 3480], arr: [3000, 3480] },           // feeder A: stop 2 at 3480
    { stops: [0, 1, 2], dep: [3000, 3200, 3600], arr: [3000, 3200, 3600] }, // feeder B: stop 2 at 3600
    // The connection: four departures a minute apart, then nothing for two hours.
    { stops: [2, 3], dep: [3700, 4000], arr: [3700, 4000] },
    { stops: [2, 3], dep: [3760, 4060], arr: [3760, 4060] },
    { stops: [2, 3], dep: [3820, 4120], arr: [3820, 4120] },
    { stops: [2, 3], dep: [3880, 4180], arr: [3880, 4180] },
    { stops: [2, 3], dep: [11000, 11300], arr: [11000, 11300] },
  ];
  const ix = makeIndex(4, trips);
  const days = oneDay(trips.length);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  };

  // Every one of the connection's gaps is attributed to hour 1, so hour 1
  // reads 60 s (a 60 s margin, i.e. no extra at all) while hour 0 -- which has
  // no departure before it to measure from -- is unmeasured and takes the cap.
  // The hour boundary at 3600 therefore sits between the two feeders.
  const pC = ix.patternOfTrip[2]!;
  assert.equal(headwayFor(q.transfer.headway[0]!, pC, 3660), 60);
  assert.equal(headwayFor(q.transfer.headway[0]!, pC, 3540), NO_HEADWAY);

  // Feeder A wins stop 2 on arrival time, 3480 against 3600...
  const res = runRaptor(ix, q);
  assert.equal(res.rounds[1]![2]!.arrivalEpoch, BASE + 3480);
  // ...and is then charged the cap, because 3480 + 60 lands in hour 0. Ready
  // at 4080, it misses all four close departures and takes the 11000.
  assert.equal(res.rounds[2]![3]!.arrivalEpoch, BASE + 11300);

  // But feeder B, arriving 120 s LATER, lands in hour 1, owes no extra at
  // all, and catches the 3700. Withholding feeder A proves that journey is
  // real and satisfies the rule -- RAPTOR finds it as soon as the
  // earlier-arriving label stops shadowing it.
  const withheld = runRaptor(ix, { ...q, tripFilter: (t: number) => t !== 0 });
  assert.equal(withheld.rounds[1]![2]!.arrivalEpoch, BASE + 3600);
  assert.equal(withheld.rounds[2]![3]!.arrivalEpoch, BASE + 4000);

  // The accepted cost, stated as a relation between the two runs rather than
  // as arithmetic on literals -- asserting `11300 - 4000 === 7300` directly
  // would be a true statement about numbers and no statement at all
  // about this planner. 7300 s is the hour-bucketing penalty, and it is NOT bounded by
  // `capSeconds - baseSeconds` (540 s) -- that bounds the readiness delta,
  // while this is a missed departure compounding into a full headway of
  // arrival.
  assert.equal(
    res.rounds[2]![3]!.arrivalEpoch - withheld.rounds[2]![3]!.arrivalEpoch, 7300,
    "the hour-bucketing penalty, measured between the two runs",
  );
});

test("the margin's hour comes from the candidate boarding instant, not from the trip that ends up boarded", () => {
  // The margin's independence from which trip is boarded, pinned by name.
  // Deriving the hour from
  // the trip the search settles on would feed the margin its own output: a
  // bigger margin picks a later trip, whose hour may carry a different
  // headway, which changes the margin.
  //
  // The connection departs at 3480, 3540, 3700 and 11000, so hour 0 collects
  // gaps [60, 160] -> median 110 -> no extra at all, while hour 1 collects
  // the single 7300 s gap -> the 600 s cap -> 540 s of extra.
  const trips = [
    { stops: [0, 1], dep: [3000, 3500], arr: [3000, 3500] }, // feeder A: stop 1 at 3500
    { stops: [0, 1], dep: [3000, 3600], arr: [3000, 3600] }, // feeder B: stop 1 at 3600
    { stops: [1, 2], dep: [3480, 3780], arr: [3480, 3780] },
    { stops: [1, 2], dep: [3540, 3840], arr: [3540, 3840] },
    { stops: [1, 2], dep: [3700, 4000], arr: [3700, 4000] },
    { stops: [1, 2], dep: [11000, 11300], arr: [11000, 11300] },
  ];
  const ix = makeIndex(3, trips);
  const days = oneDay(trips.length);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  };
  const pC = ix.patternOfTrip[2]!;
  assert.equal(headwayFor(q.transfer.headway[0]!, pC, 3560), 110);  // hour 0
  assert.equal(headwayFor(q.transfer.headway[0]!, pC, 3660), 7300); // hour 1

  // Feeder A lands at 3500, so the candidate instant is 3560 -- hour 0, where
  // the margin is nothing. The rider boards the 3700 and arrives at 4000.
  // Charging the hour of the trip actually boarded (3700, hour 1) would cost
  // 540 s, put readiness at 4100, miss the 3700 entirely and arrive 11300.
  const viaA = runRaptor(ix, { ...q, tripFilter: (t: number) => t !== 1 });
  assert.equal(viaA.rounds[2]![2]!.arrivalEpoch, BASE + 4000);

  // The mirror, which catches reading the hour off the pattern's own
  // timetable instead of off the rider: feeder B lands 100 s later at 3600,
  // so the candidate instant is 3660 -- hour 1, where the margin IS 540 s.
  // This rider genuinely cannot make the 3700 and arrives 11300. Any
  // implementation that reads the hour from the pattern's first departure
  // (3480, hour 0) would hand them the 3700 instead.
  const viaB = runRaptor(ix, { ...q, tripFilter: (t: number) => t !== 0 });
  assert.equal(viaB.rounds[2]![2]!.arrivalEpoch, BASE + 11300);
});

// ------------------------------------------------------------ last service
// The last service of the night. The ordinary rule promises "later, not
// fewer", but measurement falsified it: on the real feed, 9 of 241 randomly-drawn
// late-evening `departAfter` queries that returned a journey under the flat
// rule returned NOTHING under the headway-scaled one, because there was no
// next trip to be pushed onto. These pin the rule that fixes it -- and the
// floor it may never go below.

test("a connection failing the margin is still boarded when the pattern has no later trip", () => {
  // One connection, departing 4380. A single active trip produces no gap to
  // measure, so its hour reports NO_HEADWAY and `required` takes the full
  // 600 s cap: the rider, ready at 4260, is 480 s short. Without the
  // last-service fallback the whole journey would vanish -- there is no
  // later trip on this pattern to be moved onto, and the forward search
  // does not roll into the next morning. Instead the margin yields to the
  // flat 60 s buffer, which this 180 s of slack clears comfortably and
  // which is exactly what the flat rule (`TRANSFER_HEADWAY_FACTOR=0`) demands.
  const { ix, days } = interchange([{ dep: 4380, arr: 4980 }]);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
  };
  const flat = runRaptor(ix, q);
  const scaled = runRaptor(ix, {
    ...q,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  // Identical to the flat-rule journey, which is the whole claim: the
  // fallback restores today's behaviour, it does not invent a new one.
  assert.equal(flat.rounds[2]![2]!.arrivalEpoch, BASE + 4980);
  assert.equal(scaled.rounds[2]![2]!.arrivalEpoch, BASE + 4980);
  assert.equal(scaled.rounds[2]![2]!.boardEpoch, BASE + 4380);
});

test("the rule is 'no LATER trip', not 'the pattern runs once'", () => {
  // The same connection at 4380, but the pattern also ran at 3000 -- long
  // gone by the time this rider is ready at 4260, and in an earlier hour
  // bucket, so hour 1 still holds only the day's last departure and still
  // reports NO_HEADWAY. What matters is that nothing runs AFTER 4380, not
  // how many trips the pattern has.
  const { ix, days } = interchange([{ dep: 3000, arr: 3600 }, { dep: 4380, arr: 4980 }]);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 4980);
  assert.equal(res.rounds[2]![2]!.boardEpoch, BASE + 4380);
});

test("the fallback stops at the flat buffer -- it never boards below it", () => {
  // The feeder now lands at 4340, so even the flat 60 s buffer puts the
  // rider at 4400, after the 4380 departure. `baseSeconds` is the floor the
  // whole dominance argument rests on, so the answer here must be no journey
  // at all -- the same answer the pre-headway planner gives, which is what
  // the flat run below asserts. A fallback that boarded "whatever is left"
  // would make this planner LAXER than it has ever been.
  const trips = [
    { stops: [0, 1], dep: [3600, 4340], arr: [3600, 4340] },
    { stops: [1, 2], dep: [4380, 4980], arr: [4380, 4980] },
  ];
  const ix = makeIndex(3, trips);
  const days = oneDay(trips.length);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 2400, days, maxRounds: 3, transferMinSeconds: 60,
  };
  assert.equal(runRaptor(ix, q).rounds[2]![2], null);
  const scaled = runRaptor(ix, {
    ...q,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(scaled.rounds[2]![2], null);
});

test("the fallback is reachable even when the scan already holds a later trip", () => {
  // The boarding check's gate. It reads `base <= currentDep`, the FLOOR of
  // what the rule can require -- not `ready`, the margin-inflated instant.
  // Narrowing it back to `ready` looks harmless (a trip found at `ready`
  // could never beat the held one) and is not: it also skips the fallback,
  // in exactly the case where the fallback would have found a STRICTLY
  // EARLIER trip than the one being ridden.
  //
  // The oracle finds this on its own, but only just: with the gate narrowed
  // it first disagrees at trial 2433, so the committed 400-trial suite
  // passes and this file is the real guard.
  //
  // Pattern P = [0,1,2] runs T0 (3620 -> 4000 -> 4600) and T1 (4100 -> 4200
  // -> 5200). Its only gap, 480 s, is attributed to hour 1 (T0 leaves the
  // FIRST stop at 3620), so hour 0 is unmeasured and costs the full 600 s
  // cap.
  //
  // A rider off feeder R reaches stop 0 at 3300 and is ready at 3360 -- hour
  // 0 at position 0, so the cap applies, readiness is 3900, and they ride T1
  // (4100), which passes stop 1 at 4200. A second rider off feeder Q reaches
  // stop 1 at 3900, ready at 3960. Position 1 is 380 s down the pattern, so
  // the table is asked about 3580 -- still hour 0, still unmeasured, still
  // the cap: `ready` is 4500, past T1's own 4200, and nothing on P departs
  // stop 1 that late. The fallback yields, the second rider boards T0 at 4000 -- an
  // EARLIER trip than the scan was holding -- and stop 2 is reached at 4600
  // instead of 5200.
  //
  // The 380 s offset is load-bearing, not incidental: it is what makes the
  // position-shifted lookup land where it does. A different offset could put
  // the two lookups in different buckets by accident, without the position
  // shift being responsible.
  const trips = [
    { stops: [0, 1, 2], dep: [3620, 4000, 4600], arr: [3620, 4000, 4600] },
    { stops: [0, 1, 2], dep: [4100, 4200, 5200], arr: [4100, 4200, 5200] },
    { stops: [5, 0], dep: [3000, 3300], arr: [3000, 3300] },
    { stops: [6, 1], dep: [3600, 3900], arr: [3600, 3900] },
  ];
  const ix = makeIndex(7, trips);
  const days = oneDay(trips.length);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 5, secondsToReach: 0 }, { stopIdx: 6, secondsToReach: 0 }],
    destinations: [], departAfterEpoch: BASE + 2400, days,
    maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![2]!.arrivalEpoch, BASE + 4600);
  assert.equal(res.rounds[2]![2]!.boardEpoch, BASE + 4000);
});

test("the margin is charged for the hour the rider BOARDS in, not the hour the pattern left its first stop", () => {
  // The position-shift defect, pinned deterministically because the oracle
  // reaches it only at trial 8175 -- far past the committed trial count. The
  // oracle alone is not a reliable guard against it: if both the oracle and
  // the implementation bucket gaps at the pattern's first stop, they can
  // agree with each other while disagreeing with the rule.
  //
  // Pattern P = [0,1,2,3], leaving stop 0 at 10800 / 11400 / 14400 and
  // taking 4800 s to reach stop 2. Its gaps (600 s and 3000 s) both belong
  // to hour 3, median 1800, so boarding it in hour 3 asks for 450 s. Hour 4
  // has no gap of its own -- only the day's last departure starts in it --
  // so hour 4 asks for the full 600 s cap.
  //
  // A rider off feeder F reaches stop 2 at 15640 and is ready at 15700.
  // Their own clock says hour 4; the pattern that carries them left its
  // first stop at 15700 - 4800 = 10900, which is hour 3. The rule charges
  // hour 3's 450 s, readiness is 16090, and they catch the 16200 departure,
  // reaching stop 3 at 16800.
  //
  // Reading the table at the rider's raw 15700 instead charges hour 4's cap,
  // readiness becomes 16240, the 16200 departure is missed, and the next one
  // is 19200 -- stop 3 at 19800, a full 50 minutes later. Note the
  // last-service fallback does NOT paper over this: a later trip genuinely
  // exists, so nothing yields.
  const trips = [
    { stops: [0, 1, 2, 3], dep: [10800, 13200, 15600, 16200], arr: [10800, 13200, 15600, 16200] },
    { stops: [0, 1, 2, 3], dep: [11400, 13800, 16200, 16800], arr: [11400, 13800, 16200, 16800] },
    { stops: [0, 1, 2, 3], dep: [14400, 16800, 19200, 19800], arr: [14400, 16800, 19200, 19800] },
    { stops: [4, 2], dep: [15000, 15640], arr: [15000, 15640] }, // feeder F
  ];
  const ix = makeIndex(5, trips);
  const days = oneDay(trips.length);
  const res = runRaptor(ix, {
    origins: [{ stopIdx: 4, secondsToReach: 0 }], destinations: [],
    departAfterEpoch: BASE + 14400, days, maxRounds: 3, transferMinSeconds: 60,
    transfer: { cfg: MARGIN_CFG, headway: days.map((day) => buildHeadwayTable(ix, day)) },
  });
  assert.equal(res.rounds[2]![3]!.arrivalEpoch, BASE + 16800);
  assert.equal(res.rounds[2]![3]!.boardEpoch, BASE + 16200);
});

// --- realtime shift ---------------------------------------------------------

test("boards a late trip whose SCHEDULED departure has already gone", () => {
  // The defect this whole feature exists for: at BASE+5000 the 3600 bus is
  // eleven minutes into the past by the timetable, but it is running 30 min
  // late and is about to pull in. Schedule-only, the rider is told to wait for
  // the 7200.
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const shift = buildShift(ix, [{
    tripIdx: 0,
    byStopIdx: new Map([[0, { expectedArrival: BASE + 5400 }]]),
  }], oneDay(2)[0]!)!;
  assert.equal(shift.delay[0], 1800);

  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 5000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
    shift: [shift],
  });
  // Boards the late 3600 bus, arriving at its shifted arrival, not the 7200's.
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 4200 + 1800);
});

test("a late trip is still not boardable once its SHIFTED departure has gone", () => {
  // The shift moves the bus later; it must not become boardable retroactively.
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const shift = buildShift(ix, [{
    tripIdx: 0,
    byStopIdx: new Map([[0, { expectedArrival: BASE + 4200 }]]),
  }], oneDay(2)[0]!)!;

  const res = runRaptor(ix, {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 5000,   // after the shifted 4200 departure
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
    shift: [shift],
  });
  assert.equal(res.rounds[1]![1]!.arrivalEpoch, BASE + 7800);
});

test("omitting the shift leaves the search byte-for-byte unchanged", () => {
  const ix = makeIndex(2, [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },
    { stops: [0, 1], dep: [7200, 7800], arr: [7200, 7800] },
  ]);
  const q = {
    origins: [{ stopIdx: 0, secondsToReach: 0 }],
    destinations: [{ stopIdx: 1, secondsToReach: 0 }],
    departAfterEpoch: BASE + 5000,
    days: oneDay(2), maxRounds: 3, transferMinSeconds: 0,
  };
  assert.equal(runRaptor(ix, q).rounds[1]![1]!.arrivalEpoch, BASE + 7800);
  assert.equal(runRaptor(ix, { ...q, shift: undefined }).rounds[1]![1]!.arrivalEpoch, BASE + 7800);
});
