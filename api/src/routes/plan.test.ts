import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { serveFixture, shutdown } from "../testing/planServer.js";
import { IndexManager } from "../transit/manager.js";
import { buildServer } from "../server.js";
import { parsePlace } from "./plan/places.js";
import { RealtimeStore } from "../realtime/store.js";
import type { ResolvedJourney } from "../realtime/match.js";
import type { RealtimeJourney } from "../realtime/types.js";
import { walkConfig } from "../config.js";

/** The shared fixture with baked footpaths at the 400 m radius, below the
 *  695 m gap between stops 1000 and 2000, so the "unreachable" test cannot
 *  pass through a walk-only path. */
async function serve() {
  return serveFixture({ footpaths: "baked" });
}

/** The shared fixture with a `realtime` dependency (or `null`, disabled) and
 *  no footpaths: every caller queries `stop:` to `stop:`. */
async function serveWithRealtime(realtime: RealtimeStore | null) {
  return serveFixture({ prefix: "rt", realtime });
}

/**
 * Adds stop 5000 and R103: T4 leaves stop 2000 (where T1 alights at 08:10) at
 * 08:15, a same-stop transfer with no walk leg. T4E (08:09, before T1
 * arrives, so never boardable) gives R103 a 360 s headway, so the required
 * margin is 90 s (0.25 factor): inside the 300 s offered, and above the flat
 * 60 s floor so tests can tell the two apart.
 */
async function serveWithTransfer(realtime: RealtimeStore | null) {
  return serveFixture({
    prefix: "transfer",
    realtime,
    sql: `
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
    INSERT INTO trips VALUES (5,'T4E','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,29340,29340,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,29940,29940,1,0,900);
  `,
  });
}

/**
 * `serveWithTransfer` plus stop 6000 and R104 (T5), leaving stop 5000 at
 * 08:35, 600 s after T4 arrives. Two transfers, so one can be confirmed fine
 * and the other unknown in the same response. R104 is single-trip
 * (NO_HEADWAY), but its 600 s gap equals the 600 s cap, which passes.
 */
async function serveWithTwoTransfers(realtime: RealtimeStore | null) {
  return serveFixture({
    prefix: "transfer2",
    realtime,
    sql: `
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
  `,
  });
}

/**
 * Adds TX, sharing T1's stops (1000 to 2000) and 08:10 arrival but departing
 * 08:05 instead of 08:00, in the same pattern, so reoptimisation can swap T1
 * for it. Kept out of the shared fixture, where it would change every other
 * test's trip. TX's shape SHX has 3 points against T1's 2-point SH1, so the
 * returned leg's geometry shows which trip it was resolved for.
 */
async function serveWithExpressTrip() {
  return serveFixture({
    prefix: "express",
    footpaths: "baked",
    sql: `
    INSERT INTO trips VALUES (4,'TX','R1','S1','הרצל',0,'SHX',1);
    INSERT INTO stop_times VALUES (4,1,1,29100,29100,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29400,29400,1,0,696);
    INSERT INTO shapes VALUES ('SHX','oeoc|@_uxiaAoaDnzD_|B~{B',3,696.0);
  `,
  });
}

/** A server whose walking router reports a fixed real distance for every
 *  candidate, so a test can push candidates over or under the cap. */
async function serveWithWalk(distanceMeters: number, durationSeconds: number) {
  return serveFixture({
    prefix: "walk",
    footpaths: "managed",
    valhalla: {
      route: async () => ({ distanceMeters, durationSeconds, geometry: null, estimated: true }),
      // Stop 2000 (the destination) is also in access range. Its walk is
      // reported real but absurdly slow, so a walk-only path cannot beat the
      // T1 ride and prune its label. The coordinates are stop 2000's in
      // `testing/fixture.ts`; if they move, this branch silently goes dead.
      matrix: async (_s: unknown[], t: unknown[]) =>
        [(t as [number, number][]).map(([lat, lon]) =>
          Math.abs(lat - 32.06) < 1e-6 && Math.abs(lon - 34.775) < 1e-6
            ? { distanceMeters: 26_000, durationSeconds: 20_000 }
            : { distanceMeters, durationSeconds })],
    },
  });
}

/**
 * Adds six stops due east of Q=(32.2000, 34.9000), all 17.7 to 19.6 km from
 * the base fixture so those never enter the fallback's top 5: stopA(5000)
 * 300 m from Q, then filler1(6000), filler2(7000), filler3(8000), stopB(9000)
 * and stopC(10000), 100 m apart.
 *
 * stopA is crow-flight nearest, but its trip TA leaves at 08:20 and the stub
 * reports a 1,500 s real walk, so TA is missed. stopB is fifth-nearest; TB
 * also leaves at 08:20 and the walk is 120 s, so it is boardable. The
 * fillers carry no trips and only push stopB to fifth. stopC (TC, the
 * fastest trip) is sixth, so it must never be a candidate. The 10 m footpath
 * radius keeps these stops unconnected (at 400 m, stopA and stopB, 399.6 m
 * apart, would be joined).
 */
async function serveWithNearestFallback() {
  // Real walking costs in the order candidates are refined (ascending
  // crow-flight distance from Q). stopC gets a valid cost so that a sixth
  // candidate would show up as `accessStops === 6` rather than being dropped
  // as unroutable.
  const costs = [
    { distanceMeters: 2000, durationSeconds: 1500 }, // stopA: bad real walk
    { distanceMeters: 80, durationSeconds: 60 },      // filler1
    { distanceMeters: 80, durationSeconds: 60 },      // filler2
    { distanceMeters: 80, durationSeconds: 60 },      // filler3
    { distanceMeters: 150, durationSeconds: 120 },    // stopB: good real walk
    { distanceMeters: 170, durationSeconds: 130 },    // stopC: must never be requested
  ];
  return serveFixture({
    prefix: "nearest-fallback",
    footpaths: "managed",
    footpathMaxMeters: 10,
    sql: `
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
  `,
    valhalla: {
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      // Not wrapped in an assert: a throwing `matrix` degrades silently. The
      // response assertions are what pin the candidate set.
      matrix: async (_s: unknown[], t: unknown[]) => [t.map((_, i) => costs[i])],
    },
  });
}

