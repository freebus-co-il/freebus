import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import type { GeocodePlace, Geocoder } from "../geocode/types.js";

async function serve(overrides?: Partial<Geocoder>) {
  const dir = mkdtempSync(join(tmpdir(), "transit-geocode-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const geocoder: Geocoder | undefined = overrides && {
    search: async () => [], place: async () => null, reverse: async () => null, ...overrides,
  };
  const app = await buildServer({ index, geocoder });
  return { app, index };
}

const PLACE: GeocodePlace = {
  label: "Shomer 13", secondaryLabel: "Pardes Hana", lat: 32.47, lon: 34.98, placeId: null, distanceMeters: null,
};

test("GET /geocode/search returns places from the geocoder", async () => {
  const { app, index } = await serve({ search: async () => [PLACE] });
  const res = await app.inject({ url: "/geocode/search?q=Shomer+13" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { places: GeocodePlace[] };
  assert.deepEqual(body.places, [PLACE]);
  await app.close(); index.stop();
});

test("GET /geocode/search rejects a missing q", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/geocode/search" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("GET /geocode/search rejects an unsupported lang", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/geocode/search?q=x&lang=fr" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("GET /geocode/search returns an empty list when the geocoder finds nothing", async () => {
  const { app, index } = await serve({});
  const res = await app.inject({ url: "/geocode/search?q=x" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { places: GeocodePlace[] }).places, []);
  await app.close(); index.stop();
});

test("GET /geocode/reverse returns a place", async () => {
  const { app, index } = await serve({ reverse: async () => PLACE });
  const res = await app.inject({ url: "/geocode/reverse?lat=32.47&lon=34.98" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { place: GeocodePlace | null }).place, PLACE);
  await app.close(); index.stop();
});

test("GET /geocode/reverse returns null when nothing is found", async () => {
  const { app, index } = await serve({});
  const res = await app.inject({ url: "/geocode/reverse?lat=32.47&lon=34.98" });
  assert.equal((res.json() as { place: GeocodePlace | null }).place, null);
  await app.close(); index.stop();
});

test("GET /geocode/reverse rejects a missing lon", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/geocode/reverse?lat=32.47" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("GET /geocode/search passes the session and a near point through", async () => {
  let seen: unknown;
  const { app, index } = await serve({ search: async (_q, _lang, _limit, opts) => { seen = opts; return []; } });
  const res = await app.inject({ url: "/geocode/search?q=x&session=abc_DEF-1&lat=32.1&lon=34.8" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, { session: "abc_DEF-1", near: { lat: 32.1, lon: 34.8 } });
  await app.close(); index.stop();
});

test("GET /geocode/search ignores a lat without a lon", async () => {
  let seen: { near?: unknown } | undefined;
  const { app, index } = await serve({ search: async (_q, _lang, _limit, opts) => { seen = opts; return []; } });
  await app.inject({ url: "/geocode/search?q=x&lat=32.1" });
  assert.equal(seen?.near, undefined);
  await app.close(); index.stop();
});

test("GET /geocode/search rejects a malformed session token", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/geocode/search?q=x&session=has%20space" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});

test("GET /geocode/place resolves an id with its session", async () => {
  let seen: unknown[] = [];
  const { app, index } = await serve({ place: async (id, session) => { seen = [id, session]; return { lat: 32.07, lon: 34.79 }; } });
  const res = await app.inject({ url: "/geocode/place?id=ChIJ_abc-1&session=s1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { location: { lat: 32.07, lon: 34.79 } });
  assert.deepEqual(seen, ["ChIJ_abc-1", "s1"]);
  await app.close(); index.stop();
});

test("GET /geocode/place rejects an id that is not URL-safe base64", async () => {
  const { app, index } = await serve();
  const res = await app.inject({ url: "/geocode/place?id=..%2Fplaces" });
  assert.equal(res.statusCode, 400);
  await app.close(); index.stop();
});
