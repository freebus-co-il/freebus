import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex, attachFootpaths } from "../transit/index.js";
import { buildFootpaths } from "../transit/footpaths.js";
import { RequestDrain } from "../requestDrain.js";
import { buildServer } from "../server.js";
import { parsePlace } from "./plan.js";
import { RealtimeStore } from "../realtime/store.js";
import type { ResolvedJourney } from "../realtime/match.js";
import type { RealtimeJourney } from "../realtime/types.js";
import { walkConfig } from "../config.js";

/**
 * Footpath radius deliberately kept BELOW the 695 m straight-line gap between
 * fixture stops 1000 and 2000. At the default 1000 m radius those two stops
 * would get a direct footpath edge baked into the index regardless of any
 * calendar/service check, which
 * would silently turn the "unreachable" test below into a false pass (a
 * walk-only itinerary would exist even on a day with zero active trips). 400 m
 * keeps that pair unconnected while still exercising the same straight-line
 * fallback path (client.ping() returns false, so no Valhalla container is
 * required).
 */
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * Realtime annotation coverage: the shared fixture, wired with an explicit
 * `realtime` dependency (or `null`, the default/disabled state) --
 * no footpaths needed, since every test using this serves `stop:` to
 * `stop:` queries with no coordinate access/egress walk to route.
 */
