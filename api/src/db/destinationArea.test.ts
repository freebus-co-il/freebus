import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { destinationStops, DESTINATION_RADIUS_METERS } from "./destinationArea.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-destarea-"));
  buildFixtureDb(dir);
  return openTransitDb(dir);
}

// Station 3000 and its platform 4000 sit together at ~32.070,34.790; stop
// 2000 is ~1.1 km away and 1000 further still.
test("finds the stops around a point, nearest first", () => {
  const h = fixture();
  const found = destinationStops(h.db, { lat: 32.0700, lon: 34.7900 });
  assert.deepEqual(found.map((s) => s.stopId), ["3000", "4000"]);
  assert.ok(found[0]!.walkMeters <= found[1]!.walkMeters);
  h.close();
});

// The whole point of the change: the rider names the place, not the stop, so
// a stop they could never have named is still found.
test("finds a stop from a point that is not any stop", () => {
  const h = fixture();
  // ~150 m north-east of the station pair, which is no stop at all.
  const found = destinationStops(h.db, { lat: 32.0713, lon: 34.7910 });
  assert.deepEqual(found.map((s) => s.stopId).sort(), ["3000", "4000"]);
  h.close();
});

test("reports the walk as whole metres from the named point", () => {
  const h = fixture();
  const [nearest] = destinationStops(h.db, { lat: 32.0700, lon: 34.7900 });
  assert.equal(nearest!.stopId, "3000");
  assert.equal(nearest!.walkMeters, 0);
  assert.equal(Number.isInteger(nearest!.walkMeters), true);
  h.close();
});

test("excludes a stop beyond the radius", () => {
  const h = fixture();
  const found = destinationStops(h.db, { lat: 32.0700, lon: 34.7900 });
  assert.ok(!found.some((s) => s.stopId === "2000"));
  h.close();
});

test("honours a radius wide enough to reach further", () => {
  const h = fixture();
  const found = destinationStops(h.db, { lat: 32.0700, lon: 34.7900, radiusMeters: 2000 });
  assert.ok(found.some((s) => s.stopId === "2000"));
  h.close();
});

// A place with no bus near it is a real answer, not an error.
test("is empty out in the sea", () => {
  const h = fixture();
  assert.deepEqual(destinationStops(h.db, { lat: 32.07, lon: 34.0 }), []);
  h.close();
});

test("defaults to the documented radius", () => {
  assert.equal(DESTINATION_RADIUS_METERS, 500);
});
