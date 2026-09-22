import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTestIndex } from "./testIndex.js";
import type { DayContext } from "./raptor.js";
import type { TimetableIndex } from "./index.js";
import { Translator } from "../db/i18n.js";
import { transitLegOf, type Itinerary, type Leg, type TransitLeg, type WalkLeg } from "./itinerary.js";
import { annotateAlternatives, type AlternativesOptions } from "./alternatives.js";

const BASE = 1_787_000_000;
const TZ = "Asia/Jerusalem";

function makeTranslator(): Translator {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE translations (trans_id TEXT, lang TEXT, translation TEXT)");
  return Translator.load(db);
}

const ctx = {
  tr: makeTranslator(), lang: "he" as const, tz: TZ,
  routeOf: (routeIdx: number): TransitLeg["route"] =>
    ({ id: `r${routeIdx}`, agencyId: null, shortName: `${routeIdx}`, longName: null, type: 3, color: null }),
};

type TripSpec = { route: number; stops: number[]; dep: number[] };

/** Trips with a route each; arrival equals departure at every stop, as in the real feed. */
function buildIx(nStops: number, trips: TripSpec[]): TimetableIndex {
  const base = makeTestIndex(nStops, trips.map((t) => ({ stops: t.stops, dep: t.dep, arr: t.dep })));
  return {
    ...base,
    stopIds: Array.from({ length: nStops }, (_, s) => `s${s}`),
    stopIdToIdx: new Map(Array.from({ length: nStops }, (_, s) => [`s${s}`, s])),
    stopNames: Array.from({ length: nStops }, (_, s) => `Stop ${s}`),
    stopLat: Float64Array.from({ length: nStops }, (_, s) => 32 + s * 0.01),
    stopLon: Float64Array.from({ length: nStops }, (_, s) => 34.7 + s * 0.01),
    tripIds: trips.map((_, t) => `t${t}`),
    tripIdToIdx: new Map(trips.map((_, t) => [`t${t}`, t])),
    tripHeadsigns: trips.map(() => null),
    tripNumbers: trips.map(() => null),
    tripRouteIdx: Int32Array.from(trips.map((t) => t.route)),
    tripDirection: new Int8Array(trips.length),
  };
}

const days = (ix: TimetableIndex, inactive: number[] = []): DayContext[] => {
  const activeTrip = new Uint8Array(ix.nTrips).fill(1);
  for (const t of inactive) activeTrip[t] = 0;
  return [{ dateYmd: 20260824, baseEpoch: BASE, activeTrip }];
};

/** The ride on trip `t` from its first visit of `from` to its next visit of `to`. */
function ride(ix: TimetableIndex, t: number, from: number, to: number): TransitLeg {
  const p = ix.patternOfTrip[t]!;
  const stops = Array.from(ix.patternStops.subarray(ix.patternStopOffset[p]!, ix.patternStopOffset[p + 1]!));
  const boardPos = stops.indexOf(from);
  const alightPos = stops.indexOf(to, boardPos + 1);
  const times = ix.departureTime.subarray(ix.tripTimeOffset[t]!, ix.tripTimeOffset[t + 1]!);
  return {
    ...transitLegOf(ix, t, boardPos, alightPos, BASE + times[boardPos]!, BASE + times[alightPos]!, ctx),
    alternatives: [],
  };
}

const walk = (seconds: number): WalkLeg => ({
  type: "walk", from: { type: "stop", lat: 0, lon: 0 }, to: { type: "stop", lat: 0, lon: 0 },
  distanceMeters: 0, durationSeconds: seconds, geometry: null, walkEstimated: false,
});

const itinerary = (...legs: Leg[]): Itinerary => ({
  departureTime: "", arrivalTime: "", durationSeconds: 0, transfers: 0,
  walkSeconds: 0, walkMeters: 0, legs, transferAtRisk: null,
});