async function serveWithRealtime(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-rt-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * Extends the shared fixture with a THIRD stop (5000) and a THIRD route
 * (R103, trip T4), which departs stop 2000 -- the same stop T1 (R1) alights
 * at -- at 08:15:00, five minutes after T1's scheduled 08:10:00 arrival:
 * 240 s of slack above the fixture's 60 s `transferMinSeconds` buffer. This
 * is a REAL cross-route transfer for `computeTransferAtRisk` to evaluate.
 *
 * Deliberately a same-stop transfer: `raptor.ts`'s main loop boards a
 * different pattern at the same stop index directly (`ready =
 * label.arrivalEpoch + transferMinSeconds`, no footpath involved -- see its
 * own comment), so this chain has NO walk leg between the two transit legs.
 * That is the "0 s of walk" case `computeTransferAtRisk` must also get
 * right, not just the walk-in-between case.
 *
 * T4E is a SECOND, earlier R103 trip (08:09:00 -> 08:19:00), needed once the
 * headway-scaled margin reads real trip data: with only T4 on this
 * pattern, R103 would report `NO_HEADWAY` for every hour (a single trip
 * produces no gap to measure -- see `headway.ts`'s `buildHeadwayTable`),
 * which charges the FULL `TRANSFER_MAX_SECONDS` cap (600 s by default) on
 * top of `transferMinSeconds` -- more than the 300 s this fixture actually
 * offers between T1's arrival and T4's departure, which would make the
 * T1->T4 connection unreachable and every test below moot. T4E departs
 * BEFORE T1 even reaches stop 2000 (08:09:00 < T1's 08:10:00 arrival), so it
 * is never itself boardable from this itinerary -- its only role is to give
 * R103's pattern a measurable 360 s headway in hour 8 (`08:15:00 - 08:09:00`),
 * which `requiredTransferSeconds` scales by the default 0.25 factor to a
 * 90 s required margin: still comfortably inside the 300 s this fixture
 * offers (so the connection remains reachable), and still well above the
 * flat 60 s floor (so a test asserting the headway-scaled value is actually
 * used, not silently still the flat one, has something to distinguish).
 */
async function serveWithTransfer(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-transfer-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
    INSERT INTO trips VALUES (5,'T4E','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,29340,29340,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,29940,29940,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * Coverage for a two-TRANSFER itinerary (three transit legs), so
 * `computeTransferAtRisk` can be exercised with one
 * transfer CONFIRMED fine and the other genuinely UNKNOWN in the same
 * response -- the case that proves the two don't collapse into each other.
 * Extends `serveWithTransfer`'s fixture with a fourth stop (6000) and a
 * fourth route (R104, trip T5), departing stop 5000 -- where T4 (R103) already
 * lands -- at 08:35:00, ten minutes after T4's 08:25:00 arrival: comfortable
 * slack, uninteresting on its own, so a store that simply never resolves T4
 * is what actually leaves this second transfer's status unknown.
 *
 * T4E: see `serveWithTransfer`'s own doc comment -- same fix, same reason
 * (without it, R103 reports `NO_HEADWAY` and the 300 s T1->T4 transfer is
 * charged the full 600 s cap, which this fixture does not offer). R104 (T5)
 * is left as a genuine single-trip, `NO_HEADWAY` pattern: the 600 s gap
 * T4->T5 already offers happens to equal `TRANSFER_MAX_SECONDS`'s default
 * exactly, so the cap this pattern is charged is still satisfied (`ready <=
 * currentDep` at equality) without needing a second R104 trip too.
 */
async function serveWithTwoTransfers(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-transfer2-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי','67004-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'6000','38836','תחנה רביעית',NULL,32.0680,34.7650,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO trips VALUES (5,'T5','R104','S1','תחנה רביעית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
    INSERT INTO stop_times VALUES (5,5,1,30900,30900,0,1,0);
    INSERT INTO stop_times VALUES (5,6,2,31500,31500,1,0,900);
    INSERT INTO trips VALUES (6,'T4E','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,2,1,29340,29340,0,1,0);
    INSERT INTO stop_times VALUES (6,5,2,29940,29940,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * `serve()`'s shared fixture has no same-arrival departure tie, so it cannot
 * distinguish "re-anchor only" from "re-anchor
 * then reoptimise" -- every existing endpoint test would pass identically
 * with `reoptimiseItinerary` deleted from `plan.ts` entirely. This variant
 * inserts one extra trip, TX, directly into the fixture db (NOT into the
 * shared `testing/fixture.ts` -- adding a same-arrival, later-departing
 * alternative to T1 there would change which trip every other `serve()`
 * test observes, since reoptimisation would then always prefer TX over T1).
 *
 * TX shares T1's stops (1000 -> 2000) and arrival (08:10), departing 5
 * minutes later (08:05 instead of T1's 08:00) -- same pattern as T1 (both
 * trips are jointly non-decreasing in departure AND arrival, so
 * `buildPatterns` keeps them in one pattern; see `overtakes` in
 * `patterns.ts`), so the reverse pass's binary search can find TX as a
 * later-departure, same-arrival, same-transfer-count alternative to T1.
 *
 * TX also carries its own shape, SHX -- three points, deliberately distinct
 * from T1's two-point SH1 -- so a leg's resolved geometry can be checked
 * against the trip it actually belongs to. That is what makes the
 * geometry-resolution ORDERING bug (resolving before reoptimisation swaps
 * T1 out for TX) observable at the HTTP layer: with the bug, either the
 * final leg's geometry is never populated at all (resolved on a T1
 * itinerary object that reoptimisation then discards), or, if the two
 * trips' shapes were identical, undetectable.
 */
async function serveWithExpressTrip() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-express-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO trips VALUES (4,'TX','R1','S1','הרצל',0,'SHX',1);
    INSERT INTO stop_times VALUES (4,1,1,29100,29100,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29400,29400,1,0,696);
    INSERT INTO shapes VALUES ('SHX','oeoc|@_uxiaAoaDnzD_|B~{B',3,696.0);
  `);
  raw.close();

  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/** A server whose walking router reports a fixed real distance for every
 *  candidate, so a test can push candidates over or under the cap. */
async function serveWithWalk(distanceMeters: number, durationSeconds: number) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-walk-"));
  const link = buildFixtureDb(dir);
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain,
    buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();
  const app = await buildServer({
    index, drain,
    valhalla: {
      route: async () => ({ distanceMeters, durationSeconds, geometry: null, estimated: true }),
      // Every test using this fixture queries `to=stop:2000`. Stop 2000 is
      // ALSO within access-walk range of the coordinate origins these tests
      // use, so if its own access-refinement cost were the SAME uniform
      // value as stop 1000's (the candidate these tests actually mean to
      // exercise), a walk straight to the destination would exist alongside
      // the T1 ride -- and, added with effort ranking, `hasTransitLeg` now
      // drops every walk-only itinerary outright. Worse than just losing that
      // one candidate: RAPTOR's own improvement pruning discards a LATER
      // label at a stop once an earlier one is already recorded there, so a
      // fast uniform walk-only label reaching stop 2000 in round 0 would
      // suppress the T1 label in round 1 from ever being recorded at all --
      // these tests would then have NOTHING left to assert on. Reporting
      // stop 2000's own walk as real but absurdly slow keeps it a genuine,
      // honestly-refined candidate (so the fallback-trigger and
      // honest-distance assertions below still cover it too) while keeping
      // both its arrival (forward) and its departure (reverse) worse than
      // the T1 ride's, so the transit itinerary survives to be asserted on.
      //
      // The literal below is stop 2000's own `stop_lat`/`stop_lon`, copied
      // from `testing/fixture.ts:64` -- there is no lookup, so if that row's
      // coordinates ever move, this branch silently goes dead and tests
      // 1/4 above revert to exercising the walk-only leak instead of the
      // fallback/refinement logic they are named for.
      matrix: async (_s: unknown[], t: unknown[]) =>
        [(t as [number, number][]).map(([lat, lon]) =>
          Math.abs(lat - 32.06) < 1e-6 && Math.abs(lon - 34.775) < 1e-6
            ? { distanceMeters: 26_000, durationSeconds: 20_000 }
            : { distanceMeters, durationSeconds })],
    } as never,
  });
  return { app, index };
}

/**
 * A server whose fixture adds six extra stops strung out east of a query
 * point Q=(32.2000, 34.9000), all far (17.7-19.6 km) from every base-fixture
 * stop so those never compete for the nearest-stop fallback's own top-5:
 *
 *   Q --300m--> stopA(5000) --100m--> filler1(6000) --100m--> filler2(7000)
 *     --100m--> filler3(8000) --100m--> stopB(9000) --100m--> stopC(10000)
 *
 * stopA is the single crow-flight-nearest candidate, but TA (its only trip)
 * departs 08:20:00 and the caller's Valhalla stub reports a 1,500 s (25 min)
 * REAL walk to it -- arriving there at 08:25:00, after TA has already left.
 * stopB sits fifth-nearest by crow-flight, but its own trip TB departs the
 * same 08:20:00 and the stub reports only a 120 s real walk, so it is
 * boardable. filler1-3 carry no trip at all -- pure crow-flight distractors,
 * present only so stopB sits at position five, not two, pinning the
 * fallback's N at "several", not just "more than one". stopC's own trip TC
 * would be strictly the fastest of the three (departs 08:00:00, a 5-minute
 * ride) if it were ever considered, but it is the SIXTH-nearest stop and so
 * must never appear in the candidate set at all -- proving the fallback
 * takes a bounded N, not every reachable stop.
 *
 * The footpath radius is set far below every custom stop's ~100 m spacing
 * (10 m, not the usual 400) so no footpath edge forms between any pair of
 * them: at the ordinary 400 m radius stopA and stopB (399.6 m apart) would
 * be directly footpath-connected, and filler3/stopC (199.8 m apart) too --
 * either would let a rider reach a stop this test means to exclude from the
 * candidate set via a transfer, instead of via the fallback's own selection,
 * defeating the very thing being pinned.
 */
async function serveWithNearestFallback() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-nearest-fallback-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R105','2','5','חמישי','r5',3,NULL);
    INSERT INTO routes VALUES ('R106','2','6','שישי','r6',3,NULL);
    INSERT INTO routes VALUES ('R107','2','7','שביעי','r7',3,NULL);

    INSERT INTO stops VALUES (5,'5000',NULL,'א',NULL,32.2000,34.903185,0,NULL,'z2');
    INSERT INTO stops VALUES (6,'6000',NULL,'ב',NULL,32.2000,34.904246,0,NULL,'z2');
    INSERT INTO stops VALUES (7,'7000',NULL,'ג',NULL,32.2000,34.905308,0,NULL,'z2');
    INSERT INTO stops VALUES (8,'8000',NULL,'ד',NULL,32.2000,34.906370,0,NULL,'z2');
    INSERT INTO stops VALUES (9,'9000',NULL,'ה',NULL,32.2000,34.907431,0,NULL,'z2');
    INSERT INTO stops VALUES (10,'10000',NULL,'ו',NULL,32.2000,34.908493,0,NULL,'z2');

    -- TA: stopA(5000) 08:20:00 -> stop1000 08:30:00. Crow-flight nearest,
    -- but the walking stub makes it unboardable (see doc comment above).
    INSERT INTO trips VALUES (4,'TA','R105','S1','TA',0,NULL,0);
    INSERT INTO stop_times VALUES (4,5,1,30000,30000,0,1,0);
    INSERT INTO stop_times VALUES (4,1,2,30600,30600,1,0,600);

    -- TB: stopB(9000) 08:20:00 -> stop1000 08:25:00. Fifth-nearest by crow
    -- flight, but genuinely closest on foot -- must be the one actually used.
    INSERT INTO trips VALUES (5,'TB','R106','S1','TB',0,NULL,0);
    INSERT INTO stop_times VALUES (5,9,1,30000,30000,0,1,0);
    INSERT INTO stop_times VALUES (5,1,2,30300,30300,1,0,300);

    -- TC: stopC(10000) 08:00:00 -> stop1000 08:05:00. Objectively the
    -- fastest of the three, but sixth-nearest -- must never be offered.
    INSERT INTO trips VALUES (6,'TC','R107','S1','TC',0,NULL,0);
    INSERT INTO stop_times VALUES (6,10,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (6,1,2,29100,29100,1,0,300);
  `);
  raw.close();

  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain, buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 10, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();

  // Real walking costs, keyed by the ORDER `nearestStops` (routes/plan.ts)
  // hands its candidates to `refineAccessByWalking` -- ascending crow-flight
  // distance from Q. filler1-3's own costs are never read by anything (they
  // carry no trip), so any finite value does for them.
  //
  // Carries a SIXTH entry, for stopC, even though only the first five
  // should ever be requested -- and its own doc comment says stopC "must
  // never appear in the candidate set at all". Without it, an off-by-one
  // mutation of `NEAREST_STOP_FALLBACK_COUNT` (5 -> 6) would go undetected
  // by this test: `t.map((_, i) => costs[i])` below would read `costs[5]`
  // as `undefined` for a 6-candidate call, which `refineAccessByWalking`
  // treats exactly like Valhalla reporting "no pedestrian path" and drops --
  // so `accessStops` would still land on 5 after refinement, passing the
  // assertion below for the wrong reason (a cost-lookup miss, not the N=5
  // cap) and hiding a real regression. Giving stopC a valid cost here closes
  // that gap: a 6-candidate call surfaces as `accessStops === 6`, an actual
  // assertion failure -- confirmed by mutation-testing
  // `NEAREST_STOP_FALLBACK_COUNT` to 6.
  const costs = [
    { distanceMeters: 2000, durationSeconds: 1500 }, // stopA: bad real walk
    { distanceMeters: 80, durationSeconds: 60 },      // filler1
    { distanceMeters: 80, durationSeconds: 60 },      // filler2
    { distanceMeters: 80, durationSeconds: 60 },      // filler3
    { distanceMeters: 150, durationSeconds: 120 },    // stopB: good real walk
    { distanceMeters: 170, durationSeconds: 130 },    // stopC: must never be requested
  ];
  const app = await buildServer({
    index, drain,
    valhalla: {
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      // NOT wrapped in an assert: `refineAccessByWalking` catches a throwing
      // `matrix` call and silently degrades (`refined: false`), which would
      // swallow a mismatch here instead of surfacing it -- the test's own
      // assertions on the response (which stop was used, `accessStops`'s
      // count) are what actually pin the candidate set, below.
      matrix: async (_s: unknown[], t: unknown[]) => [t.map((_, i) => costs[i])],
    } as never,
  });
  return { app, index };
}

/**
 * The design's reference query, in miniature: one journey that arrives sooner
 * but walks most of the way, and one that departs later, arrives later, and
 * walks 30 seconds.
 *
 * Both alighting stops are NEW, and both sit far from the origin on purpose.
 * Reusing the shared fixture's stop 2000 for journey A would be STRUCTURALLY
 * IMPOSSIBLE: stop 2000 is 695 m from the origin, so walking to it takes
 * 523 s while the ride there takes 600 s plus any wait. A walk-only path
 * through it would therefore dominate every transit
 * journey, `paretoRounds` emitted only that, and A never existed as a
 * candidate at all. The rule the fixture now respects: an alighting stop that
 * a rider could simply WALK to cannot anchor a journey meant to be found by
 * an earliest-arrival search.
 *
 * The arithmetic, at the code's real `WALK_DETOUR_FACTOR` of 1.35
 * (`walking/valhalla.ts`) over straight-line distance at 1.33 m/s -- tests run
 * with the degraded Valhalla client, so every access/egress estimate carries
 * that factor:
 *
 *   A (walk-heavy): T4 departs 1000 at 08:00, reaches 7000 at 08:10, then a
 *                   901 m egress walk (914 s) -> arrives 08:25:14.
 *                   duration 1514 s, walk 914 s (60.4% share), cost 2428.
 *   B (low-walk):   T5 departs 1000 at 08:20, reaches 6000 at 08:29, then a
 *                   29 m egress walk (30 s) -> arrives 08:29:30.
 *                   duration 570 s, walk 30 s (5.2% share), cost 599.
 *
 * A arrives FOUR MINUTES EARLIER, and both are round-1 journeys, so
 * `paretoRounds` emits A and only A -- B is dominated on arrival and cannot be
 * found by the forward search at any ranking. That is the defect this
 * fixture demonstrates in isolation; the reverse probe (see
 * `serveEffortBeyondWindow` below) is what produces B, and effort ranking
 * then puts B first.
 *
 * A's 60.4% walk share is under the 0.7 cap, so A is never filtered out,
 * which lets the reverse-probe test below assert an ORDER rather than an
 * absence.
 *
 * Distances verified rather than eyeballed. Within the 1000 m access/egress
 * radius: DEST reaches only stops 6000 (29 m) and 7000 (901 m); ORIGIN reaches
 * only stops 1000 (0 m) and 2000 (695 m). Those two sets do not overlap, so no
 * walk-only ORIGIN->DEST path exists. Boarding at 2000 leads only to stop 4000
 * (25:30 service), which is 2631 m from DEST -- out of egress range -- so stop
 * 2000 contributes no journey at all.
 */
async function serveEffort() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-effort-"));
  const link = buildFixtureDb(dir);
  const db = new Database(link);
  db.exec(`
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי','67004-1-#',3,NULL);
    INSERT INTO routes VALUES ('R105','2','5','קו חמישי','67005-1-#',3,NULL);

    -- 6000 is 29 m from DEST; 7000 is 901 m from it. Both ~3 km from ORIGIN,
    -- so neither is walkable from the origin and neither can be short-circuited.
    INSERT INTO stops VALUES (5,'6000','38835','עמק',NULL,32.0902,34.7752,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'7000','38836','רחוק',NULL,32.0819,34.7750,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref IN (5,6);
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref IN (5,6);

    -- A: departs 1000 at 08:00 (28800), reaches 7000 at 08:10 (29400).
    INSERT INTO trips VALUES (4,'T4','R104','S1','רחוק',0,NULL,1);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    -- Final stop: pickup_type=1, nothing can board at 7000.
    INSERT INTO stop_times VALUES (4,6,2,29400,29400,1,0,4200);

    -- B: departs 1000 at 08:20 (30000), reaches 6000 at 08:29 (30540).
    INSERT INTO trips VALUES (5,'T5','R105','S1','עמק',0,NULL,1);
    INSERT INTO stop_times VALUES (5,1,1,30000,30000,0,1,0);
    -- Final stop: pickup_type=1, nothing can board at 6000. The walk-only
    -- test below depends on that.
    INSERT INTO stop_times VALUES (5,5,2,30540,30540,1,0,4800);
  `);
  db.close();

  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * `serveEffort`, with journey B moved BEYOND the departure window --
 * the case that proves the window exemption is load-bearing at the route
 * level rather than only in `rank.test.ts`'s arithmetic.
 *
 * `serveEffort` cannot show this: its B departs 08:20, twenty minutes after
 * A's 08:00, comfortably inside the 1800 s window, so an unexempted window
 * would order it correctly anyway. `serveEffort`'s own reference query does
 * not show it either -- there the walk-share cap DELETES the 85%-walking forward answer,
 * which moves the anchor onto the probe's own departure and rescues the
 * ordering by accident. Neither rescue is available when the walk-heavy
 * forward answer sits UNDER the cap, which is exactly this fixture: A's walk
 * share is 60.4%, so A survives, anchors the window at 08:00, and the cutoff
 * lands at 08:30.
 *
 * Everything is `serveEffort`'s arithmetic except T5's times:
 *
 *   A (walk-heavy): T4 departs 1000 at 08:00, reaches 7000 at 08:10, then a
 *                   901 m egress walk (914 s) -> arrives 08:25:14.
 *                   duration 1514 s, walk 914 s (60.4% share), cost 2428.
 *   B (low-walk):   T5 departs 1000 at 08:40 (31200), reaches 6000 at 08:49
 *                   (31740), then a 29 m egress walk (30 s) -> arrives
 *                   08:49:30. duration 570 s, walk 30 s, cost 599.
 *
 * B is still generated: the probe's deadline is A's arrival + 1800 s =
 * 08:55:14, and B arrives 08:49:30, inside it. But B departs 08:40, TEN
 * MINUTES past the 08:30 ranking cutoff -- so without the exemption the
 * 4x-cheaper journey is ranked second, which is the defect.
 */
async function serveEffortBeyondWindow() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-effort-late-"));
  const link = buildFixtureDb(dir);
  const db = new Database(link);
  db.exec(`
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי','67004-1-#',3,NULL);
    INSERT INTO routes VALUES ('R105','2','5','קו חמישי','67005-1-#',3,NULL);

    INSERT INTO stops VALUES (5,'6000','38835','עמק',NULL,32.0902,34.7752,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'7000','38836','רחוק',NULL,32.0819,34.7750,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref IN (5,6);
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref IN (5,6);

    -- A: departs 1000 at 08:00 (28800), reaches 7000 at 08:10 (29400).
    INSERT INTO trips VALUES (4,'T4','R104','S1','רחוק',0,NULL,1);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (4,6,2,29400,29400,1,0,4200);

    -- B: departs 1000 at 08:40 (31200), reaches 6000 at 08:49 (31740).
    -- The ONLY difference from serveEffort: 40 minutes past A rather than
    -- 20, i.e. past the 1800 s window rather than inside it.
    INSERT INTO trips VALUES (5,'T5','R105','S1','עמק',0,NULL,1);
    INSERT INTO stop_times VALUES (5,1,1,31200,31200,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,31740,31740,1,0,4800);
  `);
  db.close();

  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * Demonstrates one of the two mechanisms behind the measured real-feed
 * defect (a Pardes Hanna query: one bus itinerary at `maxWalkMeters`
 * 800/1000, zero at 1200/2500 -- widening the walk radius deletes the bus),
 * in miniature -- NOT a full reproduction of that query, and deliberately
 * routed AROUND the query's other mechanism (see the T1 note at the bottom).
 * This query's ORIGIN (`32.0554,34.7800`, stop 1000 exactly) is close enough
 * to stop 2000 for a direct walk to reach it, and RAPTOR's own per-stop
 * `best[]` array keeps only the earliest arrival at a stop -- so once a walk
 * beats a ride to a given stop, that stop's transit-boarded label is
 * discarded FOREVER, at every round. That is `raptor.ts`'s own pruning, not
 * `paretoRounds`, and no predicate passed to `paretoRounds` can rescue a
 * label that was never written. So the transit journey THIS fixture proves
 * must arrive through a THIRD stop, `8000` ("קצה"), chosen to be walkable
 * from DEST but NOT from ORIGIN -- nothing can ever prune its transit label
 * with a faster walk, because no walk to it exists. That isolates the OTHER
 * mechanism: `paretoRounds` itself picking the walk-only label over the
 * genuine transit one within a single round.
 *
 * All distances haversine, at this file's `serve()` footpath radius (400 m,
 * still below the 1000 m default `maxWalkMeters` used for access/egress):
 *
 * | pair               | metres | in 1000 m radius? |
 * | ------------------- | -----: | ------------------ |
 * | ORIGIN -> DEST       |   1269 | no -- no direct walk |
 * | ORIGIN -> stop 2000  |    695 | yes -- access + round-0 walk |
 * | ORIGIN -> stop 8000  |   1667 | no -- so 8000's transit label survives |
 * | DEST -> stop 2000    |    667 | yes -- round 0's egress |
 * | DEST -> stop 8000    |    455 | yes -- the transit journey's egress |
 * | DEST -> stop 3000    |   1482 | no |
 *
 * The race, both legs measured from `DEPART` (`07:55:00`):
 *
 * - Walk-only, via stop 2000: ORIGIN->2000 (706 s) then 2000->DEST (677 s)
 *   -- arrives 08:18:03. This label already exists at round 0 (zero
 *   boardings) and is carried forward, unchanged, into round 1 and every
 *   round after -- RAPTOR's `best[]` never regresses.
 * - Transit, via stop 8000: T7 departs stop 1000 at 08:00, reaches 8000 at
 *   08:15, then walks 8000->DEST (461 s) -- arrives 08:22:41 (round 1).
 *   Duration 1361 s, of which 461 s (34%) is walking -- comfortably inside
 *   the 0.7 `maxWalkShare` cap.
 *
 * `paretoRounds` (pre-`accept`) computes ONE pick per round: the minimum
 * arrival across ALL of `target.stops` combined, not per stop. At round 1,
 * BOTH labels above are live candidates in that same arg-min -- and
 * 08:18:03 < 08:22:41, so the still-present walk-only label at stop 2000
 * wins the round's pick, not T7's genuinely-boarded label at stop 8000.
 * Nothing about round 0 "suppresses" round 1 here: round 1 IS emitted, its
 * pick is simply the wrong one of two live candidates, and `hasTransitLeg`
 * then drops that walk-only survivor, leaving the response empty for a
 * query with a working bus. `accept` closes this by rejecting the walk-only
 * label from ever winning the arg-min in the first place, at any round, so
 * T7's label wins instead.
 *
 * (T1, the fixture's original stop-1000-to-2000 trip, is irrelevant here --
 * its own arrival at stop 2000 is pruned by `raptor.ts`'s per-stop `best[]`
 * before `paretoRounds` ever runs, which is why this fixture routes its
 * transit journey through 8000 instead: that is the OTHER mechanism, not
 * the one this fixture exists to isolate.)
 */
async function serveWalkDominance() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-walk-dominance-"));
  const link = buildFixtureDb(dir);
  const db = new Database(link);
  db.exec(`
    INSERT INTO routes VALUES ('R106','2','6','קו שישי','67006-1-#',3,NULL);
    -- 8000: 455 m from DEST, but 1667 m from ORIGIN -- OUT of the 1000 m
    -- access radius, so no walk label can ever reach it and prune the
    -- transit label. That is the whole point of this fixture.
    INSERT INTO stops VALUES (5,'8000','38837','קצה',NULL,32.0700,34.7760,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref = 5;
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref = 5;

    -- T7: departs 1000 at 08:00 (28800), reaches 8000 at 08:15 (29700).
    INSERT INTO trips VALUES (4,'T7','R106','S1','קצה',0,NULL,1);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    -- Final stop: pickup_type=1, nothing can board at 8000.
    INSERT INTO stop_times VALUES (4,5,2,29700,29700,1,0,3000);
  `);
  db.close();

  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

// Stop 1000 exactly.
const ORIGIN = "32.0554,34.7800";
// 29 m from stop 6000, 901 m from stop 7000, and >2.6 km from every other stop.
const DEST = "32.0900,34.7750";
// A weekday inside the fixture's S1 calendar window (20260821-20260920).
const DEPART = "2026-08-24T07:55:00+03:00";

// 433 m and 373 m from stop 6000, whose only trip (T5) has pickup_type=1 there
// -- nothing can ever be BOARDED at 6000, so the only thing connecting this
// pair is a walk. Every other stop is out of range (nearest is 7000 at 1350 m
// and 1291 m), so no transit itinerary exists between them at all and the
// expected response is empty.
const WALK_FROM = "32.0940,34.7762";
const WALK_TO = "32.0935,34.7745";

// The measured Ayalon case: 958 m straight-line, 3,690 m on foot. Under a
// 1,000 m cap that stop does not qualify for the ORDINARY access set -- but
// this is exactly the case the nearest-stop fallback exists for: every
// coordinate-side candidate empties out of `refineAccessByWalking` (not the
// earlier haversine prefilter this time -- see the Negev test below for
// that path), so the fallback re-routes the nearest stops with the cap
// lifted and the SAME stub still reports 3,690 m / 2,775 s for them. Must
// fail if the fallback is reverted: without it this is the old 422.
//
// `distanceMeters` is deliberately NOT asserted against the stub's 3,690 m
// here: that field is sourced from a plain haversine estimate in `walkLeg`
// (routes/plan.ts), only overwritten later by the SEPARATE `resolveWalkGeometry`
// `/route` call when it resolves with real (non-estimated) geometry -- see
// that function's own doc comment. `serveWithWalk`'s `route` stub always
// reports `estimated: true`, so it never overwrites here, and this test's
// origin coordinate is exactly stop 1000's own location, making the
// haversine estimate 0. That is pre-existing, unrelated plumbing; the
// dedicated "honest distance" test below drives a stub where `route` also
// resolves for real, to check that path instead.
//
// Order changed with effort ranking, and further than just order: the
// fallback still finds and honestly reports this walk (2,775 s against T1's
// 600 s ride), but that is an 82% walk share -- over the 0.7 maxWalkShare
// backstop -- so the itinerary the fallback assembles is now correctly
// dropped rather than surfaced as the query's only answer. What this test
// can still pin is the part effort ranking did NOT change: the fallback
// still avoids a 422.
test("a candidate whose real walk exceeds the cap triggers the nearest-stop fallback instead of a 422", async () => {
  const { app, index } = await serveWithWalk(3690, 2775);
  try {
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7800&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.deepEqual(body.itineraries, []);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

test("a candidate within the cap is used, with the real walking time", async () => {
  const { app, index } = await serveWithWalk(120, 90);
  try {
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7800&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: { legs: {
      type: string; durationSeconds: number }[] }[] }).itineraries[0]!;
    const walk = it.legs.find((l) => l.type === "walk")!;
    // 90 s from the stub, not the 1.33 m/s estimate the prefilter produced.
    assert.equal(walk.durationSeconds, 90);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// A stop: endpoint has no walk to route. Refining it would waste a call and
// could drop the query's only candidate.
test("a stop: endpoint is unaffected by walk refinement", async () => {
  let matrixCalls = 0;
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-stoponly-"));
  const link = buildFixtureDb(dir);
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain, buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();
  const app = await buildServer({
    index, drain,
    valhalla: {
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      matrix: async (_s: unknown[], t: unknown[]) => { matrixCalls++; return [t.map(() => null)]; },
    } as never,
  });
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(matrixCalls, 0, "a stop:-to-stop: query must route no walks");
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// Both RAPTOR passes take the same candidate arrays, so arriveBy must be
// corrected by the same change -- not left planning against the estimate.
// Also doubles as the nearest-stop fallback's own arriveBy coverage: same
// over-cap candidates as the departAfter case above, so the fallback must
// fire here too, not just on the forward pass. Fails if the fallback is
// reverted (was the old 422).
//
// Order changed with effort ranking, same reason as the departAfter case
// above: the fallback-assembled itinerary is still an 82% walk share, so
// the maxWalkShare cap drops it here too, on the reverse pass. Still pinned:
// the fallback keeps this a 200, not a 422.
test("arriveBy uses the same refined candidates as departAfter, including the nearest-stop fallback", async () => {
  const { app, index } = await serveWithWalk(3690, 2775);
  try {
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7800&to=stop:2000&arriveBy=2026-08-24T09:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.deepEqual(body.itineraries, []);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// Regression coverage: `walkEstimated` must reflect whether THIS leg's own
// duration was refined, never the UNRELATED `resolveWalkGeometry` geometry
// call's success or failure -- the two are independent, and conflating them
// lets a leg's flag lie about its own provenance. Here `matrix` succeeds
// (refinement replaces `secondsToReach` with a real Valhalla duration) while
// the SEPARATE `route` call `resolveWalkGeometry` issues afterwards degrades
// (falls back to a straight-line estimate, `geometry: null` / `estimated:
// true` -- the same shape the real `ValhallaClient.route()` produces on a
// failure; see its own doc comment). A hardcoded `walkEstimated: true` left
// untouched by that route-side degrade would misreport a duration that is,
// by then, genuinely real.
//
test("an access leg reports walkEstimated false once refinement succeeds, even when the geometry call degrades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-walkest-"));
  const link = buildFixtureDb(dir);
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain, buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();
  const app = await buildServer({
    index, drain,
    valhalla: {
      // Refinement's matrix call succeeds with a real distance/duration.
      matrix: async (_s: unknown[], t: unknown[]) =>
        [t.map(() => ({ distanceMeters: 141, durationSeconds: 106 }))],
      // The SEPARATE geometry call degrades -- same shape ValhallaClient's
      // own route() falls back to on failure.
      route: async () => (
        { distanceMeters: 190, durationSeconds: 142, geometry: null, estimated: true }
      ),
    } as never,
  });
  try {
    // Same coordinate/cap as the existing "plans from a coordinate, adding a
    // walking access leg" test: 141 m from stop 1000, 798 m from stop 2000;
    // maxWalkMeters=300 keeps only stop 1000 directly reachable, guaranteeing
    // a nonzero-duration access walk leg refinement can act on.
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7815&to=stop:2000"
        + "&departAfter=2026-08-24T07:00:00%2B03:00&maxWalkMeters=300",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: { legs: {
      type: string; walkEstimated?: boolean; durationSeconds: number }[] }[] }).itineraries[0]!;
    const walk = it.legs.find((l) => l.type === "walk")!;
    // The real duration from the matrix call, not the 1.33 m/s estimate.
    assert.equal(walk.durationSeconds, 106);
    // The route call degraded, so it left walkEstimated untouched -- meaning
    // this value came from walkLeg itself, driven by `refined`.
    assert.equal(walk.walkEstimated, false);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// The mirror case: `matrix` throws (so refinement never runs and the
// duration stays the 1.33 m/s estimate) while the SEPARATE `route` call
// SUCCEEDS with real geometry. A leg's path being real says nothing about
// whether its duration is -- `resolveWalkGeometry` must attach the geometry
// without touching `walkEstimated`. If `resolveWalkGeometry` instead set
// `walkEstimated = false` unconditionally whenever its own `/route` call
// resolves with non-null geometry and `estimated: false`, regardless of
// `refined`, this exact leg would claim a real duration it never had, purely
// because its path happened to resolve -- this test exists to catch that.
test("an access leg keeps walkEstimated true when the matrix call degrades, even though the geometry call succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-walkest-mirror-"));
  const link = buildFixtureDb(dir);
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain, buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();
  const app = await buildServer({
    index, drain,
    valhalla: {
      // Refinement's matrix call degrades -- duration stays the estimate.
      matrix: async () => { throw new Error("down"); },
      // The SEPARATE geometry call succeeds with a real precision-6 polyline.
      route: async () => ({
        distanceMeters: 190, durationSeconds: 142,
        geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@", estimated: false,
      }),
    } as never,
  });
  try {
    // Same coordinate/cap as the fixable-case test above: 141 m from stop
    // 1000, 798 m from stop 2000; maxWalkMeters=300 keeps only stop 1000
    // directly reachable, guaranteeing a nonzero-duration access walk leg.
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7815&to=stop:2000"
        + "&departAfter=2026-08-24T07:00:00%2B03:00&maxWalkMeters=300",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: { legs: {
      type: string; walkEstimated?: boolean; durationSeconds: number;
      distanceMeters: number; geometry: string | null }[] }[] }).itineraries[0]!;
    const walk = it.legs.find((l) => l.type === "walk")!;
    // Refinement never ran, so this is still the 1.33 m/s estimate.
    assert.equal(walk.walkEstimated, true);
    // The route call succeeded, so the path is real regardless.
    assert.notEqual(walk.geometry, null);
    // ...and `resolveWalkGeometry` overwrites the haversine-estimate
    // `distanceMeters` with the routed one (190, from the `route` stub
    // above) whenever it resolves for real -- the ONLY existing coverage of
    // that overwrite in the whole suite: `serveWithWalk`'s own `route` stub
    // always reports `estimated: true`, so it never enters this branch, and
    // its `matrix`-derived assertions check a different value than this one.
    assert.equal(walk.distanceMeters, 190);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

test("parsePlace accepts coordinates and stop ids", () => {
  assert.deepEqual(parsePlace("32.0554,34.78"), { kind: "coord", lat: 32.0554, lon: 34.78 });
  assert.deepEqual(parsePlace("stop:1000"), { kind: "stop", stopId: "1000" });
});

test("parsePlace rejects malformed input", () => {
  assert.throws(() => parsePlace("banana"), /Invalid place/);
  assert.throws(() => parsePlace("999,999"), /Invalid place/);
});

test("plans a direct journey between two stops", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { itineraries: { legs: { type: string }[]; transfers: number }[] };
  assert.ok(body.itineraries.length >= 1);
  const legs = body.itineraries[0]!.legs;
  assert.equal(legs.filter((l) => l.type === "transit").length, 1);
  assert.equal(body.itineraries[0]!.transfers, 0);
  await app.close(); index.stop();
});

// Origin coordinate sits 141 m from stop 1000 and 798 m from stop 2000; an
// explicit maxWalkMeters=300 keeps only stop 1000 reachable directly, so the
// only way to the destination is walk -> board T1 -> ride. Using the exact
// coordinates of a fixture stop would give a zero-second, leg-less "walk"
// and silently defeat the very thing this test claims to check.
test("plans from a coordinate, adding a walking access leg", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=32.0554,34.7815&to=stop:2000"
      + "&departAfter=2026-08-24T07:00:00%2B03:00&maxWalkMeters=300",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { itineraries: { legs: { type: string }[] }[] };
  assert.ok(body.itineraries.length >= 1);
  assert.equal(body.itineraries[0]!.legs[0]!.type, "walk");
  assert.equal(body.itineraries[0]!.legs[1]!.type, "transit");
  await app.close(); index.stop();
});

// The feed holds ~30 days. Returning [] for a date months out is
// indistinguishable from "no service" and costs hours of client debugging.
test("a date outside the calendar window is 422, naming the window", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-11-01T08:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 422);
  // The shared error envelope: the machine-readable code /plan introduced is
  // kept (it is genuinely useful), but carried in `code` alongside the
  // numeric status, the human message and the request id, exactly like every
  // other error in the service. The window moves into `details`.
  const body = res.json() as {
    statusCode: number; code: string; message: string; requestId: string;
    details: { serviceWindow: { start: number; end: number } };
  };
  assert.equal(body.statusCode, 422);
  assert.equal(body.code, "date_outside_service_window");
  assert.equal(typeof body.requestId, "string");
  assert.deepEqual(body.details.serviceWindow, { start: 20260821, end: 20260920 });
  assert.match(body.message, /20260821/);
  assert.match(body.message, /20260920/);
  await app.close(); index.stop();
});

// The nearest-stop fallback: a coordinate whose haversine prefilter (not
// just the later real-walk refinement -- that path is covered by the
// "Ayalon case" tests above) already comes back empty must now plan from the
// nearest stops instead of 422ing. `serve()`'s own default Valhalla client
// throws on every `matrix` call under `NODE_TEST_CONTEXT` (see server.ts's
// `inertWalkRouter`), so this simultaneously covers the "Valhalla stub that
// throws" case: the fallback's own refinement call degrades too,
// and the response must still be a plan built on straight-line estimates,
// not a 422. Must fail if the fallback is reverted (was the old 422).
//
// Order changed with effort ranking, and further than order: the query's
// destination is itself `stop:2000`, so the fallback's only candidate is a
// walk covering the WHOLE trip -- zero transit legs. That is exactly the
// walk-only leak `hasTransitLeg` now drops, so the
// correct response is empty rather than a huge honest walk. What survives is
// the part effort ranking did not touch: the fallback still avoids a 422.
test("a coordinate far from every stop is a 200 with no walk-only itinerary, not a 422", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // The Negev, far from every fixture stop.
    url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { itineraries: unknown[] };
  assert.deepEqual(body.itineraries, []);
  await app.close(); index.stop();
});

// Dedicated coverage for "the walk leg must report its true distance and
// duration" (not just duration -- see the "Ayalon case" tests' own comment
// on why `distanceMeters` needs its OWN stub where the separate
// `resolveWalkGeometry` `/route` call also resolves for real, rather than
// degrading). A 38 km fallback walk is a legitimate outcome of this design;
// the response has to say so plainly rather than presenting it as an
// ordinary walk.
//
// Order changed with effort ranking, same reason as the test above: the
// destination is `stop:2000` itself, so this fallback walk covers the whole
// trip -- zero transit legs -- and `hasTransitLeg` now drops it. Still
// pinned: 200, not 422.
test("a coordinate far from every stop is still a 200 with no walk-only itinerary when the fallback's own walk is honestly huge, not an estimate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-fallback-honest-"));
  const link = buildFixtureDb(dir);
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain, buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();
  const app = await buildServer({
    index, drain,
    valhalla: {
      matrix: async (_s: unknown[], t: unknown[]) =>
        [t.map(() => ({ distanceMeters: 38000, durationSeconds: 28500 }))],
      route: async () => (
        { distanceMeters: 38000, durationSeconds: 28500, geometry: "abc", estimated: false }
      ),
    } as never,
  });
  try {
    const res = await app.inject({
      // The Negev, far from every fixture stop.
      url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.deepEqual(body.itineraries, []);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// One of the two mechanisms behind the measured real-feed defect, in
// miniature -- see `serveWalkDominance`'s own doc comment for the full
// geometry table and the race between the walk-only label at stop 2000
// (08:18:03) and T7's genuinely-boarded label at stop 8000 (08:22:41, 34%
// walking, well inside the 0.7 cap). Without `accept`, round 1 would still
// be emitted -- its pick would be the still-live walk-only label at stop
// 2000, which wins the round's `paretoRounds` arg-min across `target.stops`
// simply by arriving earlier than T7's label, not because any round
// "suppressed" another, and `hasTransitLeg` would then drop that walk-only
// survivor, leaving the rider an empty list for a query with a working bus.
// `accept` fixes this by rejecting the walk-only label from ever winning the
// arg-min, so T7's label wins in its place.
test("/plan returns the bus when walking the whole way would be faster", async () => {
  const { app, index } = await serveWalkDominance();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=32.0554,34.7800&to=32.0660,34.7750`
        + `&departAfter=${encodeURIComponent("2026-08-24T07:55:00+03:00")}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: { legs: { type: string }[] }[] };
    assert.ok(body.itineraries.length > 0, "a walk-only label won the round's pick ahead of the bus");
    assert.ok(
      body.itineraries.every((itin) => itin.legs.some((l) => l.type === "transit")),
      "every returned itinerary must still contain transit",
    );
  } finally {
    await app.close();
    index.currentBundle().db.close();
    index.stop();
  }
});

// The primary guarantee: a query that already has candidates
// in range must not touch the fallback machinery at all. Pinned by call
// count, not just by outcome, so a bug that runs the fallback redundantly
// (e.g. always, then discards the result) cannot hide behind an
// unchanged response.
test("the fallback does not fire when candidates already exist", async () => {
  let matrixCalls = 0;
  const { app, index } = await (async () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-plan-fallback-notfire-"));
    const link = buildFixtureDb(dir);
    const drain = new RequestDrain();
    const idx = new IndexManager(dir, {
      drain, buildFn: async () => buildIndex(link),
      footpaths: {
        client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
        options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                   batchSize: 10, speedMps: 1.33 },
        cacheDir: join(dir, "cache"),
      },
    });
    await idx.rebuild();
    const server = await buildServer({
      index: idx, drain,
      valhalla: {
        matrix: async (_s: unknown[], t: unknown[]) => {
          matrixCalls++;
          return [t.map(() => ({ distanceMeters: 120, durationSeconds: 90 }))];
        },
        route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      } as never,
    });
    return { app: server, index: idx };
  })();
  try {
    const res = await app.inject({
      // 141 m from stop 1000 -- comfortably inside the default 1000 m cap,
      // and the stub keeps it inside the cap after refinement too.
      url: "/plan?from=32.0554,34.7815&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    // Exactly one matrix call: the ordinary refinement. A second call would
    // mean the fallback ran even though the ordinary path already produced
    // candidates.
    assert.equal(matrixCalls, 1);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// Per-endpoint independence: the fallback must fire separately for the
// origin and the destination, not as a single whole-request switch.
test("the fallback fires for the origin only, when only the origin has no candidates", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // Origin: the Negev, far from everything. Destination: an ordinary stop,
    // needing no fallback at all.
    url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { query: { accessStops: number; egressStops: number } };
  assert.ok(body.query.accessStops >= 1);
  // stop: destinations resolve to exactly that stop -- one egress "stop",
  // unaffected by anything on the origin side.
  assert.equal(body.query.egressStops, 1);
  await app.close(); index.stop();
});

test("the fallback fires for the destination only, when only the destination has no candidates", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=30.5000,34.9000&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { query: { accessStops: number; egressStops: number } };
  assert.equal(body.query.accessStops, 1);
  assert.ok(body.query.egressStops >= 1);
  await app.close(); index.stop();
});

test("the fallback fires independently for both endpoints in the same request", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // Both far from every fixture stop, in different directions.
    url: "/plan?from=30.5000,34.9000&to=29.5500,34.9500&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { query: { accessStops: number; egressStops: number } };
  assert.ok(body.query.accessStops >= 1);
  assert.ok(body.query.egressStops >= 1);
  await app.close(); index.stop();
});

// An unresolved `stop:<id>` is a bad id, not a walking
// distance problem, and must not fall through to the nearest-stop fallback
// or the (now practically unreachable) walking-cap 422 -- either would
// misreport a typo'd id as "no stop within N m", which is actively
// misleading once the walking cap no longer applies to access stops at all.
// Mirrors the `No <thing> with id ${id}` / `not_found` convention every
// other route (trips.ts, departures.ts, stops.ts, lines.ts) already uses.
test("an unresolved stop: origin is its own 404, not the walking-distance 422", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:NOPE&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { statusCode: number; code: string; message: string };
  assert.equal(body.statusCode, 404);
  assert.equal(body.code, "not_found");
  assert.match(body.message, /NOPE/);
  await app.close(); index.stop();
});

test("an unresolved stop: destination is its own 404, not the walking-distance 422", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:NOPE&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { statusCode: number; code: string; message: string };
  assert.equal(body.statusCode, 404);
  assert.equal(body.code, "not_found");
  assert.match(body.message, /NOPE/);
  await app.close(); index.stop();
});

// The "unreachable except..." comment/README list is not exhaustive on its
// own: a coordinate whose 5 nearest-stop fallback candidates are ALL
// reported unreachable ON FOOT by Valhalla (cost === null -- "no pedestrian
// path", not "too far"; offshore, a fenced-off zone, a road with no
// pedestrian access) still empties the set and still 422s against a
// perfectly healthy index -- unlike every OTHER over-cap case, which the
// fallback now catches. Must fail if the fallback's own 422 comment/README
// update is wrong about this being the one surviving in-range case.
test("a coordinate whose nearest stops are all unreachable on foot is still a 422, not a 200", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-allnull-fallback-"));
  const link = buildFixtureDb(dir);
  const drain = new RequestDrain();
  const index = new IndexManager(dir, {
    drain, buildFn: async () => buildIndex(link),
    footpaths: {
      client: { ping: async () => false, matrix: async () => { throw new Error("down"); } } as never,
      options: { maxMeters: 400, sameStationSeconds: 180, transferMinSeconds: 60,
                 batchSize: 10, speedMps: 1.33 },
      cacheDir: join(dir, "cache"),
    },
  });
  await index.rebuild();
  const app = await buildServer({
    index, drain,
    valhalla: {
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      // Resolves (does not throw/degrade) but reports every candidate as
      // having no pedestrian path at all.
      matrix: async (_s: unknown[], t: unknown[]) => [t.map(() => null)],
    } as never,
  });
  try {
    const res = await app.inject({
      // The Negev, far from every fixture stop -- guarantees the ordinary
      // haversine prefilter is already empty, so this exercises the
      // fallback's own all-null matrix row, not the earlier refine step.
      url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { code: string };
    assert.equal(body.code, "no_stops_near_origin");
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// Saturday: every fixture trip belongs to service S1 (Sun-Thu only), and the
// two stops are deliberately NOT footpath-connected by this suite's `serve()`
// (see its comment), so nothing at all connects them today -- a genuinely
// searched, genuinely unreachable pair.
test("an unreachable but searched pair is 200 with an empty list", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-22T07:30:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { itineraries: unknown[] }).itineraries, []);
  await app.close(); index.stop();
});

test("arriveBy returns a journey arriving no later than requested", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&arriveBy=2026-08-24T08:30:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { itineraries: { arrivalTime: string }[] };
  assert.ok(body.itineraries.length >= 1);
  assert.ok(Date.parse(body.itineraries[0]!.arrivalTime) <= Date.parse("2026-08-24T08:30:00+03:00"));
  await app.close(); index.stop();
});

// The reverse (`arriveBy`) branch must call `walkLeg` for the egress side
// too, or a coordinate destination silently loses its final walk leg
// entirely -- `arrivalTime` would come out as the STOP arrival instead of
// the door arrival, and `legs`/`walkSeconds`/`walkMeters`/`durationSeconds`
// would all exclude a real leg. Every OTHER `arriveBy` test in this file
// uses `stop:` on both ends (zero walk either side), so this endpoint needs
// its own coverage. Destination coordinate
// sits 141 m from stop 2000 (609 m from stop 1000); maxWalkMeters=200 keeps
// only stop 2000 reachable from it, so the only route is board T1 -> ride ->
// walk the rest, mirroring the coordinate-egress `departAfter` test above.
test("arriveBy to a coordinate destination includes the egress walk leg", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=32.0600,34.7765"
      + "&arriveBy=2026-08-24T08:30:00%2B03:00&maxWalkMeters=200",
  });
  assert.equal(res.statusCode, 200);

  interface WalkLeg { type: "walk"; durationSeconds: number; distanceMeters: number }
  interface TransitLeg { type: "transit"; to: { arrivalTime: string } }
  type Leg = WalkLeg | TransitLeg;
  interface Itinerary {
    arrivalTime: string; walkSeconds: number; walkMeters: number; legs: Leg[];
  }

  const body = res.json() as { itineraries: Itinerary[] };
  assert.ok(body.itineraries.length >= 1);
  const itin = body.itineraries[0]!;

  const lastLeg = itin.legs[itin.legs.length - 1]!;
  assert.equal(lastLeg.type, "walk", "the itinerary must end with the egress walk leg");
  assert.ok(itin.walkSeconds > 0, "walkSeconds must include the egress walk");
  assert.ok(itin.walkMeters > 0, "walkMeters must include the egress walk");

  // Door arrival must be AFTER the boarded trip's own stop arrival (08:10) --
  // the egress walk still has to happen -- and still no later than requested.
  const transitLeg = itin.legs.find((l): l is TransitLeg => l.type === "transit")!;
  assert.ok(
    Date.parse(itin.arrivalTime) > Date.parse(transitLeg.to.arrivalTime),
    "door arrival must be later than the transit leg's own stop arrival",
  );
  assert.ok(Date.parse(itin.arrivalTime) <= Date.parse("2026-08-24T08:30:00+03:00"));

  await app.close(); index.stop();
});

