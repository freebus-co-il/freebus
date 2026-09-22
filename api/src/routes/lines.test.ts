import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { RealtimeStore } from "../realtime/store.js";
import type { RealtimeJourney } from "../realtime/types.js";
import { baseEpochOfYmd } from "../transit/calendar.js";
import { config } from "../config.js";

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-lines-http-"));
  const link = buildFixtureDb(dir);
  // In-process buildFn: these tests exercise the DB-backed routes, not the
  // index worker, so a spawned worker would only add noise.
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  return { app: await buildServer({ index }), index };
}

/** Like `serve`, with a realtime store and a BUILT index: the run list
 *  resolves an unscheduled run's template through `app.index.current()`. */
async function serveWithRealtime(realtime: RealtimeStore) {
  const dir = mkdtempSync(join(tmpdir(), "transit-lines-rt-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/** One unscheduled run on R1, templated on T2 (trip index 1, 09:00), starting
 *  two minutes early. `byStop` empty means it has no stop left ahead. */
function storeWithRunOnT2(byStop: [number, number][]): RealtimeStore {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const journey: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: "2026-08-24", datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null, vehicleRef: "veh-9",
    confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
  };
  store.replace([], { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 1 }, 1_000, [{
    templateTripIdx: 1, offsetSeconds: -120, serviceBaseEpoch: baseEpochOfYmd(20260824, config.timezone), journey,
    byStopIdx: new Map(byStop.map(([stopIdx, expectedArrival]) => [stopIdx, { expectedArrival, ambiguous: false }])),
  }]);
  return store;
}

test("GET /routes paginates", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/routes?limit=1" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { routes: unknown[]; total: number };
  assert.equal(body.routes.length, 1);
  assert.equal(body.total, 8);
  await app.close(); index.stop();
});

test("GET /routes/:id returns directions, 404 when unknown", async () => {
  const { app, index } = await serve();
  assert.equal((await app.inject({ url: "/routes/R1" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/routes/nope" })).statusCode, 404);
  await app.close(); index.stop();
});

test("GET /routes/:id/shape returns GeoJSON in [lon, lat] order", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/routes/R1/shape" });
  const body = res.json() as { geometry: { coordinates: [number, number][] } };
  assert.ok(body.geometry.coordinates[0]![0] > 34);
  await app.close(); index.stop();
});

test("GET /trips/:id returns the timetable, 404 when unknown", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/trips/T1" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { stops: unknown[] }).stops.length, 2);
  assert.equal((await app.inject({ url: "/trips/nope" })).statusCode, 404);
  await app.close(); index.stop();
});

test("GET /routes returns desc and keeps a line's rows adjacent", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/routes?limit=100" });
  const body = res.json() as { routes: { routeId: string; desc: string | null }[] };

  const descs = body.routes.map((r) => r.desc);
  assert.ok(descs.includes("67003-1-0"), "desc must be returned");

  // Every row of line 67003 must occupy one contiguous run.
  const positions = body.routes
    .map((r, i) => (r.desc?.startsWith("67003-") ? i : -1))
    .filter((i) => i !== -1);
  assert.equal(positions.length, 4);
  assert.equal(positions[positions.length - 1]! - positions[0]!, 3);
  await app.close(); index.stop();
});

test("GET /routes filters by lineCode", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/routes?lineCode=67003" });
  const body = res.json() as { routes: { routeId: string }[]; total: number };
  assert.equal(body.total, 4);
  assert.deepEqual(
    body.routes.map((r) => r.routeId).sort(),
    ["R3", "R4", "R5", "R6"],
  );
  await app.close(); index.stop();
});

test("GET /routes lineCode keys a rail row on its route id, not its desc", async () => {
  const { app, index } = await serve();
  // R7 and R8 share the bare desc '900'. The desc is not a key for them.
  const byRouteId = await app.inject({ url: "/routes?lineCode=route:R7" });
  const body = byRouteId.json() as { routes: { routeId: string }[]; total: number };
  assert.equal(body.total, 1);
  assert.equal(body.routes[0]!.routeId, "R7");

  const byDesc = await app.inject({ url: "/routes?lineCode=900" });
  assert.equal((byDesc.json() as { total: number }).total, 0);
  await app.close(); index.stop();
});

test("GET /routes/:id/trips returns that route's runs in departure order", async (t) => {
  // This endpoint has no date/time query parameter of its own -- it always
  // asks nextRuns() for "today" (see db/lines.ts). The fixture's calendar
  // window is FIXED (S1: 20260821-20260920, testing/fixture.ts), so a test
  // that lets this read the real clock silently starts failing the day
  // after the window ends and stays broken forever after. Pin the clock to
  // 2026-08-24, a Monday inside S1's Sun-Thu service, instead of letting it
  // drift -- do not replace this with `new Date()`.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-24T07:00:00+03:00").getTime() });
  const { app, index } = await serve();
  try {
    const res = await app.inject({ url: "/routes/R1/trips?limit=10" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { runs: { tripId: string; departureTime: string }[] };
    assert.deepEqual(body.runs.map((r) => r.tripId), ["T1", "T2"]);
    // Ordered, and never another route's trips.
    assert.ok(body.runs[0]!.departureTime < body.runs[1]!.departureTime);
  } finally {
    await app.close(); index.stop();
    t.mock.timers.reset();
  }
});

test("GET /routes/:id/trips 404s on an unknown route", async () => {
  const { app, index } = await serve();
  assert.equal((await app.inject({ url: "/routes/nope/trips" })).statusCode, 404);
  await app.close(); index.stop();
});

test("GET /lines/:code collapses alternatives and keys directions on the desc digit", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/lines/67003" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    lineCode: string; shortName: string | null; type: number;
    directions: { direction: string; directionId: number; routeId: string; stops: unknown[] }[];
  };

  assert.equal(body.lineCode, "67003");
  assert.equal(body.shortName, "3");

  // Four route rows, but three directions: R3 and R4 are alternatives of
  // direction "1" and must collapse to one entry.
  assert.deepEqual(body.directions.map((d) => d.direction), ["1", "2", "3"]);

  // R3 has three stops, R4 two — the representative is the longer.
  const dir1 = body.directions[0]!;
  assert.equal(dir1.routeId, "R3");
  assert.equal(dir1.stops.length, 3);

  // Why this endpoint exists: directions "1" and "3" both carry GTFS
  // direction_id 0, so keying on direction_id would merge them.
  assert.equal(body.directions[0]!.directionId, 0);
  assert.equal(body.directions[2]!.directionId, 0);
  await app.close(); index.stop();
});

test("GET /lines/:code keys each rail row on its route id, not its shared desc", async () => {
  const { app, index } = await serve();

  // R7 and R8 are different services that happen to share the bare desc
  // '900' -- 32 undashed descs in the real feed are shared by exactly two
  // route rows. The desc is therefore NOT a line code: asking for it must
  // 404 rather than answer with one of the two services and hide the other.
  assert.equal((await app.inject({ url: "/lines/900" })).statusCode, 404);

  const seven = await app.inject({ url: "/lines/route:R7" });
  assert.equal(seven.statusCode, 200);
  const r7 = seven.json() as {
    lineCode: string; shortName: string | null; longName: string | null;
    type: number; directions: { routeId: string }[];
  };
  assert.equal(r7.lineCode, "route:R7");
  assert.equal(r7.type, 2);
  assert.equal(r7.longName, "נהריה<->מודיעין");
  assert.deepEqual(r7.directions.map((d) => d.routeId), ["R7"]);

  const eight = await app.inject({ url: "/lines/route:R8" });
  assert.equal(eight.statusCode, 200);
  const r8 = eight.json() as { longName: string | null; directions: { routeId: string }[] };
  assert.equal(r8.longName, "מודיעין<->נהריה");
  assert.deepEqual(r8.directions.map((d) => d.routeId), ["R8"]);
  await app.close(); index.stop();
});

test("GET /lines/:code 404s on an unknown code", async () => {
  const { app, index } = await serve();
  assert.equal((await app.inject({ url: "/lines/nope" })).statusCode, 404);
  await app.close(); index.stop();
});

test("GET /agencies reports the route types each agency actually runs", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/agencies" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { agencies: { agencyId: string; types: number[] }[] };

  // The fixture's single agency runs bus rows (R1-R6) and rail rows (R7,
  // R8), so both types must be present -- ascending, and distinct despite
  // six bus rows and two rail rows.
  const two = body.agencies.find((a) => a.agencyId === "2");
  assert.ok(two !== undefined, "agency 2 must be listed");
  assert.deepEqual(two.types, [2, 3]);
  await app.close(); index.stop();
});

