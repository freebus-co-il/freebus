import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeStore } from "./store.js";
import type { ResolvedJourney, UnscheduledRun } from "./match.js";
import type { RealtimeJourney } from "./types.js";

/** A minimal RealtimeJourney -- only its presence matters to these tests,
 * never its fields, since `store.ts` treats it as an opaque payload. */
const STUB_JOURNEY: RealtimeJourney = {
  lineRef: "1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
  originAimedDeparture: null, operatorRef: null, publishedLineName: null,
  vehicleRef: null, confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
};

/** `ambiguous` defaults to `false` -- the common, non-loop case every test
 * in this file except the dedicated ambiguity tests exercises. */
function resolvedJourney(
  tripIdx: number, byStopIdx: [number, number, boolean?][],
): ResolvedJourney {
  return {
    tripIdx, journey: STUB_JOURNEY,
    byStopIdx: new Map(byStopIdx.map(([stopIdx, expectedArrival, ambiguous]) =>
      [stopIdx, { expectedArrival, ambiguous: ambiguous ?? false }])),
  };
}

// ---------------------------------------------------------------------
// predictionFor (departures board) vs.
// unambiguousPredictionFor (/plan) must genuinely differ on an ambiguous
// (loop-repeated) stop, and agree everywhere else.
// ---------------------------------------------------------------------

test("unambiguousPredictionFor returns null for an ambiguous stop; predictionFor still answers it", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const rj = resolvedJourney(5, [[2, 1_500, true]]); // ambiguous: true
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  assert.equal(
    store.predictionFor(5, 2), 1_500,
    "the departures board keeps its own soonest-visit behaviour, unaffected by ambiguity",
  );
  assert.equal(
    store.unambiguousPredictionFor(5, 2), null,
    "/plan must not attach a prediction it cannot attribute to one specific visit",
  );
});

test("unambiguousPredictionFor matches predictionFor for a stop visited only once", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const rj = resolvedJourney(5, [[2, 1_500, false]]); // ambiguous: false
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  assert.equal(store.predictionFor(5, 2), 1_500);
  assert.equal(store.unambiguousPredictionFor(5, 2), 1_500);
});

test("unambiguousPredictionFor is null for every reason predictionFor is null (no data, stale)", () => {
  let now = 1_000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  assert.equal(store.unambiguousPredictionFor(5, 2), null, "no snapshot at all");

  const rj = resolvedJourney(5, [[2, 1_500, false]]);
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);
  now = 1_000 + 181; // past maxAgeSeconds (180)
  assert.equal(store.unambiguousPredictionFor(5, 2), null, "stale");
});

test("a fresh snapshot answers predictions", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const rj = resolvedJourney(5, [[2, 1_500], [3, 1_600]]);
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  assert.equal(store.predictionFor(5, 2), 1_500);
  assert.equal(store.predictionFor(5, 3), 1_600);
  // A stop this trip never called at.
  assert.equal(store.predictionFor(5, 99), null);
  // A trip never resolved into this snapshot at all.
  assert.equal(store.predictionFor(6, 2), null);
  assert.deepEqual(store.journeyFor(5), rj);
  assert.equal(store.journeyFor(6), null);
});

test("a snapshot older than maxAge reports stale and answers null", () => {
  // Stale predictions are worse than none: a rider trusts them.
  let now = 1_000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const rj = resolvedJourney(5, [[2, 1_500]]);
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  // Still within maxAge (180s).
  now = 1_000 + 180;
  assert.equal(store.predictionFor(5, 2), 1_500);
  assert.equal(store.status(now).health, "ok");

  // One second past maxAge.
  now = 1_000 + 181;
  assert.equal(store.predictionFor(5, 2), null);
  assert.equal(store.journeyFor(5), null);
  const status = store.status(now);
  assert.equal(status.health, "stale");
  assert.equal(status.ageSeconds, 181);
  // The last snapshot's counts are still reported alongside "stale" -- an
  // operator diagnosing a stuck poller wants to see what it last had, not a
  // count reset to zero indistinguishable from "never received anything".
  assert.equal(status.resolved, 1);
});