// `buildDayContexts` includes both today and yesterday so a real >86400s
// (e.g. 25:30) trip can still be
// found, but nothing else stops the reverse search from satisfying a
// deadline with a perfectly ORDINARY previous-day trip too, if today simply
// has no active service at all. Friday (2026-08-28) has none in this fixture
// (only service S1, Sun-Thu, exists with any trips); Thursday
// (2026-08-27) does, and its own latest trip (T2, 09:00 -> 09:10) is nearly
// 35 hours before an evening Friday deadline -- an itinerary that "arrives
// by" Friday 20:00 by arriving Thursday morning is not what that means.
test("arriveBy discards a journey that arrives more than a day before the deadline", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&arriveBy=2026-08-28T20:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { itineraries: unknown[] }).itineraries, []);
  await app.close(); index.stop();
});

test("passing both departAfter and arriveBy is a 400", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00&arriveBy=2026-08-24T09:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("returns 503 while no index is loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-cold-"));
  buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => { throw new Error("not yet"); } });
  const app = await buildServer({ index });
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "5");
  // A deliberate, retryable 503 -- so it keeps its own code and message
  // rather than being genericised by the error handler's 5xx branch, and
  // `state` survives in `details`.
  const body = res.json() as {
    statusCode: number; code: string; message: string; requestId: string;
    details: { state: string };
  };
  assert.equal(body.statusCode, 503);
  assert.equal(body.code, "index_not_ready");
  assert.equal(body.details.state, "empty");
  assert.equal(typeof body.requestId, "string");
  await app.close(); index.stop();
});