test("GET /routes takes a comma-separated type list", async () => {
  const { app, index } = await serve();

  // Widening, not a break: a single value still behaves exactly as before.
  const bus = await app.inject({ url: "/routes?type=3&limit=100" });
  const busBody = bus.json() as { routes: { routeId: string; type: number }[]; total: number };
  assert.equal(busBody.total, 6);
  assert.deepEqual(
    busBody.routes.map((r) => r.routeId).sort(),
    ["R1", "R2", "R3", "R4", "R5", "R6"],
  );

  const both = await app.inject({ url: "/routes?type=3,2&limit=100" });
  const bothBody = both.json() as { routes: { routeId: string }[]; total: number };
  assert.equal(bothBody.total, 8);
  assert.deepEqual(
    bothBody.routes.map((r) => r.routeId).sort(),
    ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
  );

  // Whitespace around an entry survives a URL-decoded space, as parseModes
  // tolerates it for /plan.
  const spaced = await app.inject({ url: "/routes?type=3,%202&limit=100" });
  assert.equal((spaced.json() as { total: number }).total, 8);
  await app.close(); index.stop();
});

test("GET /routes takes a comma-separated agency list", async () => {
  const { app, index } = await serve();

  // A single value keeps working.
  const one = await app.inject({ url: "/routes?agency=2&limit=100" });
  assert.equal((one.json() as { total: number }).total, 8);

  // ...and a list matches on any of its entries. The fixture has one
  // agency, so the second entry is a miss that must not narrow the first.
  const many = await app.inject({ url: "/routes?agency=2,999&limit=100" });
  assert.equal((many.json() as { total: number }).total, 8);

  const none = await app.inject({ url: "/routes?agency=999&limit=100" });
  assert.equal((none.json() as { total: number }).total, 0);
  await app.close(); index.stop();
});