/**
 * One journey that arrives sooner but walks most of the way, and one that
 * departs later and walks 30 s. At the degraded client's 1.35 detour factor
 * and 1.33 m/s:
 *
 *   A (walk-heavy): T4 departs 1000 at 08:00, reaches 7000 at 08:10, then a
 *                   901 m egress walk (914 s), arriving 08:25:14.
 *                   Duration 1514 s, walk 914 s (60.4% share), cost 2428.
 *   B (low-walk):   T5 departs 1000 at 08:20, reaches 6000 at 08:29, then a
 *                   29 m egress walk (30 s), arriving 08:29:30.
 *                   Duration 570 s, walk 30 s (5.2% share), cost 599.
 *
 * A arrives first, so the forward search emits only A; the reverse probe
 * finds B. A's share is under the 0.7 cap, so tests can assert an order.
 * Both alighting stops are new and far from ORIGIN (stop 2000, 695 m away,
 * would be beaten by walking). ORIGIN reaches only stops 1000 and 2000 and
 * DEST only 6000 and 7000, so no walk-only path exists; 2000 leads only to
 * stop 4000, out of DEST's egress range.
 */
async function serveEffort() {
  return serveFixture({
    prefix: "effort",
    footpaths: "baked",
    sql: `
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
  `,
  });
}

/**
 * `serveEffort` with B moved beyond the departure window, proving the window
 * exemption is load-bearing at the route level. A (60.4% walk share, under
 * the cap) survives and anchors the window at 08:00, cutoff 08:30. B (T5)
 * now departs 08:40 (31200) and arrives 08:49:30, inside the probe's
 * 08:55:14 deadline, so it is still generated; without the exemption the
 * 4x cheaper B ranks second.
 */
async function serveEffortBeyondWindow() {
  return serveFixture({
    prefix: "effort-late",
    footpaths: "baked",
    sql: `
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
  `,
  });
}

/**
 * One of two mechanisms behind a real-feed defect where widening the walk
 * radius deleted the only bus. Adds stop 8000, 455 m from DEST but 1667 m
 * from ORIGIN, so no walk can reach it and prune T7's transit label.
 *
 * From DEPART (07:55), walking ORIGIN to 2000 (706 s) then 2000 to DEST
 * (677 s) arrives 08:18:03, a label present from round 0. T7 departs 1000 at
 * 08:00, reaches 8000 at 08:15, then walks to DEST (461 s), arriving
 * 08:22:41 (34% walking, under the 0.7 cap).
 *
 * `paretoRounds` picks one minimum arrival per round across all target
 * stops, so without `accept` round 1's pick is the earlier walk-only label,
 * which `hasTransitLeg` then drops, leaving the response empty.
 */
async function serveWalkDominance() {
  return serveFixture({
    prefix: "walk-dominance",
    footpaths: "baked",
    sql: `
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
  `,
  });
}

// Stop 1000 exactly.
const ORIGIN = "32.0554,34.7800";
// 29 m from stop 6000, 901 m from stop 7000, and >2.6 km from every other stop.
const DEST = "32.0900,34.7750";
// A weekday inside the fixture's S1 calendar window (20260821-20260920).
const DEPART = "2026-08-24T07:55:00+03:00";

// 433 m and 373 m from stop 6000, where nothing can be boarded (T5 has
// pickup_type=1 there). Every other stop is out of range, so no transit
// itinerary exists between them and the response must be empty.
const WALK_FROM = "32.0940,34.7762";
const WALK_TO = "32.0935,34.7745";

// The measured Ayalon case: 958 m straight-line, 3,690 m on foot. Over the
// 1,000 m cap the ordinary candidate set empties after refinement, so the
// nearest-stop fallback must fire (without it this is a 422). Its walk
// (2,775 s against T1's 600 s ride) is an 82% walk share, over the 0.7 cap,
// so the itinerary is dropped and the response is an empty 200.
test("a candidate whose real walk exceeds the cap triggers the nearest-stop fallback instead of a 422", async () => {
  const { app, index } = await serveWithWalk(3690, 2775);
  try {
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7800&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.deepEqual(body.itineraries, []);
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
});

// A stop: endpoint has no walk to route. Refining it would waste a call and
// could drop the query's only candidate.
test("a stop: endpoint is unaffected by walk refinement", async () => {
  let matrixCalls = 0;
  const { app, index } = await serveFixture({
    prefix: "stoponly",
    footpaths: "managed",
    valhalla: {
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      matrix: async (_s: unknown[], t: unknown[]) => { matrixCalls++; return [t.map(() => null)]; },
    },
  });
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(matrixCalls, 0, "a stop:-to-stop: query must route no walks");
  } finally { await shutdown({ app, index }); }
});

// arriveBy uses the same refined candidates, so the nearest-stop fallback
// must fire on the reverse pass too. Its itinerary is an 82% walk share,
// over the 0.7 cap, so it is dropped; the response is a 200, not a 422.
test("arriveBy uses the same refined candidates as departAfter, including the nearest-stop fallback", async () => {
  const { app, index } = await serveWithWalk(3690, 2775);
  try {
    const res = await app.inject({
      url: "/plan?from=32.0554,34.7800&to=stop:2000&arriveBy=2026-08-24T09:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.deepEqual(body.itineraries, []);
  } finally { await shutdown({ app, index }); }
});

// `walkEstimated` must reflect whether this leg's duration was refined, not
// whether the separate geometry call succeeded. Here `matrix` succeeds while
// `route` degrades (`geometry: null`, `estimated: true`).
test("an access leg reports walkEstimated false once refinement succeeds, even when the geometry call degrades", async () => {
  const { app, index } = await serveFixture({
    prefix: "walkest",
    footpaths: "managed",
    valhalla: {
      // Refinement's matrix call succeeds with a real distance/duration.
      matrix: async (_s: unknown[], t: unknown[]) =>
        [t.map(() => ({ distanceMeters: 141, durationSeconds: 106 }))],
      // The separate geometry call degrades, the way ValhallaClient's
      // route() does on failure.
      route: async () => (
        { distanceMeters: 190, durationSeconds: 142, geometry: null, estimated: true }
      ),
    },
  });
  try {
    // 141 m from stop 1000, 798 m from stop 2000; maxWalkMeters=300 keeps
    // only stop 1000, so there is a nonzero access walk to refine.
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
    // The route call degraded, so this value came from walkLeg, driven by
    // `refined`.
    assert.equal(walk.walkEstimated, false);
  } finally { await shutdown({ app, index }); }
});

// The mirror case: `matrix` throws (the duration stays the estimate) while
// `route` succeeds with real geometry. A real path says nothing about the
// duration, so `walkEstimated` must stay true.
test("an access leg keeps walkEstimated true when the matrix call degrades, even though the geometry call succeeds", async () => {
  const { app, index } = await serveFixture({
    prefix: "walkest-mirror",
    footpaths: "managed",
    valhalla: {
      // Refinement's matrix call degrades; the duration stays the estimate.
      matrix: async () => { throw new Error("down"); },
      // The separate geometry call succeeds with a real precision-6 polyline.
      route: async () => ({
        distanceMeters: 190, durationSeconds: 142,
        geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@", estimated: false,
      }),
    },
  });
  try {
    // Same coordinate and cap as above: only stop 1000 (141 m) is in reach.
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
    // `resolveWalkGeometry` overwrites the estimated `distanceMeters` with
    // the routed 190 when it resolves for real; this is the suite's only
    // coverage of that overwrite.
    assert.equal(walk.distanceMeters, 190);
  } finally { await shutdown({ app, index }); }
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
  await shutdown({ app, index });
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
  await shutdown({ app, index });
});

// The feed holds ~30 days. Returning [] for a date months out is
// indistinguishable from "no service" and costs hours of client debugging.
test("a date outside the calendar window is 422, naming the window", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-11-01T08:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 422);
  // The shared error envelope: `code` alongside the status, message and
  // request id; the window goes in `details`.
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
  await shutdown({ app, index });
});

