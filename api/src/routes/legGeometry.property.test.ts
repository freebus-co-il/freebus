import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  decodePolyline, encodePolyline, haversineMeters, type LatLon,
} from "../geo.js";
import { sliceByDistance } from "../transit/shapeSlice.js";
import type { Itinerary, TransitLeg } from "../transit/itinerary.js";
import { resolveLegGeometry } from "./legGeometry.js";

/**
 * Property test for transit-leg geometry, over deterministic seeded random
 * networks — the four geometry properties this endpoint's design requires
 * and which no test previously covered:
 *
 *   1. the decoded geometry begins near the board stop and ends near the
 *      alight stop;
 *   2. its length is consistent with the distance between them;
 *   3. a leg on a shapeless trip sets `geometryFallback: true`;
 *   4. a sliced leg is never longer than its whole shape.
 *
 * The hand-written examples in `legGeometry.test.ts` assert none of these
 * across generated input, and their absence is exactly why a feed whose
 * `shape_dist_traveled` scale disagrees with its own shape shipped an
 * 8-metre polyline — ending 3,675 m from the alight stop — flagged as the
 * operator's real geometry. Property 1 is the one that catches it, so the
 * real offending shape (`124297`, trip `584731495_210826`) is generated as a
 * fixed case alongside the random ones rather than left to chance.
 *
 * **Seed 20260823, 240 generated trips** (`SEED`/`TRIALS` below), mixing five
 * feed shapes randomly per trip: honest metre distances, a broken distance
 * scale, absent distances, a trip with no `shape_id`, and a `shape_id` whose
 * `shapes` row is missing. Roughly 600 legs, in ~40 ms — the same budget as
 * the existing oracle tests, so `npm test` stays around a second.
 *
 * Everything runs against one in-memory SQLite database rather than a temp
 * file per trial: `resolveLegGeometry` only ever reads `trips`, `stop_times`,
 * `stops` and `shapes`, and per-trial file creation would dominate the run.
 */

const SEED = 20260823;
const TRIALS = 240;

/**
 * The tolerance `legGeometry.ts` itself applies, restated rather than
 * imported: the module's constant is an internal implementation choice, and a
 * test that imports it would silently follow the implementation anywhere it
 * moved instead of pinning the intended behaviour.
 */
const ENDPOINT_TOLERANCE_METERS = 500;

/**
 * Slack for the precision-6 polyline round trip. Coordinates are quantised to
 * 1e-6 degrees on encode, roughly 0.11 m of latitude, so a decoded line's
 * measured length differs from the input's by a fraction of a metre per
 * vertex. Exact equality is not available and asserting it would make these
 * properties fail on arithmetic rather than on behaviour.
 */
const QUANTISATION_SLACK_METERS = 0.5;

// ---------------------------------------------------------------- PRNG
// Same mulberry32 the RAPTOR oracle harness uses, for the same reason: a
// seeded generator makes a failure reproducible from the seed alone.
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- generation
type Variant = "metres" | "brokenScale" | "noDistances" | "shapeless" | "missingShapeRow";

interface GenTrip {
  tripId: string;
  variant: Variant;
  /** Null only for `shapeless`. */
  shapeId: string | null;
  /** The shape's own vertices; null for `shapeless`. */
  points: LatLon[] | null;
  /** Whether a `shapes` row is actually written. */
  shapeRowPresent: boolean;
  stops: { lat: number; lon: number; dist: number | null }[];
}

/** A random walk of `n` vertices at plausible Israeli latitudes. */
function randomShape(rnd: () => number, n: number): LatLon[] {
  let lat = 31.0 + rnd() * 2.0;
  let lon = 34.5 + rnd() * 1.0;
  let bearing = rnd() * 2 * Math.PI;
  const points: LatLon[] = [[lat, lon]];
  for (let i = 1; i < n; i++) {
    // Bounded turn per vertex, so the line meanders like a road rather than
    // folding back on itself and putting two stops on the same nearest vertex.
    bearing += (rnd() - 0.5) * 0.8;
    const meters = 60 + rnd() * 440;
    lat += (meters * Math.cos(bearing)) / 111_320;
    lon += (meters * Math.sin(bearing)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    points.push([lat, lon]);
  }
  return points;
}

function polylineLength(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1]!, points[i]!);
  return total;
}

/** The point `meters` along the line — `sliceByDistance`'s own interpolation. */
function pointAt(points: readonly LatLon[], meters: number): LatLon {
  return sliceByDistance(points, meters, meters)[0]!;
}

function pickVariant(rnd: () => number): Variant {
  const r = rnd();
  if (r < 0.40) return "metres";
  if (r < 0.65) return "brokenScale";
  if (r < 0.80) return "noDistances";
  if (r < 0.92) return "shapeless";
  return "missingShapeRow";
}