test("GET /routes excludes the types in excludeTypes", async () => {
  const { app, index } = await serve();

  // Why the Lines tab passes 2: every rail row here has an empty
  // route_short_name and an ungroupable desc, so it is an unnamed "line".
  const res = await app.inject({ url: "/routes?excludeTypes=2&limit=100" });
  const body = res.json() as { routes: { routeId: string; type: number }[]; total: number };
  assert.equal(body.total, 6);
  assert.ok(!body.routes.some((r) => r.type === 2), "no rail row may survive");
  await app.close(); index.stop();
});

test("GET /routes lets excludeTypes win over type", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/routes?type=2&excludeTypes=2&limit=100" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { routes: unknown[]; total: number };
  assert.equal(body.total, 0);
  assert.equal(body.routes.length, 0);
  await app.close(); index.stop();
});

test("GET /routes 400s on a malformed type or excludeTypes list", async () => {
  const { app, index } = await serve();

  const bad = await app.inject({ url: "/routes?type=3,abc" });
  assert.equal(bad.statusCode, 400);
  assert.ok(
    (bad.json() as { message: string }).message.includes("abc"),
    "the 400 must name the offending value",
  );

  const badExclude = await app.inject({ url: "/routes?excludeTypes=2,nope" });
  assert.equal(badExclude.statusCode, 400);
  assert.ok((badExclude.json() as { message: string }).message.includes("nope"));
  await app.close(); index.stop();
});

