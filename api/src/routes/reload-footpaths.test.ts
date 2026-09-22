import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { buildServer } from "../server.js";

const V1 = "2026-08-23T00-00-00-000Z";
const V2 = "2026-08-23T01-00-00-000Z";

/** Forces `buildFootpaths`'s straight-line fallback deterministically, with
 * no network call: `ping()` reporting false makes it skip `matrix()`
 * entirely, so `matrix` throwing if ever called is a hard guarantee nothing
 * silently fell through to a real request. */
const STUB_CLIENT = {
  ping: async () => false,
  matrix: async () => { throw new Error("STUB_CLIENT.matrix must never be called"); },
} as never;

const FOOTPATH_OPTIONS = {
  // 100 m is deliberately tight: it connects stop 2000 to the new stop 5000
  // (~73 m away) while excluding the new stop 6000 (~292 m away). A wider
  // radius (300 m) would let RAPTOR walk directly from 2000 to 6000 and skip
  // route R103/T4 entirely -- a real, valid itinerary, but one that would not
  // exercise "ride, walk a footpath, ride again", which is the whole point of
  // this fixture.
  maxMeters: 100, sameStationSeconds: 180, transferMinSeconds: 60,
  batchSize: 10, speedMps: 1.33,
};

/**
 * Adds a stop (5000) ~73 m from fixture stop 2000 -- far enough to need a
 * real footpath edge (not the same stop, not a `parent_station` pair), close
 * enough that even the tight 100 m radius above connects it -- plus a second
 * new stop (6000) reachable ONLY via a new route (R103/T4) boarding at 5000.
 * The only way from stop 1000 to stop 6000 in this fixture is therefore:
 * ride R1 to 2000, WALK the footpath to 5000, ride R103 to 6000. That walk leg
 * is what these tests use to prove footpaths survived a reload -- unlike the
 * fixture's existing routes, which never require a non-same-stop transfer.
 */
function addWalkTransferStops(dir: string, version: string): void {
  const path = join(dir, `gtfs-${version}.sqlite`);
  const db = new Database(path);
  db.exec(`
    INSERT INTO stops VALUES (5,'5000',NULL,'תחנה חדשה 1',NULL,32.0605,34.7755,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'6000',NULL,'תחנה חדשה 2',NULL,32.0620,34.7770,0,NULL,'z1');
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    -- T4: 08:15 -> 08:25, comfortably after T1's 08:10 arrival at 2000 plus
    -- the ~74 s walk and 60 s transfer buffer (~166 s of slack).
    INSERT INTO trips VALUES (4,'T4','R103','S1','יעד',0,NULL,1);
    INSERT INTO stop_times VALUES (4,5,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,6,2,30300,30300,1,0,900);
    -- T4E: a SECOND, earlier R103 trip, needed because /plan applies a
    -- headway-scaled transfer margin. With only T4 on this pattern, R103
    -- would report NO_HEADWAY (a single trip produces no
    -- gap to measure -- see transit/headway.ts's buildHeadwayTable), which
    -- charges the full TRANSFER_MAX_SECONDS cap (600 s by default) on top
    -- of transferMinSeconds for boarding it -- far more than the ~166 s of
    -- slack this fixture actually offers, which would make the walk
    -- transfer this whole file exists to test unreachable. T4E departs
    -- stop 5000 at 08:09:00, well before the walk from 2000 could ever
    -- deliver anyone there, so it is never itself boardable -- its only
    -- role is to give R103's pattern a measurable 360 s headway in hour 8
    -- (08:15:00 - 08:09:00), which the default 0.25 factor scales to a
    -- 90 s required margin: comfortably inside the slack this fixture
    -- offers.
    INSERT INTO trips VALUES (5,'T4E','R103','S1','יעד',0,NULL,1);
    INSERT INTO stop_times VALUES (5,5,1,29340,29340,0,1,0);
    INSERT INTO stop_times VALUES (5,6,2,29940,29940,1,0,900);
  `);
  db.close();
}

