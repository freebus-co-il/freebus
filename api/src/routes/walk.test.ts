import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import type { WalkRoute } from "../walking/valhalla.js";
import type { LatLon } from "../geo.js";

async function serve(route: (from: LatLon, to: LatLon) => Promise<WalkRoute>) {
  const dir = mkdtempSync(join(tmpdir(), "transit-walk-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index, valhalla: { route, matrix: async () => [] } });
  return { app, index };
}

const ROUTED: WalkRoute = {
  distanceMeters: 412.4,
  durationSeconds: 310,
  geometry: "abc",
  estimated: false,
  steps: [
    { maneuver: "depart", street: "דרך הבנים", lengthMeters: 80, beginShapeIndex: 0, endShapeIndex: 3 },
    { maneuver: "right", street: "הדקלים", lengthMeters: 332, beginShapeIndex: 3, endShapeIndex: 9 },
    { maneuver: "arrive", street: null, lengthMeters: 0, beginShapeIndex: 9, endShapeIndex: 9 },
  ],
};

test("GET /walk returns the routed walk with its turns", async () => {
  const asked: [LatLon, LatLon][] = [];
  const { app, index } = await serve(async (from, to) => { asked.push([from, to]); return ROUTED; });
  try {
    const res = await app.inject({ url: "/walk?from=32.4753,34.9737&to=32.4783,34.9695" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      distanceMeters: 412, durationSeconds: 310, geometry: "abc", steps: ROUTED.steps, estimated: false,
    });
    assert.deepEqual(asked, [[[32.4753, 34.9737], [32.4783, 34.9695]]]);
  } finally { await app.close(); index.stop(); }
});

test("GET /walk passes a degraded walk through as an estimate, with no turns", async () => {
  const { app, index } = await serve(async () => ({
    distanceMeters: 500, durationSeconds: 376, geometry: null, estimated: true,
  }));
  try {
    const res = await app.inject({ url: "/walk?from=32.4753,34.9737&to=32.4783,34.9695" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      distanceMeters: 500, durationSeconds: 376, geometry: null, steps: [], estimated: true,
    });
  } finally { await app.close(); index.stop(); }
});

test("GET /walk rejects coordinates it cannot read", async () => {
  const { app, index } = await serve(async () => ROUTED);
  try {
    for (const query of ["from=32.4,34.9", "from=abc&to=32,34", "from=91,34&to=32,34", "from=32,34,1&to=32,34"]) {
      const res = await app.inject({ url: `/walk?${query}` });
      assert.equal(res.statusCode, 400, query);
    }
  } finally { await app.close(); index.stop(); }
});

test("GET /walk refuses a walk longer than it plans, without asking the router", async () => {
  let asked = false;
  const { app, index } = await serve(async () => { asked = true; return ROUTED; });
  try {
    const res = await app.inject({ url: "/walk?from=32.0853,34.7818&to=32.7940,34.9896" });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { code: string }).code, "walk_too_long");
    assert.equal(asked, false);
  } finally { await app.close(); index.stop(); }
});
