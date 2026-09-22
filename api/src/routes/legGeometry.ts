import type Database from "better-sqlite3";
import { decodePolyline, encodePolyline, haversineMeters, type LatLon } from "../geo.js";
import { legShapeRefs, shapePolyline } from "../db/shapes.js";
import { sliceByDistance, sliceByNearestVertices } from "../transit/shapeSlice.js";
import type { Itinerary, TransitRide } from "../transit/itinerary.js";
import { defaultRailGeometry, type RailGeometry } from "../rail/railGeometry.js";
import { RAIL_ROUTE_TYPE } from "../transit/routeTypes.js";

/**
 * How far a sliced line's own endpoints may sit from the leg's board and
 * alight stops before the slice is rejected as not describing this leg.
 *
 * This exists because a feed can disagree with itself. Trip
 * `584731495_210826` (shape `124297`, `total_length_m` 4,412) carries
 * `shape_dist_traveled` values of 0, 2 and 8 — some unit that is not metres —
 * so cutting the shape between them yields an 8-metre, two-point line whose
 * far end is 3,675 m from the alight stop. Without this check that line shipped
 * with `geometryFallback: false`: the wrong line, presented as the operator's
 * real one, which is the exact failure the flag exists to prevent. Full-table
 * on the live feed (2026-08-23): 2,402 of 260,549 shaped trips (0.92%) have a
 * maximum `shape_dist_traveled` below half their shape's `total_length_m`,
 * all of them `route_type` 5 and all inside the active service window.
 *
 * 500 m, chosen from a measured distribution rather than picked. Sampling
 * every 11th shaped trip on the live feed and cutting three legs per trip
 * (71,040 legs, 654 of them on scale-broken trips), the endpoint error of a
 * distance cut is:
 *
 *   | trips        | p50   | p99    | p99.9  | max     |
 *   | good scale   | 9.6 m | 148 m  | 299 m  | 1,600 m |
 *   | broken scale | 3,675 m — every single one, tightly clustered |
 *
 * Any threshold from 150 m to 1,500 m rejects 100% of the broken legs and
 * keeps essentially all the good ones; at 2,000 m broken legs start slipping
 * through. 500 m sits in the middle of that plateau — 3x the worst-case
 * p99.9 of a legitimate cut, 7x below the broken cluster. At 500 m exactly 20
 * of 70,386 legitimate legs (0.028%) fail the distance cut, and every one of
 * them is recovered by `sliceByNearestVertices` below, so none degrades to a
 * straight line. Tighter (100 m) starts pushing real legs onto straight lines;
 * looser (2 km) starts keeping the 3.7 km case. Both failure directions were
 * measured, not assumed.
 */
const SLICE_ENDPOINT_TOLERANCE_METERS = 500;

/**
 * The line, oriented board-stop-first, if its endpoints really are this leg's
 * stops — otherwise null.
 *
 * Reversal is tolerated (and corrected) rather than rejected: both slicing
 * functions return their result in SHAPE order, which is board-to-alight only
 * while the trip runs the same way its shape is drawn. A line that matches
 * the leg's stops end-for-end is still the right piece of the operator's
 * geometry; only its direction was wrong, and that is fixable here rather
 * than a reason to fall back to a straight line.
 */
function orientedIfEndpointsMatch(
  line: readonly LatLon[], from: LatLon, to: LatLon,
): LatLon[] | null {
  if (line.length < 2) return null;
  const head = line[0]!;
  const tail = line[line.length - 1]!;
  const forward = Math.max(haversineMeters(head, from), haversineMeters(tail, to));
  const reversed = Math.max(haversineMeters(tail, from), haversineMeters(head, to));
  if (forward <= SLICE_ENDPOINT_TOLERANCE_METERS && forward <= reversed) return [...line];
  if (reversed <= SLICE_ENDPOINT_TOLERANCE_METERS) return [...line].reverse();
  return null;
}

/**
 * Fills in `geometry` and `geometryFallback` on every transit leg.
 *
 * This lives in the route layer, not in `itinerary.ts`, because it needs the
 * database. `itinerary.ts` is deliberately free of SQL so it can be
 * property-tested as pure computation — that is what found three real bugs in
 * it — and reaching into a database from there would end that.
 *
 * MUST run AFTER departure reoptimisation. Reoptimisation can replace a
 * journey with a different one arriving at the same time, so resolving
 * geometry first would compute it for legs that are then discarded.
 */