interface Place { type: string; stopId?: string }
interface Leg { type: string; from: Place; to: Place; walkEstimated?: boolean }
interface PlanResponse { itineraries: { legs: Leg[] }[] }
interface MetaResponse { index: { footpaths: string } }

/** Reports Valhalla present, with a flat cost for the only street pair the
 *  fixture below ever asks about (stop 2000 to the new stop 5000, ~73 m). A
 *  fixed reply is enough to make the whole build finish in "valhalla" mode:
 *  buildFootpaths calls this per direction and per batch, not per output
 *  edge. */
const ROUTED_CLIENT = {
  ping: async () => true,
  matrix: async (_s: unknown[], t: unknown[]) =>
    [t.map(() => ({ distanceMeters: 73, durationSeconds: 60 }))],
} as never;

test("a reload re-attaches footpaths to the newly served index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-footpath-reload-"));
  buildFixtureDb(dir, V1);
  const index = new IndexManager(dir, {
    buildFn: async () => buildIndex(join(dir, "gtfs.sqlite")),
    footpaths: { client: STUB_CLIENT, options: FOOTPATH_OPTIONS, cacheDir: join(dir, "cache") },
  });

  await index.rebuild();
  const first = index.current();
  assert.notEqual(first, null);
  // Same-station pair 3000/4000 alone guarantees at least one footpath edge
  // regardless of maxMeters (see footpaths.ts's stationPeers), so a healthy
  // build's footTarget is never empty.
  assert.ok(first!.footTarget.length > 0, "initial build must attach footpaths");
  assert.equal(index.footpathMode(), "straight-line");

  // Simulate a nightly feed swap: gtfs republishes a new version and
  // repoints the symlink.
  unlinkSync(join(dir, "gtfs.sqlite"));
  buildFixtureDb(dir, V2);

  assert.equal(await index.maybeReload(), true);

  const second = index.current();
  assert.notEqual(second, first, "the served index identity must actually change on a reload");
  assert.ok(
    second!.footTarget.length > 0,
    "the index served AFTER a reload must have footpaths attached too -- " +
    "buildIndex always starts a fresh TimetableIndex with EMPTY footTarget/footSeconds, " +
    "and nothing but this attachment step ever populates them",
  );
  assert.equal(index.footpathMode(), "straight-line");

  index.stop();
});

test("a walking-transfer /plan still succeeds after a reload, and /meta's footpath mode stays truthful", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-footpath-http-"));
  buildFixtureDb(dir, V1);
  addWalkTransferStops(dir, V1);

  const index = new IndexManager(dir, {
    buildFn: async () => buildIndex(join(dir, "gtfs.sqlite")),
    footpaths: { client: STUB_CLIENT, options: FOOTPATH_OPTIONS, cacheDir: join(dir, "cache") },
  });
  await index.rebuild();
  const app = await buildServer({ index });

  const query = "/plan?from=stop:1000&to=stop:6000&departAfter=2026-08-24T07:00:00%2B03:00";

  const before = (await app.inject({ url: query })).json() as PlanResponse;
  assert.ok(before.itineraries.length > 0, "must find the walk-transfer journey before the swap");
  const beforeWalk = before.itineraries[0]!.legs.find((l) => l.type === "walk");
  assert.ok(beforeWalk, "the only route to stop 6000 requires a walking transfer at 2000/5000");
  assert.equal(beforeWalk!.from.stopId, "2000");
  assert.equal(beforeWalk!.to.stopId, "5000");
  // STUB_CLIENT's ping() reports Valhalla absent, so this index's footpaths
  // are straight-line -- the transfer leg's duration is still the estimate.
  assert.equal(beforeWalk!.walkEstimated, true);

  const metaBefore = (await app.inject({ url: "/meta" })).json() as MetaResponse;
  assert.equal(metaBefore.index.footpaths, "straight-line");

  // Simulate a nightly feed swap.
  unlinkSync(join(dir, "gtfs.sqlite"));
  buildFixtureDb(dir, V2);
  addWalkTransferStops(dir, V2);
  assert.equal(await index.maybeReload(), true);

  const after = (await app.inject({ url: query })).json() as PlanResponse;
  assert.ok(
    after.itineraries.length > 0,
    "must STILL find the walk-transfer journey after the swap -- this is exactly what silently " +
    "breaks if a reload does not re-attach footpaths to the new index",
  );
  const afterWalk = after.itineraries[0]!.legs.find((l) => l.type === "walk");
  assert.ok(afterWalk, "the walking transfer must still exist after a reload");
  assert.equal(afterWalk!.from.stopId, "2000");
  assert.equal(afterWalk!.to.stopId, "5000");
  assert.equal(afterWalk!.walkEstimated, true);

  // /meta must describe the index actually being served, not a value left
  // over from an earlier build.
  const metaAfter = (await app.inject({ url: "/meta" })).json() as MetaResponse;
  assert.equal(metaAfter.index.footpaths, "straight-line");

  await app.close(); index.stop();
});

