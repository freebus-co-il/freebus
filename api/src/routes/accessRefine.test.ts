import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimetableIndex } from "../transit/index.js";
import type { LatLon } from "../geo.js";
import type { WalkCost } from "../walking/valhalla.js";
import { refineAccessByWalking } from "./accessRefine.js";

/** Four stops in a line east of the query point; coordinates are incidental —
 *  what matters is that the stub returns a chosen cost per index. */
function fakeIndex(): TimetableIndex {
  return {
    nStops: 4,
    stopLat: Float64Array.from([32.0700, 32.0700, 32.0700, 32.0700]),
    stopLon: Float64Array.from([34.7800, 34.7810, 34.7820, 34.7830]),
  } as unknown as TimetableIndex;
}

const POINT: LatLon = [32.0700, 34.7790];
const cands = (...idx: number[]) => idx.map((stopIdx) => ({ stopIdx, secondsToReach: 999 }));

/** A client whose matrix returns the supplied costs, in target order. */
function stub(costs: (WalkCost | null)[]) {
  return { matrix: async (_s: LatLon[], t: LatLon[]) => {
    assert.equal(t.length, costs.length, "one cost per target");
    return [costs];
  } };
}

test("keeps candidates within the cap and replaces their seconds with real ones", async () => {
  const out = await refineAccessByWalking(
    stub([{ distanceMeters: 400, durationSeconds: 300 }]) as never,
    POINT, cands(0), { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, [{ stopIdx: 0, secondsToReach: 300 }]);
  assert.equal(out.refined, true);
});

// The whole point of the change: straight-line admits it, the street does not.
test("drops a candidate whose real walk exceeds the cap", async () => {
  const out = await refineAccessByWalking(
    stub([{ distanceMeters: 3690, durationSeconds: 2775 }]) as never,
    POINT, cands(0), { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, []);
  assert.equal(out.refined, true);
});

test("drops a candidate Valhalla reports unreachable on foot", async () => {
  const out = await refineAccessByWalking(
    stub([null]) as never,
    POINT, cands(0), { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, []);
  assert.equal(out.refined, true);
});

// A cell that omits its keys or carries a string yields NaN, which passes
// `> maxWalkMeters` as false -- if this guard were missing, that NaN would
// reach `Math.round(NaN)` and flow into a downstream `toIso(new Date(NaN))`
// RangeError (a 500), not a wrong answer. Mirrors footpaths.ts's own
// finite + non-negative check on matrix output.
test("drops a candidate whose matrix cell is not a finite, non-negative number", async () => {
  const out = await refineAccessByWalking(
    stub([
      { distanceMeters: NaN, durationSeconds: 300 },
      { distanceMeters: 200, durationSeconds: -5 },
    ]) as never,
    POINT, cands(0, 1), { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, []);
  assert.equal(out.refined, true);
});

test("keeps and drops independently across several candidates", async () => {
  const out = await refineAccessByWalking(
    stub([
      { distanceMeters: 200, durationSeconds: 150 },   // keep
      { distanceMeters: 4000, durationSeconds: 3000 }, // over cap
      null,                                            // unreachable
      { distanceMeters: 990, durationSeconds: 740 },   // keep, just inside
    ]) as never,
    POINT, cands(0, 1, 2, 3), { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, [
    { stopIdx: 0, secondsToReach: 150 },
    { stopIdx: 3, secondsToReach: 740 },
  ]);
  assert.equal(out.refined, true);
});

// Degrade, never fail: a plan must still be produced when Valhalla is down.
test("returns the candidates untouched, and refined false, when the matrix call throws", async () => {
  const input = cands(0, 1);
  const out = await refineAccessByWalking(
    { matrix: async () => { throw new Error("valhalla down"); } } as never,
    POINT, input, { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, input);
  assert.equal(out.refined, false);
});

test("returns the candidates untouched, and refined false, when the matrix row is malformed", async () => {
  const input = cands(0, 1);
  const out = await refineAccessByWalking(
    { matrix: async () => [] } as never,
    POINT, input, { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, input);
  assert.equal(out.refined, false);
});

test("returns the candidates untouched, and refined false, when the row is present but the wrong length", async () => {
  const input = cands(0, 1);
  const cost = { distanceMeters: 100, durationSeconds: 80 };
  const out = await refineAccessByWalking(
    { matrix: async () => [[cost]] } as never,
    POINT, input, { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, input);
  assert.equal(out.refined, false);
});

test("makes no call at all for an empty candidate list, and reports refined false", async () => {
  let called = false;
  const out = await refineAccessByWalking(
    { matrix: async () => { called = true; return [[]]; } } as never,
    POINT, [], { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.deepEqual(out.stops, []);
  assert.equal(out.refined, false);
  assert.equal(called, false, "an empty list must not cost a round-trip");
});

test("issues exactly one matrix call regardless of candidate count", async () => {
  let calls = 0;
  const costs = [0, 1, 2, 3].map(() => ({ distanceMeters: 100, durationSeconds: 80 }));
  await refineAccessByWalking(
    { matrix: async (_s: LatLon[], t: LatLon[]) => { calls++; return [costs.slice(0, t.length)]; } } as never,
    POINT, cands(0, 1, 2, 3), { ix: fakeIndex(), maxWalkMeters: 1000 });
  assert.equal(calls, 1);
});
