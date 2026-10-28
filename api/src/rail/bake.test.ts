import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "../db/connect.js";
import { decodePolyline, haversineMeters, type LatLon } from "../geo.js";
import { RailGraph } from "./railGraph.js";
import { bakeRailGeometry, parseOverpassRail, railStationPairs } from "./bake.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rail-bake-"));
  buildFixtureDb(dir);
  return openTransitDb(dir);
}

// The fixture's only rail service runs between stop 1000 (32.0554, 34.7800)
// and stop 4000 (32.0701, 34.7901), once each way (T105 and T106).
const STOP_1000: LatLon = [32.0554, 34.7800];
const STOP_4000: LatLon = [32.0701, 34.7901];

test("station pairs are consecutive rail stops, once per undirected pair", () => {
  const h = fixture();
  try {
    const pairs = railStationPairs(h.db);
    // T105 runs 1000 -> 4000 and T106 runs 4000 -> 1000: one pair. The bus
    // trips calling at the same stops are not rail and add nothing.
    assert.deepEqual(pairs.map((p) => p.key), ["1000>4000"]);
    assert.equal(pairs[0]!.from.stopId, "1000");
    assert.equal(pairs[0]!.to.stopId, "4000");
  } finally { h.close(); }
});

test("each routable pair is baked as a track line from the lower stop id's station", () => {
  const h = fixture();
  try {
    const graph = RailGraph.fromWays([{
      nodeIds: [1, 2, 3],
      points: [STOP_1000, [32.0630, 34.7870], STOP_4000],
    }]);
    const result = bakeRailGeometry(graph, railStationPairs(h.db), { osmTimestamp: "2026-09-15T07:31:05Z" });
    assert.deepEqual(result.unroutable, []);
    assert.deepEqual(result.detours, []);
    assert.equal(result.baked.osmTimestamp, "2026-09-15T07:31:05Z");
    assert.match(result.baked.attribution, /OpenStreetMap/);
    const line = decodePolyline(result.baked.lines["1000>4000"]!);
    assert.ok(haversineMeters(line[0]!, STOP_1000) < 1);
    assert.ok(haversineMeters(line[line.length - 1]!, STOP_4000) < 1);
  } finally { h.close(); }
});

test("a pair with no track between its stations is reported, not baked", () => {
  const h = fixture();
  try {
    const result = bakeRailGeometry(RailGraph.fromWays([]), railStationPairs(h.db), { osmTimestamp: "" });
    assert.deepEqual(result.unroutable, ["1000>4000"]);
    assert.deepEqual(result.baked.lines, {});
  } finally { h.close(); }
});

test("a line far longer than the distance between its stations is reported as a detour", () => {
  // Out ~4 km east, round a smooth loop and back: the signature of a route
  // that found a wrong corridor because the right one is missing from OSM.
  // Smooth (10° a step) so the turn limit is not what rejects it.
  const h = fixture();
  try {
    const loop: LatLon[] = [];
    for (let deg = 10; deg < 180; deg += 10) {
      const a = (deg * Math.PI) / 180;
      loop.push([32.06275 - 0.00735 * Math.cos(a), 34.8200 + 0.00864 * Math.sin(a)]);
    }
    const points: LatLon[] = [STOP_1000, [32.0554, 34.8200], ...loop, [32.0701, 34.8200], STOP_4000];
    const graph = RailGraph.fromWays([{ nodeIds: points.map((_, i) => i + 1), points }]);
    const result = bakeRailGeometry(graph, railStationPairs(h.db), { osmTimestamp: "" });
    assert.equal(result.detours.length, 1);
    assert.equal(result.detours[0]!.key, "1000>4000");
    assert.ok(result.detours[0]!.ratio > 3);
  } finally { h.close(); }
});

test("parses Overpass ways with their node ids and geometry", () => {
  const parsed = parseOverpassRail({
    osm3s: { timestamp_osm_base: "2026-09-15T07:31:05Z" },
    elements: [
      { type: "way", id: 7, nodes: [1, 2], geometry: [{ lat: 32, lon: 34.8 }, { lat: 32.01, lon: 34.8 }],
        tags: { railway: "rail", service: "crossover" } },
      { type: "node", id: 9, lat: 32, lon: 34 },
    ],
  });
  assert.equal(parsed.osmTimestamp, "2026-09-15T07:31:05Z");
  assert.deepEqual(parsed.ways, [{ nodeIds: [1, 2], points: [[32, 34.8], [32.01, 34.8]] }]);
});

test("an Overpass response without elements is refused rather than baked as no track", () => {
  // Overpass answers a timed-out query with HTTP 200 and a `remark`; baking
  // that would silently empty the file.
  assert.throws(() => parseOverpassRail({ remark: "runtime error: timeout" }), /elements/);
  assert.throws(() => parseOverpassRail({ elements: [] }), /no rail ways/);
});
