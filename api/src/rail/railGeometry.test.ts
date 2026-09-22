import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePolyline, haversineMeters, type LatLon } from "../geo.js";
import { RailGeometry, railPairKey, type BakedRailGeometry } from "./railGeometry.js";

// Station A -> B -> C along a bent track. Baked lines are stored once per
// undirected pair, oriented from the lower stop id to the higher.
const A = { stopId: "100", lat: 32.000, lon: 34.800 };
const B = { stopId: "200", lat: 32.010, lon: 34.800 };
const C = { stopId: "300", lat: 32.020, lon: 34.800 };
const AB: LatLon[] = [[32.0001, 34.8001], [32.005, 34.803], [32.0099, 34.8001]];
const BC: LatLon[] = [[32.0101, 34.8001], [32.015, 34.803], [32.0199, 34.8001]];

function baked(lines: Record<string, LatLon[]>): BakedRailGeometry {
  return {
    osmTimestamp: "2026-09-15T07:31:05Z",
    attribution: "© OpenStreetMap contributors, ODbL",
    lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, encodePolyline(v)])),
  };
}

const near = (p: LatLon | undefined, q: LatLon) => p !== undefined && haversineMeters(p, q) < 1;

test("the pair key does not depend on direction", () => {
  assert.equal(railPairKey("200", "100").key, railPairKey("100", "200").key);
  assert.equal(railPairKey("100", "200").reversed, false);
  assert.equal(railPairKey("200", "100").reversed, true);
});

test("a line through stations follows the track and is anchored on the end stations", () => {
  const rail = RailGeometry.fromBaked(baked({ "100>200": AB, "200>300": BC }));
  const line = rail.lineThrough([A, B, C]);
  assert.ok(line);
  assert.ok(near(line[0], [A.lat, A.lon]), "starts on the board station");
  assert.ok(near(line[line.length - 1], [C.lat, C.lon]), "ends on the alight station");
  assert.ok(line.some((p) => near(p, [32.005, 34.803])), "follows the first track bend");
  assert.ok(line.some((p) => near(p, [32.015, 34.803])), "follows the second track bend");
});

test("a line running against the stored orientation is reversed", () => {
  const rail = RailGeometry.fromBaked(baked({ "100>200": AB }));
  const line = rail.lineThrough([B, A]);
  assert.ok(line);
  assert.ok(near(line[0], [B.lat, B.lon]));
  assert.ok(near(line[1], AB[AB.length - 1]!), "the track is walked from B's end");
  assert.ok(near(line[line.length - 1], [A.lat, A.lon]));
});

test("one unbaked pair means no line, so the caller can fall back honestly", () => {
  // Half a real line and half a straight guess would be presented as real.
  const rail = RailGeometry.fromBaked(baked({ "100>200": AB }));
  assert.equal(rail.lineThrough([A, B, C]), null);
});

test("an unbaked pair is reported once, however often it is asked for", () => {
  const missing: string[] = [];
  const rail = RailGeometry.fromBaked(baked({}), { onMissingPair: (key) => missing.push(key) });
  rail.lineThrough([A, B]);
  rail.lineThrough([B, A]);
  assert.deepEqual(missing, ["100>200"]);
});

test("stops without an id, or fewer than two stops, have no line", () => {
  const rail = RailGeometry.fromBaked(baked({ "100>200": AB }));
  assert.equal(rail.lineThrough([A]), null);
  assert.equal(rail.lineThrough([{ lat: A.lat, lon: A.lon }, B]), null);
});

test("loads a baked file from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rail-geometry-"));
  const file = join(dir, "rail-geometry.json");
  writeFileSync(file, JSON.stringify(baked({ "100>200": AB })));
  const rail = RailGeometry.load(file);
  assert.equal(rail.size, 1);
  assert.ok(rail.lineThrough([A, B]));
});

test("a missing file loads as empty rather than taking the API down", () => {
  const warnings: string[] = [];
  const rail = RailGeometry.load(join(tmpdir(), "no-such-rail-geometry.json"), {
    warn: (m) => warnings.push(m),
  });
  assert.equal(rail.size, 0);
  assert.equal(rail.lineThrough([A, B]), null);
  assert.equal(warnings.length, 1);
});