// A coordinate whose haversine prefilter is already empty must plan from the
// nearest stops instead of 422ing. `serve()`'s default Valhalla throws under
// test, so the fallback's own refinement degrades too. The destination is
// stop 2000 itself, so the only candidate is walk-only, which
// `hasTransitLeg` drops: the response is an empty 200.
test("a coordinate far from every stop is a 200 with no walk-only itinerary, not a 422", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // The Negev, far from every fixture stop.
    url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { itineraries: unknown[] };
  assert.deepEqual(body.itineraries, []);
  await shutdown({ app, index });
});

// The fallback's walk is reported as honestly huge (38 km, real geometry).
// The destination is stop 2000 itself, so that walk covers the whole trip
// with no transit leg and `hasTransitLeg` drops it. Still a 200, not a 422.
test("a coordinate far from every stop is still a 200 with no walk-only itinerary when the fallback's own walk is honestly huge, not an estimate", async () => {
  const { app, index } = await serveFixture({
    prefix: "fallback-honest",
    footpaths: "managed",
    valhalla: {
      matrix: async (_s: unknown[], t: unknown[]) =>
        [t.map(() => ({ distanceMeters: 38000, durationSeconds: 28500 }))],
      route: async () => (
        { distanceMeters: 38000, durationSeconds: 28500, geometry: "abc", estimated: false }
      ),
    },
  });
  try {
    const res = await app.inject({
      // The Negev, far from every fixture stop.
      url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { itineraries: unknown[] };
    assert.deepEqual(body.itineraries, []);
  } finally { await shutdown({ app, index }); }
});

// See `serveWalkDominance`: the walk-only label at stop 2000 (08:18:03) beats
// T7's boarded label at stop 8000 (08:22:41) in the round's arg-min. Without
// `accept` rejecting walk-only labels, `hasTransitLeg` drops that pick and
// the response is empty despite a working bus.
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
    await shutdown({ app, index });
  }
});

// A query with candidates in range must not run the fallback at all. Pinned
// by matrix call count, so a redundant fallback run cannot hide behind an
// unchanged response.
test("the fallback does not fire when candidates already exist", async () => {
  let matrixCalls = 0;
  const { app, index } = await serveFixture({
    prefix: "fallback-notfire",
    footpaths: "managed",
    valhalla: {
      matrix: async (_s: unknown[], t: unknown[]) => {
        matrixCalls++;
        return [t.map(() => ({ distanceMeters: 120, durationSeconds: 90 }))];
      },
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
    },
  });
  try {
    const res = await app.inject({
      // 141 m from stop 1000, inside the default 1000 m cap before and
      // after refinement.
      url: "/plan?from=32.0554,34.7815&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    // Exactly one matrix call: the ordinary refinement. A second call would
    // mean the fallback ran even though the ordinary path already produced
    // candidates.
    assert.equal(matrixCalls, 1);
  } finally { await shutdown({ app, index }); }
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
  // A stop: destination resolves to exactly one egress stop, unaffected by
  // the origin side.
  assert.equal(body.query.egressStops, 1);
  await shutdown({ app, index });
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
  await shutdown({ app, index });
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
  await shutdown({ app, index });
});

// An unresolved `stop:<id>` is a bad id: a 404 `not_found` like every other
// route, not the nearest-stop fallback or the walking-cap 422.
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
  await shutdown({ app, index });
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
  await shutdown({ app, index });
});

// When all 5 nearest-stop fallback candidates are unreachable on foot
// (`matrix` returns null: no pedestrian path), the set empties and the query
// is still a 422 against a healthy index.
test("a coordinate whose nearest stops are all unreachable on foot is still a 422, not a 200", async () => {
  const { app, index } = await serveFixture({
    prefix: "allnull-fallback",
    footpaths: "managed",
    valhalla: {
      route: async () => ({ distanceMeters: 0, durationSeconds: 0, geometry: null, estimated: true }),
      // Resolves (does not throw/degrade) but reports every candidate as
      // having no pedestrian path at all.
      matrix: async (_s: unknown[], t: unknown[]) => [t.map(() => null)],
    },
  });
  try {
    const res = await app.inject({
      // The Negev: the haversine prefilter is already empty, so this
      // exercises the fallback's own all-null matrix row.
      url: "/plan?from=30.5000,34.9000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { code: string };
    assert.equal(body.code, "no_stops_near_origin");
  } finally { await shutdown({ app, index }); }
});

// Saturday: every fixture trip runs Sun to Thu (S1), and `serve()` leaves
// stops 1000 and 2000 unconnected by footpath, so the pair is searched and
// unreachable.
test("an unreachable but searched pair is 200 with an empty list", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-22T07:30:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { itineraries: unknown[] }).itineraries, []);
  await shutdown({ app, index });
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
  await shutdown({ app, index });
});