function generate(): GenTrip[] {
  const rnd = mulberry32(SEED);
  const trips: GenTrip[] = [];

  // The real offending trip, verbatim from the live feed: shape 124297
  // (4,412 m over 12 vertices) with shape_dist_traveled values of 0, 2 and 8
  // in some unit that is not metres. Generated first so it is exercised on
  // every run regardless of seed.
  trips.push({
    tripId: "REAL_584731495_210826",
    variant: "brokenScale",
    shapeId: "REAL_124297",
    points: decodePolyline("snpp}@mxfyaA`CpE~_E|xH`ArBziNu_BxBWbhOpkDvCp@dm@plPHlAl`RjiAtHd@"),
    shapeRowPresent: true,
    stops: [
      { lat: 32.793287, lon: 35.032991, dist: 0 },
      { lat: 32.773845, lon: 35.026632, dist: 2 },
      { lat: 32.763275, lon: 35.016467, dist: 8 },
    ],
  });

  for (let i = 0; i < TRIALS; i++) {
    const variant = pickVariant(rnd);
    const points = randomShape(rnd, 2 + Math.floor(rnd() * 38));
    const total = polylineLength(points);
    const nStops = 2 + Math.floor(rnd() * 5);

    // Stop distances: strictly increasing fractions of the line, so the stops
    // sit in travel order the way a real trip's do.
    const fractions: number[] = [];
    for (let s = 0; s < nStops; s++) fractions.push(rnd());
    fractions.sort((a, b) => a - b);

    // A broken feed scale, mimicking the real one: distances divided by a
    // large factor, so cutting by them yields a line metres long on a shape
    // kilometres long.
    const brokenFactor = 100 + rnd() * 900;

    const stops = fractions.map((f) => {
      const trueMeters = f * total;
      const on = pointAt(points, trueMeters);
      // Stops sit NEAR the line, not exactly on it: a real platform is offset
      // from the road or track centreline the shape is drawn along.
      const jitterLat = ((rnd() - 0.5) * 40) / 111_320;
      const jitterLon = ((rnd() - 0.5) * 40) / (111_320 * Math.cos((on[0] * Math.PI) / 180));
      const dist = variant === "noDistances" ? null
        : variant === "brokenScale" ? Math.round(trueMeters / brokenFactor)
        : trueMeters;
      return { lat: on[0] + jitterLat, lon: on[1] + jitterLon, dist };
    });

    trips.push({
      tripId: `T${i}`,
      variant,
      shapeId: variant === "shapeless" ? null : `SH${i}`,
      points: variant === "shapeless" ? null : points,
      shapeRowPresent: variant !== "shapeless" && variant !== "missingShapeRow",
      stops,
    });
  }
  return trips;
}