const options: AlternativesOptions = {
  ...ctx,
  transferMinSeconds: 60,
  laterDepartureSeconds: 1800,
  earlierDepartureSeconds: 1800,
  maxPerLeg: 8,
};

const alternativesOf = (leg: Leg | undefined) => (leg as TransitLeg).alternatives;
const alternativeTrips = (leg: Leg | undefined): string[] => alternativesOf(leg).map((a) => a.tripId);
const verdicts = (leg: Leg | undefined) =>
  alternativesOf(leg).map((a) => [a.tripId, a.missesConnection, a.arrivalDelaySeconds]);

// A rider who sets out before the plan told them to catches the run BEFORE the
// planned one. It has to be offered, or the journey can never be switched onto
// the bus they are actually sitting on.
test("offers the closest earlier run for a rider who set out early", () => {
  const ix = buildIx(3, [
    { route: 0, stops: [0, 1, 2], dep: [600, 700, 800] },    // 20 min early: long gone
    { route: 0, stops: [0, 1, 2], dep: [1500, 1600, 1700] }, // 5 min early: the one caught
    { route: 0, stops: [0, 1, 2], dep: [1800, 1900, 2000] }, // planned
    { route: 0, stops: [0, 1, 2], dep: [2400, 2500, 2600] }, // the next one
  ]);
  const plan = itinerary(ride(ix, 2, 0, 2));
  annotateAlternatives(ix, days(ix), [plan], options);

  // One per route on each side: the closest earlier run, and the next one --
  // the earlier run never costs the rider the late-fallback they had before.
  assert.deepEqual(alternativeTrips(plan.legs[0]), ["t1", "t3"]);
});

test("an earlier run reaches the end of the journey sooner, not later", () => {
  const ix = buildIx(3, [
    { route: 0, stops: [0, 1, 2], dep: [1500, 1600, 1700] },
    { route: 0, stops: [0, 1, 2], dep: [1800, 1900, 2000] },
  ]);
  const plan = itinerary(ride(ix, 1, 0, 2));
  annotateAlternatives(ix, days(ix), [plan], options);

  const [earlier] = alternativesOf(plan.legs[0]);
  assert.equal(earlier?.tripId, "t0");
  assert.equal(earlier?.missesConnection, false);
  // 300 s sooner at the alight stop, which is the end of this one-ride journey.
  assert.equal(earlier?.arrivalDelaySeconds, -300);
});

test("a run further back than the window is not offered", () => {
  const ix = buildIx(3, [
    { route: 0, stops: [0, 1, 2], dep: [0, 100, 200] },      // 60 min early
    { route: 0, stops: [0, 1, 2], dep: [3600, 3700, 3800] }, // planned
  ]);
  const plan = itinerary(ride(ix, 1, 0, 2));
  annotateAlternatives(ix, days(ix), [plan], options);
  assert.deepEqual(alternativeTrips(plan.legs[0]), []);
});

