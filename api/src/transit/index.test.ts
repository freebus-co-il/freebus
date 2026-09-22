import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildIndex } from "./index.js";

function built() {
  const dir = mkdtempSync(join(tmpdir(), "transit-idx-"));
  const link = buildFixtureDb(dir);
  return buildIndex(link);
}

test("indexes every stop with a dense zero-based mapping", () => {
  const ix = built();
  assert.equal(ix.nStops, 4);
  const idx = ix.stopIdToIdx.get("2000")!;
  assert.equal(ix.stopIds[idx], "2000");
  assert.ok(Math.abs(ix.stopLat[idx]! - 32.06) < 1e-9);
});

test("resolves parent stations to stop indices", () => {
  const ix = built();
  const platform = ix.stopIdToIdx.get("4000")!;
  const station = ix.stopIdToIdx.get("3000")!;
  assert.equal(ix.stopParent[platform], station);
  assert.equal(ix.stopParent[station], -1);
});

test("indexes trips with their service, route and times", () => {
  const ix = built();
  assert.equal(ix.nTrips, 9);
  const t = ix.tripIds.indexOf("T1");
  assert.equal(ix.serviceIds[ix.tripServiceIdx[t]!], "S1");
  assert.equal(ix.routeIds[ix.tripRouteIdx[t]!], "R1");
  const from = ix.tripTimeOffset[t]!;
  assert.equal(ix.departureTime[from], 28800);
  assert.equal(ix.departureTime[from + 1], 29400);
});

// The feed's max departure_time is 105787. Any clamping here silently deletes
// late-night service from every plan.
test("preserves times above 86400", () => {
  const ix = built();
  const t = ix.tripIds.indexOf("T3");
  assert.equal(ix.departureTime[ix.tripTimeOffset[t]!], 91800);
});

test("groups trips into patterns", () => {
  const ix = built();
  // T1 and T2 share a stop sequence; T3 does not.
  const t1 = ix.tripIds.indexOf("T1");
  const t2 = ix.tripIds.indexOf("T2");
  const t3 = ix.tripIds.indexOf("T3");
  assert.equal(ix.patternOfTrip[t1], ix.patternOfTrip[t2]);
  assert.notEqual(ix.patternOfTrip[t1], ix.patternOfTrip[t3]);
});

test("builds the stop -> patterns inverted index with positions", () => {
  const ix = built();
  const stop2 = ix.stopIdToIdx.get("2000")!;
  const from = ix.stopPatternOffset[stop2]!;
  const to = ix.stopPatternOffset[stop2 + 1]!;
  // Stop 2000 is the second stop of T1's pattern (which T102 shares), the
  // first of T3's (shared with T104), and the second of T101's 1000 -> 2000
  // -> 4000 pattern.
  assert.equal(to - from, 3);
  const positions = [...ix.stopPatternPos.slice(from, to)].sort();
  assert.deepEqual(positions, [0, 1, 1]);
});

// itinerary.ts's buildItinerary reads stop names straight off the index, with
// no database round-trip per leg.
test("carries stop names for itinerary rendering", () => {
  const ix = built();
  assert.equal(ix.stopNames[ix.stopIdToIdx.get("2000")!], "הרצל");
});

test("starts with no footpaths until they are attached", () => {
  const ix = built();
  assert.equal(ix.footOffset.length, ix.nStops + 1);
  assert.equal(ix.footTarget.length, 0);
});

test("carries shape distances parallel to the time arrays", () => {
  const ix = built();
  assert.equal(ix.stopDistance.length, ix.arrivalTime.length);

  // T101's three stops, in pattern order: the fixture's 0 / 1200 / 2400.
  const t = ix.tripIdToIdx.get("T101")!;
  const from = ix.tripTimeOffset[t]!;
  assert.deepEqual(
    Array.from(ix.stopDistance.subarray(from, ix.tripTimeOffset[t + 1]!)),
    [0, 1200, 2400],
  );
});

test("marks an absent shape distance with -1, never with 0", () => {
  const ix = built();
  // T104's final stop has a NULL shape_dist_traveled in the fixture. Zero is
  // a legitimate distance (every trip's first stop), so it cannot serve as
  // the sentinel -- the distinction is what stops predictFromDistance
  // placing a vehicle at the origin of a trip whose distances are missing.
  const t = ix.tripIdToIdx.get("T104")!;
  const from = ix.tripTimeOffset[t]!;
  assert.equal(ix.stopDistance[from]!, 0);
  assert.equal(ix.stopDistance[from + 1]!, -1);
});
