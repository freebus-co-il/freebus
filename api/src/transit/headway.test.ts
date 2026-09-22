import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHeadwayTable, headwayFor, requiredTransferSeconds, NO_HEADWAY,
} from "./headway.js";
import { makeTestIndex } from "./testIndex.js";
import type { DayContext } from "./raptor.js";

const CFG = { baseSeconds: 60, factor: 0.25, capSeconds: 600 };

test("the rule clamps between the base and the cap", () => {
  assert.equal(requiredTransferSeconds(300, CFG), 75);      // 5 min -> 75 s
  assert.equal(requiredTransferSeconds(360, CFG), 90);      // 6 min -> 90 s
  assert.equal(requiredTransferSeconds(1200, CFG), 300);    // 20 min -> 5 min
  assert.equal(requiredTransferSeconds(3600, CFG), 600);    // 1 h -> capped
  assert.equal(requiredTransferSeconds(60, CFG), 60);       // 1 min -> floored
});

test("factor 0 collapses the rule to today's flat base", () => {
  // The off switch the whole differential guarantee rests on.
  for (const h of [0, 60, 600, 3600, NO_HEADWAY]) {
    assert.equal(requiredTransferSeconds(h, { ...CFG, factor: 0 }), 60);
  }
});

test("an unmeasurable headway takes the cap, not the base", () => {
  // One departure in an hour IS the expensive case, not a cheap one.
  assert.equal(requiredTransferSeconds(NO_HEADWAY, CFG), 600);
});

/** A trip on a 2-stop route departing at `dep`, arriving 300 s later. */
function trip(dep: number, stops: [number, number] = [0, 1]) {
  return { stops, dep: [dep, dep + 300], arr: [dep + 150, dep + 450] };
}

function allActive(nTrips: number): DayContext {
  return { dateYmd: 20260101, baseEpoch: 0, activeTrip: new Uint8Array(nTrips).fill(1) };
}

test("two active trips an hour apart give a one-hour headway", () => {
  // A gap is attributed to the hour of the EARLIER departure, so
  // two trips exactly one hour apart -- one in hour 8, the next in hour 9 --
  // give hour 8 a measured headway of exactly 3600 s.
  const dep1 = 8 * 3600; // 08:00:00
  const dep2 = dep1 + 3600; // 09:00:00
  const ix = makeTestIndex(2, [trip(dep1), trip(dep2)]);
  const day = allActive(2);

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, dep1), 3600);
});

test("an exactly-hourly service reports 3600 in every hour it runs", () => {
  // The case the same-bucket-only reading of the rule got wrong: a service
  // running exactly once an hour has one departure per bucket, never two,
  // so it must still report a measurable 3600 s headway in every hour it
  // operates in (all but the last, which has no successor).
  const deps = [5 * 3600, 6 * 3600, 7 * 3600, 8 * 3600];
  const ix = makeTestIndex(2, deps.map((d) => trip(d)));
  const day = allActive(deps.length);

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, 5 * 3600), 3600);
  assert.equal(headwayFor(table, 0, 6 * 3600), 3600);
  assert.equal(headwayFor(table, 0, 7 * 3600), 3600);
});

test("the last trip of the day contributes no gap", () => {
  // Three trips, exactly hourly, ending at hour 7: hour 7 has a departure
  // but no successor, so it must stay unmeasurable and take the cap --
  // nobody should later "fix" it into looking as frequent as hours 5 and 6.
  const ix = makeTestIndex(2, [trip(5 * 3600), trip(6 * 3600), trip(7 * 3600)]);
  const day = allActive(3);

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, 7 * 3600), NO_HEADWAY);
  assert.equal(requiredTransferSeconds(headwayFor(table, 0, 7 * 3600), CFG), CFG.capSeconds);
});

