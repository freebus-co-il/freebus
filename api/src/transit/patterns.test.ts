import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatterns, type TripTimes } from "./patterns.js";

function trip(stops: number[], departures: number[], arrivals: number[] = departures): TripTimes {
  return {
    stops: Int32Array.from(stops),
    departures: Int32Array.from(departures),
    arrivals: Int32Array.from(arrivals),
  };
}

test("trips with the same stop sequence share one pattern", () => {
  const set = buildPatterns([
    trip([1, 2, 3], [100, 200, 300]),
    trip([1, 2, 3], [400, 500, 600]),
  ]);
  assert.equal(set.nPatterns, 1);
  assert.equal(set.patternOfTrip[0], set.patternOfTrip[1]);
});

test("trips with different stop sequences get different patterns", () => {
  const set = buildPatterns([
    trip([1, 2, 3], [100, 200, 300]),
    trip([1, 2], [100, 200]),
  ]);
  assert.equal(set.nPatterns, 2);
});

test("pattern stops are stored once, in order", () => {
  const set = buildPatterns([trip([7, 8, 9], [1, 2, 3]), trip([7, 8, 9], [4, 5, 6])]);
  const start = set.patternStopOffset[0]!;
  const end = set.patternStopOffset[1]!;
  assert.deepEqual([...set.patternStops.slice(start, end)], [7, 8, 9]);
});

test("a pattern's trips are ordered by departure at the first stop", () => {
  const set = buildPatterns([
    trip([1, 2], [500, 600]),
    trip([1, 2], [100, 200]),
  ]);
  const from = set.patternTripOffset[0]!;
  // Trip index 1 departs at 100 and must come first.
  assert.equal(set.patternTrips[from], 1);
  assert.equal(set.patternTrips[from + 1], 0);
});

// RAPTOR binary-searches a pattern's trips, which is only valid when they are
// totally ordered. Exactly 8 pairs in the real feed overtake; splitting them
// makes the search exact instead of approximately right.
test("an overtaking trip is split into its own pattern", () => {
  const set = buildPatterns([
    // Departs first but arrives last — an express overtaken by a stopper.
    trip([1, 2, 3], [100, 500, 900]),
    trip([1, 2, 3], [200, 300, 400]),
  ]);
  assert.equal(set.nPatterns, 2);
  assert.notEqual(set.patternOfTrip[0], set.patternOfTrip[1]);
});

test("non-overtaking trips are not split", () => {
  const set = buildPatterns([
    trip([1, 2, 3], [100, 200, 300]),
    trip([1, 2, 3], [150, 250, 350]),
    trip([1, 2, 3], [200, 300, 400]),
  ]);
  assert.equal(set.nPatterns, 1);
});

// Critical: two trips can be perfectly ordered by DEPARTURE at every stop —
// no departure-only overtake — while still crossing in ARRIVAL because of a
// dwell-time difference. RAPTOR rides a held trip by reading its arrival at
// each later stop, so a pattern whose arrivals aren't also jointly ordered
// makes that read silently wrong. This is a real repro: trip A departs
// earlier at every stop, but trip B's shorter dwell lets it arrive at stop 1
// (index 1) before A does.
test("trips that cross in arrival despite ordered departures are split", () => {
  const a = trip([0, 1, 2], [1320, 2520, 3000], [1200, 2520, 3000]);
  const b = trip([0, 1, 2], [2160, 2580, 3300], [2100, 2460, 3180]);
  const set = buildPatterns([a, b]);
  assert.equal(set.nPatterns, 2);
  assert.notEqual(set.patternOfTrip[0], set.patternOfTrip[1]);
});

test("an empty input yields an empty pattern set", () => {
  const set = buildPatterns([]);
  assert.equal(set.nPatterns, 0);
  assert.equal(set.patternStopOffset.length, 1);
});

/**
 * Asserts that within every pattern, BOTH departures and arrivals are
 * non-decreasing at EVERY stop position along `patternTrips` order — not
 * just the first stop, and not just departures. This is the actual
 * invariant RAPTOR depends on: it binary-searches on departure to board, but
 * then reads arrival at every later stop while riding the held trip, so an
 * arrival-only crossing is just as fatal as a departure-only one. Sorting
 * only by departure at stop 0 can satisfy the narrower "ordered by first
 * stop" test above while still violating this one whenever first-stop
 * departures tie, or whenever dwell-time differences cross trips in arrival
 * alone.
 */
