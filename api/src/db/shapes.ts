import type Database from "better-sqlite3";
import type { LatLon } from "../geo.js";

export interface LegShapeRefs {
  /** null when the trip carries no shape (1,085 trips in the real feed). */
  shapeId: string | null;
  /** Metres along the shape at the board stop; null when the feed omits it. */
  fromDist: number | null;
  toDist: number | null;
  /**
   * The board/alight stop coordinate, or null when the feed's `stops` row has
   * no `stop_lat`/`stop_lon`.
   *
   * NULL, deliberately, rather than a defaulted `[0, 0]`. Both columns are
   * nullable in the schema, and `[0, 0]` is not a neutral placeholder — it is
   * a real point in the Gulf of Guinea, roughly 4,000 km from anything in
   * this feed. A consumer projecting that onto a shape gets a confident,
   * silently absurd answer; a consumer handed `null` can fall back. Callers
   * MUST treat null as "cannot project this endpoint".
   */
  fromStop: LatLon | null;
  toStop: LatLon | null;
}

interface Row {
  shape_id: string | null;
  stop_lat: number | null;
  stop_lon: number | null;
  shape_dist_traveled: number | null;
}

function coordOf(row: Row): LatLon | null {
  if (row.stop_lat === null || row.stop_lon === null) return null;
  return [row.stop_lat, row.stop_lon];
}

/**
 * A leg's shape reference and the distances of its two endpoints along it.
 *
 * `fromPos` and `toPos` are PATTERN POSITIONS (0-based within the trip's stop
 * sequence), which is what a transit leg reports — NOT the feed's
 * `stop_sequence` values. Ordering by `stop_sequence` and taking the Nth row
 * is what maps one to the other; querying `stop_sequence = ?` directly would
 * silently mismatch on any feed whose sequences are not 0-based and
 * contiguous. Array indexing into the ordered rows below is what performs
 * that mapping — there is deliberately no SQL-side position column, since a
 * `ROW_NUMBER() OVER (...)` here bought nothing but a CO-ROUTINE + SCAN
 * wrapper in the query plan and the false impression that positions came
 * from SQL.
 */
export function legShapeRefs(
  db: Database.Database, tripId: string, fromPos: number, toPos: number,
): LegShapeRefs | null {
  if (fromPos < 0 || toPos < 0) return null;

  const rows = db.prepare(`
    SELECT t.shape_id,
           s.stop_lat, s.stop_lon,
           st.shape_dist_traveled
    FROM trips t
    JOIN stop_times st ON st.trip_ref = t.trip_ref
    JOIN stops s       ON s.stop_ref  = st.stop_ref
    WHERE t.trip_id = ?
    ORDER BY st.stop_sequence
  `).all(tripId) as Row[];

  if (rows.length === 0) return null;
  const from = rows[fromPos];
  const to = rows[toPos];
  if (from === undefined || to === undefined) return null;

  return {
    shapeId: from.shape_id === "" ? null : from.shape_id,
    fromDist: from.shape_dist_traveled,
    toDist: to.shape_dist_traveled,
    fromStop: coordOf(from),
    toStop: coordOf(to),
  };
}

export function shapePolyline(db: Database.Database, shapeId: string): string | null {
  const row = db.prepare("SELECT encoded_polyline FROM shapes WHERE shape_id = ?")
    .get(shapeId) as { encoded_polyline: string } | undefined;
  return row?.encoded_polyline ?? null;
}
