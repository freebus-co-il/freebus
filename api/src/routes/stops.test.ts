import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-routes-"));
  const link = buildFixtureDb(dir);
  // In-process buildFn: these tests exercise the DB-backed routes, not the
  // index worker, so a spawned worker would only add noise.
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index });
  return { app, index };
}

test("GET /stops/search returns matches", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/search?q=הרצל" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { stops: { stopId: string }[] };
  assert.equal(body.stops[0]!.stopId, "2000");
  await app.close(); index.stop();
});

test("GET /stops/search honours lang", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/search?q=Herzl&lang=en" });
  const body = res.json() as { stops: { name: string }[] };
  assert.equal(body.stops[0]!.name, "Herzl");
  await app.close(); index.stop();
});

// `q` is optional: the Stations tab opens on this endpoint before the rider
// has typed anything, and gets an alphabetical page rather than an error.
// See the browse-mode test below for the full contract.
test("GET /stops/search accepts a missing q", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/search" });
  assert.equal(res.statusCode, 200);
  await app.close(); index.stop();
});

test("GET /stops/search rejects an unsupported lang", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/search?q=x&lang=fr" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("GET /stops/search with an embedded NUL byte does not 500", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/search?q=abc%00def" });
  assert.notEqual(res.statusCode, 500);
  await app.close(); index.stop();
});

test("GET /stops/nearby returns stops ordered by distance", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/nearby?lat=32.0554&lon=34.78&radius=800" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { stops: { stopId: string; distanceMeters: number }[] };
  assert.equal(body.stops[0]!.stopId, "1000");
  await app.close(); index.stop();
});

test("GET /stops/:id returns detail, 404 when unknown", async () => {
  const { app, index } = await serve();
  const ok = await app.inject({ url: "/stops/3000" });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { children: unknown[] }).children.length, 1);
  const missing = await app.inject({ url: "/stops/nope" });
  assert.equal(missing.statusCode, 404);
  await app.close(); index.stop();
});

test("GET /agencies lists agencies", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/agencies" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { agencies: unknown[] }).agencies.length, 1);
  await app.close(); index.stop();
});

test("GET /stops/search with no q lists stops alphabetically and pages", async () => {
  const { app, index } = await serve();
  const all = (await app.inject({ url: "/stops/search?limit=10" })).json() as
    { stops: { stopId: string; name: string | null }[] };
  assert.equal(all.stops.length, 4);
  const names = all.stops.map((s) => s.name ?? "");
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names);

  const page2 = (await app.inject({ url: "/stops/search?limit=2&offset=2" })).json() as
    { stops: { stopId: string }[] };
  assert.equal(page2.stops.length, 2);
  assert.deepEqual(page2.stops.map((s) => s.stopId), all.stops.slice(2).map((s) => s.stopId));
  await app.close(); index.stop();
});

test("GET /stops/search still searches when q is given", async () => {
  const { app, index } = await serve();
  const res = (await app.inject({ url: "/stops/search?q=הרצל" })).json() as
    { stops: { stopId: string }[] };
  assert.ok(res.stops.some((s) => s.stopId === "2000"));
  await app.close(); index.stop();
});

test("GET /stops/nearby includes the lines calling at each stop", async () => {
  const { app, index } = await serve();
  const res = (await app.inject({ url: "/stops/nearby?lat=32.0554&lon=34.78&radius=2000" })).json() as
    { stops: { stopId: string; routes: { shortName: string }[] }[] };
  const central = res.stops.find((s) => s.stopId === "1000");
  assert.ok(central !== undefined);
  assert.ok(central.routes.length > 0, "stop 1000 is served by R1, R3, R4 and R7");
  await app.close(); index.stop();
});

test("GET /stops/in-box returns the boardable stops inside the box", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/stops/in-box?minLat=32.05&minLon=34.77&maxLat=32.08&maxLon=34.80&lang=he",
  });
  assert.equal(res.statusCode, 200);
  const { stops } = res.json() as { stops: { stopId: string; rail: boolean }[] };
  assert.deepEqual(stops.map((s) => s.stopId).sort(), ["1000", "2000", "4000"]);
  assert.equal(stops.find((s) => s.stopId === "1000")?.rail, true);
  await app.close(); index.stop();
});

// The client stops asking once the map is zoomed out; the server refuses too,
// so a client bug cannot turn into a request for every stop in the country.
test("GET /stops/in-box refuses a box wider than a neighbourhood", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/in-box?minLat=31&minLon=34&maxLat=33&maxLon=35" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("GET /stops/in-box refuses a box whose corners are swapped", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/stops/in-box?minLat=32.08&minLon=34.77&maxLat=32.05&maxLon=34.80" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});