function assertPatternsTotallyOrdered(trips: readonly TripTimes[], set: ReturnType<typeof buildPatterns>): void {
  for (let p = 0; p < set.nPatterns; p++) {
    const tripFrom = set.patternTripOffset[p]!;
    const tripTo = set.patternTripOffset[p + 1]!;
    const nStops = set.patternStopOffset[p + 1]! - set.patternStopOffset[p]!;
    for (let pos = 0; pos < nStops; pos++) {
      for (let k = tripFrom + 1; k < tripTo; k++) {
        const prevTrip = set.patternTrips[k - 1]!;
        const currTrip = set.patternTrips[k]!;
        const prevDep = trips[prevTrip]!.departures[pos]!;
        const currDep = trips[currTrip]!.departures[pos]!;
        assert.ok(
          prevDep <= currDep,
          `pattern ${p} not totally ordered (departure) at stop position ${pos}: ` +
            `trip ${prevTrip} departs ${prevDep} before trip ${currTrip} at ${currDep} in patternTrips order`,
        );
        const prevArr = trips[prevTrip]!.arrivals[pos]!;
        const currArr = trips[currTrip]!.arrivals[pos]!;
        assert.ok(
          prevArr <= currArr,
          `pattern ${p} not totally ordered (arrival) at stop position ${pos}: ` +
            `trip ${prevTrip} arrives ${prevArr} before trip ${currTrip} at ${currArr} in patternTrips order`,
        );
      }
    }
  }
}

// Counterexample: A and B tie at the first stop, so a departures[0]-only sort
// falls back to insertion order (A, B) — but B dominates A pointwise (ties at
// stop 0, strictly earlier at stop 1), so the correct pattern order is (B, A).
// overtakes(A, B) is legitimately false (no crossing), so they must share one
// pattern; the bug is purely in which order they land in within it.
test("a pattern's trips are ordered consistently at every stop, not just the first", () => {
  const trips = [
    trip([1, 2], [100, 300]), // A: ties with B at stop 0, later at stop 1
    trip([1, 2], [100, 200]), // B: dominates A
  ];
  const set = buildPatterns(trips);
  assert.equal(set.nPatterns, 1); // sanity: they don't overtake, so one pattern
  assertPatternsTotallyOrdered(trips, set);
});

// Deterministic PRNG (mulberry32) so failures are reproducible in CI instead
// of being seed-dependent flakes. Seed and trial count are fixed constants.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Property test: 20,000 trials, seed 20260822 (fixed). Each trial builds a
// batch of trips that all share one stop sequence — some generated with
// deliberate overtakes, some with exact ties across all stops, some with
// partial ties (equal at some stop positions, dominated at others) — and
// checks that every resulting pattern is totally ordered at every stop, in
// BOTH departure and arrival. Each trip carries its own random per-stop
// dwell (arrival vs. departure gap), which is what lets two trips stay
// perfectly ordered by departure while still crossing in arrival — the
// dwell-time defect this generator must be able to produce and the fixed
// `overtakes`/`compareTimes` must therefore handle.
test("property: every pattern is totally ordered at every stop across many random trip sets", () => {
  const rand = mulberry32(20260822);
  const TRIALS = 20000;
  for (let trial = 0; trial < TRIALS; trial++) {
    const nStops = 2 + Math.floor(rand() * 4); // 2..5 stops
    const nTrips = 2 + Math.floor(rand() * 5); // 2..6 trips
    const stops = Array.from({ length: nStops }, (_, i) => i + 1);

    const trips: TripTimes[] = [];
    for (let t = 0; t < nTrips; t++) {
      const departures: number[] = [];
      const arrivals: number[] = [];
      let time = Math.floor(rand() * 5); // small range to force ties/crossings
      for (let s = 0; s < nStops; s++) {
        const arrival = time;
        // Small, often-zero dwell so different trips' dwells frequently
        // differ enough to cross in arrival despite tied/ordered departures.
        const dwell = Math.floor(rand() * 3); // 0..2
        const departure = arrival + dwell;
        arrivals.push(arrival);
        departures.push(departure);
        // Small, possibly-zero increments so trips frequently tie or cross
        // each other, while still being non-decreasing within one trip.
        time = departure + Math.floor(rand() * 4);
      }
      trips.push(trip(stops, departures, arrivals));
    }

    const set = buildPatterns(trips);
    assertPatternsTotallyOrdered(trips, set);
  }
});