// The routed mirror of the test above: exercises all three `footpathsRouted`
// assignment sites in manager.ts's `attachFootpathsTo` (the `mode ===
// "valhalla"` build, the cache hit on the second load, and -- unreached here
// but covered by the stub variant above -- the straight-line/catch fallback).
// Together with routes/accessRefine.ts's tests (access/egress) and
// itinerary.test.ts (same-station), this covers all three legs of the
// `walkEstimated` rule end to end.
test("a walking-transfer /plan reports walkEstimated false when footpaths were routed, and it survives a reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-footpath-routed-"));
  buildFixtureDb(dir, V1);
  addWalkTransferStops(dir, V1);

  const index = new IndexManager(dir, {
    buildFn: async () => buildIndex(join(dir, "gtfs.sqlite")),
    footpaths: { client: ROUTED_CLIENT, options: FOOTPATH_OPTIONS, cacheDir: join(dir, "cache") },
  });
  await index.rebuild();
  const app = await buildServer({ index });

  const query = "/plan?from=stop:1000&to=stop:6000&departAfter=2026-08-24T07:00:00%2B03:00";

  const before = (await app.inject({ url: query })).json() as PlanResponse;
  assert.ok(before.itineraries.length > 0, "must find the walk-transfer journey before the swap");
  const beforeWalk = before.itineraries[0]!.legs.find((l) => l.type === "walk");
  assert.ok(beforeWalk, "the only route to stop 6000 requires a walking transfer at 2000/5000");
  assert.equal(beforeWalk!.from.stopId, "2000");
  assert.equal(beforeWalk!.to.stopId, "5000");
  // ROUTED_CLIENT's ping() reports Valhalla present, so this index's
  // footpaths are real -- the transfer leg's duration is a routed time.
  assert.equal(beforeWalk!.walkEstimated, false);

  const metaBefore = (await app.inject({ url: "/meta" })).json() as MetaResponse;
  assert.equal(metaBefore.index.footpaths, "valhalla");

  // Simulate a nightly feed swap. The stop set is unchanged, so this load
  // hits the footpath cache -- exercising the cache-hit assignment site,
  // not the mode === "valhalla" build path the first load exercised.
  unlinkSync(join(dir, "gtfs.sqlite"));
  buildFixtureDb(dir, V2);
  addWalkTransferStops(dir, V2);
  assert.equal(await index.maybeReload(), true);

  const after = (await app.inject({ url: query })).json() as PlanResponse;
  assert.ok(
    after.itineraries.length > 0,
    "must STILL find the walk-transfer journey after the swap",
  );
  const afterWalk = after.itineraries[0]!.legs.find((l) => l.type === "walk");
  assert.ok(afterWalk, "the walking transfer must still exist after a reload");
  assert.equal(afterWalk!.from.stopId, "2000");
  assert.equal(afterWalk!.to.stopId, "5000");
  assert.equal(afterWalk!.walkEstimated, false, "must survive the feed swap, not just the initial build");

  const metaAfter = (await app.inject({ url: "/meta" })).json() as MetaResponse;
  assert.equal(metaAfter.index.footpaths, "valhalla");

  await app.close(); index.stop();
});
