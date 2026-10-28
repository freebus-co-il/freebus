import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "../db/connect.js";
import { decodePolyline } from "../geo.js";
import { encodePolyline, haversineMeters } from "../geo.js";
import { RailGeometry } from "../rail/railGeometry.js";
import type { Itinerary, TransitLeg } from "../transit/itinerary.js";
import { resolveLegGeometry } from "./legGeometry.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-leggeo-"));
  buildFixtureDb(dir);
  return openTransitDb(dir);
}

function transitLeg(tripId: string, fromPos: number, toPos: number): TransitLeg {
  return {
    type: "transit",
    route: { id: "R1", agencyId: null, shortName: "1", longName: null, type: 3, color: null },
    tripId, headsign: null, tripNumber: null, directionId: 0,
    from: { stop: { type: "stop", lat: 32.0554, lon: 34.78, stopId: "1000" },
            departureTime: "2026-08-24T08:00:00+03:00", scheduledDepartureTime: "2026-08-24T08:00:00+03:00", stopSequence: fromPos },
    to:   { stop: { type: "stop", lat: 32.06, lon: 34.775, stopId: "2000" },
            arrivalTime: "2026-08-24T08:10:00+03:00", scheduledArrivalTime: "2026-08-24T08:10:00+03:00", stopSequence: toPos },
    numStops: toPos - fromPos, intermediateStops: [],
    geometry: null, geometryFallback: false, realtime: null,
    alternatives: [],
  };
}

function itinerary(legs: TransitLeg[]): Itinerary {
  return {
    departureTime: "2026-08-24T08:00:00+03:00",
    arrivalTime: "2026-08-24T08:10:00+03:00",
    durationSeconds: 600, transfers: 0, walkSeconds: 0, walkMeters: 0, legs,
    transferAtRisk: null,
  };
}

test("resolves real shape geometry for a trip that has one", () => {
  const h = fixture();
  const it = itinerary([transitLeg("T1", 0, 1)]);
  resolveLegGeometry(h.db, [it]);
  const leg = it.legs[0] as TransitLeg;
  assert.ok(leg.geometry, "geometry should be populated");
  assert.equal(leg.geometryFallback, false);
  const pts = decodePolyline(leg.geometry!);
  assert.ok(pts.length >= 2);
  // The drawn line should start near the board stop and end near the alight stop.
  assert.ok(haversineMeters(pts[0]!, [32.0554, 34.78]) < 200);
  assert.ok(haversineMeters(pts[pts.length - 1]!, [32.06, 34.775]) < 200);
  h.close();
});

// 1,085 real trips have no shape. A straight line is acceptable; pretending
// it is the operator's real route is not.
test("falls back to a stop-to-stop line and flags it for a shapeless trip", () => {
  const h = fixture();
  const it = itinerary([transitLeg("T3", 0, 1)]);
  resolveLegGeometry(h.db, [it]);
  const leg = it.legs[0] as TransitLeg;
  assert.ok(leg.geometry);
  assert.equal(leg.geometryFallback, true);
  assert.equal(decodePolyline(leg.geometry!).length, 2);
  h.close();
});

test("a shapeless leg is drawn through the stations it calls at", () => {
  // Israel Railways ships NO geometry: all 1,137 of its trips carry an empty
  // shape_id, so every rail leg lands on the fallback. Drawn as a chord
  // between its end stops, a coastal train journey rendered as one straight
  // line that cut through the sea. The stations are points the train
  // provably passes through, so the line has to use them.
  const h = fixture();
  try {
    const leg = transitLeg("T3", 0, 1);
    leg.intermediateStops = [
      { type: "stop", lat: 32.0575, lon: 34.7745, stopId: "A" },
      { type: "stop", lat: 32.0590, lon: 34.7760, stopId: "B" },
    ];
    resolveLegGeometry(h.db, [itinerary([leg])]);

    assert.equal(leg.geometryFallback, true, "still not the operator's own shape");
    const points = decodePolyline(leg.geometry!);
    assert.equal(points.length, 4, "board + two stations + alight");
    // Board and alight still anchor the ends, in that order.
    assert.ok(haversineMeters(points[0]!, [leg.from.stop.lat, leg.from.stop.lon]) < 1);
    assert.ok(haversineMeters(points[3]!, [leg.to.stop.lat, leg.to.stop.lon]) < 1);
    // And the middle really is the stations, so the line bends where they do.
    assert.ok(haversineMeters(points[1]!, [32.0575, 34.7745]) < 1);
    assert.ok(haversineMeters(points[2]!, [32.0590, 34.7760]) < 1);
  } finally { h.close(); }
});