test("an empty store reports disabled and answers null", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  assert.equal(store.predictionFor(0, 0), null);
  assert.equal(store.journeyFor(0), null);
  assert.deepEqual(store.status(1_000), {
    source: "siri-sm", health: "disabled", ageSeconds: null, journeys: 0, resolved: 0, unresolved: 0,
    resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

test("replace() is a full replacement of the previous snapshot, not a merge", () => {
  // A trip present only in the first snapshot must vanish the instant the
  // second replace() call returns -- an implementation that merged new
  // entries into the existing maps instead of building a fresh one would
  // leave trip 1's leftovers sitting alongside trip 2's data forever.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  store.replace([resolvedJourney(1, [[10, 1_100]])], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);
  assert.notEqual(store.journeyFor(1), null);

  store.replace([resolvedJourney(2, [[20, 1_200]])], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);
  assert.equal(store.journeyFor(1), null, "trip 1 must not survive as a leftover");
  assert.notEqual(store.journeyFor(2), null);
  assert.equal(store.predictionFor(1, 10), null);
  assert.equal(store.predictionFor(2, 20), 1_200);
});

test("replace() swaps atomically -- a throw mid-build leaves the old snapshot whole", () => {
  // The property "full replacement" above does not by itself prove: JS is
  // single-threaded, so there is no way to literally catch a reader
  // mid-replace(). What IS observable is the case that would break first
  // if replace() ever stopped building the new snapshot fully off to the
  // side before touching `this.snapshot` -- a build that fails partway
  // through must leave the OLD snapshot completely untouched, not an empty
  // store, not a store holding half of the new data.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  store.replace([resolvedJourney(1, [[10, 1_100]])], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  // A ResolvedJourney whose byStopIdx throws partway through iteration --
  // not something a real caller constructs, but exactly the shape of
  // failure "atomic" has to survive (a corrupt entry, a future bug in
  // match.ts, anything that can make the build loop itself throw).
  const poisoned: ResolvedJourney = {
    tripIdx: 2,
    journey: STUB_JOURNEY,
    byStopIdx: {
      [Symbol.iterator]() {
        let n = 0;
        return { next: () => {
          n++;
          if (n === 1) {
            return { done: false, value: [20, { expectedArrival: 999, ambiguous: false }] };
          }
          throw new Error("boom mid-iteration");
        } };
      },
    } as unknown as Map<number, { expectedArrival: number; ambiguous: boolean }>,
  };

  assert.throws(
    () => store.replace([poisoned], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 2_000),
    /boom mid-iteration/,
  );
  // The old snapshot must be EXACTLY what it was before the failed call --
  // not empty, not a mix of trip 1's old data and whatever partial state
  // replace() built before it threw.
  assert.notEqual(store.journeyFor(1), null, "trip 1 must still be there");
  assert.equal(store.predictionFor(1, 10), 1_100, "trip 1's own data must be unchanged");
  assert.equal(store.journeyFor(2), null, "the poisoned trip must not have partially landed");
});

test("status() reports the resolution rate", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 500);
  store.replace(
    [resolvedJourney(1, []), resolvedJourney(2, [])],
    { resolved: 2, unresolved: 5, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0 },
    500,
  );
  assert.deepEqual(store.status(500), {
    source: "siri-sm", health: "ok", ageSeconds: 0, journeys: 7, resolved: 2, unresolved: 5,
    resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

// clear() is a full reset, distinct from
// ordinary staleness -- it zeroes counts rather than preserving them,
// because a snapshot resolved against a SUPERSEDED index describes trips
// that may not even be the ones its own counts now imply. See clear()'s
// own doc comment for why this deliberately disagrees with status()'s
// stale-but-counted behaviour.
test("clear() resets the store to the never-received-anything state, unlike ordinary staleness", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  store.replace([resolvedJourney(5, [[2, 1_500]])], { resolved: 3, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0 }, 1_000);
  assert.equal(store.predictionFor(5, 2), 1_500);
  assert.equal(store.status(1_000).health, "ok");

  store.clear();

  assert.equal(store.predictionFor(5, 2), null);
  assert.equal(store.journeyFor(5), null);
  assert.deepEqual(store.status(1_000), {
    source: "siri-sm", health: "disabled", ageSeconds: null, journeys: 0, resolved: 0, unresolved: 0,
    resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });
});

test("clear() does not prevent a later replace() from working normally", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  store.replace([resolvedJourney(1, [[1, 100]])], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);
  store.clear();
  store.replace([resolvedJourney(2, [[2, 200]])], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);
  assert.equal(store.predictionFor(2, 2), 200);
  assert.equal(store.status(1_000).health, "ok");
});

test("a store reports its source even with no snapshot at all", () => {
  // An operator looking at a silent process needs to know which feed it
  // WOULD read -- "disabled" alone cannot distinguish "no source configured"
  // from "configured, nothing received yet".
  const store = new RealtimeStore("stride-vm", 180, () => 1000);
  assert.equal(store.status(1000).source, "stride-vm");
  assert.equal(store.status(1000).health, "disabled");
  assert.equal(store.feedSource, "stride-vm");
});

test("the source survives clear() — it is a property of the process, not the snapshot", () => {
  const store = new RealtimeStore("stride-vm", 180, () => 1000);
  store.replace([], { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1000);
  store.clear();
  assert.equal(store.status(1000).source, "stride-vm");
});

// ---------------------------------------------------------------------
// Anchoring a position-derived prediction on NOW (fix 2, 2026-09-13).
//
// A prediction derived from a position assumes the bus kept pace with the
// timetable from the moment it was seen. When it did not -- stuck at a
// light, the next report not yet in -- that ETA slides into the past while
// the bus is still coming, and the departures board drops it: seen live,
// a line 5 bus vanished 450 m before the stop and arrived 2.5 min later.
// The store resolves this at READ time because only the reader knows now.
//
// Only for a report that was fresh when fetched. An old report's elapsed
// time is lag, not a bus standing still: anchoring Stride's 13-23 minute-old
// positions pushed the 2026-09-10 replay from 118 s to 334 s at 2-5 min out.
// ---------------------------------------------------------------------

const STATS = { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 };

/** A journey reported at `recordedAt`, predicting stop `stopIdx`. */
function anchoredJourney(
  tripIdx: number, stopIdx: number, expectedArrival: number,
  anchorAt: number | undefined, recordedAt: number | null,
): ResolvedJourney {
  return {
    tripIdx, journey: { ...STUB_JOURNEY, recordedAt },
    byStopIdx: new Map([[stopIdx, { expectedArrival, ambiguous: false, anchorAt }]]),
  };
}

test("a fresh report's ETA gains half the time since the bus was placed", () => {
  let now = 1_000;
  const store = new RealtimeStore("open-bus-vm", 180, () => now);
  store.replace([anchoredJourney(5, 2, 1_500, 1_000, 1_000)], STATS, 1_000);

  assert.equal(store.predictionFor(5, 2), 1_500, "no time has passed, so nothing to add");
  now = 1_100;
  // 100 s since the bus was placed: half of it is assumed lost.
  assert.equal(store.predictionFor(5, 2), 1_550);
  assert.equal(store.unambiguousPredictionFor(5, 2), 1_550, "/plan reads the same anchored value");
});

test("a fresh report never answers an ETA at or before now for a bus not yet past the stop", () => {
  let now = 1_000;
  const store = new RealtimeStore("open-bus-vm", 180, () => now);
  // Due at 1,050 when seen at 1,000; at 1,160 the half-share only reaches
  // 1,130, which would already be in the past.
  store.replace([anchoredJourney(5, 2, 1_050, 1_000, 1_000)], STATS, 1_000);
  now = 1_160;
  const eta = store.predictionFor(5, 2)!;
  assert.ok(eta > now, `ETA ${eta} must be after now ${now}`);
  assert.equal(eta, 1_161);
});

test("an anchored ETA is whole seconds, so the wire format keeps no milliseconds", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000.4);
  store.replace([anchoredJourney(5, 2, 1_500, 999, 999)], STATS, 1_000);
  // 1,500 + 0.5 x 1.4 = 1,500.7.
  assert.equal(store.predictionFor(5, 2), 1_501);
});

test("nothing is added before the anchor, such as a bus waiting at its origin", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  // Reported at 950, not due to leave until 1,200.
  store.replace([anchoredJourney(5, 2, 1_600, 1_200, 950)], STATS, 1_000);
  assert.equal(store.predictionFor(5, 2), 1_600);
});

test("a report already five minutes old when fetched is not anchored: no drift and no floor", () => {
  // 2026-09-13 18:47Z: all of Egged's reports ran ~21 min late. A bus that
  // old may well have passed the stop, so it gets the plain estimate -- and
  // is allowed to fall off the board -- rather than being pinned at "now".
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_500);
  store.replace([anchoredJourney(5, 2, 1_450, 1_000, 1_000)], STATS, 1_400);
  assert.equal(store.predictionFor(5, 2), 1_450);
});

