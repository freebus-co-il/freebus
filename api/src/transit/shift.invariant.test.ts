import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTestIndex } from "./testIndex.js";
import { buildShift, type DelayJourney } from "./shift.js";
import type { TimetableIndex } from "./index.js";
import type { DayContext } from "./raptor.js";

/**
 * The invariant every other file in this directory depends on, restated here
 * as an executable claim about the SHIFTED view:
 *
 *   within one pattern, trip k's departures AND arrivals are each pointwise
 *   <= trip k+1's, at every position.
 *
 * `raptor.ts`'s `earliestTripOnDay` binary-searches on that order and then
 * rides the trip it picked, reading that trip's arrival at every later stop.
 * Four critical defects in this codebase have come from breaking it, every one
 * found by a differential test rather than a hand-written one -- which is why
 * this file is randomised rather than a list of cases someone thought of.
 *
 * This test is not expected to catch a bug in `buildShift`. It exists to
 * falsify the design's central argument if that argument is wrong: that a
 * UNIFORM per-trip shift preserves pointwise domination, so re-sorting is
 * enough and no pattern ever has to split. If this fails, the design is
 * wrong, not the code.
 */
function assertOrdered(ix: TimetableIndex, patternTrips: Int32Array, delay: Int32Array): void {
  const nPatterns = ix.patternTripOffset.length - 1;
  for (let p = 0; p < nPatterns; p++) {
    const from = ix.patternTripOffset[p]!;
    const to = ix.patternTripOffset[p + 1]!;
    const nStops = ix.patternStopOffset[p + 1]! - ix.patternStopOffset[p]!;
    for (let j = from + 1; j < to; j++) {
      const a = patternTrips[j - 1]!;
      const b = patternTrips[j]!;
      const offA = ix.tripTimeOffset[a]!;
      const offB = ix.tripTimeOffset[b]!;
      for (let i = 0; i < nStops; i++) {
        const depA = ix.departureTime[offA + i]! + delay[a]!;
        const depB = ix.departureTime[offB + i]! + delay[b]!;
        assert.ok(
          depA <= depB,
          `pattern ${p} position ${i}: trip ${a} departs ${depA} after trip ${b}'s ${depB}`,
        );
        const arrA = ix.arrivalTime[offA + i]! + delay[a]!;
        const arrB = ix.arrivalTime[offB + i]! + delay[b]!;
        assert.ok(
          arrA <= arrB,
          `pattern ${p} position ${i}: trip ${a} arrives ${arrA} after trip ${b}'s ${arrB}`,
        );
      }
    }
  }
}

/** Deterministic PRNG, so a failure is reproducible from the seed alone. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test("a uniform shift never breaks the pattern ordering, over 200 random timetables", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = rng(seed);
    const nStops = 3 + Math.floor(rnd() * 6);
    const stops = Array.from({ length: nStops }, (_, i) => i);

    // Several trips over one stop sequence, each with its OWN running times --
    // that difference is exactly what a non-uniform delay would turn into a
    // crossing, so the generator must produce it for this test to mean
    // anything.
    const nTrips = 2 + Math.floor(rnd() * 8);
    const trips: { stops: number[]; dep: number[]; arr: number[] }[] = [];
    let start = Math.floor(rnd() * 600);
    for (let t = 0; t < nTrips; t++) {
      const dep: number[] = [];
      const arr: number[] = [];
      let at = start;
      for (let i = 0; i < nStops; i++) {
        arr.push(at);
        at += Math.floor(rnd() * 60);          // dwell
        dep.push(at);
        at += 60 + Math.floor(rnd() * 300);    // run to the next stop
      }
      trips.push({ stops, dep, arr });
      start += 120 + Math.floor(rnd() * 900);  // headway
    }

    const ix = makeTestIndex(nStops, trips);
    const day: DayContext = {
      dateYmd: 20260918, baseEpoch: 0, activeTrip: new Uint8Array(nTrips).fill(1),
    };

    // Delay a random subset, by up to 30 minutes -- comfortably more than the
    // headways above, so trips really do get reordered past one another.
    const journeys: DelayJourney[] = [];
    for (let t = 0; t < nTrips; t++) {
      if (rnd() < 0.5) continue;
      const late = Math.floor(rnd() * 1800);
      journeys.push({
        tripIdx: t,
        byStopIdx: new Map([[0, { expectedArrival: trips[t]!.arr[0]! + late }]]),
      });
    }

    const shift = buildShift(ix, journeys, day);
    if (shift === null) continue;
    assertOrdered(ix, shift.patternTrips, shift.delay);
  }
});

test("the base timetable is already ordered, so the assertion means something", () => {
  // Guards the guard: if `assertOrdered` were vacuous (say it looped zero
  // times), the test above would pass on anything. This pins it to a case with
  // a known-good answer AND a known-bad one.
  const ix = makeTestIndex(2, [
    { stops: [0, 1], dep: [1000, 1600], arr: [1000, 1600] },
    { stops: [0, 1], dep: [1600, 2200], arr: [1600, 2200] },
  ]);
  const zero = new Int32Array(2);
  assertOrdered(ix, ix.patternTrips, zero);

  // Delaying trip 0 past trip 1 WITHOUT re-sorting must be caught.
  const bad = new Int32Array(2);
  bad[0] = 1200;
  assert.throws(() => assertOrdered(ix, ix.patternTrips, bad), /departs .* after/);
});
