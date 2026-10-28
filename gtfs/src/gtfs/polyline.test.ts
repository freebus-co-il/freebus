import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePolyline, decodePolyline, haversineMeters, polylineLengthMeters,
  type LatLon,
} from "./polyline.js";

const SHAPE: LatLon[] = [
  [32.164723, 34.848813],
  [32.164738, 34.848972],
  [32.164771, 34.849177],
];

test("encode then decode round-trips within precision-6 tolerance", () => {
  const decoded = decodePolyline(encodePolyline(SHAPE));
  assert.equal(decoded.length, SHAPE.length);
  for (const [i, p] of SHAPE.entries()) {
    assert.ok(Math.abs(decoded[i]![0] - p[0]) < 1e-6, `lat ${i}`);
    assert.ok(Math.abs(decoded[i]![1] - p[1]) < 1e-6, `lon ${i}`);
  }
});

test("encoding is compact for densely sampled shapes", () => {
  // Real shapes sample every few metres; deltas must stay short.
  assert.ok(encodePolyline(SHAPE).length < 40, "unexpectedly long encoding");
});

test("empty and single-point inputs are handled", () => {
  assert.equal(encodePolyline([]), "");
  assert.deepEqual(decodePolyline(""), []);
  assert.equal(decodePolyline(encodePolyline([[32.1, 34.8]])).length, 1);
});

test("precision 5 is supported for interoperability", () => {
  const enc = encodePolyline(SHAPE, 5);
  const dec = decodePolyline(enc, 5);
  assert.ok(Math.abs(dec[0]![0] - SHAPE[0]![0]) < 1e-5);
});

test("haversineMeters matches a known distance", () => {
  // ~15.5 m apart along the shape's first segment.
  const d = haversineMeters(SHAPE[0]!, SHAPE[1]!);
  assert.ok(d > 10 && d < 25, `expected 10-25 m, got ${d}`);
});

test("polylineLengthMeters sums the segments", () => {
  const total = polylineLengthMeters(SHAPE);
  const manual =
    haversineMeters(SHAPE[0]!, SHAPE[1]!) + haversineMeters(SHAPE[1]!, SHAPE[2]!);
  assert.ok(Math.abs(total - manual) < 1e-9);
  assert.equal(polylineLengthMeters([SHAPE[0]!]), 0);
});

test("round-trip with southbound/westbound deltas (reversed shape)", () => {
  // SHAPE reversed has negative deltas in both lat and lon.
  // This catches sign-handling bugs: ~(value << 1) vs -(value << 1),
  // or inverted result & 1 logic.
  const reversed = SHAPE.slice().reverse();
  const encoded = encodePolyline(reversed);
  const decoded = decodePolyline(encoded);
  assert.equal(decoded.length, reversed.length);
  for (const [i, p] of reversed.entries()) {
    assert.ok(Math.abs(decoded[i]![0] - p[0]) < 1e-6, `lat ${i}`);
    assert.ok(Math.abs(decoded[i]![1] - p[1]) < 1e-6, `lon ${i}`);
  }
});

test("round-trip with mixed-sign deltas", () => {
  // Oscillating lat/lon ensures both positive and negative deltas.
  // Catches asymmetric sign bugs.
  const mixed: LatLon[] = [
    [32.16, 34.85],
    [32.17, 34.84],  // lat +, lon -
    [32.15, 34.86],  // lat -, lon +
    [32.16, 34.85],  // lat +, lon -
  ];
  const encoded = encodePolyline(mixed);
  const decoded = decodePolyline(encoded);
  assert.equal(decoded.length, mixed.length);
  for (const [i, p] of mixed.entries()) {
    assert.ok(Math.abs(decoded[i]![0] - p[0]) < 1e-6, `lat ${i}`);
    assert.ok(Math.abs(decoded[i]![1] - p[1]) < 1e-6, `lon ${i}`);
  }
});

test("canonical Google reference vector at precision 5", () => {
  // Standard conformance test: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
  // Expected: _p~iF~ps|U_ulLnnqC_mqNvxq`@
  // This pins correctness to the published algorithm spec, not just self-consistency.
  const canonical: LatLon[] = [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ];
  const expected = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
  const encoded = encodePolyline(canonical, 5);
  assert.equal(encoded, expected, `encoded mismatch: got ${encoded}`);
  const decoded = decodePolyline(encoded, 5);
  assert.equal(decoded.length, canonical.length);
  for (const [i, p] of canonical.entries()) {
    assert.ok(Math.abs(decoded[i]![0] - p[0]) < 1e-5, `lat ${i}`);
    assert.ok(Math.abs(decoded[i]![1] - p[1]) < 1e-5, `lon ${i}`);
  }
});