test("an unsupported lang is a 400, not a 500", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00&lang=fr",
  });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

// End-to-end: a real multi-leg journey through the full HTTP layer, with both
// an access walk and an egress walk bracketing a real transit ride. Departing
// at exactly T1's scheduled departure (08:00:00) from a bare "stop:" origin
// (zero access seconds there) means the door-to-door departureTime is
// anchored on that same instant -- exactly what legs[0] (the transit leg)
// itself departs at -- so this also exercises the one case where the two
// times DO coincide, alongside asserting every leg is coherent.
test("plans a real multi-leg journey with coherent, contiguous legs", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // Destination coordinate sits 141 m from stop 2000 and 609 m from stop
    // 1000; maxWalkMeters=200 keeps only stop 2000 reachable from it, so the
    // only route is: board T1 at stop 1000, ride to stop 2000, walk the rest.
    url: "/plan?from=stop:1000&to=32.0600,34.7765"
      + "&departAfter=2026-08-24T08:00:00%2B03:00&maxWalkMeters=200",
  });
  assert.equal(res.statusCode, 200);

  interface Place { type: string; stopId?: string; name?: string | null }
  interface WalkLeg { type: "walk"; from: Place; to: Place; durationSeconds: number }
  interface TransitLeg {
    type: "transit"; tripId: string;
    from: { stop: Place; departureTime: string };
    to: { stop: Place; arrivalTime: string };
  }
  type Leg = WalkLeg | TransitLeg;
  interface Itinerary {
    departureTime: string; arrivalTime: string; transfers: number; legs: Leg[];
  }

  const body = res.json() as { itineraries: Itinerary[] };
  assert.ok(body.itineraries.length >= 1);
  const itin = body.itineraries[0]!;

  // Correct order: transit ride first (no access walk needed -- the origin
  // IS the boarding stop), then an egress walk to the destination coordinate.
  assert.equal(itin.legs.length, 2);
  const [leg0, leg1] = itin.legs as [TransitLeg, WalkLeg];
  assert.equal(leg0.type, "transit");
  assert.equal(leg1.type, "walk");

  // A transit leg with a real trip id -- not a placeholder or a stop_ref.
  assert.equal(leg0.tripId, "T1");
  assert.equal(leg0.from.stop.stopId, "1000");
  assert.equal(leg0.to.stop.stopId, "2000");

  // Contiguous times: the ride departs 08:00 and arrives 08:10 (fixture
  // schedule), and the egress walk's own duration is positive.
  assert.equal(leg0.from.departureTime, "2026-08-24T08:00:00+03:00");
  assert.equal(leg0.to.arrivalTime, "2026-08-24T08:10:00+03:00");
  assert.ok(leg1.durationSeconds > 0);

  // Door-to-door departureTime anchors on the whole chain, which here starts
  // with the access label at the origin STOP (zero access seconds, since
  // "stop:1000" needs no walk to itself) -- and because the query's
  // departAfter instant exactly equals T1's own departure, the two coincide.
  // This is the one case where they do; a real access/egress walk means they
  // generally will NOT once it precedes/follows.
  assert.equal(itin.departureTime, leg0.from.departureTime);
  assert.equal(itin.transfers, 0);

  await app.close(); index.stop();
});

// The `arriveBy` mirror of the test above -- same route, same destination
// coordinate, but reconstructed via `reconstructReverseChain` and the
// reverse pass's own egress-leg wiring. This is exactly the path where a
// coordinate destination's egress `walkLeg` call could be skipped in the
// reverse branch, so this also stands as an end-to-end coherence check for
// that, not just the narrower regression test above.
test("plans a real multi-leg journey with coherent, contiguous legs (arriveBy)", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // Deadline 08:30 leaves enough room for T1 (08:00 -> 08:10) plus the
    // ~144 s egress walk (door arrival ~08:12:24); T2 (09:00 -> 09:10) is
    // correctly excluded by the reverse search itself, since its arrival at
    // stop 2000 alone is already past the deadline once the mandatory
    // egress walk is accounted for (08:30 - 144s effective stop deadline).
    url: "/plan?from=stop:1000&to=32.0600,34.7765"
      + "&arriveBy=2026-08-24T08:30:00%2B03:00&maxWalkMeters=200",
  });
  assert.equal(res.statusCode, 200);

  interface Place { type: string; stopId?: string; name?: string | null }
  interface WalkLeg { type: "walk"; from: Place; to: Place; durationSeconds: number }
  interface TransitLeg {
    type: "transit"; tripId: string;
    from: { stop: Place; departureTime: string };
    to: { stop: Place; arrivalTime: string };
  }
  type Leg = WalkLeg | TransitLeg;
  interface Itinerary {
    departureTime: string; arrivalTime: string; transfers: number;
    walkSeconds: number; walkMeters: number; legs: Leg[];
  }

  const body = res.json() as { itineraries: Itinerary[] };
  assert.ok(body.itineraries.length >= 1);
  const itin = body.itineraries[0]!;

  // Correct order: transit ride first, egress walk last.
  assert.equal(itin.legs.length, 2);
  const [leg0, leg1] = itin.legs as [TransitLeg, WalkLeg];
  assert.equal(leg0.type, "transit");
  assert.equal(leg1.type, "walk");

  // A transit leg with a real trip id, boarding/alighting the right stops.
  assert.equal(leg0.tripId, "T1");
  assert.equal(leg0.from.stop.stopId, "1000");
  assert.equal(leg0.to.stop.stopId, "2000");

  // Contiguous times, and a real (nonzero) egress walk this time.
  assert.equal(leg0.from.departureTime, "2026-08-24T08:00:00+03:00");
  assert.equal(leg0.to.arrivalTime, "2026-08-24T08:10:00+03:00");
  assert.ok(leg1.durationSeconds > 0);
  assert.ok(itin.walkSeconds > 0);
  assert.ok(itin.walkMeters > 0);

  // Door-to-door departureTime still coincides with leg0's own departure
  // here (bare "stop:" origin, zero access seconds) -- but arrivalTime must
  // now be STRICTLY LATER than the transit leg's own stop arrival, because
  // the egress walk happens after it. Were the egress leg silently dropped,
  // its time would never be added in and the two would incorrectly read
  // equal.
  assert.equal(itin.departureTime, leg0.from.departureTime);
  assert.ok(Date.parse(itin.arrivalTime) > Date.parse(leg0.to.arrivalTime));
  assert.ok(Date.parse(itin.arrivalTime) <= Date.parse("2026-08-24T08:30:00+03:00"));
  assert.equal(itin.transfers, 0);

  await app.close(); index.stop();
});

// `Number("")` is 0, so a bare `modes=` would coerce to "tram only" -- a
// query that reads as "no filter" silently answering as the narrowest
// filter there is. And `Number("abc")` is NaN; filtering those out with
// `.filter(Number.isFinite)` would leave `modes=abc` an EMPTY mode set and a
// 200 with zero itineraries: a typo indistinguishable from "genuinely
// unreachable".
test("a malformed modes value is a 400 naming it, not a silent filter", async () => {
  const { app, index } = await serve();
  const base = "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00";
  for (const [modes, needle] of [
    ["", '""'],
    ["abc", '"abc"'],
    ["0,abc", '"abc"'],
    ["0,,3", '""'],
    ["3.5", '"3.5"'],
  ] as [string, string][]) {
    const res = await app.inject({ url: `${base}&modes=${encodeURIComponent(modes)}` });
    assert.equal(res.statusCode, 400, `modes=${modes}`);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "bad_request", `modes=${modes}`);
    assert.match(body.message, /Invalid modes value/, `modes=${modes}`);
    assert.ok(body.message.includes(needle), `modes=${modes}: ${body.message}`);
  }
  await app.close(); index.stop();
});

test("a well-formed modes list still filters", async () => {
  const { app, index } = await serve();
  const base = "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00";
  // The fixture's routes are route_type 3 (bus).
  const bus = await app.inject({ url: `${base}&modes=3` });
  assert.equal(bus.statusCode, 200);
  assert.ok((bus.json() as { itineraries: unknown[] }).itineraries.length > 0);

  // Whitespace around an entry survives a URL-decoded space.
  const spaced = await app.inject({ url: `${base}&modes=${encodeURIComponent("0, 3")}` });
  assert.equal(spaced.statusCode, 200);
  assert.ok((spaced.json() as { itineraries: unknown[] }).itineraries.length > 0);

  // Tram only: nothing in this fixture, and a genuine search that found
  // nothing is still a 200 with an empty list.
  const tram = await app.inject({ url: `${base}&modes=0` });
  assert.equal(tram.statusCode, 200);
  assert.deepEqual((tram.json() as { itineraries: unknown[] }).itineraries, []);
  await app.close(); index.stop();
});

// Departure reoptimisation. Without re-anchoring, `departAfter`'s
// `departureTime` would be the bare query instant (07:00), and the platform
// wait before T1's 08:00 boarding would sit inside `durationSeconds` as part
// of a bogus 70-minute "journey". It instead reports the door departure the
// traveller would actually act on -- T1's own boarding time, since a bare
// "stop:" origin needs no access walk -- and the true 10-minute ride
// duration.
test("departAfter reports the boarding moment, not the query instant", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: {
      departureTime: string; arrivalTime: string; durationSeconds: number;
      legs: { type: string; from?: { departureTime: string } }[] }[] }).itineraries[0]!;
    const firstTransit = it.legs.find((l) => l.type === "transit")!;
    assert.equal(it.departureTime, firstTransit.from!.departureTime);
    // T1 runs 08:00 -> 08:10: a 10-minute journey, not the 70 minutes bare
    // query-instant anchoring would report.
    assert.equal(it.durationSeconds, 600);
    assert.equal(
      it.durationSeconds,
      (Date.parse(it.arrivalTime) - Date.parse(it.departureTime)) / 1000,
    );
  } finally {
    await app.close(); index.stop();
  }
});

test("transit legs carry decodable geometry", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    const it = (res.json() as { itineraries: { legs: {
      type: string; geometry: string | null; geometryFallback?: boolean }[] }[] }).itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    assert.ok(transit.geometry, "transit leg should carry geometry");
    assert.equal(transit.geometryFallback, false);
  } finally {
    await app.close(); index.stop();
  }
});

// Regression guard: reoptimisation must never touch the `arriveBy` branch's
// own answer, which already reports the latest feasible departure via the
// reverse pass directly.
test("arriveBy still arrives no later than requested", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&arriveBy=2026-08-24T08:30:00%2B03:00",
    });
    const it = (res.json() as { itineraries: { arrivalTime: string }[] }).itineraries[0]!;
    assert.ok(Date.parse(it.arrivalTime) <= Date.parse("2026-08-24T08:30:00+03:00"));
  } finally {
    await app.close(); index.stop();
  }
});

// Regression coverage: the tests above cannot tell "re-anchor only"
// (reanchorDeparture, step 1) apart from "re-anchor then reoptimise"
// (step 2, reoptimiseItinerary) -- the shared fixture has no same-arrival
// departure tie for the reverse pass to find, so deleting the
// `reoptimiseItinerary` call from `plan.ts` entirely still passes every
// existing test. `serveWithExpressTrip` adds TX (08:05 -> 08:10, same
// arrival as T1's 08:00 -> 08:10, one trip) specifically to close that gap.
test("departAfter swaps to a later same-arrival departure when one exists", async () => {
  const { app, index } = await serveWithExpressTrip();
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: { departureTime: string; arrivalTime: string;
      transfers: number;
      legs: { type: string; tripId?: string; from?: { departureTime: string } }[] }[] })
      .itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    // TX, not T1: the later departure with the identical arrival and the
    // identical (zero) transfer count. Fails if `reoptimiseItinerary` is
    // never called (T1, 08:00, would be reported instead).
    assert.equal(transit.tripId, "TX");
    assert.equal(transit.from!.departureTime, "2026-08-24T08:05:00+03:00");
    assert.equal(it.departureTime, "2026-08-24T08:05:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:10:00+03:00");
    assert.equal(it.transfers, 0);
  } finally {
    await app.close(); index.stop();
  }
});

test("geometry is resolved on the itinerary reoptimisation actually returns", async () => {
  const { app, index } = await serveWithExpressTrip();
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    const it = (res.json() as { itineraries: { legs: {
      type: string; tripId?: string; geometry: string | null;
      geometryFallback?: boolean }[] }[] }).itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    // Confirms the swap to TX happened (same assertion as above, load-bearing
    // here too: the geometry check below is meaningless against the wrong trip).
    assert.equal(transit.tripId, "TX");
    // SHX (TX's shape) decodes to 3 points; SH1 (T1's shape) decodes to 2.
    // Only the correct ordering -- resolve geometry AFTER reoptimisation has
    // settled on TX -- can produce SHX's geometry here. Resolving on the
    // pre-reoptimisation (T1) itinerary instead mutates leg objects that
    // reoptimisation then discards in favour of a freshly built TX
    // itinerary, so the leg actually returned would keep `geometry: null`.
    assert.ok(transit.geometry, "transit leg should carry geometry");
    assert.equal(transit.geometryFallback, false);
    const { decodePolyline } = await import("../geo.js");
    const points = decodePolyline(transit.geometry!);
    assert.equal(points.length, 3, "should decode SHX (3 points), not SH1 (2)");
  } finally {
    await app.close(); index.stop();
  }
});

// ---------------------------------------------------------------------
// Realtime annotation on /plan legs and itineraries.
// ---------------------------------------------------------------------

interface RtLeg {
  type: string;
  tripId?: string;
  from?: { departureTime: string; scheduledDepartureTime: string };
  to?: { arrivalTime: string; scheduledArrivalTime: string };
  realtime: {
    predictedDeparture: string | null; predictedArrival: string | null;
    delaySeconds: number | null; vehicleRef: string | null;
    confidence: string | null; recordedAt: string | null;
  } | null;
}
interface RtItinerary { transfers: number; transferAtRisk: boolean | null; legs: RtLeg[] }

const STUB_JOURNEY: RealtimeJourney = {
  lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
  originAimedDeparture: null, operatorRef: null, publishedLineName: null,
  vehicleRef: null, confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
};

test("with realtime disabled, every transit leg carries realtime: null", async () => {
  // This is the whole no-key guarantee, asserted at the response boundary.
  const { app, index } = await serveWithRealtime(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: RtItinerary[] };
    assert.ok(body.itineraries.length >= 1);
    for (const it of body.itineraries) {
      assert.equal(it.transferAtRisk, null);
      for (const leg of it.legs) {
        if (leg.type === "transit") assert.equal(leg.realtime, null);
      }
    }
  } finally { await app.close(); index.stop(); }
});

