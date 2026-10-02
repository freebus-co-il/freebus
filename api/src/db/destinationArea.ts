import type Database from "better-sqlite3";
import { bboxAround, haversineMeters } from "../geo.js";

/**
 * How far from the place the rider named a stop may be and still count as
 * arriving there.
 *
 * A rider can name a landmark -- a railway station, a hospital, a mall --
 * far more reliably than they can name the bus stop beside it, which in this
 * feed is called something like "דרך מנחם בגין/נחמני" and is not what anyone
 * searches for. So the destination is a POINT, and any stop near it will do.
 *
 * 500 m is about a six-minute walk. It also dissolves a problem the previous
 * name-matching version of this file existed to solve: one physical station
 * split across several unrelated GTFS station rows (Hadera's central station
 * is four of them over ~111 m, Tel Aviv's is three name families over
 * ~195 m). Every fragment of those sits well inside this radius, so they are
 * reunited by geometry instead of by guessing at names.
 *
 * Not a query parameter, deliberately: it is the meaning of "arrives there"
 * and must be the same for every caller, rather than something a client can
 * drift.
 */
export const DESTINATION_RADIUS_METERS = 500;

/** A stop near the destination, and how far the rider still has to walk. */
export interface DestinationStop {
  stopId: string;
  /** Straight-line metres from the stop to the place the rider named. Not a
   *  walking route: it is used to choose between stops and to warn when the
   *  walk is long, and a street-level route for every candidate stop would
   *  cost a Valhalla call per row of the board. */
  walkMeters: number;
}

/**
 * Every stop within `DESTINATION_RADIUS_METERS` of a point, nearest first.
 *
 * Empty when nothing is in range, which is a real answer: the rider named
 * somewhere no bus goes near.
 */
export function destinationStops(
  db: Database.Database,
  opts: { lat: number; lon: number; radiusMeters?: number },
): DestinationStop[] {
  const radius = opts.radiusMeters ?? DESTINATION_RADIUS_METERS;
  const box = bboxAround(opts.lat, opts.lon, radius);

  // The R*Tree gives a rectangle; the exact circle is applied below. The
  // rectangle is always a superset, so nothing inside the radius is lost.
  const rows = db.prepare(`
    SELECT stop_id, stop_lat, stop_lon FROM stops
    WHERE stop_ref IN (
      SELECT stop_ref FROM stops_rtree
      WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
    )
  `).all(box.minLat, box.maxLat, box.minLon, box.maxLon) as
    { stop_id: string; stop_lat: number; stop_lon: number }[];

  return rows
    .map((row) => ({
      stopId: row.stop_id,
      walkMeters: Math.round(haversineMeters([opts.lat, opts.lon], [row.stop_lat, row.stop_lon])),
    }))
    .filter((stop) => stop.walkMeters <= radius)
    .sort((a, b) => a.walkMeters - b.walkMeters);
}