test("only trips active on the day are counted", () => {
  // Same two active trips as the hour-apart test above, plus a third trip
  // strictly between them, timewise, that does NOT run on this service day.
  // If it were counted it would shrink the measured gap -- this is the
  // whole point of only counting departures active on the day.
  const dep1 = 8 * 3600;
  const dep2 = dep1 + 3600;
  const depInactive = dep1 + 1800; // strictly between dep1 and dep2
  const ix = makeTestIndex(2, [trip(dep1), trip(depInactive), trip(dep2)]);
  const day: DayContext = {
    dateYmd: 20260101, baseEpoch: 0, activeTrip: Uint8Array.from([1, 0, 1]),
  };

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, dep1), 3600);
});

test("one large gap cannot drag the median down", () => {
  // Four departures, all in hour 8, with gaps (in departure order) of
  // 1700, 900, 300. The values are deliberately ordered so that neither
  // the first gap computed (1700) nor the last (300) nor the mean (967)
  // happens to coincide with the true median (900) -- only an actual
  // median calculation lands on 900. This is the median rule's own
  // guarantee: one large gap must not drag an otherwise-frequent hour
  // toward looking sparse.
  const deps = [8 * 3600, 8 * 3600 + 1700, 8 * 3600 + 2600, 8 * 3600 + 2900];
  const ix = makeTestIndex(2, deps.map((d) => trip(d)));
  const day = allActive(deps.length);

  const table = buildHeadwayTable(ix, day);
  const result = headwayFor(table, 0, deps[0]!);
  assert.equal(result, 900);
  assert.notEqual(result, 1700, "must not just be the first gap computed");
  assert.notEqual(result, 300, "must not just be the last gap computed");
  const naiveMean = Math.round((1700 + 900 + 300) / 3);
  assert.notEqual(result, naiveMean, "a mean would report 967, not the true median 900");
});

test("an even number of gaps in one hour averages the two middle values", () => {
  // Three departures in hour 9 -- 09:00, 09:10, 09:15 -- give exactly two
  // gaps: 600 and 300. The even-length branch of median() must average
  // them (450), not just pick one: not the first computed (600), not the
  // last (300).
  const h9 = 9 * 3600;
  const deps = [h9, h9 + 600, h9 + 900];
  const ix = makeTestIndex(2, deps.map((d) => trip(d)));
  const day = allActive(deps.length);

  const table = buildHeadwayTable(ix, day);
  const result = headwayFor(table, 0, h9);
  assert.equal(result, 450);
  assert.notEqual(result, 600, "must not just be the first gap computed");
  assert.notEqual(result, 300, "must not just be the last gap computed");
});

test("an hour with a single active departure has no measurable gap", () => {
  const ix = makeTestIndex(2, [trip(8 * 3600)]);
  const day = allActive(1);

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, 8 * 3600), NO_HEADWAY);
  assert.equal(requiredTransferSeconds(headwayFor(table, 0, 8 * 3600), CFG), CFG.capSeconds);
});

test("an hour past the end of service has no measurable gap", () => {
  // Both trips depart in hour 3 (gap 1800, attributed to hour 3); hour 4,
  // immediately adjacent with no departures of its own, must still report
  // NO_HEADWAY rather than leaking hour 3's neighbouring value -- a
  // disconnected, far-away empty hour would pass this even with a loop-
  // bounds bug, since it would never be touched either way.
  const dep1 = 3 * 3600;
  const dep2 = dep1 + 1800; // still hour 3
  const ix = makeTestIndex(2, [trip(dep1), trip(dep2)]);
  const day = allActive(2);

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, dep1), 1800); // sanity: hour 3 IS measured
  assert.equal(headwayFor(table, 0, 4 * 3600), NO_HEADWAY); // hour 4, right after, is not
});