test("the rule is the report's age, not the feed: Stride's lagged reports are left alone", () => {
  const store = new RealtimeStore("stride-vm", 180, () => 2_100);
  // Fetched at 2,000, reported at 1,000: Stride's weekday ETL lag.
  store.replace([anchoredJourney(5, 2, 2_050, 1_000, 1_000)], STATS, 2_000);
  assert.equal(store.predictionFor(5, 2), 2_050);
});

test("...and a fresh Stride report, as on a quiet holiday night, is anchored like any other", () => {
  const store = new RealtimeStore("stride-vm", 180, () => 1_100);
  store.replace([anchoredJourney(5, 2, 1_500, 1_000, 1_000)], STATS, 1_050);
  assert.equal(store.predictionFor(5, 2), 1_550);
});

test("a report with no RecordedAtTime is never anchored -- its freshness is unknown", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_100);
  store.replace([anchoredJourney(5, 2, 1_050, 1_000, null)], STATS, 1_000);
  assert.equal(store.predictionFor(5, 2), 1_050);
});

test("an operator ETA is never anchored", () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_100);
  store.replace([anchoredJourney(5, 2, 1_050, undefined, 1_000)], STATS, 1_000);
  assert.equal(store.predictionFor(5, 2), 1_050);
});

// ---------------------------------------------------------------------
// Unscheduled runs: found by stop and by route, never by trip.
// ---------------------------------------------------------------------