// The arriveBy branch must add the egress walk for a coordinate destination,
// or `arrivalTime` and the walk totals miss a real leg. The destination is
// 141 m from stop 2000 (609 m from 1000); maxWalkMeters=200 keeps only 2000,
// so the route is: board T1, ride, walk.
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

  // Door arrival is after T1's 08:10 stop arrival (the egress walk still has
  // to happen) and no later than requested.
  const transitLeg = itin.legs.find((l): l is TransitLeg => l.type === "transit")!;
  assert.ok(
    Date.parse(itin.arrivalTime) > Date.parse(transitLeg.to.arrivalTime),
    "door arrival must be later than the transit leg's own stop arrival",
  );
  assert.ok(Date.parse(itin.arrivalTime) <= Date.parse("2026-08-24T08:30:00+03:00"));

  await shutdown({ app, index });
});

// The reverse search also covers yesterday (for 25:30-style trips), so it
// could meet a Friday 20:00 deadline with Thursday's T2 (09:00 to 09:10),
// ~35 h early. Friday has no service in this fixture, so the answer is empty.
test("arriveBy discards a journey that arrives more than a day before the deadline", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&arriveBy=2026-08-28T20:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { itineraries: unknown[] }).itineraries, []);
  await shutdown({ app, index });
});

test("passing both departAfter and arriveBy is a 400", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:00:00%2B03:00&arriveBy=2026-08-24T09:00:00%2B03:00",
  });
  assert.equal(res.statusCode, 400);
  await shutdown({ app, index });
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
  // A deliberate, retryable 503 keeps its own code and message, and `state`
  // survives in `details`.
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
  await shutdown({ app, index });
});

// End to end: a ride plus an egress walk through the HTTP layer, departing
// at exactly T1's 08:00 from a bare "stop:" origin, every leg checked.
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

  // Transit ride first (the origin is the boarding stop), then an egress walk.
  assert.equal(itin.legs.length, 2);
  const [leg0, leg1] = itin.legs as [TransitLeg, WalkLeg];
  assert.equal(leg0.type, "transit");
  assert.equal(leg1.type, "walk");

  // A transit leg with a real trip id, not a placeholder or a stop_ref.
  assert.equal(leg0.tripId, "T1");
  assert.equal(leg0.from.stop.stopId, "1000");
  assert.equal(leg0.to.stop.stopId, "2000");

  // Contiguous times: the ride departs 08:00 and arrives 08:10 (fixture
  // schedule), and the egress walk's own duration is positive.
  assert.equal(leg0.from.departureTime, "2026-08-24T08:00:00+03:00");
  assert.equal(leg0.to.arrivalTime, "2026-08-24T08:10:00+03:00");
  assert.ok(leg1.durationSeconds > 0);

  // A bare "stop:" origin has zero access seconds and departAfter equals
  // T1's departure, so the door departure coincides with the ride's.
  assert.equal(itin.departureTime, leg0.from.departureTime);
  assert.equal(itin.transfers, 0);

  await shutdown({ app, index });
});

// The arriveBy mirror of the test above: same route and destination, built
// by the reverse pass, where the egress walk leg could be skipped.
test("plans a real multi-leg journey with coherent, contiguous legs (arriveBy)", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    // Deadline 08:30 fits T1 (08:00 to 08:10) plus the ~144 s egress walk;
    // T2 (09:00 to 09:10) is past it.
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

  // departureTime still equals leg0's (bare "stop:" origin), but arrivalTime
  // must be strictly later than the stop arrival because of the egress walk;
  // a dropped egress leg would make them equal.
  assert.equal(itin.departureTime, leg0.from.departureTime);
  assert.ok(Date.parse(itin.arrivalTime) > Date.parse(leg0.to.arrivalTime));
  assert.ok(Date.parse(itin.arrivalTime) <= Date.parse("2026-08-24T08:30:00+03:00"));
  assert.equal(itin.transfers, 0);

  await shutdown({ app, index });
});

// `Number("")` is 0, so a bare `modes=` would silently mean "tram only", and
// dropping NaN entries would make `modes=abc` an empty set and a 200 with no
// itineraries. Both must be a 400.
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
  await shutdown({ app, index });
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
  await shutdown({ app, index });
});

// Without re-anchoring, `departureTime` would be the query instant (07:00)
// and the wait for T1's 08:00 boarding would make a bogus 70-minute journey.
// It must report T1's boarding time and the true 10-minute ride.
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
    await shutdown({ app, index });
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
    await shutdown({ app, index });
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
    await shutdown({ app, index });
  }
});

// The shared fixture has no same-arrival departure tie, so the tests above
// cannot tell re-anchoring alone from re-anchor plus reoptimise.
// `serveWithExpressTrip` adds TX (08:05 to 08:10, same arrival as T1).
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
    // TX, not T1: the later departure with the same arrival and zero
    // transfers. Fails if `reoptimiseItinerary` is never called.
    assert.equal(transit.tripId, "TX");
    assert.equal(transit.from!.departureTime, "2026-08-24T08:05:00+03:00");
    assert.equal(it.departureTime, "2026-08-24T08:05:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:10:00+03:00");
    assert.equal(it.transfers, 0);
  } finally {
    await shutdown({ app, index });
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
    // The swap to TX must have happened, or the geometry check is meaningless.
    assert.equal(transit.tripId, "TX");
    // SHX (TX's shape) decodes to 3 points, SH1 (T1's) to 2. Resolving
    // geometry before reoptimisation swaps T1 for TX leaves the returned leg
    // with `geometry: null`.
    assert.ok(transit.geometry, "transit leg should carry geometry");
    assert.equal(transit.geometryFallback, false);
    const { decodePolyline } = await import("../geo.js");
    const points = decodePolyline(transit.geometry!);
    assert.equal(points.length, 3, "should decode SHX (3 points), not SH1 (2)");
  } finally {
    await shutdown({ app, index });
  }
});

// Realtime annotation on /plan legs and itineraries.

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
  } finally { await shutdown({ app, index }); }
});

test("a resolved trip reports predicted times and a delay", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    ...STUB_JOURNEY, vehicleRef: "veh-42", confidence: "reliable",
    recordedAt: Date.parse("2026-08-24T07:59:00+03:00") / 1000,
  };
  // T1 is trip index 0; stops 1000 and 2000 are stop indexes 0 and 1
  // (buildIndex assigns both by ascending ref).
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
  } finally { await shutdown({ app, index }); }
});

