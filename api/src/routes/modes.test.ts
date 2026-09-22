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

type ModeRow = { type: number; name: string; routes: number };
type App = Awaited<ReturnType<typeof buildServer>>;

/**
 * The shared fixture carries six `route_type` 3 routes and one rail row
 * (R7, `route_type` 2), which cannot on its own distinguish any of the
 * behaviours under test. Rather than widen that fixture (several other
 * suites assert against its counts), each test here opens the freshly built
 * database and appends its own routes/trips BEFORE the index and the server
 * bundle are built -- both read the same file, so the additions are visible
 * to each.
 */
function seed(extraSql: string): { dir: string; link: string } {
  const dir = mkdtempSync(join(tmpdir(), "transit-modes-"));
  const link = buildFixtureDb(dir);
  if (extraSql !== "") {
    const db = new Database(link);
    db.exec(extraSql);
    db.close();
  }
  return { dir, link };
}

async function serve(extraSql = "", withIndex = true): Promise<App> {
  const { dir, link } = seed(extraSql);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  if (withIndex) await index.rebuild();
  return buildServer({ index, adminToken: null });
}

async function modesOf(app: App): Promise<ModeRow[]> {
  const res = await app.inject({ url: "/modes" });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { modes: ModeRow[] }).modes;
}

/** A route plus one two-stop trip on it, reusing the fixture's own stops and
 *  weekday service so the trip is a real, indexable one. */
function routeWithTrip(routeId: string, shortName: string, type: number, ref: number): string {
  return `
    INSERT INTO routes VALUES ('${routeId}','2','${shortName}','קו','6700${ref}-1-#',${type},NULL);
    INSERT INTO trips  VALUES (${ref},'T${ref}','${routeId}','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (${ref},1,1,36000,36000,0,1,0);
    INSERT INTO stop_times VALUES (${ref},2,2,36600,36600,1,0,1200);
  `;
}

test("GET /modes reports each route_type that has trips, named", async () => {
  // R103 is a second rail route (type 2) with one trip, alongside the
  // fixture's own R7; R1..R6 are buses.
  const app = await serve(routeWithTrip("R103", "3", 2, 4));
  const modes = await modesOf(app);

  assert.deepEqual(modes.map((m) => m.type).sort((a, b) => a - b), [2, 3]);
  assert.equal(modes.find((m) => m.type === 3)!.name, "Bus");
  assert.equal(modes.find((m) => m.type === 2)!.name, "Rail");
});

test("GET /modes sorts by route count, descending", async () => {
  const app = await serve(routeWithTrip("R103", "3", 2, 4));
  const modes = await modesOf(app);

  // Six buses (R1..R6) outrank three trains (R7, R8 and R103).
  assert.deepEqual(modes.map((m) => m.type), [3, 2]);
  assert.equal(modes[0]!.routes, 6);
  assert.equal(modes[1]!.routes, 3);
});

test("GET /modes omits a route_type whose routes have no trips", async () => {
  // A ferry route with no trip rows at all: filtering to it could only ever
  // return nothing, so it must never be offered as a toggle. This is the
  // whole reason the tally runs over the index rather than over `routes`.
  const app = await serve(`
    INSERT INTO routes VALUES ('R9','2','9','מעבורת','67009-1-#',4,NULL);
  `);
  const modes = await modesOf(app);

  assert.equal(modes.find((m) => m.type === 4), undefined);
  // Bus and rail, the two the fixture itself has trips for -- and no ferry.
  assert.deepEqual(modes.map((m) => m.type), [3, 2]);
});

test("GET /modes counts routes, not trips", async () => {
  // One extra bus route carrying two trips: the bus count must go 6 -> 7
  // (routes), not 7 -> 9 (trips).
  const app = await serve(`
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי','67004-1-#',3,NULL);
    INSERT INTO trips  VALUES (5,'T5','R104','S1','הרצל',0,NULL,0);
    INSERT INTO trips  VALUES (6,'T6','R104','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (5,1,1,36000,36000,0,1,0);
    INSERT INTO stop_times VALUES (5,2,2,36600,36600,1,0,1200);
    INSERT INTO stop_times VALUES (6,1,1,39600,39600,0,1,0);
    INSERT INTO stop_times VALUES (6,2,2,40200,40200,1,0,1200);
  `);
  const modes = await modesOf(app);

  assert.equal(modes.find((m) => m.type === 3)!.routes, 7);
});

test("GET /modes falls back to a numeric name for an unknown route_type", async () => {
  const app = await serve(routeWithTrip("R107", "7", 999, 7));
  const modes = await modesOf(app);

  assert.equal(modes.find((m) => m.type === 999)!.name, "Route type 999");
});

test("GET /modes is 503 until an index is ready", async () => {
  const app = await serve("", false);
  const res = await app.inject({ url: "/modes" });

  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as { code: string }).code, "index_not_ready");
});

test("GET /modes recomputes after a feed swap", async () => {
  // A REAL feed swap: a new versioned file with the `gtfs.sqlite` symlink
  // repointed at it, exactly as reload.test.ts stages one. Editing the
  // existing file in place would NOT do -- `IndexManager.rebuild` reopens the
  // db bundle only when the live target filename changes (see its own
  // comment), so an in-place edit rebuilds `tripRouteIdx` while leaving
  // `routeTypeByIdx` stale, and the two parallel arrays this endpoint reads
  // would disagree. That divergence cannot arise from a production swap,
  // which always writes a new file, so staging one here keeps the test
  // honest about what it proves.
  const dir = mkdtempSync(join(tmpdir(), "transit-modes-swap-"));
  const link = join(dir, "gtfs.sqlite");
  buildFixtureDb(dir, "2026-08-21T16-10-22-006Z");
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  const app = await buildServer({ index, adminToken: null });

  // The fixture's own modes: bus and rail. Ferry is what the swap adds.
  assert.deepEqual((await modesOf(app)).map((m) => m.type), [3, 2]);
  assert.equal((await modesOf(app)).some((m) => m.type === 4), false);

  unlinkSync(link);
  buildFixtureDb(dir, "2026-08-22T00-00-00-000Z");
  const db = new Database(link);
  db.exec(routeWithTrip("R109", "9", 4, 9));
  db.close();
  await index.rebuild();

  assert.ok((await modesOf(app)).some((m) => m.type === 4));
});