function unscheduledRun(over: Partial<UnscheduledRun> & { byStop?: [number, number][] } = {}): UnscheduledRun {
  const { byStop = [[2, 1_500]], ...rest } = over;
  return {
    templateTripIdx: 5, offsetSeconds: -300, serviceBaseEpoch: 0,
    journey: { ...STUB_JOURNEY, lineRef: "R1", vehicleRef: "extra" },
    byStopIdx: new Map(byStop.map(([stopIdx, expectedArrival]) => [stopIdx, { expectedArrival, ambiguous: false, anchorAt: 900 }])),
    ...rest,
  };
}

const RUN_STATS = { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 1 };

test("an unscheduled run is invisible to every per-trip read", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  store.replace([], RUN_STATS, 1_000, [unscheduledRun()]);
  assert.equal(store.journeyFor(5), null);
  assert.equal(store.predictionFor(5, 2), null);
  assert.equal(store.unambiguousPredictionFor(5, 2), null);
});

test("an unscheduled run is found by the stops it predicts, with its arrival", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  const run = unscheduledRun({ byStop: [[2, 1_500], [3, 1_600]] });
  store.replace([], RUN_STATS, 1_000, [run]);
  // No report time on STUB_JOURNEY, so nothing is anchored.
  assert.deepEqual(store.unscheduledAtStop(3).map((e) => [e.run.journey.vehicleRef, e.arrival]), [["extra", 1_600]]);
  assert.deepEqual(store.unscheduledAtStop(9), []);
});

test("an unscheduled run's arrival is anchored like any fresh report", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_100);
  const run = unscheduledRun({ journey: { ...STUB_JOURNEY, lineRef: "R1", vehicleRef: "extra", recordedAt: 900 } });
  // Report 100 s old at fetch: anchored on 900, read at 1,100 -> +100.
  store.replace([], RUN_STATS, 1_000, [run]);
  assert.equal(store.unscheduledAtStop(2)[0]!.arrival, 1_600);
});

test("unscheduledOnRoute lists a route's runs that still have a stop ahead", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  store.replace([], RUN_STATS, 1_000, [
    unscheduledRun(),
    unscheduledRun({ journey: { ...STUB_JOURNEY, lineRef: "R2", vehicleRef: "other-route" } }),
    unscheduledRun({ journey: { ...STUB_JOURNEY, lineRef: "R1", vehicleRef: "finished" }, byStop: [] }),
  ]);
  assert.deepEqual(store.unscheduledOnRoute("R1").map((r) => r.journey.vehicleRef), ["extra"]);
});