// A stop the trip's pattern visits more than once (a loop) must never hand
// `/plan` a prediction it cannot attribute to this leg's visit; the store's
// `ambiguous` flag carries that.

test("an ambiguous (loop-repeated) stop prediction is withheld from /plan, even though the store has data for it", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    ...STUB_JOURNEY, vehicleRef: "veh-42", confidence: "reliable", recordedAt: null,
  };
  // Same positions as above, but both entries are `ambiguous: true`, as if
  // the pattern visited each stop twice. A synthetic store, isolating the
  // store/plan contract from match.ts's own logic.
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
    // The epoch fields the ambiguity protects go null ("wrong is worse than
    // absent"); vehicleRef and confidence, not tied to a stop, survive.
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
  } finally { await shutdown({ app, index }); }
});

test("the departures board is unaffected by an ambiguous stop -- it keeps reporting the soonest visit", async () => {
  // The departures board keeps its behaviour: the same ambiguous store, read
  // through GET /stops/:stopId/departures.
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
  } finally { await shutdown({ app, index }); }
});

test("a leg whose trip is unresolved carries realtime: null, and the plan still succeeds", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // The snapshot resolved only an unrelated trip index, never T1 (index 0).
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
    // No transfer in this single-leg itinerary: confirmed false, not the
    // "unknown" null.
    assert.equal(it.transferAtRisk, false);
  } finally { await shutdown({ app, index }); }
});

// The store's data is stale, but annotation still runs: transferAtRisk is
// `false`, the "no transfer at all" case.
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
  } finally { await shutdown({ app, index }); }
});

test("a late feeding leg that eats the transfer sets transferAtRisk", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // T1 (tripIdx 0) predicted 10 minutes late into stop 2000 (stopIdx 1):
  // 08:20, past T4's 08:15 departure, so at risk under either the flat 60 s
  // or the headway-scaled 90 s margin.
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
  } finally { await shutdown({ app, index }); }
});

test("a delay that still leaves slack does not set transferAtRisk", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // T1 predicted 3 minutes late (08:13): 120 s before T4's 08:15 departure,
  // 30 s more than the 90 s margin R103's headway demands (via T4E). Enough.
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
  } finally { await shutdown({ app, index }); }
});

test("live delays may not delete a rider's only journey", async () => {
  // When live delays refuse every journey, the planner yields to the
  // schedule rather than return nothing: the answer is still the scheduled
  // T1 to T4, flagged by the prediction that refused it.
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // Predicted an hour late, long past T4's own scheduled arrival.
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

    // The annotation really differs, so the comparison above is not vacuous.
    assert.equal(itinsA[0]!.transferAtRisk, true);
    assert.equal(itinsB[0]!.transferAtRisk, null);
  } finally {
    await shutdown(withStore);
    await shutdown(without);
  }
});

// The null branch of transferAtRisk, and the transfer-margin behaviour.

test("transferAtRisk is null, not false, when a transfer's data is genuinely unknown", async () => {
  // An enabled store that resolves nothing for T1, on a genuine one-transfer
  // itinerary: the verdict must be unknown (null), not false.
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
  } finally { await shutdown({ app, index }); }
});

test("one transfer confirmed fine and another unknown yields null, not false", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // T1 (tripIdx 0) on time into stop 2000: the first transfer (into T4) is
  // confirmed fine. T4 (tripIdx 3) is never resolved, so the second (into T5)
  // is unknown.
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
  } finally { await shutdown({ app, index }); }
});

test("a transfer inside the planner's own boarding buffer is still flagged at risk", async () => {
  // RAPTOR built this connection only because arrival plus the 90 s margin
  // (R103's headway via T4E) fit before T4's departure. A predicted arrival
  // 5 s before departure leaves far less, so it must be flagged.
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
  } finally { await shutdown({ app, index }); }
});

// The headway-scaled transfer margin, wired into /plan for real.

/**
 * Sets `walkConfig.headwayFactor` for the duration of `fn`, then restores it.
 * `plan.ts` reads it on every request, so mutating the (not runtime-frozen)
 * config object changes behaviour without a fresh process.
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
 * An itinerary's transit trip ids, joined: which rides the journey is made
 * of. The planner merges the relaxed (flat-margin) search with the
 * configured one, so a query can return both a margin-respecting journey and
 * a flagged tight one. Margin tests therefore assert "this journey is
 * present, with this flag"; the margin-only journey's presence is what
 * proves a call site got `transfer`.
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

/**
 * R103's T4 is the only trip on its pattern (no T4E), so it is NO_HEADWAY and
 * boarding costs the full 600 s cap. The 300 s between T1's 08:10 arrival and
 * T4's 08:15 departure clears the flat 60 s but not that cap.
 *
 * Without `laterTrip`, T4 is R103's last service, so the rule yields to the
 * flat buffer and returns the journey flagged `transferAtRisk`. With
 * `laterTrip`, R103 also runs T5 (09:00 to 09:10), so the margin refuses T4
 * and the search takes T5 instead.
 */
async function serveWithInfrequentTransfer(
  realtime: RealtimeStore | null, opts: { laterTrip?: boolean; altFeeder?: boolean } = {},
) {
  let sql = `
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
  `;
  if (opts.laterTrip === true) {
    sql += `
      INSERT INTO trips VALUES (5,'T5','R103','S1','תחנה שלישית',0,NULL,0);
      INSERT INTO stop_times VALUES (5,2,1,32400,32400,0,1,0);
      INSERT INTO stop_times VALUES (5,5,2,33000,33000,1,0,900);
    `;
  }
  if (opts.altFeeder === true) {
    // T1E, an earlier R1 trip (07:30, reaching stop 2000 at 07:55): 1200 s
    // before T4 clears the 600 s cap that T1's 300 s does not. The reverse
    // pass maximises departure, so it only reaches back to T1E when the
    // margin refuses T1.
    sql += `
      INSERT INTO trips VALUES (6,'T1E','R1','S1','הרצל',0,'SH1',1);
      INSERT INTO stop_times VALUES (6,1,1,27000,27000,0,1,0);
      INSERT INTO stop_times VALUES (6,2,2,28500,28500,1,0,1200);
    `;
  }
  return serveFixture({ prefix: "infrequent", sql, realtime });
}