test("a resolved trip reports predicted times and a delay", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    ...STUB_JOURNEY, vehicleRef: "veh-42", confidence: "reliable",
    recordedAt: Date.parse("2026-08-24T07:59:00+03:00") / 1000,
  };
  // T1 is trip index 0 (the fixture's only trip_ref is 1, ordered from 1);
  // stop 1000 is stop index 0 and stop 2000 is index 1 (stop_ref 1 and 2,
  // same ordering) -- see buildIndex, which assigns both by ascending ref.
  const predictedDeparture = Date.parse("2026-08-24T08:02:00+03:00") / 1000;
  const predictedArrival = Date.parse("2026-08-24T08:15:00+03:00") / 1000;
  const resolved: ResolvedJourney = {
    tripIdx: 0, journey, byStopIdx: new Map([
      [0, { expectedArrival: predictedDeparture, ambiguous: false }],
      [1, { expectedArrival: predictedArrival, ambiguous: false }],
    ]),
  };
  store.replace([resolved], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);

  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    assert.equal(transit.tripId, "T1");
    // Scheduled arrival is 08:10:00 (fixture); predicted is 08:15:00, a
    // 300 s delay.
    assert.deepEqual(transit.realtime, {
      predictedDeparture: "2026-08-24T08:02:00+03:00",
      predictedArrival: "2026-08-24T08:15:00+03:00",
      delaySeconds: 300,
      vehicleRef: "veh-42",
      confidence: "reliable",
      recordedAt: "2026-08-24T07:59:00+03:00",
      source: "siri-sm",
    });
  } finally { await app.close(); index.stop(); }
});

// ---------------------------------------------------------------------
// A stop the trip's own pattern visits more than once (a loop) must never
// hand `/plan` a prediction it cannot attribute to this leg's specific
// visit -- `match.ts`'s `ambiguous` flag is exactly what the store carries
// for this, and `unambiguousPredictionFor` is the accessor `/plan` must use
// instead of `predictionFor`.
// ---------------------------------------------------------------------

test("an ambiguous (loop-repeated) stop prediction is withheld from /plan, even though the store has data for it", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    ...STUB_JOURNEY, vehicleRef: "veh-42", confidence: "reliable", recordedAt: null,
  };
  // Same fixture positions as the test above (T1 = tripIdx 0, stop 1000 =
  // stopIdx 0, stop 2000 = stopIdx 1), but BOTH entries are marked
  // `ambiguous: true` -- as if this trip's own pattern visited each of
  // these physical stops more than once. A real per-tick resolution would
  // never mark an ordinary (non-looping) fixture trip this way; this is a
  // synthetic store, deliberately isolating the store/plan.ts contract
  // from match.ts's own pattern-counting logic (covered separately in
  // match.test.ts and store.test.ts).
  const predictedDeparture = Date.parse("2026-08-24T08:02:00+03:00") / 1000;
  const predictedArrival = Date.parse("2026-08-24T08:15:00+03:00") / 1000;
  const resolved: ResolvedJourney = {
    tripIdx: 0, journey, byStopIdx: new Map([
      [0, { expectedArrival: predictedDeparture, ambiguous: true }],
      [1, { expectedArrival: predictedArrival, ambiguous: true }],
    ]),
  };
  store.replace([resolved], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);

  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    assert.equal(transit.tripId, "T1");
    // The two epoch-shaped fields the ambiguity actually protects go
    // null -- exactly the "wrong is worse than absent" outcome the design
    // requires (match.ts:186) -- while fields that never came from a
    // specific stop position (vehicleRef, confidence) survive untouched,
    // the same partial-degrade shape `realtimeForLeg` already uses when a
    // board/alight stop index simply can't be found.
    assert.deepEqual(transit.realtime, {
      predictedDeparture: null,
      predictedArrival: null,
      delaySeconds: null,
      vehicleRef: "veh-42",
      confidence: "reliable",
      recordedAt: null,
      // Present even when every prediction is withheld: the block still
      // names which feed the (suppressed) data came from.
      source: "siri-sm",
    });
  } finally { await app.close(); index.stop(); }
});

test("the departures board is unaffected by an ambiguous stop -- it keeps reporting the soonest visit", async () => {
  // The departures board must NOT change behaviour here. Same ambiguous
  // store as above, read through
  // GET /stops/:stopId/departures instead of /plan.
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    ...STUB_JOURNEY, vehicleRef: "veh-42", confidence: "reliable", recordedAt: null,
  };
  const predictedDeparture = Date.parse("2026-08-24T08:02:00+03:00") / 1000;
  const resolved: ResolvedJourney = {
    tripIdx: 0, journey, byStopIdx: new Map([
      [0, { expectedArrival: predictedDeparture, ambiguous: true }],
    ]),
  };
  store.replace([resolved], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);

  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: { tripId: string; realtime: { predictedDeparture: string | null } | null }[] };
    const t1 = body.departures.find((d) => d.tripId === "T1")!;
    assert.equal(
      t1.realtime?.predictedDeparture, "2026-08-24T08:02:00+03:00",
      "the departures board keeps the soonest-visit prediction regardless of ambiguity",
    );
  } finally { await app.close(); index.stop(); }
});

test("a leg whose trip is unresolved carries realtime: null, and the plan still succeeds", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // The snapshot resolved something, but never T1 (trip index 0) -- only an
  // unrelated trip index that this fixture doesn't even have.
  store.replace(
    [{ tripIdx: 99, journey: STUB_JOURNEY, byStopIdx: new Map() }],
    { resolved: 1, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    assert.equal(transit.realtime, null);
    // No transfer at all in this single-leg itinerary -- confirmed false,
    // not the "unknown" null.
    assert.equal(it.transferAtRisk, false);
  } finally { await app.close(); index.stop(); }
});

