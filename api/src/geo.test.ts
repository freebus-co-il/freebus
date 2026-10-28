import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePolyline, encodePolyline, haversineMeters, bboxAround } from "./geo.js";

test("polyline round-trips at precision 6", () => {
  const points = [[32.0554, 34.78], [32.06, 34.775]] as const;
  const decoded = decodePolyline(encodePolyline(points));
  assert.equal(decoded.length, 2);
  assert.ok(Math.abs(decoded[0]![0] - 32.0554) < 1e-6);
  assert.ok(Math.abs(decoded[1]![1] - 34.775) < 1e-6);
});

test("haversine matches a known distance", () => {
  // Tel Aviv Savidor to Jerusalem Yitzhak Navon, ~50 km great-circle.
  const d = haversineMeters([32.0836, 34.7981], [31.7883, 35.2028]);
  assert.ok(d > 49_000 && d < 52_000, `got ${d}`);
});

test("bboxAround contains a point at the requested radius and excludes one beyond", () => {
  const box = bboxAround(32.0554, 34.78, 500);
  // 400 m due north is inside; 700 m due north is outside.
  const inside = 32.0554 + 400 / 111_320;
  const outside = 32.0554 + 700 / 111_320;
  assert.ok(inside <= box.maxLat);
  assert.ok(outside > box.maxLat);
});