test("arriveBy applies the headway-scaled margin too, and never falls back to a previous-day connection with an overnight wait", async () => {
  // T1 to T4 (300 s against the 600 s NO_HEADWAY cap) fails the margin.
  // With `transfer` wired but no wait bound, the reverse search would fall
  // back to the previous day's T2 as feeder, a ~23h05m wait at stop 2000.
  // `laterTrip` (T5, arriving 09:10, past the deadline) keeps the
  // last-service fallback out of play.
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
    // The margin search returns nothing, so the retry returns the flat
    // rule's same-day T1 to T4, flagged. Without the wait bound the
    // overnight journey would come back instead.
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
  } finally { await shutdown({ app, index }); }
});

test("the arriveBy call site carries the margin: it reaches back to an earlier feeder rather than take a refused connection", async () => {
  // The direct proof that arriveBy's `runRaptorReverse` gets `transfer`. T1E
  // reaches stop 2000 at 07:55 (1200 s before T4, clears the margin), T1 at
  // 08:10 (300 s, does not). The reverse pass maximises departure, so without
  // the margin it takes T1 (08:00), with it T1E (07:30).
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
    // Both searches are merged, so the margin's T1E chain and the relaxed T1
    // chain both return. The T1E chain's presence proves the wiring.
    assert.equal(body.itineraries.length, 2);
    const safe = itineraryFor(body.itineraries, "T1E,T4");
    assert.equal(safe.departureTime, "2026-08-24T07:30:00+03:00");
    // It satisfies the margin, so it is unflagged (the flag is not simply
    // always true on this fixture).
    assert.notEqual(safe.transferAtRisk, true);
    // The relaxed search's tight T1 connection comes back alongside, flagged.
    assert.equal(itineraryFor(body.itineraries, "T1,T4").transferAtRisk, true);
  } finally { await shutdown({ app, index }); }
});

test("arriveBy yields to the flat margin at the last service of the day, flagged at risk", async () => {
  // The last-service fallback, reverse half: the query above without T5, so
  // T4 is R103's last service. Refusing T1's 300 s connection would delete
  // the only journey, so the reverse pass charges the flat 60 s and flags it.
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
    // No realtime store, so this `true` comes from the schedule.
    assert.equal(it.transferAtRisk, true);
  } finally { await shutdown({ app, index }); }
});

test("arriveBy at TRANSFER_HEADWAY_FACTOR=0 returns the ordinary flat-margin itinerary", async () => {
  // The off-switch half of the pair above. The 300 s wait is far below the
  // 12 h bound, so this does not prove the gate; "the wait bound is
  // genuinely gated" below does.
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
  } finally { await shutdown({ app, index }); }
});

/**
 * Isolates the wait bound's gate. TFEED reaches stop 8000 (served by nothing
 * else) at 08:10 and T4X leaves it at 22:00: a ~13h50m wait that clears any
 * margin, so reachability never depends on the feature and only the wait
 * bound can remove this itinerary. A separate short-wait chain to stop 5000
 * (T5, T6, T7: one more transfer) keeps the response non-empty when the
 * long-wait one is discarded.
 */
async function serveWithInherentlyLongWait(realtime: RealtimeStore | null) {
  return serveFixture({
    prefix: "long-wait",
    realtime,
    sql: `
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
  `,
  });
}

/**
 * The chain effect the per-connection last-service fallback cannot close.
 * R103 runs T4 (08:15) and T5 (09:00), a 2700 s gap, so boarding costs the
 * full 600 s cap; T1 reaches stop 2000 at 08:10, too close to T4, so that
 * connection is refused (R103 does run again). R104's only trip leaves 5000
 * at 08:30, which T4 makes and T5 (arriving 09:10) misses, so the margin
 * search finds nothing.
 */
async function serveWithChainEffect(realtime: RealtimeStore | null) {
  return serveFixture({
    prefix: "chain",
    realtime,
    sql: `
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
  `,
  });
}

test("the query-level retry: an empty margin-respecting result falls back to the flat rule for the whole query", async () => {
  // No query is left empty that the flat rule could answer. The margin
  // search is empty here (a chain effect), so the retry returns the flat
  // planner's itinerary with the tight transfers flagged.
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
  } finally { await shutdown({ app, index }); }
});

test("the relaxed search returns exactly what factor 0 returns, and is merged rather than replacing the margin's own answer", async () => {
  // The relaxed search's output must equal the flat planner's, and where the
  // margin search has an answer it must survive the merge.
  const { app, index } = await serveWithChainEffect(null);
  try {
    const empty = "/plan?from=stop:1000&to=stop:6000&departAfter=2026-08-24T07:30:00%2B03:00";
    const retried = await app.inject({ url: empty });
    const flat = await withHeadwayFactor(0, () => app.inject({ url: empty }));
    interface Body { itineraries: Record<string, unknown>[] }
    const strip = (r: { json: () => unknown }): unknown[] =>
      (r.json() as Body).itineraries.map((it) => {
        // `transferAtRisk` legitimately differs: the retry annotates against
        // the configured margin; a factor-0 request has no scaled rule.
        const rest = { ...it };
        delete rest.transferAtRisk;
        return rest;
      });
    assert.deepEqual(strip(retried), strip(flat));
    assert.equal((retried.json() as { itineraries: { transferAtRisk: unknown }[] })
      .itineraries[0]!.transferAtRisk, true);
    assert.equal((flat.json() as { itineraries: { transferAtRisk: unknown }[] })
      .itineraries[0]!.transferAtRisk, null);

    // Stop 5000: the margin answers on its own (T1 to T5, the later trip),
    // and the relaxed tight T1 to T4 comes back beside it, flagged.
    const notEmpty = "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00";
    const res = await app.inject({ url: notEmpty });
    const body = res.json() as {
      itineraries: { transferAtRisk: boolean | null; legs: { tripId?: string }[] }[];
    };
    assert.equal(body.itineraries.length, 2);
    assert.notEqual(itineraryFor(body.itineraries, "T1,T5").transferAtRisk, true);
    assert.equal(itineraryFor(body.itineraries, "T1,T4").transferAtRisk, true);
  } finally { await shutdown({ app, index }); }
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
    // Feature on: the ~13h50m wait between TFEED's 08:10 arrival and T4X's
    // 22:00 departure exceeds the 12 h bound and is refused. The
    // one-more-transfer chain survives, so the response is not empty (an
    // empty one would be retried with the flat rule, returning the rejected
    // itinerary).
    assert.deepEqual(trips(withHeadway.json() as { itineraries: WaitItinerary[] }), [
      ["T5", "T6", "T7"],
    ]);

    const flat = await withHeadwayFactor(0, () => app.inject({ url }));
    assert.equal(flat.statusCode, 200);
    // At factor 0 the same wait must survive: the gate, not reachability,
    // makes the difference. T5, T6, T7 (departs 20:00, 90 minutes) ranks
    // ahead of TFEED, T4X (departs in the morning) because arriveBy is
    // exempt from the departure window.
    assert.deepEqual(trips(flat.json() as { itineraries: WaitItinerary[] }), [
      ["T5", "T6", "T7"],
      ["TFEED", "T4X"],
    ]);
  } finally { await shutdown({ app, index }); }
});