test("a departure past 86400 lands in its own hour, not a wrapped one", () => {
  // Two separate patterns (distinct stop sequences, so distinct rows in the
  // flat table): pattern 0 runs only in hour 25 (91800 = 25:30:00 into the
  // service day), pattern 1 only in hour 1, with a deliberately different
  // gap. A 24-hour table indexed by hour 25 -- whether via a wrong `HOURS`
  // stride or via wrapping the time itself -- would corrupt pattern 1's
  // real hour-1 row with pattern 0's hour-25 data, silently reading a
  // different pattern's row. Asserting both values survive, distinct and
  // correct, catches that class of bug.
  const hour25a = 91800; // hour 25
  const hour25b = hour25a + 500; // gap 500
  const hour1a = 3700; // hour 1
  const hour1b = hour1a + 900; // gap 900
  const ix = makeTestIndex(4, [
    trip(hour25a, [0, 1]), trip(hour25b, [0, 1]),
    trip(hour1a, [2, 3]), trip(hour1b, [2, 3]),
  ]);
  const day = allActive(4);

  const table = buildHeadwayTable(ix, day);
  assert.equal(headwayFor(table, 0, hour25a), 500);
  assert.equal(headwayFor(table, 1, hour1a), 900);
});

test("a gap too large for a 16-bit table is stored whole, not wrapped", () => {
  // A `Uint16Array` table wrapped every gap above 65535 s, and the rule
  // inverted exactly where it matters most: the LARGER the true gap, the
  // SMALLER the wrapped value could be, so the most expensive miss in the
  // feed -- a pattern whose only two departures are ~18 hours apart -- was
  // handed a small buffer instead of the cap. A gap of exactly 65536 s
  // wrapped to 0, i.e. no margin at all.
  //
  // These are real shapes for this feed, whose maximum departure is 105787.
  for (const [first, second] of [
    [0, 65536],       // wrapped to 0: the rule fully inverted
    [18000, 84600],   // 05:00 and 23:30, gap 66600: wrapped to 1064
    [0, 105787],      // the feed's widest possible span
  ] as const) {
    const ix = makeTestIndex(2, [trip(first), trip(second)]);
    const table = buildHeadwayTable(ix, allActive(2));
    const gap = second - first;
    assert.equal(
      headwayFor(table, 0, first), gap,
      `gap of ${gap} s must round-trip through the table intact`,
    );
    // ...and therefore take the cap, which is the whole point of measuring it.
    assert.equal(requiredTransferSeconds(headwayFor(table, 0, first), CFG), 600);
  }
});

test("the no-measurement sentinel is not a gap any feed can produce", () => {
  // `NO_HEADWAY` means "no gap was attributed to this hour". If it were a
  // reachable gap value, a real service would be silently reported as
  // unmeasurable -- harmless today, since both take the cap, but only by
  // luck.
  //
  // Note the bound being asserted. Only the EARLIER departure of a pair has
  // to fall inside `[0, HOURS)` for its gap to be recorded, so a gap itself
  // is not bounded by `HOURS * 3600`. A gap is bounded by the
  // largest departure a GTFS feed can express, and `Uint32Array`'s sentinel
  // is roughly 136 YEARS of seconds -- four orders of magnitude clear of
  // anything a service day can produce, which is why the value is safe
  // whatever the exact bound turns out to be.
  assert.ok(
    NO_HEADWAY > 100 * 24 * 3600,
    "sentinel must be unreachable by any gap between two GTFS departures",
  );
});

test("an inverted clamp returns BELOW the base -- the sharp edge three guards exist for", () => {
  // The clamp applies the cap LAST, so a ceiling below the floor wins. This
  // is the one input that makes this function return a buffer smaller than
  // today's flat rule, which would make boarding EASIER and break the
  // dominance argument `raptor.ts` terminates on. It is pinned here as a
  // FACT about this function, not a wish: `config.ts` refuses the setting at
  // boot, `runRaptor` refuses the cfg at the query boundary, and
  // `extraBoardingSeconds` floors the result at zero -- three guards, because
  // this function will not defend itself.
  // 120 IS below `baseSeconds` (600), which is the whole claim -- asserting
  // the exact value says it more precisely than a second `< baseSeconds`
  // check restating it would.
  const inverted = { baseSeconds: 600, factor: 0.25, capSeconds: 120 };
  assert.equal(requiredTransferSeconds(360, inverted), 120);
});

