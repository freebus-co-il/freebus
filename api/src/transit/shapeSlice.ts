import { haversineMeters, type LatLon } from "../geo.js";

/**
 * Running distance along a polyline in metres. Same length as `points`, first
 * entry always 0.
 *
 * GTFS gives us `shape_dist_traveled` per stop but the `shapes` table stores
 * only the encoded polyline, `point_count` and `total_length_m` — there is no
 * per-vertex distance column. So the distances have to be recomputed here to
 * find where along the line a stop sits.
 */
export function cumulativeDistances(points: readonly LatLon[]): number[] {
  const out = new Array<number>(points.length);
  if (points.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < points.length; i++) {
    // Both indices are within bounds by the loop condition.
    out[i] = out[i - 1]! + haversineMeters(points[i - 1]!, points[i]!);
  }
  return out;
}

/** Linear interpolation between two points at fraction `t` of the way. */
function lerp(a: LatLon, b: LatLon, t: number): LatLon {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * The portion of `points` between two distances along the line, in metres.
 *
 * The ends are INTERPOLATED rather than snapped to the nearest vertex: a stop
 * usually sits partway along a segment, and snapping would visibly overshoot
 * or undershoot the platform on a shape whose vertices are hundreds of metres
 * apart.
 *
 * Bounds are clamped to the line and a reversed span is normalised, because
 * either would otherwise yield an empty or backwards line that a client draws
 * as nothing at all.
 *
 * `fromMeters` and `toMeters` must be finite: a NaN or Infinity bound can only
 * arrive from a caller's bug (e.g. an unparsed `shape_dist_traveled`), and
 * computing with it would silently produce NaN coordinates that get encoded
 * and shipped to a client instead of failing loudly here.
 */
export function sliceByDistance(
  points: readonly LatLon[], fromMeters: number, toMeters: number,
): LatLon[] {
  if (!Number.isFinite(fromMeters)) {
    throw new Error(`sliceByDistance: fromMeters must be a finite number, got ${fromMeters}`);
  }
  if (!Number.isFinite(toMeters)) {
    throw new Error(`sliceByDistance: toMeters must be a finite number, got ${toMeters}`);
  }
  if (points.length < 2) return [...points];

  const dist = cumulativeDistances(points);
  const total = dist[dist.length - 1]!;
  let lo = Math.min(fromMeters, toMeters);
  let hi = Math.max(fromMeters, toMeters);
  lo = Math.max(0, Math.min(lo, total));
  hi = Math.max(0, Math.min(hi, total));

  const at = (target: number): { point: LatLon; index: number } => {
    // First vertex at or beyond `target`. `dist` is non-decreasing.
    let i = 1;
    while (i < dist.length - 1 && dist[i]! < target) i++;
    const prev = dist[i - 1]!;
    const span = dist[i]! - prev;
    const t = span <= 0 ? 0 : (target - prev) / span;
    return { point: lerp(points[i - 1]!, points[i]!, t), index: i };
  };

  const start = at(lo);
  const end = at(hi);

  // A degenerate span still returns two points so consumers can treat the
  // result uniformly as a line rather than special-casing a single vertex.
  if (lo === hi) return [start.point, start.point];

  const out: LatLon[] = [start.point];
  for (let i = start.index; i < end.index; i++) out.push(points[i]!);
  out.push(end.point);
  return out;
}

/** Index of the vertex closest to `target`. */
export function nearestVertexIndex(points: readonly LatLon[], target: LatLon): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineMeters(points[i]!, target);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Cuts between the vertices nearest each stop, ignoring
 * `shape_dist_traveled` entirely.
 *
 * Two callers reach this, both in `legGeometry.ts`:
 *
 *  1. a `stop_times` row with no `shape_dist_traveled` at all. On the live
 *     feed (2026-08-23) this case is unreachable: of 9,817,029 `stop_times`
 *     rows, 12,384 (0.13%) lack the column, and every one of them belongs to
 *     one of the 1,085 trips that have no `shape_id` either -- those legs take
 *     the straight-line fallback before this function is ever called.
 *  2. a distance cut whose endpoints did not land on the leg's own stops.
 *     This case IS reached, and often: 2,402 of 260,549 shaped trips (0.92%)
 *     carry a `shape_dist_traveled` scale that disagrees with their shape by
 *     kilometres. Ignoring those distances is precisely why this function is
 *     right for them -- measured endpoint error on those trips is 7.4 m,
 *     against 3,675 m for the distance cut it replaces.
 *
 * Coarser than an interpolated distance cut, but still real shape geometry
 * rather than a straight line, which is why neither caller reports it as a
 * fallback. The 0.92% figure above is the full measurement, not a sampled
 * estimate.
 *
 * Like `sliceByDistance`, this always returns at least two points. When both
 * stops project to the same nearest vertex, `points.slice` alone would yield
 * a one-point array — exactly the invisible-geometry failure this module
 * exists to avoid — so that case is widened to a degenerate two-point line.
 */
export function sliceByNearestVertices(
  points: readonly LatLon[], from: LatLon, to: LatLon,
): LatLon[] {
  if (points.length < 2) return [...points];
  const a = nearestVertexIndex(points, from);
  const b = nearestVertexIndex(points, to);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return [points[lo]!, points[lo]!];
  return points.slice(lo, hi + 1);
}