/**
 * Adds stop 5000, about 73 m from stop 2000, with no service of its own; the
 * only way there is a baked footpath (100 m radius) from 2000. A reverse
 * chain ending in a footpath reports the deadline as its arrival, so its
 * `durationSeconds` diverges from the real ride; only this shape catches a
 * duration-based wait bound.
 */
async function serveWithFootpathEgress(realtime: RealtimeStore | null) {
  return serveFixture({
    prefix: "footpath-egress",
    footpaths: "baked",
    footpathMaxMeters: 100,
    realtime,
    sql: `
    INSERT INTO stops VALUES (5,'5000',NULL,'תחנה חדשה',NULL,32.0605,34.7755,0,NULL,'z1');
  `,
  });
}

test("a legitimate long-lead-time arriveBy journey survives the wait bound", async () => {
  // A ride into stop 2000 plus a short footpath to 5000: no transfer, so the
  // wait bound is 0 whatever the deadline. A duration-based bound would
  // refuse it: with a 20:00 deadline the deadline-anchored
  // `durationSeconds` is about 12 h.
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
    // T102 (13:00), the latest run into stop 2000 before the deadline. Which
    // trip is irrelevant; only that one survives, with a footpath tail.
    assert.deepEqual(
      it.legs.filter((l) => l.tripId !== undefined).map((l) => l.tripId),
      ["T102"],
    );
    assert.equal(it.legs[it.legs.length - 1]!.type, "walk", "must end on the footpath into 5000");
  } finally { await shutdown({ app, index }); }
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
    // The 300 s gap after T1 does not clear R103's 600 s cap, so the margin
    // search takes T5 (unflagged). The tight T4 connection, 45 minutes
    // earlier, is offered alongside it, flagged, so the choice is the rider's.
    assert.equal(body.itineraries.length, 2);
    const later = itineraryFor(body.itineraries, "T1,T5");
    assert.equal(later.arrivalTime, "2026-08-24T09:10:00+03:00");
    assert.notEqual(later.transferAtRisk, true);
    const tight = itineraryFor(body.itineraries, "T1,T4");
    assert.equal(tight.arrivalTime, "2026-08-24T08:25:00+03:00");
    assert.equal(tight.transferAtRisk, true);
  } finally { await shutdown({ app, index }); }
});

test("at the last service of the day the tight interchange is offered instead, flagged at risk", async () => {
  // The last-service fallback, forward half: the fixture above minus T5, so
  // T4 is R103's last service. Without the yield to the flat 60 s margin
  // (which the 300 s connection clears), the response would be empty.
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
    // Flagged, and with no realtime store this can only be the schedule.
    assert.equal(it.transferAtRisk, true);
  } finally { await shutdown({ app, index }); }
});

test("with TRANSFER_HEADWAY_FACTOR=0 the response is identical to today's", async () => {
  const { app, index } = await serveWithInfrequentTransfer(null, { laterTrip: true });
  try {
    const url = "/plan?from=stop:1000&to=stop:5000&departAfter=2026-08-24T07:30:00%2B03:00";
    const withHeadway = await app.inject({ url });
    const flat = await withHeadwayFactor(0, () => app.inject({ url }));

    assert.equal(withHeadway.statusCode, 200);
    assert.equal(flat.statusCode, 200);

    // `laterTrip` makes the feature change this query's outcome; without T5
    // the last-service fallback returns T1 to T4 at both factors and the
    // comparison would prove nothing.
    interface HeadwayItinerary {
      arrivalTime: string; transferAtRisk: boolean | null; legs: { tripId?: string }[];
    }
    const withHeadwayBody = withHeadway.json() as { itineraries: HeadwayItinerary[] };
    // The default factor returns both the margin's T1 to T5 (unflagged) and
    // the relaxed T1 to T4 (flagged); factor 0 returns only the latter.
    assert.equal(withHeadwayBody.itineraries.length, 2);
    assert.notEqual(itineraryFor(withHeadwayBody.itineraries, "T1,T5").transferAtRisk, true);
    assert.equal(itineraryFor(withHeadwayBody.itineraries, "T1,T4").transferAtRisk, true);

    // Factor 0 restores the flat-buffer itinerary: T1 to T4, 08:00 to 08:25,
    // one transfer.
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
  } finally { await shutdown({ app, index }); }
});

test("transferAtRisk uses the same margin the planner used", async () => {
  // R103's headway (via T4E) gives a 90 s margin, above the flat 60 s. A
  // predicted arrival at 08:13:55 (65 s before T4's 08:15) is safe under the
  // flat rule and at risk under the real one, which RAPTOR used.
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
  } finally { await shutdown({ app, index }); }
});

/**
 * Reoptimise's reverse query must carry the same `transfer` margin as the
 * forward search. TX shares T1's pattern, departing 08:05 and arriving
 * 08:10:50 (50 s after T1). R103's T4 departs 08:20, exactly T1's arrival
 * plus the 600 s NO_HEADWAY cap: T1 clears it at the boundary, TX misses by
 * 50 s. The flat 60 s rule accepts either, so a reverse query without the
 * margin would report TX's 08:05 instead of T1's 08:00.
 */
