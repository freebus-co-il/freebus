import { test } from "node:test";
import assert from "node:assert/strict";
import type { LatLon } from "../geo.js";
import { haversineMeters } from "../geo.js";
import {
  cumulativeDistances, sliceByDistance, nearestVertexIndex, sliceByNearestVertices,
} from "./shapeSlice.js";

/** A roughly north-south line near Tel Aviv, five points about 111 m apart. */
const LINE: LatLon[] = [
  [32.0000, 34.8000], [32.0010, 34.8000], [32.0020, 34.8000],
  [32.0030, 34.8000], [32.0040, 34.8000],
];

test("cumulativeDistances starts at zero and increases monotonically", () => {
  const d = cumulativeDistances(LINE);
  assert.equal(d.length, LINE.length);
  assert.equal(d[0], 0);
  for (let i = 1; i < d.length; i++) assert.ok(d[i]! > d[i - 1]!);
  // Total should match the sum of the leg distances.
  let total = 0;
  for (let i = 1; i < LINE.length; i++) total += haversineMeters(LINE[i - 1]!, LINE[i]!);
  assert.ok(Math.abs(d[d.length - 1]! - total) < 1e-6);
});

test("cumulativeDistances handles a single point and an empty line", () => {
  assert.deepEqual(cumulativeDistances([LINE[0]!]), [0]);
  assert.deepEqual(cumulativeDistances([]), []);
});

test("sliceByDistance returns only the requested span, with interpolated ends", () => {
  const d = cumulativeDistances(LINE);
  const mid1 = d[1]! + (d[2]! - d[1]!) / 2;
  const mid3 = d[3]! + (d[4]! - d[3]!) / 2;
  const slice = sliceByDistance(LINE, mid1, mid3);
  // Ends are interpolated points, not snapped to vertices.
  assert.ok(slice.length >= 3);
  assert.ok(slice[0]![0] > LINE[1]![0] && slice[0]![0] < LINE[2]![0]);
  const last = slice[slice.length - 1]!;
  assert.ok(last[0] > LINE[3]![0] && last[0] < LINE[4]![0]);
  // The slice is shorter than the whole line.
  const whole = cumulativeDistances(LINE).at(-1)!;
  const part = cumulativeDistances(slice).at(-1)!;
  assert.ok(part < whole, `slice ${part} should be shorter than whole ${whole}`);
});

test("sliceByDistance clamps out-of-range bounds to the line", () => {
  const slice = sliceByDistance(LINE, -500, 1e9);
  assert.deepEqual(slice, LINE);
});

// A reversed span would silently produce an empty or backwards line, which a
// client would draw as nothing. Normalising is safer than trusting callers.
test("sliceByDistance normalises a reversed span", () => {
  const d = cumulativeDistances(LINE);
  const forward = sliceByDistance(LINE, d[1]!, d[3]!);
  const reversed = sliceByDistance(LINE, d[3]!, d[1]!);
  assert.deepEqual(reversed, forward);
});

test("sliceByDistance on a zero-length span returns a two-point degenerate line", () => {
  const d = cumulativeDistances(LINE);
  const slice = sliceByDistance(LINE, d[2]!, d[2]!);
  assert.equal(slice.length, 2);
  assert.deepEqual(slice[0], slice[1]);
});

test("nearestVertexIndex finds the closest point", () => {
  assert.equal(nearestVertexIndex(LINE, [32.0021, 34.8000]), 2);
  assert.equal(nearestVertexIndex(LINE, [31.0000, 34.8000]), 0);
  assert.equal(nearestVertexIndex(LINE, [33.0000, 34.8000]), 4);
});

test("sliceByNearestVertices cuts between the two projected vertices", () => {
  const slice = sliceByNearestVertices(LINE, [32.0011, 34.8000], [32.0031, 34.8000]);
  assert.deepEqual(slice, [LINE[1]!, LINE[2]!, LINE[3]!]);
});

test("sliceByNearestVertices normalises reversed endpoints", () => {
  const a = sliceByNearestVertices(LINE, [32.0031, 34.8000], [32.0011, 34.8000]);
  assert.deepEqual(a, [LINE[1]!, LINE[2]!, LINE[3]!]);
});

// A single-point "line" is the invisible-geometry failure this module exists
// to avoid: a client draws nothing and there is no error to notice. This is
// reachable in production whenever two stops on a coarse shape are close
// enough to project to the same nearest vertex.
test("sliceByNearestVertices returns a degenerate two-point line when both stops project to the same vertex", () => {
  const slice = sliceByNearestVertices(LINE, [32.0001, 34.8000], [32.0002, 34.8000]);
  assert.equal(slice.length, 2);
  assert.deepEqual(slice[0], slice[1]);
  assert.deepEqual(slice[0], LINE[0]!);
});

test("sliceByDistance throws on a non-finite fromMeters or toMeters", () => {
  assert.throws(() => sliceByDistance(LINE, NaN, 100), /fromMeters/);
  assert.throws(() => sliceByDistance(LINE, 0, NaN), /toMeters/);
  assert.throws(() => sliceByDistance(LINE, -Infinity, 100), /fromMeters/);
  assert.throws(() => sliceByDistance(LINE, 0, Infinity), /toMeters/);
});