test("a shapeless leg with no stations between still gets a usable line", () => {
  // Adjacent stations -- nothing to thread through, so this degrades to the
  // two-point chord it always was rather than to an unusable one-point line.
  const h = fixture();
  try {
    const leg = transitLeg("T3", 0, 1);
    leg.intermediateStops = [];
    resolveLegGeometry(h.db, [itinerary([leg])]);

    assert.equal(leg.geometryFallback, true);
    assert.equal(decodePolyline(leg.geometry!).length, 2);
  } finally { h.close(); }
});

test("flags a fallback when the trip is unknown", () => {
  const h = fixture();
  const it = itinerary([transitLeg("nope", 0, 1)]);
  resolveLegGeometry(h.db, [it]);
  const leg = it.legs[0] as TransitLeg;
  assert.equal(leg.geometryFallback, true);
  assert.ok(leg.geometry);
  h.close();
});

test("leaves walk legs untouched", () => {
  const h = fixture();
  const it: Itinerary = {
    departureTime: "2026-08-24T08:00:00+03:00",
    arrivalTime: "2026-08-24T08:05:00+03:00",
    durationSeconds: 300, transfers: 0, walkSeconds: 300, walkMeters: 300,
    legs: [{ type: "walk",
      from: { type: "coordinate", lat: 32.0554, lon: 34.78 },
      to: { type: "stop", lat: 32.06, lon: 34.775, stopId: "2000" },
      distanceMeters: 300, durationSeconds: 300, geometry: null, walkEstimated: true }],
    transferAtRisk: null,
  };
  resolveLegGeometry(h.db, [it]);
  assert.equal(it.legs[0]!.type, "walk");
  assert.equal((it.legs[0] as { geometry: string | null }).geometry, null);
  h.close();
});

// Itineraries in one response frequently share a line; decoding a long rail
// shape repeatedly would be wasteful.
test("decodes each shape once across all itineraries in a response", () => {
  const h = fixture();
  let queries = 0;
  const spy = {
    prepare: (sql: string) => { queries++; return h.db.prepare(sql); },
  } as unknown as typeof h.db;
  const a = itinerary([transitLeg("T1", 0, 1)]);
  const b = itinerary([transitLeg("T2", 0, 1)]);
  resolveLegGeometry(spy, [a, b]);
  // Both legs resolved, but SH1's polyline fetched only once.
  assert.ok((a.legs[0] as TransitLeg).geometry);
  assert.ok((b.legs[0] as TransitLeg).geometry);
  const shapeFetches = queries - 2; // two legShapeRefs calls
  assert.equal(shapeFetches, 1, `expected 1 shape fetch, saw ${shapeFetches}`);
  h.close();
});

// Israel Railways publishes no shapes, so its legs are drawn along track lines
// baked from OpenStreetMap (rail/railGeometry.ts). The fixture's rail trip
// T105 runs stop 1000 -> stop 4000.
const RAIL_TRACK: [number, number][] = [[32.0556, 34.7802], [32.0630, 34.7870], [32.0699, 34.7899]];

function railLeg(): TransitLeg {
  const leg = transitLeg("T105", 0, 1);
  leg.route = { ...leg.route, id: "R7", type: 2 };
  leg.to = { ...leg.to, stop: { type: "stop", lat: 32.0701, lon: 34.7901, stopId: "4000" } };
  return leg;
}

test("a shapeless train leg is drawn along its baked track, as real geometry", () => {
  const h = fixture();
  try {
    const rail = RailGeometry.fromBaked({
      osmTimestamp: "", attribution: "", lines: { "1000>4000": encodePolyline(RAIL_TRACK) },
    });
    const leg = railLeg();
    resolveLegGeometry(h.db, [itinerary([leg])], rail);

    assert.equal(leg.geometryFallback, false, "the track is the real alignment, not a guess");
    const points = decodePolyline(leg.geometry!);
    assert.ok(haversineMeters(points[0]!, [32.0554, 34.78]) < 1, "starts on the board station");
    assert.ok(haversineMeters(points[points.length - 1]!, [32.0701, 34.7901]) < 1, "ends on the alight station");
    assert.ok(points.some((p) => haversineMeters(p, [32.0630, 34.7870]) < 1), "follows the track");
  } finally { h.close(); }
});

test("a train leg whose station pair is not baked still falls back through its stations", () => {
  const h = fixture();
  try {
    const rail = RailGeometry.fromBaked({ osmTimestamp: "", attribution: "", lines: {} });
    const leg = railLeg();
    resolveLegGeometry(h.db, [itinerary([leg])], rail);
    assert.equal(leg.geometryFallback, true);
    assert.equal(decodePolyline(leg.geometry!).length, 2);
  } finally { h.close(); }
});