test("offers another line from the same board stop to the same alight stop", () => {
  const ix = buildIx(4, [
    { route: 0, stops: [0, 1, 2], dep: [1000, 1100, 1200] },
    { route: 1, stops: [0, 3, 2], dep: [1060, 1150, 1260] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 2));
  annotateAlternatives(ix, days(ix), [plan], options);

  const [alt] = alternativesOf(plan.legs[0]);
  assert.equal(alt?.tripId, "t1");
  assert.equal(alt?.route.id, "r1");
  assert.equal(alt?.from.stop.stopId, "s0");
  assert.equal(alt?.to.stop.stopId, "s2");
  assert.equal(alt?.numStops, 2);
  assert.deepEqual(alt?.intermediateStops.map((s) => s.stopId), ["s3"]);
  assert.equal(alt?.from.stopSequence, 0);
  assert.equal(alt?.to.stopSequence, 2);
  assert.equal(alt?.missesConnection, false);
  assert.equal(alt?.arrivalDelaySeconds, 60);
  assert.equal("alternatives" in (alt ?? {}), false);
});

test("a line that never reaches the alight stop, or reaches it before boarding, is not an alternative", () => {
  const ix = buildIx(4, [
    { route: 0, stops: [0, 1, 2], dep: [1000, 1100, 1200] },
    { route: 1, stops: [0, 1, 3], dep: [1000, 1100, 1200] },
    { route: 2, stops: [2, 0, 3], dep: [1000, 1100, 1200] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 2));
  annotateAlternatives(ix, days(ix), [plan], options);
  assert.deepEqual(alternativeTrips(plan.legs[0]), []);
});

test("a bus that still makes the planned train costs nothing; one that misses it costs the wait for the next train", () => {
  const ix = buildIx(4, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1100, 1440] }, // 1440 + 300 walk + 60 buffer = 1800: makes it
    { route: 2, stops: [0, 1], dep: [1100, 1441] }, // one second too late
    { route: 3, stops: [2, 3], dep: [1800, 2400] }, // the planned train
    { route: 4, stops: [2, 3], dep: [2700, 3300] }, // the next one
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1), walk(300), ride(ix, 3, 2, 3));
  annotateAlternatives(ix, days(ix), [plan], options);
  assert.deepEqual(verdicts(plan.legs[0]), [["t1", false, 0], ["t2", true, 900]]);
  // On the final ride there is no connection to miss, and the delay is the ride's own.
  assert.deepEqual(verdicts(plan.legs[2]), [["t4", false, 900]]);
});

test("a later bus that gets there sooner has a negative delay", () => {
  const ix = buildIx(2, [
    { route: 0, stops: [0, 1], dep: [1000, 1600] },
    { route: 1, stops: [0, 1], dep: [1100, 1500] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1));
  annotateAlternatives(ix, days(ix), [plan], options);
  assert.deepEqual(verdicts(plan.legs[0]), [["t1", false, -100]]);
});

test("a bus after which no onward ride runs misses the connection with no delay to report", () => {
  const ix = buildIx(3, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1100, 1900] },
    { route: 2, stops: [1, 2], dep: [1300, 1400] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1), ride(ix, 2, 1, 2));
  annotateAlternatives(ix, days(ix), [plan], options);
  assert.deepEqual(verdicts(plan.legs[0]), [["t1", true, null]]);
});

test("when the same stops have no onward trip, the delay comes from a fresh plan from where the bus drops the rider", () => {
  const ix = buildIx(3, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1100, 1900] },
    { route: 2, stops: [1, 2], dep: [1300, 1400] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1), ride(ix, 2, 1, 2));
  const asked: [number, number][] = [];
  annotateAlternatives(ix, days(ix), [plan], {
    ...options,
    replanArrival: (stopIdx, readyEpoch) => { asked.push([stopIdx, readyEpoch - BASE]); return readyEpoch + 500; },
  });
  // Planned: 1400 along the itinerary's own stops. The 1900 bus: re-planned from stop 1 at 1900, arriving 2400.
  assert.deepEqual(verdicts(plan.legs[0]), [["t1", true, 1000]]);
  assert.deepEqual(asked, [[1, 1900]]);
});

// The list has to carry the rider who set out EARLY and is sitting on the run
// before the planned one, not only the rider running late -- the journey has
// to be able to follow them onto it.
test("a bus leaving just before the planned one is offered, alongside the later ones", () => {
  const ix = buildIx(4, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [1, 2], dep: [1400, 1600] },
    { route: 2, stops: [1, 2], dep: [1399, 1500] },
    { route: 3, stops: [1, 2], dep: [1400, 1650] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1), ride(ix, 1, 1, 2));
  annotateAlternatives(ix, days(ix), [plan], options);
  // In departure order: the one a second earlier, then the one alongside it.
  assert.deepEqual(alternativeTrips(plan.legs[1]), ["t2", "t3"]);
});