// ------------------------------------------------------------ boarding hour
// The hour a gap is TABULATED in and the hour a rider is looked up in are
// different questions once the rider boards downstream of the pattern's first
// stop, and every fixture above uses the 2-stop `trip()` helper looked up at
// `deps[0]` -- so none of them could tell the two apart. That is the exact
// gap that hid a real defect: 14.8% of this feed's active (trip, position)
// departures were charged the wrong hour's margin, 5.0% of them too little.

/** A 3-stop trip: departs `dep`, then `dep + 2400`, then `dep + 4800`. */
function longTrip(dep: number) {
  return {
    stops: [0, 1, 2],
    dep: [dep, dep + 2400, dep + 4800],
    arr: [dep, dep + 2400, dep + 4800],
  };
}

test("a boarding downstream of an hour boundary is charged its OWN hour, not the first stop's", () => {
  // Two trips leaving stop 0 at 03:00:00 and 03:10:00 -- a 600 s gap, wholly
  // inside hour 3. At stop 1 they pass at 03:40:00 and 03:50:00, still hour
  // 3. At stop 2 they pass at 04:20:00 and 04:30:00, which is hour 4 -- and
  // hour 4 has no gap of its own, because nothing else runs.
  //
  // A rider boarding at stop 2 is therefore boarding in an hour this pattern
  // does not measure, and the rule says an unmeasured hour takes the CAP.
  // Reading the table at the raw boarding instant gets that right only if
  // the instant is first shifted back to first-stop time; reading it at the
  // rider's own clock against a table keyed on the first stop is what
  // charged the wrong hour.
  const trips = [longTrip(10_800), longTrip(11_400)];
  const ix = makeTestIndex(3, trips);
  const table = buildHeadwayTable(ix, allActive(trips.length));

  // The table itself is keyed in FIRST-STOP time and knows only hour 3.
  assert.equal(headwayFor(table, 0, 3 * 3600), 600);
  assert.equal(headwayFor(table, 0, 4 * 3600), NO_HEADWAY);

  // `patternTravelSeconds` is what carries a boarding position back to that
  // key: 0 s at stop 0, 2400 s at stop 1, 4800 s at stop 2.
  assert.deepEqual([...ix.patternTravelSeconds], [0, 2400, 4800]);

  // Boarding the 04:20:00 departure at stop 2: raw 15600 s is hour 4, and
  // shifting back by 4800 gives 10800 -- hour 3, where the gap lives.
  const boarding = 15_600;
  const shifted = boarding - ix.patternTravelSeconds[ix.patternStopOffset[0]! + 2]!;
  assert.equal(Math.floor(boarding / 3600), 4, "the rider's own hour");
  assert.equal(Math.floor(shifted / 3600), 3, "the hour the table is keyed on");
  assert.equal(headwayFor(table, 0, shifted), 600);

  // And that is the whole difference in margin: 600 s of headway asks for
  // 150 s, while treating the boarding hour as unmeasured asks for the full
  // 600 s cap. Four times the buffer, from one bucket.
  assert.equal(requiredTransferSeconds(headwayFor(table, 0, shifted), CFG), 150);
  assert.equal(requiredTransferSeconds(headwayFor(table, 0, boarding), CFG), 600);
});

test("the shift is a property of the pattern, not of the boarded trip", () => {
  // Both trips of the pattern have the same shape here, so the offset is
  // unambiguous -- but the array is built from the pattern's FIRST trip, and
  // that is what a pattern whose trips run at different speeds gets too.
  // Pinned so the residual approximation this offset makes is a stated
  // fact rather than an accident: a second, slower trip does not move the
  // offsets.
  const trips = [
    { stops: [0, 1], dep: [3600, 4200], arr: [3600, 4200] },      // 600 s
    { stops: [0, 1], dep: [7200, 9000], arr: [7200, 9000] },      // 1800 s
  ];
  const ix = makeTestIndex(2, trips);
  assert.deepEqual([...ix.patternTravelSeconds], [0, 600], "the first trip's offsets");
});