export function resolveLegGeometry(
  db: Database.Database, itineraries: readonly Itinerary[],
  rail: RailGeometry = defaultRailGeometry(),
): void {
  // Itineraries in one response frequently share a line, and a long rail
  // shape can carry thousands of points, so decode each at most once.
  const decoded = new Map<string, LatLon[] | null>();

  const shapeFor = (shapeId: string): LatLon[] | null => {
    const cached = decoded.get(shapeId);
    if (cached !== undefined) return cached;
    const encoded = shapePolyline(db, shapeId);
    const points = encoded === null ? null : decodePolyline(encoded);
    decoded.set(shapeId, points);
    return points;
  };

  const resolve = (t: TransitRide): void => {
    // Validated against the LEG'S OWN stops, the coordinates the client is
    // shown, not against the `stop_times` rows the slice was computed from.
    // That way a positional mismatch between the leg and the trip's rows is
    // caught by the same check as a broken distance scale.
    const boardStop: LatLon = [t.from.stop.lat, t.from.stop.lon];
    const alightStop: LatLon = [t.to.stop.lat, t.to.stop.lon];

    /**
     * No usable shape from the operator.
     *
     * This is every rail leg: in this feed rail has NO geometry at all --
     * every one of its trips carries an empty `shape_id`, while every bus
     * and light-rail trip has one. So the baked OpenStreetMap track comes
     * first (see `rail/railGeometry.ts`), and it is reported as real
     * geometry: it is the alignment the train runs on, not a guess. Asked
     * only for rail (`route_type` 2): a bus stop pair is never baked, and
     * asking would log every one of them as a pair missing from the bake.
     *
     * Without a baked line the leg is drawn through the stops the vehicle
     * calls at. A chord between the two end stops drew every train journey
     * as a single straight line across the country, cutting through the sea
     * on the coastal route; a station is at least a point the train
     * demonstrably passes through. Still `geometryFallback: true`: between
     * two stations this remains a straight guess, and the flag is what lets
     * the client draw it dashed rather than present it as real.
     */
    const throughStops = (): void => {
      const track = t.route.type === RAIL_ROUTE_TYPE
        ? rail.lineThrough([t.from.stop, ...t.intermediateStops, t.to.stop])
        : null;
      if (track !== null) {
        t.geometry = encodePolyline(track);
        t.geometryFallback = false;
        return;
      }
      const via = t.intermediateStops
        .filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon))
        .map((stop) => [stop.lat, stop.lon] as LatLon);
      t.geometry = encodePolyline([boardStop, ...via, alightStop]);
      t.geometryFallback = true;
    };

    const refs = legShapeRefs(db, t.tripId, t.from.stopSequence, t.to.stopSequence);
    if (refs === null || refs.shapeId === null) { throughStops(); return; }

    const points = shapeFor(refs.shapeId);
    if (points === null || points.length < 2) { throughStops(); return; }

    // 99.87% of stop_times rows carry shape_dist_traveled (full-table
    // count against the live database, 2026-08-23: 9,804,645 of
    // 9,817,029). Cut by distance when both ends have
    // it, then CHECK THE RESULT: a distance cut is only as good as the
    // feed's own distance scale, and 0.92% of shaped trips have one that
    // disagrees with their shape by kilometres (see
    // SLICE_ENDPOINT_TOLERANCE_METERS).
    //
    // Degradation is ordered, most real geometry first:
    //   1. distance cut, if its endpoints land on the leg's stops;
    //   2. nearest-vertex projection, which ignores the feed's distances
    //      entirely and is therefore CORRECT on exactly the trips whose
    //      distances are broken (measured endpoint error on those trips:
    //      7.4 m, against 3,675 m for the distance cut);
    //   3. only then the stop-to-stop line, flagged `geometryFallback: true`.
    // Steps 1 and 2 are both the operator's real shape, so neither is
    // reported as a fallback.
    let line: LatLon[] | null = null;

    if (refs.fromDist !== null && refs.toDist !== null
        && Number.isFinite(refs.fromDist) && Number.isFinite(refs.toDist)) {
      line = orientedIfEndpointsMatch(
        sliceByDistance(points, refs.fromDist, refs.toDist), boardStop, alightStop,
      );
    }

    // The projection needs coordinates from the trip's own `stop_times`
    // rows; `legShapeRefs` reports null for either when the feed's `stops`
    // row has no lat/lon, and there is nothing to project in that case.
    if (line === null && refs.fromStop !== null && refs.toStop !== null) {
      line = orientedIfEndpointsMatch(
        sliceByNearestVertices(points, refs.fromStop, refs.toStop), boardStop, alightStop,
      );
    }

    if (line === null || line.length < 2) { throughStops(); return; }
    t.geometry = encodePolyline(line);
    t.geometryFallback = false;
  };

  for (const itinerary of itineraries) {
    for (const leg of itinerary.legs) {
      if (leg.type !== "transit") continue;
      resolve(leg);
      // Alternatives are swapped in for the leg by the client, so they need
      // the same real line the leg has, not a fallback.
      for (const alternative of leg.alternatives) resolve(alternative);
    }
  }
}