// ---------------------------------------------------------------- db build
function buildDb(trips: readonly GenTrip[]): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE trips (trip_ref INTEGER PRIMARY KEY, trip_id TEXT NOT NULL UNIQUE, shape_id TEXT);
    CREATE TABLE stops (stop_ref INTEGER PRIMARY KEY, stop_lat REAL, stop_lon REAL);
    CREATE TABLE stop_times (trip_ref INTEGER, stop_ref INTEGER, stop_sequence INTEGER,
      shape_dist_traveled REAL);
    CREATE TABLE shapes (shape_id TEXT PRIMARY KEY, encoded_polyline TEXT NOT NULL);
  `);
  const insTrip = db.prepare("INSERT INTO trips VALUES (?, ?, ?)");
  const insStop = db.prepare("INSERT INTO stops VALUES (?, ?, ?)");
  const insTime = db.prepare("INSERT INTO stop_times VALUES (?, ?, ?, ?)");
  const insShape = db.prepare("INSERT OR IGNORE INTO shapes VALUES (?, ?)");

  let stopRef = 0;
  trips.forEach((t, tripRef) => {
    insTrip.run(tripRef, t.tripId, t.shapeId);
    if (t.shapeRowPresent && t.points !== null && t.shapeId !== null) {
      insShape.run(t.shapeId, encodePolyline(t.points));
    }
    t.stops.forEach((s, i) => {
      stopRef++;
      insStop.run(stopRef, s.lat, s.lon);
      // Sequences deliberately start at 7 and step by 3: pattern position is
      // the Nth ordered row, never the raw stop_sequence value.
      insTime.run(tripRef, stopRef, 7 + i * 3, s.dist);
    });
  });
  return db;
}

function makeLeg(t: GenTrip, fromPos: number, toPos: number): TransitLeg {
  const a = t.stops[fromPos]!;
  const b = t.stops[toPos]!;
  return {
    type: "transit",
    route: { id: "R", agencyId: null, shortName: null, longName: null, type: 3, color: null },
    tripId: t.tripId, headsign: null, tripNumber: null, directionId: 0,
    from: { stop: { type: "stop", lat: a.lat, lon: a.lon, stopId: `${t.tripId}:${fromPos}` },
            departureTime: "2026-08-24T08:00:00+03:00", scheduledDepartureTime: "2026-08-24T08:00:00+03:00", stopSequence: fromPos },
    to: { stop: { type: "stop", lat: b.lat, lon: b.lon, stopId: `${t.tripId}:${toPos}` },
          arrivalTime: "2026-08-24T08:30:00+03:00", scheduledArrivalTime: "2026-08-24T08:30:00+03:00", stopSequence: toPos },
    numStops: toPos - fromPos, intermediateStops: [],
    geometry: null, geometryFallback: true, realtime: null,
    alternatives: [],
  };
}

// ---------------------------------------------------------------- the test
test("geometry properties hold over seeded random feeds", () => {
  const trips = generate();
  const db = buildDb(trips);

  // Every leg goes through ONE resolveLegGeometry call, which is also how the
  // route uses it — and exercises the per-request shape memoisation.
  const rnd = mulberry32(SEED ^ 0x5eed);
  const cases: { trip: GenTrip; leg: TransitLeg }[] = [];
  for (const trip of trips) {
    const n = trip.stops.length;
    const pairs: [number, number][] = [[0, n - 1]];
    if (n >= 3) {
      const a = Math.floor(rnd() * (n - 1));
      const b = a + 1 + Math.floor(rnd() * (n - 1 - a));
      pairs.push([a, b]);
    }
    for (const [from, to] of pairs) cases.push({ trip, leg: makeLeg(trip, from, to) });
  }

  const itineraries: Itinerary[] = cases.map(({ leg }) => ({
    departureTime: "2026-08-24T08:00:00+03:00",
    arrivalTime: "2026-08-24T08:30:00+03:00",
    durationSeconds: 1800, transfers: 0, walkSeconds: 0, walkMeters: 0, legs: [leg],
    transferAtRisk: null,
  }));
  resolveLegGeometry(db, itineraries);

  let realGeometryLegs = 0;
  let fallbackLegs = 0;

  for (const { trip, leg } of cases) {
    const where = `${trip.tripId} (${trip.variant}) ${leg.from.stopSequence}->${leg.to.stopSequence}`;
    const board: LatLon = [leg.from.stop.lat, leg.from.stop.lon];
    const alight: LatLon = [leg.to.stop.lat, leg.to.stop.lon];
    const stopDistance = haversineMeters(board, alight);

    assert.ok(leg.geometry !== null, `${where}: geometry must never be left null`);
    const drawn = decodePolyline(leg.geometry);
    assert.ok(drawn.length >= 2, `${where}: a line needs at least two points`);
    const drawnLength = polylineLength(drawn);

    // PROPERTY 1 -- begins near the board stop, ends near the alight stop.
    // This holds for a fallback line too (it IS the two stops), and it is the
    // property that rejects the broken-scale slice.
    const startError = haversineMeters(drawn[0]!, board);
    const endError = haversineMeters(drawn[drawn.length - 1]!, alight);
    assert.ok(startError <= ENDPOINT_TOLERANCE_METERS,
      `${where}: line starts ${startError.toFixed(0)} m from the board stop`);
    assert.ok(endError <= ENDPOINT_TOLERANCE_METERS,
      `${where}: line ends ${endError.toFixed(0)} m from the alight stop`);

    // PROPERTY 2 -- length consistent with the distance between the stops.
    // A drawn line can only be SHORTER than the stop-to-stop straight line by
    // however far its two ends are allowed to sit from those stops.
    assert.ok(drawnLength >= stopDistance - startError - endError - QUANTISATION_SLACK_METERS,
      `${where}: ${drawnLength.toFixed(0)} m drawn for stops `
      + `${stopDistance.toFixed(0)} m apart`);

    // PROPERTY 3 -- a shapeless trip (or one whose shape row is gone) is a
    // flagged straight line through the two stops, never real geometry.
    if (trip.variant === "shapeless" || trip.variant === "missingShapeRow") {
      assert.equal(leg.geometryFallback, true, `${where}: must be flagged as a fallback`);
      assert.equal(drawn.length, 2, `${where}: a fallback is exactly the two stops`);
      assert.ok(Math.abs(drawnLength - stopDistance) < QUANTISATION_SLACK_METERS,
        `${where}: fallback length ${drawnLength.toFixed(3)} vs ${stopDistance.toFixed(3)}`);
    }

    // PROPERTY 4 -- a sliced leg is never longer than the whole shape it came
    // from. A tiny epsilon absorbs the precision-6 polyline round trip.
    if (leg.geometryFallback === false) {
      realGeometryLegs++;
      assert.ok(trip.points !== null, `${where}: real geometry with no shape`);
      const shapeLength = polylineLength(trip.points);
      assert.ok(drawnLength <= shapeLength + QUANTISATION_SLACK_METERS,
        `${where}: slice ${drawnLength.toFixed(0)} m exceeds its `
        + `${shapeLength.toFixed(0)} m shape`);
    } else {
      fallbackLegs++;
    }

    // The regression itself: a trip whose distance scale is broken must still
    // come back as real geometry, recovered by the nearest-vertex path --
    // not as a straight line, and above all not as a wrong line called real.
    if (trip.variant === "brokenScale") {
      assert.equal(leg.geometryFallback, false,
        `${where}: a broken distance scale must be recovered, not fallen back`);
    }
  }

  // Guards against the whole assertion block passing vacuously if generation
  // ever drifts to producing only one kind of leg.
  assert.ok(realGeometryLegs > 100, `expected many real-geometry legs, saw ${realGeometryLegs}`);
  assert.ok(fallbackLegs > 20, `expected some fallback legs, saw ${fallbackLegs}`);
  db.close();
});