test("GET /routes/:id/trips lists unscheduled runs on the road first, then the timetable", async (t) => {
  // Same reason as the "departure order" test above: no date param on this
  // endpoint, and the fixture's calendar window is fixed -- pin the clock
  // rather than let it read the real, ever-advancing one. Also matches
  // storeWithRunOnT2's own hardcoded `dataFrameRef`/`serviceBaseEpoch` of
  // 2026-08-24.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-24T07:00:00+03:00").getTime() });
  const { app, index } = await serveWithRealtime(storeWithRunOnT2([[1, 5_000]]));
  try {
    const res = await app.inject({ url: "/routes/R1/trips?limit=10" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { runs: { tripId: string; runId: string; unscheduled: boolean; offsetSeconds: number; departureTime: string; directionId: number }[] };
    const [first, ...timetable] = body.runs;
    assert.deepEqual(
      { tripId: first!.tripId, runId: first!.runId, unscheduled: first!.unscheduled, offsetSeconds: first!.offsetSeconds, departureTime: first!.departureTime, directionId: first!.directionId },
      { tripId: "T2", runId: "T2@veh-9", unscheduled: true, offsetSeconds: -120, departureTime: "2026-08-24T08:58:00+03:00", directionId: 0 },
    );
    // Prepended without eating the limit: the timetable still lists both runs.
    assert.deepEqual(timetable.map((r) => [r.tripId, r.runId, r.unscheduled, r.offsetSeconds]), [["T1", "T1", false, 0], ["T2", "T2", false, 0]]);
  } finally {
    await app.close(); index.stop();
    t.mock.timers.reset();
  }
});

test("GET /routes/:id/trips leaves off an unscheduled run with no stop ahead", async () => {
  const { app, index } = await serveWithRealtime(storeWithRunOnT2([]));
  try {
    const res = await app.inject({ url: "/routes/R1/trips?limit=10" });
    const body = res.json() as { runs: { unscheduled: boolean }[] };
    assert.ok(body.runs.every((r) => !r.unscheduled));
  } finally { await app.close(); index.stop(); }
});

test("GET /routes/:id/trips around a stop never prepends unscheduled runs", async () => {
  // `runsAround` has no lookahead loop like `nextRuns` -- it times a 5 h
  // window around the real clock, so it may find zero runs depending on when
  // this test happens to execute. What this pins, regardless of that: an
  // unscheduled run is never merged into the around branch, and every entry
  // it DOES return carries the plain-timetable field values from item 1.
  const { app, index } = await serveWithRealtime(storeWithRunOnT2([[1, 5_000]]));
  try {
    const res = await app.inject({ url: "/routes/R1/trips?stopId=1000&around=T2" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { runs: { tripId: string; runId: string; unscheduled: boolean; offsetSeconds: number }[] };
    assert.ok(body.runs.every((r) => !r.unscheduled), "the around branch stays free of unscheduled entries");
    assert.ok(body.runs.every((r) => r.runId === r.tripId));
    assert.ok(body.runs.every((r) => r.offsetSeconds === 0));
  } finally { await app.close(); index.stop(); }
});

test("GET /routes/:id/trips around a stop needs both stopId and around", async () => {
  const { app, index } = await serve();
  for (const q of ["stopId=1000", "around=T1"]) {
    const res = await app.inject({ url: `/routes/R1/trips?${q}` });
    assert.equal(res.statusCode, 400, q);
  }
  await app.close(); index.stop();
});

test("GET /routes/:id/trips around a trip that is not running answers no runs", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/routes/R1/trips?stopId=1000&around=nope" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { runs: [] });
  await app.close(); index.stop();
});


test("GET /trips/:id and the rail line/route pages show a train's destination, not its number", async () => {
  const { app, index } = await serve();
  try {
    const rail = (await app.inject({ url: "/trips/T106?lang=en" })).json() as { headsign: string | null; tripNumber: string | null };
    assert.equal(rail.headsign, "Central Station");
    assert.equal(rail.tripNumber, "106");
    const bus = (await app.inject({ url: "/trips/T1?lang=en" })).json() as { headsign: string | null; tripNumber: string | null };
    assert.equal(bus.headsign, "Herzl");
    assert.equal(bus.tripNumber, null);

    const line = (await app.inject({ url: "/lines/route:R8?lang=en" })).json() as { directions: { headsign: string | null }[] };
    assert.equal(line.directions[0]!.headsign, "Central Station");
    const route = (await app.inject({ url: "/routes/R8?lang=en" })).json() as { directions: { headsign: string | null }[] };
    assert.equal(route.directions[0]!.headsign, "Central Station");
  } finally { await app.close(); index.stop(); }
});