// A run with a prediction is not necessarily a run
// still AHEAD of now. A report older than ANCHOR_MAX_REPORT_AGE_SECONDS (300 s)
// carries no anchor floor (see `arrivalOf`), so every one of its
// `expectedArrival`s can already be behind the store's clock while the bus
// itself is still fresh enough for `maxVehicleAgeSeconds` -- a run that has
// plainly finished must not still top `/routes/:id/trips`.
test("unscheduledOnRoute drops a run whose every prediction has already passed", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  // recordedAt 400 s before fetchedAt (1_000): past the 300 s anchor floor,
  // so its expectedArrival (500, already behind the 1_000 clock) is used
  // exactly as stored -- no anchor pushes it into the future.
  const finished = unscheduledRun({
    journey: { ...STUB_JOURNEY, lineRef: "R1", vehicleRef: "finished", recordedAt: 600 },
    byStop: [[2, 500]],
  });
  store.replace([], RUN_STATS, 1_000, [finished]);
  assert.deepEqual(store.unscheduledOnRoute("R1"), [], "no stored prediction is still ahead of now");

  // Same stale-report shape, but one of its two predictions is still ahead
  // (1_500 > 1_000): the run belongs on the board.
  const stillGoing = unscheduledRun({
    journey: { ...STUB_JOURNEY, lineRef: "R1", vehicleRef: "still-going", recordedAt: 600 },
    byStop: [[2, 500], [3, 1_500]],
  });
  store.replace([], RUN_STATS, 1_000, [stillGoing]);
  assert.deepEqual(
    store.unscheduledOnRoute("R1").map((r) => r.journey.vehicleRef), ["still-going"],
    "one predicted stop still ahead is enough",
  );
});

test("unscheduled runs go with their snapshot: stale, cleared, replaced", () => {
  let now = 1_000;
  const store = new RealtimeStore("open-bus-vm", 180, () => now);
  store.replace([], RUN_STATS, 1_000, [unscheduledRun()]);
  now = 1_181;
  assert.deepEqual(store.unscheduledAtStop(2), [], "stale");
  now = 1_000;
  store.clear();
  assert.deepEqual(store.unscheduledOnRoute("R1"), [], "cleared");
  store.replace([], RUN_STATS, 1_000);
  assert.deepEqual(store.unscheduledAtStop(2), [], "a later snapshot without runs has none");
});

test("status() reports how many buses were matched by slot and how many are unscheduled", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  store.replace([], { resolved: 4, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 2, unscheduled: 1 }, 1_000);
  const status = store.status(1_000);
  assert.equal(status.attached, 2);
  assert.equal(status.unscheduled, 1);
});

// --------- -----------------------------------------------------------------
// journeys() -- every resolved journey, never an unscheduled run, staleness aware.
// --------- -----------------------------------------------------------------

test("journeys() lists every resolved journey in a fresh snapshot", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  const rj1 = resolvedJourney(5, [[2, 1_500]]);
  const rj2 = resolvedJourney(7, [[3, 1_600]]);
  store.replace([rj1, rj2], { resolved: 2, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0 }, 1_000);
  const results = Array.from(store.journeys());
  assert.deepEqual(results.map((j) => j.tripIdx), [5, 7]);
});

test("journeys() never includes an unscheduled run, even when runs are present", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  const rj = resolvedJourney(5, [[2, 1_500]]);
  const run = unscheduledRun();
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 1 }, 1_000, [run]);
  const results = Array.from(store.journeys());
  assert.deepEqual(results.map((j) => j.tripIdx), [5]);
  assert.equal(results.length, 1, "only the resolved journey, no unscheduled run");
});

test("journeys() yields nothing when the snapshot is stale", () => {
  let now = 1_000;
  const store = new RealtimeStore("open-bus-vm", 180, () => now);
  const rj = resolvedJourney(5, [[2, 1_500]]);
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0 }, 1_000);
  assert.equal(Array.from(store.journeys()).length, 1, "fresh snapshot has 1 journey");

  now = 1_000 + 181; // past maxAgeSeconds (180)
  assert.deepEqual(Array.from(store.journeys()), [], "stale snapshot yields nothing");
});

test("journeys() yields nothing after clear()", () => {
  const store = new RealtimeStore("open-bus-vm", 180, () => 1_000);
  const rj = resolvedJourney(5, [[2, 1_500]]);
  store.replace([rj], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0 }, 1_000);
  assert.equal(Array.from(store.journeys()).length, 1);

  store.clear();
  assert.deepEqual(Array.from(store.journeys()), []);
});