test("a later bus is offered within the departure window however slow it is", () => {
  const ix = buildIx(2, [
    { route: 0, stops: [0, 1], dep: [5000, 5600] },
    { route: 1, stops: [0, 1], dep: [6800, 7400] }, // leaves 1800 s later
    { route: 2, stops: [0, 1], dep: [6801, 7000] }, // leaves 1801 s later
    { route: 3, stops: [0, 1], dep: [5100, 9000] }, // leaves soon, crawls
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1));
  annotateAlternatives(ix, days(ix), [plan], options);
  assert.deepEqual(verdicts(plan.legs[0]), [["t3", false, 3400], ["t1", false, 1800]]);
});

test("one trip per line on each side -- the last one before the planned ride, and the first one after it", () => {
  const ix = buildIx(2, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 0, stops: [0, 1], dep: [1100, 1300] },
    { route: 0, stops: [0, 1], dep: [1200, 1400] },
    { route: 1, stops: [0, 1], dep: [900, 1100] },
    { route: 1, stops: [0, 1], dep: [1050, 1250] },
    { route: 1, stops: [0, 1], dep: [1150, 1350] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1));
  annotateAlternatives(ix, days(ix), [plan], options);
  // Route 1's t3 (just before) and t4 (just after); route 0's own next, t1.
  // Never t2 or t5 -- the second one along on either line.
  assert.deepEqual(alternativeTrips(plan.legs[0]), ["t3", "t4", "t1"]);
});

test("trips not running that day, or refused by the request's filter, are not offered", () => {
  const ix = buildIx(2, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1000, 1200] },
    { route: 2, stops: [0, 1], dep: [1000, 1200] },
    { route: 3, stops: [0, 1], dep: [1000, 1200] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1));
  annotateAlternatives(ix, days(ix, [1]), [plan], { ...options, tripFilter: (t) => t !== 2 });
  assert.deepEqual(alternativeTrips(plan.legs[0]), ["t3"]);
});

test("onward rides only count trips that run that day", () => {
  const ix = buildIx(3, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1100, 1300] },
    { route: 2, stops: [1, 2], dep: [1400, 1500] }, // the planned onward ride
    { route: 3, stops: [1, 2], dep: [1500, 1600] }, // not running today
    { route: 4, stops: [1, 2], dep: [1600, 1700] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1), ride(ix, 2, 1, 2));
  annotateAlternatives(ix, days(ix, [3]), [plan], options);
  assert.deepEqual(verdicts(plan.legs[0]), [["t1", false, 0]]);
  assert.deepEqual(verdicts(plan.legs[1]), [["t4", false, 200]]);
});

test("alternatives are the soonest ones, in departure order, capped", () => {
  const ix = buildIx(2, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1030, 1230] },
    { route: 2, stops: [0, 1], dep: [1010, 1210] },
    { route: 3, stops: [0, 1], dep: [1020, 1220] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1));
  annotateAlternatives(ix, days(ix), [plan], { ...options, maxPerLeg: 2 });
  assert.deepEqual(alternativeTrips(plan.legs[0]), ["t2", "t3"]);
});

test("a trip from the previous service day is found at its own absolute time", () => {
  const ix = buildIx(2, [
    { route: 0, stops: [0, 1], dep: [1000, 1200] },
    { route: 1, stops: [0, 1], dep: [1000 + 86_400, 1200 + 86_400] },
  ]);
  const plan = itinerary(ride(ix, 0, 0, 1));
  const today = days(ix, [1])[0]!;
  const yesterday: DayContext = { dateYmd: 20260823, baseEpoch: BASE - 86_400, activeTrip: new Uint8Array(2).fill(1) };
  annotateAlternatives(ix, [today, yesterday], [plan], options);
  assert.deepEqual(alternativeTrips(plan.legs[0]), ["t1"]);
  assert.equal(alternativesOf(plan.legs[0])[0]?.from.departureTime, (plan.legs[0] as TransitLeg).from.departureTime);
});