async function serveWithHeadwaySensitiveReoptimise() {
  return serveFixture({
    prefix: "reopt-headway",
    sql: `
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
  `,
  });
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
    // The unflagged T1,T4 itinerary must keep T1's 08:00 departure; with
    // `transfer` deleted from reoptimise it would report TX's 08:05. The
    // relaxed search also finds TX,T4 (the flat 60 s clears it), returned
    // separately and flagged.
    assert.equal(body.itineraries.length, 2);
    const it = itineraryFor(body.itineraries, "T1,T4");
    assert.equal(it.transfers, 1);
    assert.equal(it.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:30:00+03:00");
    assert.notEqual(it.transferAtRisk, true);
    const viaTx = itineraryFor(body.itineraries, "TX,T4");
    assert.equal(viaTx.departureTime, "2026-08-24T08:05:00+03:00");
    assert.equal(viaTx.transferAtRisk, true);
  } finally { await shutdown({ app, index }); }
});

/**
 * `transferAtRisk` on a reverse-built itinerary must use the reverse pass's
 * window-maximum rule, not the forward pass's pointwise one.
 *
 * T1B (07:40, arriving 07:50) and T1B2 (07:45, arriving 07:55) feed T4
 * (08:05) at stop 2000. R103 has a measured 180 s headway in hour 7
 * (T4a/T4b/T4c: a 45 s margin, floored to the 60 s base) and none in hour 8,
 * where T4 is the last trip (NO_HEADWAY, the full 600 s cap). The forward
 * rule at either feeder's hour 7 says 60 s; the reverse pass's 9-minute
 * window reaches T4's hour 8 and charges 600 s.
 *
 * Two feeders because arriveBy picks T1B2 directly, while departAfter finds
 * T1B and reoptimises onto T1B2.
 */
async function serveWithReverseWindowMargin(realtime: RealtimeStore | null) {
  return serveFixture({
    prefix: "reverse-window",
    realtime,
    sql: `
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
  `,
  });
}

test("transferAtRisk uses the reverse pass's window-maximum rule for a reverse-built itinerary", async () => {
  // arriveBy maximises departure, so it boards T1B2 (tripIdx 8, 07:45) over
  // T1B (07:40); both clear T4's 600 s requirement identically.
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
  } finally { await shutdown({ app, index }); }
});

test("transferAtRisk uses the reverse pass's rule for a reoptimised departAfter itinerary too", async () => {
  // The departAfter sibling of the test above. The forward pass finds T1B;
  // reoptimiseBounded swaps to T1B2 (same arrival at stop 5000, clearing
  // T4's 600 s reverse-pass requirement at the boundary), making the
  // itinerary reverse-sourced. T1B2 predicted 5 minutes late leaves 300 s
  // before T4's 08:05: safe under the forward rule's 60 s, at risk under the
  // reverse pass's 600 s.
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
  } finally { await shutdown({ app, index }); }
});

// Pins why the nearest-stop fallback takes several candidates: stopA is the
// crow-flight nearest, but its real walk misses its only trip; only stopB,
// the fifth candidate, is boardable (see `serveWithNearestFallback`). With
// N=1, or no fallback, there is no itinerary or a 422.
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

    // Exactly five candidates went through the (uncapped) refinement call:
    // not one, and not six (stopC, the sixth-nearest, is excluded).
    assert.equal(body.query.accessStops, 5);

    assert.ok(body.itineraries.length >= 1);
    const it = body.itineraries[0]!;
    const walk = it.legs.find((l) => l.type === "walk")!;
    const transit = it.legs.find((l) => l.type === "transit")!;

    // The real, closer-on-foot walk to stopB was used, not the crow-flight
    // nearer stopA, and not stopC's faster trip (never a candidate).
    assert.equal(walk.durationSeconds, 120);
    assert.equal(transit.tripId, "TB");
    assert.equal(transit.from.stop?.stopId, "9000");
  } finally { await shutdown({ app, index }); }
});

// Round 0's access labels plus footpath relaxation reach the destination
// with zero boardings. Nothing transit-based connects this pair, so the
// response must be empty rather than a walk.
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
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
});

// The reverse probe. Journey B departs 20 minutes later (08:20 vs 08:00) and
// arrives 4 minutes later than A, so a forward earliest-arrival search
// cannot produce it. It walks 30 s against A's 914 s (cost 599 against
// 2428), so effort ranking must put it first.
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
    // Two candidates also lets this catch a stray re-sort after
    // `rankItineraries`.
    assert.ok(body.itineraries.length >= 2, "expected both journeys as candidates");

    const best = body.itineraries[0]!;
    // T5 departs 08:20; T1 departs 08:00. The low-walk, later journey wins.
    assert.equal(new Date(best.departureTime).getUTCHours() * 60
      + new Date(best.departureTime).getUTCMinutes(), 5 * 60 + 20);
    assert.ok(best.walkSeconds < body.itineraries[1]!.walkSeconds);
  } finally { await shutdown({ app, index }); }
});

// A reverse search has no lower bound on departure, so it could return a
// chain leaving before departAfter. Smoke check only: the reverse pass
// maximises departure and always picks T5 here, so this passes even with
// the guard deleted. Do not delete the guard because this test passes.
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
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
});

// The window's anchor: a query hours before the first service (04:00; T1 is
// at 08:00) must return that service, not an empty list.
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
  } finally { await shutdown({ app, index }); }
});

// The departure window's exemption at the route level. A's walk share
// (60.4%) is under the 0.7 cap, so A survives and anchors the window at
// 08:00 (cutoff 08:30). B departs 08:40, past the cutoff but inside the
// probe's 08:55:14 deadline, and costs 599 against A's 2428. With the
// exemption B is first; without it, B is second.
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
    // 08:40+03:00 is 05:40 UTC. Only the order distinguishes the exemption
    // from its absence: both return the same two itineraries.
    assert.equal(
      new Date(best.departureTime).getUTCHours() * 60
        + new Date(best.departureTime).getUTCMinutes(),
      5 * 60 + 40,
      "the probe's cheaper, later-departing journey was not ranked first",
    );
    assert.ok(best.walkSeconds < body.itineraries[1]!.walkSeconds);
    assert.ok(best.durationSeconds < body.itineraries[1]!.durationSeconds);
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
});

test("a shifted leg reports the predicted times AND the scheduled ones", async () => {
  // T1 three minutes late: still inside the 90 s margin T4's 08:15 departure
  // demands, so the journey survives with a shifted leg to inspect. The leg
  // must report the live 08:03/08:13 the planner searched while still
  // carrying the timetable (08:00/08:10).
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
  } finally { await shutdown({ app, index }); }
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
  } finally { await shutdown({ app, index }); }
});