// Renamed from "a stale store annotates nothing": annotation DOES run here
// (transferAtRisk is computed, to `false`, the "no transfer at all" case) --
// what's actually gone is the store's DATA, which is exactly what this test
// checks for.
test("a stale store leaves realtime null, but transferAtRisk is still computed", async () => {
  let now = 1_000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = { ...STUB_JOURNEY, vehicleRef: "veh-1", confidence: "certain" };
  store.replace(
    [{ tripIdx: 0, journey, byStopIdx: new Map([[1, { expectedArrival: 1_500, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now,
  );
  // Push the store's own clock past maxAgeSeconds (180) before the request
  // is ever made, so `journeyFor`/`predictionFor` both answer null.
  now += 181;

  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    const transit = it.legs.find((l) => l.type === "transit")!;
    assert.equal(transit.realtime, null);
    assert.equal(it.transferAtRisk, false);
  } finally { await app.close(); index.stop(); }
});

test("a late feeding leg that eats the transfer sets transferAtRisk", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // T1 (tripIdx 0) predicted 10 minutes late into stop 2000 (stopIdx 1):
  // scheduled 08:10:00, predicted 08:20:00 -- past T4's own 08:15:00
  // scheduled departure from that same stop, so this is at risk under
  // EITHER the flat 60 s `transferMinSeconds` or this fixture's real 90 s
  // headway-scaled margin (see serveWithTransfer's own doc comment) --
  // unlike the "leaves slack" test below, which only distinguishes the two.
  const predictedArrival = Date.parse("2026-08-24T08:20:00+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.deepEqual(it.legs.filter((l) => l.type === "transit").map((l) => l.tripId), ["T1", "T4"]);
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("a delay that still leaves slack does not set transferAtRisk", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // T1 predicted only 3 minutes late: 08:13:00 -- 2 minutes ahead of T4's
  // 08:15:00 scheduled departure by the clock, but only 30 s ahead of the
  // REAL 90 s required margin this fixture's headway now demands (via T4E,
  // see serveWithTransfer's own doc comment), not the flat 60 s
  // `transferMinSeconds`. Still enough.
  const predictedArrival = Date.parse("2026-08-24T08:13:00+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.equal(it.transferAtRisk, false);
  } finally { await app.close(); index.stop(); }
});

test("live delays may not delete a rider's only journey", async () => {
  // Realtime re-plans: "same query, same itineraries, only the annotations
  // differ" is not the contract in general -- a journey whose connection
  // the live data refuses is dropped.
  //
  // What holds instead is a principle adopted for realtime too: when the delays
  // refuse EVERYTHING, the planner yields back to the schedule rather than
  // handing a rider standing at a stop an empty result. So on this fixture
  // -- where the delay below kills the only journey there is -- the answer
  // is still the scheduled T1 -> T4, flagged through transferAtRisk by the
  // very prediction that refused it.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // Predicted an HOUR late -- long past T4's own scheduled arrival, let
  // alone its departure.
  const predictedArrival = Date.parse("2026-08-24T09:10:00+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const url = "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00";
  const withStore = await serveWithTransfer(store);
  const without = await serveWithTransfer(null);
  try {
    const resA = await withStore.app.inject({ url });
    const resB = await without.app.inject({ url });
    assert.equal(resA.statusCode, 200);
    assert.equal(resB.statusCode, 200);

    interface Body { itineraries: Record<string, unknown>[] }
    const itinsA = (resA.json() as Body).itineraries;
    const itinsB = (resB.json() as Body).itineraries;

    const strip = (itins: Record<string, unknown>[]): unknown[] => itins.map((it) => {
      const rest = { ...it };
      delete rest.transferAtRisk;
      const legs = (it.legs as Record<string, unknown>[]).map((l) => {
        const legRest = { ...l };
        delete legRest.realtime;
        return legRest;
      });
      return { ...rest, legs };
    });

    assert.deepEqual(strip(itinsA), strip(itinsB));

    // The annotation itself really did differ -- otherwise the comparison
    // above would be vacuous.
    assert.equal(itinsA[0]!.transferAtRisk, true);
    assert.equal(itinsB[0]!.transferAtRisk, null);
  } finally {
    await withStore.app.close(); withStore.index.stop();
    await without.app.close(); without.index.stop();
  }
});

// ---------------------------------------------------------------------
// The null branch of transferAtRisk, and the transfer-margin behaviour.
// ---------------------------------------------------------------------

test("transferAtRisk is null, not false, when a transfer's data is genuinely unknown", async () => {
  // Regression coverage: the original six tests never actually reached the
  // `anyUnknown` branch of `computeTransferAtRisk` -- the disabled-path
  // tests get `null` from the constructor default (annotateRealtime never
  // runs at all), and the single-leg tests have no transfer to be uncertain
  // about. This test uses a store that IS enabled (so annotation actually
  // runs and computes a verdict) but resolves nothing for T1, on a genuine
  // two-leg, one-transfer itinerary.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  store.replace([], { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    assert.equal(it.transfers, 1);
    const transit = it.legs.filter((l) => l.type === "transit");
    assert.equal(transit[0]!.realtime, null, "T1's own realtime must genuinely be absent");
    assert.equal(it.transferAtRisk, null, "unknown, not the confirmed-safe false");
  } finally { await app.close(); index.stop(); }
});

test("one transfer confirmed fine and another unknown yields null, not false", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // T1 (tripIdx 0) predicted exactly on time into stop 2000 -- the FIRST
  // transfer (into T4) is confirmed fine. T4 (tripIdx 3) is never resolved
  // at all -- the SECOND transfer (into T5) is genuinely unknown.
  const onTimeArrival = Date.parse("2026-08-24T08:10:00+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: onTimeArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithTwoTransfers(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:6000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    assert.equal(it.transfers, 2);
    assert.deepEqual(
      it.legs.filter((l) => l.type === "transit").map((l) => l.tripId),
      ["T1", "T4", "T5"],
    );
    // One confirmed-fine transfer must not force the overall verdict to
    // false when the other transfer's status is still unknown.
    assert.equal(it.transferAtRisk, null);
  } finally { await app.close(); index.stop(); }
});

test("a transfer inside the planner's own boarding buffer is still flagged at risk", async () => {
  // RAPTOR only built this connection because arrival + the required margin
  // (90 s -- this fixture's real headway-scaled margin via T4E, not the
  // flat 60 s `transferMinSeconds`; see serveWithTransfer's own doc
  // comment) <= the next departure. A predicted arrival just 5 seconds
  // before that departure leaves far less than the 90 s margin the plan
  // itself required to build the connection in the first place --
  // reporting "fine" here would be laxer than the search that produced the
  // itinerary.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const predictedArrival = Date.parse("2026-08-24T08:14:55+03:00") / 1000; // T4 departs 08:15:00
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

// ---------------------------------------------------------------------
// The headway-scaled transfer margin, wired into /plan for real.
// ---------------------------------------------------------------------

/**
 * Mutates `walkConfig.headwayFactor` for the duration of `fn`, then restores
 * it. `config.ts` computes `headwayFactor` once at module load from
 * `TRANSFER_HEADWAY_FACTOR` -- a real env-var toggle would need a fresh
 * process to take effect (see `config.test.ts`'s `spawnSync` pattern for
 * exactly that, used there for a different reason). `plan.ts` reads
 * `walkConfig.headwayFactor` fresh on every request rather than capturing it
 * at server-build time, so mutating the shared, `as const`-typed (but NOT
 * runtime-frozen) config object directly -- the same escape hatch
 * `manager.test.ts` uses for a private field -- changes behaviour for every
 * request made while `fn` runs, in this same process, without rebooting
 * anything.
 */
async function withHeadwayFactor<T>(factor: number, fn: () => Promise<T>): Promise<T> {
  const cfg = walkConfig as unknown as { headwayFactor: number };
  const original = cfg.headwayFactor;
  cfg.headwayFactor = factor;
  try {
    return await fn();
  } finally {
    cfg.headwayFactor = original;
  }
}

/**
 * R103 (T4) is THIS fixture's only trip on the pattern (unlike
 * `serveWithTransfer`, which also carries T4E), so `headwayTableFor` reports
 * `NO_HEADWAY` for every hour (a single trip produces no gap to measure --
 * `headway.ts`'s `buildHeadwayTable`), which
 * `requiredTransferSeconds` charges the FULL `TRANSFER_MAX_SECONDS` cap
 * (600 s by default) on top of `transferMinSeconds` for boarding it. The
 * 300 s this fixture offers between T1's 08:10:00 arrival and T4's
 * 08:15:00 departure clears the flat 60 s buffer easily but does not clear
 * that cap.
 *
 * With `laterTrip` FALSE, T4 is also R103's LAST service of the day, which is
 * the last-service case: refusing the connection does not move the rider onto
 * a later trip, it deletes their only journey, so the rule yields to the
 * flat buffer and returns the journey flagged `transferAtRisk`.
 *
 * With `laterTrip` TRUE, R103 additionally runs T5 (09:00:00 -> 09:10:00), so
 * there IS a later trip and the margin binds the way "journeys get later, not
 * fewer" always assumed it would: the tight T4 connection is refused and the
 * search takes T5 instead -- later, not fewer. That is the shape the
 * off-switch and overnight-wait tests need, since the last-service fallback
 * deliberately makes the last-service variant return a journey at every
 * factor.
 */
/**
 * The trip ids of an itinerary's transit legs, in order, joined -- a compact
 * identity for "which rides is this journey made of", which is what every
 * margin test below actually asserts on.
 *
 * Since the planner merges the relaxed (flat-margin) search with the
 * configured one on every query, rather than running it only on an EMPTY
 * result (`plan.ts`'s query-level retry), a query whose best journey needs a
 * connection tighter than the margin wants returns BOTH: the
 * margin-respecting journey, unflagged, and the tight one, flagged
 * `transferAtRisk`. So an assertion of the form "exactly this one itinerary"
 * does not describe the contract; "this journey is present, and this is its
 * flag" does.
 *
 * That matters for more than tidiness. Several of these tests are the DIRECT
 * proof that a particular RAPTOR call site is handed `transfer` at all, and
 * they prove it by which single journey came back. The proof holds even
 * after merging both passes' results, because the margin-respecting pass
 * contributes a journey the relaxed pass cannot: delete `transfer` at the
 * call site and that journey stops existing, so asserting its PRESENCE still
 * fails exactly when the wiring is broken. Asserting the tight journey's
 * presence would not -- both passes find that one.
 */
const tripChain = (it: { legs: { tripId?: string }[] }): string =>
  it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId).join(",");

/**
 * The one itinerary whose rides are exactly `chain`, or a failed assertion
 * naming what did come back. Returns it so the caller can go on to assert
 * its `transferAtRisk`/times.
 */
function itineraryFor<T extends { legs: { tripId?: string }[] }>(
  itineraries: readonly T[], chain: string,
): T {
  const found = itineraries.filter((it) => tripChain(it) === chain);
  assert.equal(
    found.length, 1,
    `expected exactly one ${chain} itinerary, got [${itineraries.map(tripChain).join(" | ")}]`,
  );
  return found[0]!;
}

async function serveWithInfrequentTransfer(
  realtime: RealtimeStore | null, opts: { laterTrip?: boolean; altFeeder?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-infrequent-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
  `);
  if (opts.laterTrip === true) {
    raw.exec(`
      INSERT INTO trips VALUES (5,'T5','R103','S1','תחנה שלישית',0,NULL,0);
      INSERT INTO stop_times VALUES (5,2,1,32400,32400,0,1,0);
      INSERT INTO stop_times VALUES (5,5,2,33000,33000,1,0,900);
    `);
  }
  if (opts.altFeeder === true) {
    // An EARLIER R1 trip that reaches stop 2000 at 07:55:00 -- 1200 s ahead
    // of T4's 08:15:00 departure, so it clears the 600 s cap that T1's 300 s
    // does not. It departs stop 1000 at 07:30, BEFORE T1, which is what
    // makes the two distinguishable: the reverse pass maximises departure,
    // so it prefers T1 whenever T1 is legal and only reaches back to this
    // one when the margin refuses T1.
    raw.exec(`
      INSERT INTO trips VALUES (6,'T1E','R1','S1','הרצל',0,'SH1',1);
      INSERT INTO stop_times VALUES (6,1,1,27000,27000,0,1,0);
      INSERT INTO stop_times VALUES (6,2,2,28500,28500,1,0,1200);
    `);
  }
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}


test("arriveBy applies the headway-scaled margin too, and never falls back to a previous-day connection with an overnight wait", async () => {
  // Two regressions in one query, sharing a root cause.
  // `arriveBy=09:00` is trivially satisfied
  // by T4's own 08:25 arrival, so the only live question is whether T1->T4
  // BOARDING clears the real margin. It does not (same 300 s gap, same
  // NO_HEADWAY 600 s cap as the departAfter sibling test above).
  //
  // (1) This test alone is not a full proof that the third RAPTOR-shaped
  // call site -- the `arriveBy` branch's own `runRaptorReverse` -- is handed
  // `transfer`: because of the query-level retry, deleting `transfer`
  // from that branch produces the same same-day T1 -> T4 result as leaving
  // it wired (see the next test, which says so). What this test still
  // catches on that revert is the `transferAtRisk: true` assertion below:
  // without the margin the connection is not tight, so nothing is flagged.
  // The DIRECT proof that this call site carries the margin lives in "the
  // arriveBy call site carries the margin" further down, where the two
  // wirings pick visibly different trips.
  //
  // (2) With `transfer` wired but no wait bound, the reverse search does
  // not just come back empty when T1 fails the margin -- it falls back to
  // the PREVIOUS service day's T2 as a feeder into T4, satisfying the
  // margin trivially over a ~23h05m WAIT at stop 2000 (nothing bounds how
  // large a feeder-to-onward gap may be, only whether it clears the
  // margin). That itinerary's `arrivalTime` is close enough to the
  // deadline that `ARRIVE_BY_MAX_LOOKBACK_SECONDS` (24 h) never triggers,
  // but its `departureTime` is almost a full day earlier -- exactly the
  // "you waited overnight" case the "journeys get later, not fewer" rule
  // rules out, and `ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS` exists to reject.
  // (The bound is on the per-leg wait computed here, not on
  // `itin.durationSeconds` -- see that constant's own doc comment for why
  // that field is unreliable on this branch.)
  //
  // `laterTrip` is what keeps this test about the margin rather than about
  // the last-service fallback: with T5 running at 09:00 the onward pattern
  // HAS a later trip, so that fallback does not apply and the margin binds.
  // (T5 itself arrives 09:10, past the 09:00 deadline, so it cannot rescue
  // this query -- the reverse search still has nothing but the previous
  // day's T2, and the wait bound still has to reject it.)
  const { app, index } = await serveWithInfrequentTransfer(null, { laterTrip: true });
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T09:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        departureTime: string; transferAtRisk: boolean | null; legs: { tripId?: string }[];
      }[];
    };
    // What the margin-respecting search returns here is NOTHING, which
    // the query-level retry then answers with the flat rule's own
    // journey -- the same-day T1 -> T4, flagged. The assertion that matters
    // is which journey comes back: the overnight one is the failure this
    // test exists to catch, and it would come back if the wait bound were
    // removed, since the margin-respecting search would then have found it
    // and the retry would never have run.
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1", "T4"],
    );
    assert.ok(
      it.departureTime.startsWith("2026-08-24T"),
      `expected a same-day departure, got ${it.departureTime}`,
    );
    assert.equal(it.transferAtRisk, true, "the retry's journey must be flagged");
  } finally { await app.close(); index.stop(); }
});

test("the arriveBy call site carries the margin: it reaches back to an earlier feeder rather than take a refused connection", async () => {
  // The direct proof that the THIRD RAPTOR-shaped call site -- the
  // `arriveBy` branch's own `runRaptorReverse` -- is handed `transfer`.
  // The test above cannot carry that proof: because of the query-level
  // retry, deleting `transfer` there produces the same response
  // it does with `transfer` wired (empty-then-retry and
  // never-empty-in-the-first-place both end at the flat T1 -> T4).
  //
  // This fixture distinguishes them directly. T1E reaches stop 2000 at
  // 07:55, 1200 s before T4 leaves, and clears the margin; T1 reaches it at
  // 08:10, 300 s before, and does not. The reverse pass maximises departure,
  // so WITHOUT the margin it takes T1 (departing 08:00) and with it reaches
  // back to T1E (departing 07:30). Neither is empty, so the retry plays no
  // part.
  const { app, index } = await serveWithInfrequentTransfer(
    null, { laterTrip: true, altFeeder: true },
  );
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T09:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        departureTime: string; transferAtRisk: boolean | null; legs: { tripId?: string }[];
      }[];
    };
    // Both searches now run and are merged, so the response carries the
    // margin-respecting answer AND the relaxed one. The assertion that
    // proves this call site's wiring is the PRESENCE of the T1E chain:
    // only a pass that actually charges the margin refuses T1's 300 s
    // connection and reaches back to the 07:30 feeder, so deleting
    // `transfer` here deletes this itinerary. See `tripChain`'s own comment.
    assert.equal(body.itineraries.length, 2);
    const safe = itineraryFor(body.itineraries, "T1E,T4");
    assert.equal(safe.departureTime, "2026-08-24T07:30:00+03:00");
    // This connection satisfies the margin outright, so nothing is flagged
    // -- which also pins that the flag is not simply always true on this
    // fixture.
    assert.notEqual(safe.transferAtRisk, true);
    // And the relaxed search's own answer -- the tight T1 connection the
    // margin refused -- comes back alongside it, labelled rather than
    // silently dropped.
    assert.equal(itineraryFor(body.itineraries, "T1,T4").transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("arriveBy yields to the flat margin at the last service of the day, flagged at risk", async () => {
  // The last-service fallback, the reverse half. The SAME query as the test above, on the
  // same fixture minus T5: T4 is now R103's last service of the day, so
  // refusing T1's 300 s connection does not push the rider onto a later
  // trip -- it deletes the only journey there is. The reverse pass charges
  // the flat 60 s buffer instead and returns it, and the rider is told.
  const { app, index } = await serveWithInfrequentTransfer(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T09:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: { transferAtRisk: boolean | null; legs: { tripId?: string }[] }[];
    };
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1", "T4"],
    );
    // No realtime store is configured here at all, so this `true` can only
    // have come from the SCHEDULE -- which is the whole point: the rider is
    // owed the warning whether or not a SIRI feed exists.
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("arriveBy at TRANSFER_HEADWAY_FACTOR=0 returns the ordinary flat-margin itinerary", async () => {
  // Renamed from "arriveBy's wait bound does not fire at
  // TRANSFER_HEADWAY_FACTOR=0 either", which overstated it: this fixture's
  // transfer wait is 300 s against a 12-hour bound, so the bound does not
  // fire here whether or not it is gated, and this test passes with the gate
  // deleted. It is the off-switch half of the pair above and nothing more.
  //
  // The gate's real proof is "the wait bound is genuinely gated on the
  // feature, not just on reachability" below, whose fixture has an inherent
  // ~12h50m wait and which DOES fail when the gate is removed. Kept separate
  // rather than folded into that one because the shapes differ: this asserts
  // the flat rule's own answer on the last-service fixture, which the retry
  // makes reachable at both factors and which is worth pinning in its own right.
  const { app, index } = await serveWithInfrequentTransfer(null, { laterTrip: true });
  try {
    const res = await withHeadwayFactor(0, () => app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T09:00:00%2B03:00",
    }));
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: { legs: { tripId?: string }[] }[] };
    assert.equal(body.itineraries.length, 1);
    assert.deepEqual(
      body.itineraries[0]!.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1", "T4"],
    );
  } finally { await app.close(); index.stop(); }
});

/**
 * `serveWithInfrequentTransfer`'s own pathological-fallback fixture happens
 * to be a WEAK proof of the gate above: at factor 0 the flat margin makes
 * T1->T4 directly reachable, so the reverse search never even reaches for
 * the previous-day fallback in the first place -- the wait bound is
 * trivially satisfied (a 300 s gap) whether or not it is gated. That is not
 * evidence the gate matters; a genuinely UNgated bound would pass that test
 * too.
 *
 * This fixture isolates the gate itself: T4X departs at 22:00:00, ~13h50m
 * after TFEED's 08:10:00 arrival -- a gap so large that it clears EITHER
 * margin trivially (flat 60 s or the headway-scaled 600 s NO_HEADWAY cap
 * both vanish next to 49800 s), so REACHABILITY never depends on the
 * feature at all. The only thing that can make this itinerary disappear is
 * `maxTransferWaitSeconds` itself -- which is exactly why the gate has to
 * be on `transfer.cfg.factor !== 0`, checked at the discard site, not on
 * whether the connection was headway-refused.
 *
 * The wait is deliberately carried by a feeder of this fixture's OWN (TFEED
 * into stop 8000, which nothing else serves) rather than by the shared
 * fixture's R1: the shared fixture also runs line 67003 over 1000 -> 2000 in
 * the early afternoon, and boarding T4X off THAT would be a wait of only
 * ~8h50m -- under the bound, kept at either factor, and so no proof of
 * anything. Keeping the long wait on a stop of our own pins it at 13h50m.
 */
async function serveWithInherentlyLongWait(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-long-wait-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO routes VALUES ('R108','2','8','קו ההזנה','67008-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    -- Well outside any walking radius of the fixture's own stops: the ONLY
    -- way to stop 8000 is TFEED, so the wait onto T4X is fixed at 13h50m.
    INSERT INTO stops VALUES (8,'8000','38838','תחנת ההמתנה',NULL,32.3000,35.0000,0,NULL,'z1');
    INSERT INTO trips VALUES (8,'TFEED','R108','S1','תחנת ההמתנה',0,NULL,0);
    INSERT INTO stop_times VALUES (8,1,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (8,8,2,29400,29400,1,0,1200);
    INSERT INTO trips VALUES (4,'T4X','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,8,1,79200,79200,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,79800,79800,1,0,900);

    -- A second, SHORT-WAIT route to stop 5000, deliberately costing one more
    -- transfer than the long-wait chain above. Without it, discarding the
    -- long-wait itinerary empties the response, and the query-level
    -- retry answers an empty response with the flat rule -- which returns
    -- the very journey the bound rejected, making the bound unobservable at
    -- the response boundary. With it, the discard is observable as a
    -- SURVIVOR count instead: one itinerary with the feature on, two at
    -- factor 0. Every wait here is 900 s, comfortably clear of the 600 s
    -- NO_HEADWAY cap each of these single-trip routes attracts, so the
    -- margin never refuses any of these three connections.
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי','67004-1-#',3,NULL);
    INSERT INTO routes VALUES ('R105','2','5','קו חמישי','67005-1-#',3,NULL);
    INSERT INTO routes VALUES ('R106','2','6','קו שישי','67006-1-#',3,NULL);
    INSERT INTO stops VALUES (6,'6000','38836','תחנה רביעית',NULL,32.0800,34.7600,0,NULL,'z1');
    INSERT INTO stops VALUES (7,'7000','38837','תחנה חמישית',NULL,32.0900,34.7500,0,NULL,'z1');
    INSERT INTO trips VALUES (5,'T5','R104','S1','תחנה רביעית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,1,1,72000,72000,0,1,0);
    INSERT INTO stop_times VALUES (5,6,2,73200,73200,1,0,900);
    INSERT INTO trips VALUES (6,'T6','R105','S1','תחנה חמישית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,6,1,74100,74100,0,1,0);
    INSERT INTO stop_times VALUES (6,7,2,75300,75300,1,0,900);
    INSERT INTO trips VALUES (7,'T7','R106','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (7,7,1,76200,76200,0,1,0);
    INSERT INTO stop_times VALUES (7,5,2,77400,77400,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * The CHAIN effect the last-service fallback's per-connection handling
 * cannot close, and the reason the query-level retry exists.
 *
 * R103 runs T4 (08:15 -> 08:25) and T5 (09:00 -> 09:10) to stop 5000, so its
 * 2700 s gap is measurable and boarding it costs the full 600 s cap. T1
 * reaches stop 2000 at 08:10, only 240 s of margin ahead of T4, so the rule
 * refuses that connection -- correctly, and WITHOUT the last-service
 * fallback, because R103 genuinely does run again at 09:00.
 *
 * The journey dies at the NEXT leg. R104's only trip leaves stop 5000 at
 * 08:30, which T4 makes with 300 s to spare and T5 (arriving 09:10) misses
 * by forty minutes. Every individual connection was handled correctly and
 * the rider still ends up with nothing. No per-connection rule can see this:
 * at the interchange where the margin bites, a later trip really does exist.
 */
async function serveWithChainEffect(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-chain-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי','67004-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'6000','38836','תחנה רביעית',NULL,32.0800,34.7600,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
    INSERT INTO trips VALUES (5,'T5','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,32400,32400,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,33000,33000,1,0,900);
    INSERT INTO trips VALUES (6,'T6','R104','S1','תחנה רביעית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,5,1,30600,30600,0,1,0);
    INSERT INTO stop_times VALUES (6,6,2,31200,31200,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

test("the query-level retry: an empty margin-respecting result falls back to the flat rule for the whole query", async () => {
  // The guarantee, end to end on `departAfter`: no query is left EMPTY that
  // the flat rule could answer. Note the exact wording -- the retry is gated
  // on `length === 0`, not on parity, so a query that merely loses some
  // Pareto members to the margin is untouched by it and SHOULD be (see
  // `plan.ts`'s own comment for the measured numbers). The margin-respecting
  // search comes back empty here (see the fixture: a chain effect, not a
  // last-service connection), and the retry hands back exactly the
  // itinerary the pre-branch planner returned -- every transfer the rule
  // wanted more slack for flagged.
  const { app, index } = await serveWithChainEffect(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:6000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        departureTime: string; arrivalTime: string; transferAtRisk: boolean | null;
        legs: { tripId?: string }[];
      }[];
    };
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1", "T4", "T6"],
    );
    assert.equal(it.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:40:00+03:00");
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("the relaxed search returns exactly what factor 0 returns, and is merged rather than replacing the margin's own answer", async () => {
  // Two halves of the same claim. The relaxed search's output must be the
  // flat planner's own output, not some third thing -- and where the
  // margin-respecting search HAS an answer, that answer must survive the
  // merge rather than be replaced by the relaxed one.
  const { app, index } = await serveWithChainEffect(null);
  try {
    const empty = "/plan?from=stop:1000&to=stop:6000&departAfter=2026-08-24T07:30:00%2B03:00";
    const retried = await app.inject({ url: empty });
    const flat = await withHeadwayFactor(0, () => app.inject({ url: empty }));
    interface Body { itineraries: Record<string, unknown>[] }
    const strip = (r: { json: () => unknown }): unknown[] =>
      (r.json() as Body).itineraries.map((it) => {
        // `transferAtRisk` is the ONE field that legitimately differs: the
        // retry annotates against the CONFIGURED margin, so it flags what
        // the rule wanted, while a genuine factor-0 request has no scaled
        // rule to fall short of.
        const rest = { ...it };
        delete rest.transferAtRisk;
        return rest;
      });
    assert.deepEqual(strip(retried), strip(flat));
    assert.equal((retried.json() as { itineraries: { transferAtRisk: unknown }[] })
      .itineraries[0]!.transferAtRisk, true);
    assert.equal((flat.json() as { itineraries: { transferAtRisk: unknown }[] })
      .itineraries[0]!.transferAtRisk, null);

    // A query the margin answers on its own: stop 5000 is reachable via T5
    // without the refused connection mattering. The margin's own answer
    // (T1 -> T5, the LATER trip it pushed the rider onto) must still be
    // there -- that is what proves the configured search ran and that its
    // margin actually bound -- and the relaxed search's tight T1 -> T4 now
    // comes back beside it, flagged, instead of being dropped for costing
    // the rider 45 minutes less than the "safe" answer.
    const notEmpty = "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00";
    const res = await app.inject({ url: notEmpty });
    const body = res.json() as {
      itineraries: { transferAtRisk: boolean | null; legs: { tripId?: string }[] }[];
    };
    assert.equal(body.itineraries.length, 2);
    assert.notEqual(itineraryFor(body.itineraries, "T1,T5").transferAtRisk, true);
    assert.equal(itineraryFor(body.itineraries, "T1,T4").transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("the wait bound is genuinely gated on the feature, not just on reachability", async () => {
  const { app, index } = await serveWithInherentlyLongWait(null);
  try {
    const url = "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T23:00:00%2B03:00";

    interface WaitItinerary { legs: { tripId?: string }[] }
    const trips = (body: { itineraries: WaitItinerary[] }): string[][] =>
      body.itineraries.map(
        (it) => it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId!),
      );

    const withHeadway = await app.inject({ url });
    assert.equal(withHeadway.statusCode, 200);
    // With the feature ON, the ~13h50m wait between TFEED's 08:10 arrival and
    // T4X's 22:00 departure exceeds ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS
    // (12 h) and that itinerary is refused. The one-more-transfer chain
    // survives, so the response is not empty -- which matters: an empty
    // response would be answered by the query-level retry with the flat rule,
    // and the flat rule returns the very itinerary the bound just rejected.
    assert.deepEqual(trips(withHeadway.json() as { itineraries: WaitItinerary[] }), [
      ["T5", "T6", "T7"],
    ]);

    const flat = await withHeadwayFactor(0, () => app.inject({ url }));
    assert.equal(flat.statusCode, 200);
    // At factor 0 the SAME ~13h50m wait must survive: the gate, not the
    // reachability check, is what makes the difference here. Both chains
    // come back -- the long-wait one at one transfer, the short-wait one at
    // two -- and neither is margin-refused at any factor.
    //
    // ORDER CHANGED, deliberately, now that the departure window is
    // switched off for `arriveBy` (see the `exempt` comment at plan.ts's
    // ranking call site). The set is identical; only which comes first moved,
    // and the previous order was the window INVERTING. `TFEED -> T4X` departs
    // in the morning and spends ~13h50m of it standing at stop 8000; `T5 -> T6
    // -> T7` departs 20:00 and takes 90 minutes. With the ARRIVAL pinned by
    // the query at 23:00 the second is unambiguously the better journey for
    // the rider and is roughly eight times cheaper under `journeyCost` -- yet
    // an unexempted window would rank it SECOND, purely because the window
    // anchors on the earliest departure and demotes anything departing more
    // than 30 minutes after it. This assertion is the regression test for
    // that.
    assert.deepEqual(trips(flat.json() as { itineraries: WaitItinerary[] }), [
      ["T5", "T6", "T7"],
      ["TFEED", "T4X"],
    ]);
  } finally { await app.close(); index.stop(); }
});

/**
 * Reaching the destination DIRECTLY by transit (as every earlier `arriveBy`
 * fixture in this file does) cannot exercise the
 * `arrivalTime`-reports-the-deadline defect described in
 * `ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS`'s own doc comment -- a
 * duration-based bound would pass every OTHER test in this file while still
 * being wrong, because a test built on `serveWithTransfer` (T1 alights AT
 * the query's own destination stop) never produces the shape the defect
 * needs. The mechanism, traced in `raptorReverse.ts`: `relaxFootpathsReverse`
 * writes a walk label's `alightEpoch: label.departureEpoch`
 * (`raptorReverse.ts:190-193`); when that walk is the LAST leg of the
 * chain -- a footpath INTO the destination -- the label it was relaxed from
 * is the round-0 EGRESS label, whose `departureEpoch` is `arriveByEpoch -
 * secondsToReach`, i.e. the deadline. `reconstructReverseChain` copies that
 * straight into `arrivalEpoch`, and `buildItinerary` anchors the whole
 * itinerary's `arrivalTime` on it. So a chain ending in a footpath is what
 * makes `durationSeconds` (deadline-derived) diverge from the real,
 * short ride -- and only that shape can actually pin the fix.
 *
 * Stop 5000 here has NO transit service of its own -- T1 alights at stop
 * 2000, ~73 m away, and the only way to reach 5000 is the INDEX-level
 * footpath `attachFootpaths` builds between them (mirrors
 * `reload-footpaths.test.ts`'s own `addWalkTransferStops` fixture, which
 * found the same footpath-reachability shape for a different bug). Querying
 * `to=stop:5000` therefore forces `dest.secondsToReach = 0` (a bare `stop:`
 * endpoint) and the chain's LAST leg is that footpath, not a transit leg --
 * exactly the shape needed.
 */
async function serveWithFootpathEgress(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-footpath-egress-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO stops VALUES (5,'5000',NULL,'תחנה חדשה',NULL,32.0605,34.7755,0,NULL,'z1');
  `);
  raw.close();

  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 100, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

test("a legitimate long-lead-time arriveBy journey survives the wait bound", async () => {
  // T1 (08:00 -> 08:10) plus a short footpath to stop 5000 is the whole
  // journey -- no transfer at all, so `maxTransferWaitSeconds` (which only
  // ever measures a gap BETWEEN two transit legs) is 0 regardless of the
  // deadline: the fixed bound must never reject this. A duration-based bound
  // would: with the deadline set to 20:00 -- many hours past the real
  // ~08:11 door arrival -- `itin.durationSeconds` (deadline-anchored on
  // this branch; see `ARRIVE_BY_MAX_TRANSFER_WAIT_SECONDS`'s own doc
  // comment) balloons to roughly 12 h, which a 6 h duration cap would
  // refuse. This fixture is what actually catches a duration-based bound
  // being used here instead of the wait-based one.
  const { app, index } = await serveWithFootpathEgress(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T20:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: { legs: { type: string; tripId?: string }[] }[];
    };
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    // T102 (13:00), the shared fixture's latest run into stop 2000 before
    // the deadline -- every candidate reaches stop 5000 comfortably inside
    // 20:00, and the reverse search maximises departure, so it correctly
    // prefers the last one. Which trip is irrelevant to what this test
    // checks; only that ONE survives, with a footpath tail.
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T102"],
    );
    assert.equal(it.legs[it.legs.length - 1]!.type, "walk", "must end on the footpath into 5000");
  } finally { await app.close(); index.stop(); }
});

test("a tight interchange onto an infrequent service is offered ALONGSIDE the later trip, flagged", async () => {
  const { app, index } = await serveWithInfrequentTransfer(null, { laterTrip: true });
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        arrivalTime: string; transferAtRisk: boolean | null; legs: { tripId?: string }[];
      }[];
    };
    // The 300 s gap after T1 does not clear R103's 600 s cap, so the
    // margin-respecting search refuses T4 and takes T5 instead -- "later,
    // not fewer". That journey is still here, and still unflagged,
    // because its connection genuinely satisfies the margin.
    //
    // Refusing T4 costs this rider 45 minutes (08:25 -> 09:10), and silently
    // charging them that cost is the wrong trade far more often than not --
    // measured against a reference planner on 11 real trips, the margin gave
    // up 42 minutes of arrival time in total, worse on 6 of 11, to insure
    // against misses that could never have cost that much (see plan.ts's own
    // comment at the merge). Missing T4 costs exactly one headway, and the
    // rider lands on T5 -- which is the "safe" answer anyway. So both are
    // offered, and the tight one carries `transferAtRisk` so the choice is
    // the rider's and not silently ours.
    assert.equal(body.itineraries.length, 2);
    const later = itineraryFor(body.itineraries, "T1,T5");
    assert.equal(later.arrivalTime, "2026-08-24T09:10:00+03:00");
    assert.notEqual(later.transferAtRisk, true);
    const tight = itineraryFor(body.itineraries, "T1,T4");
    assert.equal(tight.arrivalTime, "2026-08-24T08:25:00+03:00");
    assert.equal(tight.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("at the last service of the day the tight interchange is offered instead, flagged at risk", async () => {
  // The last-service fallback, the forward half: the SAME fixture as above minus T5, so T4
  // is R103's last service. Without this yield, the query returns HTTP 200
  // with an empty `itineraries` array -- the worst possible answer for
  // someone standing at a stop -- because the search would otherwise assume
  // a later trip always exists to be pushed onto. It does not, and the flat
  // 60 s margin (which this connection's 300 s clears comfortably) is
  // exactly what the planner requires without the headway-scaled rule, so
  // yielding to it can never make boarding harder than it already was.
  const { app, index } = await serveWithInfrequentTransfer(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        departureTime: string; arrivalTime: string; transfers: number;
        transferAtRisk: boolean | null; legs: { tripId?: string }[];
      }[];
    };
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1", "T4"],
    );
    assert.equal(it.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:25:00+03:00");
    // Told, not silently handed a connection tighter than the rule wanted --
    // and with no realtime store configured, this can only be the schedule
    // speaking.
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("with TRANSFER_HEADWAY_FACTOR=0 the response is identical to today's", async () => {
  const { app, index } = await serveWithInfrequentTransfer(null, { laterTrip: true });
  try {
    const url = "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00";
    const withHeadway = await app.inject({ url });
    const flat = await withHeadwayFactor(0, () => app.inject({ url }));

    assert.equal(withHeadway.statusCode, 200);
    assert.equal(flat.statusCode, 200);

    // The feature genuinely changes this query's outcome -- otherwise the
    // factor-0 comparison below would be vacuous, not a real off switch.
    // `laterTrip` is what makes it change: without T5, the last-service
    // fallback would hand back the same T1 -> T4 journey at BOTH factors (flagged at the
    // default one), and this test would prove nothing.
    interface HeadwayItinerary {
      arrivalTime: string; transferAtRisk: boolean | null; legs: { tripId?: string }[];
    }
    const withHeadwayBody = withHeadway.json() as { itineraries: HeadwayItinerary[] };
    // At the default factor the response carries BOTH the margin's own
    // answer (T1 -> T5, unflagged) and the relaxed search's tight T1 -> T4,
    // flagged. At factor 0 below it carries only the latter, and unflagged
    // -- which is what makes this a real off switch rather than a vacuous
    // comparison: the feature changes both the SET and the flags.
    assert.equal(withHeadwayBody.itineraries.length, 2);
    assert.notEqual(itineraryFor(withHeadwayBody.itineraries, "T1,T5").transferAtRisk, true);
    assert.equal(itineraryFor(withHeadwayBody.itineraries, "T1,T4").transferAtRisk, true);

    // Factor 0 restores exactly the flat-buffer itinerary this connection
    // has always produced: T1 -> T4, 08:00:00 -> 08:25:00, one transfer.
    // `requiredTransferSeconds` short-circuits to `cfg.baseSeconds`
    // unconditionally at factor 0 (`headway.ts`), so this is the same
    // computation the pre-headway planner always did.
    interface FlatItinerary {
      departureTime: string; arrivalTime: string; transfers: number;
      legs: { tripId?: string }[];
    }
    const flatBody = flat.json() as { itineraries: FlatItinerary[] };
    assert.equal(flatBody.itineraries.length, 1);
    const it = flatBody.itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1", "T4"],
    );
    assert.equal(it.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:25:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("transferAtRisk uses the same margin the planner used", async () => {
  // R103's real headway (via T4E, see serveWithTransfer's own doc comment)
  // scales this transfer's required margin to 90 s -- ABOVE the flat 60 s
  // floor. A predicted arrival landing in the 30 s gap between the two
  // (08:13:55: 65 s before T4's 08:15:00 departure) is SAFE under the flat
  // rule and AT RISK under the real one. `transferAtRisk` must agree with
  // the search that built this itinerary, which no longer uses the flat
  // rule -- reporting `false` here would contradict RAPTOR's own margin.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const predictedArrival = Date.parse("2026-08-24T08:13:55+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.equal(
      it.transferAtRisk, true,
      "flat 60s margin would call this safe (65s of slack); the real 90s headway margin does not",
    );
  } finally { await app.close(); index.stop(); }
});

/**
 * Coverage for the THIRD call site.
 * `reoptimiseBounded`'s `reverseQuery` (built in `plan.ts`, fed straight
 * into `reoptimise.ts`'s own internal `runRaptorReverse` call) must carry
 * the SAME `transfer` the forward search used, or nothing fails to
 * typecheck and no other test in this file would catch it: the reoptimised
 * departure would simply become quietly more optimistic than the search
 * that actually built the itinerary allows.
 *
 * TX shares T1's pattern (stops 1000 -> 2000), departing 5 minutes later
 * (08:05:00 vs T1's 08:00:00) and, unlike `serveWithExpressTrip`'s TX,
 * arriving 50 s later too (08:10:50 vs T1's 08:10:00) -- both trips stay
 * jointly non-decreasing in departure AND arrival, so `buildPatterns` keeps
 * them in one pattern (`overtakes`, `patterns.ts`), which is what lets the
 * reverse pass's binary search consider TX as a later-departing alternative
 * to T1 at all.
 *
 * R103 (T4) is a single-trip pattern -- `NO_HEADWAY`, charged the full
 * `TRANSFER_MAX_SECONDS` cap (600 s by default) on every boarding of it,
 * the same in every hour since every hour is equally unmeasured. T4 departs
 * at exactly T1's arrival plus that cap (08:20:00 = 08:10:00 + 600 s): T1's
 * connection clears it AT the boundary (`ready <= currentDep`), while TX's
 * 50-s-later arrival overshoots T4's departure by 50 s and does not. The
 * flat 60 s rule would accept EITHER (TX's arrival + 60 s clears T4's
 * departure with over 4 minutes to spare) -- so a reoptimised departure of
 * 08:05:00 (TX) instead of the correct 08:00:00 (T1) is exactly what a
 * `reverseQuery` that lost its `transfer` field would report.
 */
async function serveWithHeadwaySensitiveReoptimise() {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-reopt-headway-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO trips VALUES (4,'TX','R1','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (4,1,1,29100,29100,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29450,29450,1,0,700);

    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (5,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,30000,30000,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,30600,30600,1,0,900);

    -- T6 exists only so T4 is not R103's LAST service of the day. Without it,
    -- the last-service fallback applies to the TX -> T4 connection and TX
    -- becomes a legal (later) departure after all, which would quietly turn
    -- this test into a test of the fallback instead of a test that
    -- reoptimise.ts's own reverse query carries the transfer margin. It
    -- departs late enough (10:00) never to be part of any itinerary here.
    INSERT INTO trips VALUES (6,'T6','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,2,1,36000,36000,0,1,0);
    INSERT INTO stop_times VALUES (6,5,2,36600,36600,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

test("reoptimise honours the headway-scaled margin, not just the initial forward search", async () => {
  const { app, index } = await serveWithHeadwaySensitiveReoptimise();
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        departureTime: string; arrivalTime: string; transfers: number;
        transferAtRisk: boolean | null; legs: { tripId?: string }[];
      }[];
    };
    // The claim this test carries: `reoptimiseBounded` must not hand the
    // rider TX's later departure as though the margin allowed it. That is
    // still asserted, and it is still the UNFLAGGED itinerary that carries
    // it -- the margin-respecting search reports T1's own 08:00 departure,
    // and deleting `transfer` from reoptimise makes this entry report TX's
    // 08:05 instead, failing here exactly as it always did.
    //
    // The relaxed search legitimately finds boarding TX as well (a flat 60 s
    // buffer clears that connection), so it comes back as a SEPARATE,
    // flagged itinerary. That is the merge working, not reoptimise leaking:
    // the distinction that matters is that the 08:05 departure is never
    // attached to the unflagged journey.
    assert.equal(body.itineraries.length, 2);
    const it = itineraryFor(body.itineraries, "T1,T4");
    assert.equal(it.transfers, 1);
    assert.equal(it.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:30:00+03:00");
    assert.notEqual(it.transferAtRisk, true);
    const viaTx = itineraryFor(body.itineraries, "TX,T4");
    assert.equal(viaTx.departureTime, "2026-08-24T08:05:00+03:00");
    assert.equal(viaTx.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});


/**
 * `transferAtRisk` must use the window-MAXIMUM rule
 * the REVERSE pass actually charges for a reverse-built itinerary, not the
 * forward pass's pointwise rule -- the two disagree whenever the reverse
 * pass's 9-minute readiness window (`capSeconds - baseSeconds` at the
 * shipped defaults) crosses an hour boundary into a worse-headway hour, and
 * the forward rule, evaluated at the earlier (better) hour, is an
 * UNDER-estimate: using it would make `computeTransferAtRisk` less willing
 * to say `true`, the PERMISSIVE direction, not the safe one.
 *
 * T1B and T1B2 (two further R1 trips, distinct from the shared fixture's
 * T1) both arrive stop 2000 in hour 7 -- 07:50:00 and 07:55:00
 * respectively. R103's pattern is engineered so hour 7 has a small MEASURED
 * headway (T4a/T4b/T4c, 180 s apart, median 180 s -> a 45 s scaled margin,
 * floored to the 60 s base) while hour 8 -- the hour T4 (08:05:00) actually
 * departs in -- has none at all (T4 is the pattern's last trip ever, so no
 * gap is ever attributed to hour 8): NO_HEADWAY, charged the full 600 s
 * cap. The forward rule, evaluated at either feeder's own candidate
 * boarding instant (both hour 7), would say 60 s; the reverse pass, whose
 * 9-minute window includes T4's own hour 8 (`hTo = floor(departEpoch /
 * 3600)`, always at least the onward service's own hour), charges the
 * window-maximum: 600 s -- identically for both feeders, since the
 * divergence depends only on T4's own pattern and hour, not on which
 * feeder boards it.
 *
 * Two feeders, not one, because this fixture is shared by two tests below:
 * a plain `arriveBy` query (which -- since it maximises departure directly
 * -- prefers T1B2, the later of the two) and a `departAfter` query whose
 * `reoptimiseBounded` swaps the FORWARD pass's own T1B for the
 * later-departing T1B2, making that itinerary reverse-sourced too. Each
 * test's own predicted-delay comment states which trip it targets and why.
 */
async function serveWithReverseWindowMargin(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-plan-reverse-window-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');

    INSERT INTO trips VALUES (4,'T1B','R1','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (4,1,1,27600,27600,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,28200,28200,1,0,1200);

    INSERT INTO trips VALUES (5,'T4a','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,25200,25200,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,25800,25800,1,0,900);
    INSERT INTO trips VALUES (6,'T4b','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,2,1,25380,25380,0,1,0);
    INSERT INTO stop_times VALUES (6,5,2,25980,25980,1,0,900);
    INSERT INTO trips VALUES (7,'T4c','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (7,2,1,25560,25560,0,1,0);
    INSERT INTO stop_times VALUES (7,5,2,26160,26160,1,0,900);

    INSERT INTO trips VALUES (8,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (8,2,1,29100,29100,0,1,0);
    INSERT INTO stop_times VALUES (8,5,2,29700,29700,1,0,900);

    -- T1B2: a THIRD R1 trip, later than T1B (07:45:00 -> 07:55:00), added
    -- for the departAfter/reoptimise companion test below. It ALSO clears
    -- T4's real 600 s reverse-pass requirement (600 s gap, at the
    -- boundary), so the reverse search can find it as a later-departing,
    -- same-arrival, same-transfer-count alternative to T1B -- exactly what
    -- reoptimiseBounded looks for. tripIdx 8 (trip_ref 9).
    INSERT INTO trips VALUES (9,'T1B2','R1','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (9,1,1,27900,27900,0,1,0);
    INSERT INTO stop_times VALUES (9,2,2,28500,28500,1,0,1200);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

test("transferAtRisk uses the reverse pass's window-maximum rule for a reverse-built itinerary", async () => {
  // Boards T1B2 (tripIdx 8), not T1B: with T1B2 now in the fixture (added
  // for the departAfter/reoptimise companion test below), the arriveBy
  // reverse search -- which maximises departure directly -- prefers T1B2's
  // later 07:45:00 over T1B's 07:40:00, since both clear T4's real 600 s
  // requirement identically (same pattern, same hour). Same margin
  // arithmetic either way; only which trip is predicted late changes.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const predictedArrival = Date.parse("2026-08-24T08:00:00+03:00") / 1000; // T1B2: 5 min late
  store.replace(
    [{ tripIdx: 8, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithReverseWindowMargin(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&arriveBy=2026-08-24T09:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: RtItinerary[] };
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.equal(
      it.transferAtRisk, true,
      "the forward rule's 60s (evaluated at T1B's hour 7) would call this " +
      "safe with 240s of slack; the reverse pass's real 600s requirement " +
      "(T4's own hour 8, NO_HEADWAY) does not -- it is 300s short",
    );
  } finally { await app.close(); index.stop(); }
});

test("transferAtRisk uses the reverse pass's rule for a reoptimised departAfter itinerary too", async () => {
  // The sibling of the test above, on the OTHER branch that can produce a
  // reverse-sourced itinerary. 64% of
  // real-feed `departAfter` itineraries are reverse-sourced (reoptimised
  // onto a reverse-pass chain) -- a regression here silently restores the
  // exact permissive `transferAtRisk: false` defect on the MAJORITY of
  // `departAfter` responses, and nothing in the suite asserted it: the
  // existing "reoptimise honours the headway-scaled margin" test (this
  // file, `serveWithHeadwaySensitiveReoptimise`) has no second transit leg
  // to form a transfer at all, and forcing `reverseSourced.push(false)`
  // unconditionally on the departAfter branch still passes 49/49 without
  // this test.
  //
  // T1B (07:40 -> 07:50) is what the FORWARD pass finds first (earliest
  // departure after the query instant); `reoptimiseBounded` then finds
  // T1B2 (07:45 -> 07:55) as a later-departing, same-arrival (T4's fixed
  // 08:15:00), same-transfer-count alternative -- T1B2 clears T4's real
  // 600 s reverse-pass requirement (600 s gap, at the boundary) -- and
  // swaps to it, making this itinerary reverse-sourced
  // (`built.legs !== raw.legs`). T1B2 is then predicted 5 minutes late
  // (07:55:00 -> 08:00:00), leaving 300 s before T4's 08:05:00 departure:
  // safe under the forward rule's 60 s (same hour-7 measurement as T1B),
  // at risk under the reverse pass's real 600 s (300 s short) -- identical
  // margin arithmetic to the arriveBy test above, on the branch it does
  // not cover.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const predictedArrival = Date.parse("2026-08-24T08:00:00+03:00") / 1000; // T1B2: 5 min late
  store.replace(
    [{ tripIdx: 8, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithReverseWindowMargin(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: RtItinerary[] };
    assert.equal(body.itineraries.length, 1);
    const it = body.itineraries[0]!;
    assert.equal(it.transfers, 1);
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T1B2", "T4"],
      "reoptimise must actually have swapped onto T1B2 for this test to mean anything",
    );
    assert.equal(
      it.transferAtRisk, true,
      "the forward rule's 60s (evaluated at T1B2's hour 7) would call this " +
      "safe with 240s of slack; the reverse pass's real 600s requirement " +
      "(T4's own hour 8, NO_HEADWAY) does not -- it is 300s short",
    );
  } finally { await app.close(); index.stop(); }
});

// Pins why the nearest-stop fallback takes SEVERAL candidates, not one: with
// N=1 the fallback could only ever offer stopA, the single crow-flight
// nearest -- but the caller's own Valhalla stub makes stopA's real walk so
// slow that its only trip has already left by the time a rider would arrive.
// A rider is only actually served here because the fallback's fifth
// candidate, stopB, is genuinely closer on foot despite being farther away
// as the crow flies. See `serveWithNearestFallback`'s own doc comment for
// the exact numbers. Reverting the fallback to a single nearest candidate
// (or reverting it away entirely) makes this test fail -- either stopA is
// the only candidate and its trip is unboardable (no itinerary at all), or
// the query 422s outright.
test("the nearest-on-foot candidate wins over a crow-flight-nearer one, because the fallback tries several", async () => {
  const { app, index } = await serveWithNearestFallback();
  try {
    const res = await app.inject({
      // maxWalkMeters=50 keeps the ordinary haversine prefilter empty for
      // every one of the six custom stops (nearest is 300 m away), so this
      // exercises the fallback from the very first filtering stage.
      url: "/plan?from=32.2000,34.9000&to=stop:1000"
        + "&departAfter=2026-08-24T08:00:00%2B03:00&maxWalkMeters=50",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      query: { accessStops: number };
      itineraries: { legs: {
        type: string; tripId?: string;
        from: { stop?: { stopId: string } }; durationSeconds: number;
      }[] }[];
    };

    // Exactly five candidates were routed through the (uncapped) refinement
    // call -- not one, and not six (stopC, the sixth-nearest, is excluded).
    assert.equal(body.query.accessStops, 5);

    assert.ok(body.itineraries.length >= 1);
    const it = body.itineraries[0]!;
    const walk = it.legs.find((l) => l.type === "walk")!;
    const transit = it.legs.find((l) => l.type === "transit")!;

    // The real, closer-on-foot walk to stopB was used -- not the
    // crow-flight-nearer, real-walk-slower stopA, and not stopC's faster
    // trip (which was never even a candidate).
    assert.equal(walk.durationSeconds, 120);
    assert.equal(transit.tripId, "TB");
    assert.equal(transit.from.stop?.stopId, "9000");
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// Round 0's access labels plus footpath relaxation reach
// the destination with zero boardings, and `paretoRounds` picks it -- an
// itinerary of pure walking reported as `transfers: 0`. Nothing transit-based
// connects this pair, so the correct response is now EMPTY rather than a walk.
test("/plan returns nothing rather than a walk-only itinerary", async () => {
  const { app, index } = await serveEffort();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${WALK_FROM}&to=${WALK_TO}&departAfter=${encodeURIComponent(DEPART)}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: { legs: { type: string }[] }[] };
    assert.deepEqual(body.itineraries, [], "a walk-only itinerary was returned");
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// The invariant, asserted on a query that DOES have transit answers, so it
// cannot pass vacuously the way the empty case above would.
test("/plan never returns an itinerary without a transit leg", async () => {
  const { app, index } = await serveEffort();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(DEPART)}`,
    });
    const body = res.json() as { itineraries: { legs: { type: string }[] }[] };
    assert.ok(body.itineraries.length > 0);
    for (const itin of body.itineraries) {
      assert.ok(
        itin.legs.some((leg) => leg.type === "transit"),
        "a returned itinerary had no transit leg at all",
      );
    }
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// At this point the forward search finds only journey A (B is dominated on
// arrival and needs the reverse probe), so the cap is not yet exercised by a
// surplus of candidates. The assertion still pins the contract that the
// slice happens at the ranking site rather than inside `search`.
test("/plan returns at most `results` itineraries after ranking", async () => {
  const { app, index } = await serveEffort();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(DEPART)}&results=1`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.equal(body.itineraries.length, 1);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// The reverse probe, and the reason the whole feature exists. Journey B departs
// 20 minutes LATER (08:20 vs 08:00) and arrives 4 minutes LATER (08:29:30 vs
// 08:25:15) than journey A, so it is dominated on arrival and an
// earliest-arrival forward search cannot produce it at any ranking. It walks
// 30 s against A's 914 s -- cost 599 against 2428. Only the reverse probe can
// find it, and effort ranking must then put it first.
test("/plan surfaces a later-departing, far-lower-walking journey", async () => {
  const { app, index } = await serveEffort();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(DEPART)}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: { departureTime: string; walkSeconds: number }[];
    };
    // Two candidates is also what makes this the first test in the plan able to
    // catch a stray re-sort running after `rankItineraries` -- every earlier
    // ranking test has at most one candidate, where any ordering passes.
    assert.ok(body.itineraries.length >= 2, "expected both journeys as candidates");

    const best = body.itineraries[0]!;
    // T5 departs 08:20; T1 departs 08:00. The low-walk, later journey wins.
    assert.equal(new Date(best.departureTime).getUTCHours() * 60
      + new Date(best.departureTime).getUTCMinutes(), 5 * 60 + 20);
    assert.ok(best.walkSeconds < body.itineraries[1]!.walkSeconds);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// A reverse search explores BACKWARD from its deadline with no lower bound on
// departure, so it can reconstruct a chain that left before the rider asked to
// travel -- a bus they cannot board.
//
// HONEST SCOPE: this is a SMOKE CHECK, not a proof. This fixture has only two
// trips out of stop 1000, and the reverse pass maximises departure, so it will
// always choose T5 here and would pass even with the guard deleted.
// Constructing a fixture that actually forces the reverse pass to return a
// too-early chain needs a round whose only late option is invalid, which this
// four-stop network cannot express. The guard's real justification is
// structural and lives in its code comment. Do not delete the guard because
// this test passes without it.
test("/plan never returns a journey departing before departAfter", async () => {
  const { app, index } = await serveEffort();
  try {
    // 08:05 is AFTER T1's 08:00 departure and before T5's 08:20 one, so the
    // reverse pass's window straddles a departure that is no longer boardable.
    const late = "2026-08-24T08:05:00+03:00";
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(late)}`,
    });
    const body = res.json() as { itineraries: { departureTime: string }[] };
    for (const itin of body.itineraries) {
      assert.ok(
        Date.parse(itin.departureTime) >= Date.parse(late),
        `itinerary departed ${itin.departureTime}, before ${late}`,
      );
    }
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// The merged-search dedupe at the route level: both searches find T5, and the
// response must not show it twice.
test("/plan returns no duplicate journeys after merging both searches", async () => {
  const { app, index } = await serveEffort();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(DEPART)}`,
    });
    const body = res.json() as {
      itineraries: { legs: ({ type: string } & Record<string, unknown>)[] }[];
    };
    const keys = body.itineraries.map((itin) =>
      itin.legs
        .filter((leg) => leg.type === "transit")
        .map((leg) => {
          const l = leg as unknown as {
            tripId: string;
            from: { stopSequence: number }; to: { stopSequence: number };
          };
          return `${l.tripId}:${l.from.stopSequence}:${l.to.stopSequence}`;
        })
        .join("|"));
    assert.equal(new Set(keys).size, keys.length, `duplicate journeys: ${keys.join(" / ")}`);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// The departure window's anchor, end to end, and the property most easily broken
// by a naive window: a query hours before the first service must return that
// service rather than an empty list. T1 is at 08:00; this asks at 04:00.
test("/plan still answers when the first service is hours away", async () => {
  const { app, index } = await serveEffort();
  try {
    const early = "2026-08-24T04:00:00+03:00";
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(early)}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.ok(body.itineraries.length > 0, "expected the first service of the day");
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

// The departure window's EXEMPTION, at the route level. The probe's bound
// is on ARRIVAL (`A_min + W`); the window's is on DEPARTURE (`D_forward + W`).
// Solving the two against each other, a probe candidate clears the departure
// cutoff only when it is NO FASTER than the forward answer -- so an unexempted
// window demotes exactly the faster, lower-effort journeys the probe exists to
// find. See `rankItineraries`' `exempt` doc comment for the derivation.
//
// The fixture is built so neither of the two accidental rescues applies: A's
// walk share is 60.4%, UNDER the 0.7 cap, so A is not deleted and it anchors
// the window at its own 08:00 departure (cutoff 08:30). B departs 08:40 --
// past the cutoff, inside the probe's own 08:55:14 deadline -- and costs 599
// against A's 2428. With the exemption B is first; without it, B is second.
test("/plan ranks a probe journey past the window on cost, not below it", async () => {
  const { app, index } = await serveEffortBeyondWindow();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/plan?from=${ORIGIN}&to=${DEST}&departAfter=${encodeURIComponent(DEPART)}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: { departureTime: string; walkSeconds: number; durationSeconds: number }[];
    };
    assert.equal(body.itineraries.length, 2, "expected both journeys as candidates");

    const best = body.itineraries[0]!;
    // Departure is asserted in UTC minutes-of-day, as the sibling test does:
    // 08:40+03:00 is 05:40 UTC. This is the ONLY assertion that distinguishes
    // the exemption from its absence -- both orderings return the same two
    // itineraries, so an assertion on the SET would pass either way.
    assert.equal(
      new Date(best.departureTime).getUTCHours() * 60
        + new Date(best.departureTime).getUTCMinutes(),
      5 * 60 + 40,
      "the probe's cheaper, later-departing journey was not ranked first",
    );
    assert.ok(best.walkSeconds < body.itineraries[1]!.walkSeconds);
    assert.ok(best.durationSeconds < body.itineraries[1]!.durationSeconds);
  } finally { await app.close(); index.currentBundle().db.close(); index.stop(); }
});

test("a rail leg is headed for the train's last stop and carries tripNumber", async () => {
  const { app, index } = await serveWithRealtime(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:4000&to=stop:1000&departAfter=2026-08-24T16:30:00%2B03:00&lang=en",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: { legs: { type: string; tripId?: string; headsign?: string | null; tripNumber?: string | null }[] }[];
    };
    const leg = body.itineraries.flatMap((i) => i.legs).find((l) => l.tripId === "T106");
    assert.ok(leg, "T106 is the only train from 4000 to 1000 after 16:30");
    assert.equal(leg.headsign, "Central Station");
    assert.equal(leg.tripNumber, "106");
  } finally { await app.close(); index.stop(); }
});

test("a bus leg keeps its headsign and has a null tripNumber", async () => {
  const { app, index } = await serveWithRealtime(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00&lang=en",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: { legs: { type: string; tripId?: string; headsign?: string | null; tripNumber?: string | null }[] }[];
    };
    const leg = body.itineraries[0]!.legs.find((l) => l.type === "transit")!;
    assert.equal(leg.tripId, "T1");
    assert.equal(leg.headsign, "Herzl");
    assert.equal(leg.tripNumber, null);
  } finally { await app.close(); index.stop(); }
});

test("a shifted leg reports the predicted times AND the scheduled ones", async () => {
  // T1 three minutes late -- enough to move, and still inside the 90 s margin
  // T4's 08:15 departure demands, so the journey survives and there is a
  // shifted leg to inspect. (Six minutes would refuse the connection and the
  // realtime yield would hand back the schedule instead; see the test above.)
  // The leg a rider acts on must say 08:03/08:13 -- the instants the planner
  // actually searched -- while still carrying the timetable it departs from,
  // so a client can render "08:03 (sched 08:00)".
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const predictedArrival = Date.parse("2026-08-24T08:13:00+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey: STUB_JOURNEY, byStopIdx: new Map([[1, { expectedArrival: predictedArrival, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!;
    const t1 = it.legs.filter((l) => l.type === "transit")[0]!;

    assert.equal(t1.tripId, "T1");
    // Acted on: the live times.
    assert.equal(t1.from!.departureTime, "2026-08-24T08:03:00+03:00");
    assert.equal(t1.to!.arrivalTime, "2026-08-24T08:13:00+03:00");
    // Preserved: the timetable.
    assert.equal(t1.from!.scheduledDepartureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(t1.to!.scheduledArrivalTime, "2026-08-24T08:10:00+03:00");
    // And the delay is measured against the schedule, not against itself.
    assert.equal(t1.realtime!.delaySeconds, 180);
  } finally { await app.close(); index.stop(); }
});

test("an on-time leg's scheduled times equal its acted-on times", async () => {
  // The field is always present, so a client never has to branch on it.
  const { app, index } = await serveWithTransfer(null);
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    for (const leg of (res.json() as { itineraries: RtItinerary[] }).itineraries[0]!.legs) {
      if (leg.type !== "transit") continue;
      assert.equal(leg.from!.scheduledDepartureTime, leg.from!.departureTime);
      assert.equal(leg.to!.scheduledArrivalTime, leg.to!.arrivalTime);
    }
  } finally { await app.close(); index.stop(); }
});
