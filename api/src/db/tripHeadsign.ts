import type { Lang, Translator } from "./i18n.js";
import { RAIL_ROUTE_TYPE } from "../transit/routeTypes.js";

/**
 * What a rider reads as a trip's "headsign", and the train number when the
 * trip is a train.
 *
 * Israel's feed does not use `trip_headsign` the same way for every mode.
 * Every bus trip carries a real destination there. Every RAIL trip
 * (`route_type` 2) carries the TRAIN NUMBER instead -- "243", not a
 * station -- so passing it through verbatim shows riders a bare number
 * exactly where they look for where the train is going. For rail, the
 * destination is therefore the trip's own LAST stop (highest
 * `stop_sequence`): where the train terminates, not where this rider gets
 * off. The number is not thrown away -- it is what station staff, platform
 * screens and the operator's own app call the train by -- so it moves to
 * `tripNumber`, which is `null` for every non-rail trip.
 *
 * Every surface that returns a trip headsign goes through this module: the
 * SQL-backed ones via `RAIL_DESTINATION_SQL` + `tripHeadsignOf`, the
 * in-memory RAPTOR index via `rawHeadsignOf` / `tripNumberOf` at build time.
 */

/** A rail trip's number, or null for a non-rail trip or an empty headsign. */
export function tripNumberOf(routeType: number | null, rawHeadsign: string | null): string | null {
  if (routeType !== RAIL_ROUTE_TYPE) return null;
  return rawHeadsign === null || rawHeadsign === "" ? null : rawHeadsign;
}

/**
 * The UNTRANSLATED headsign to show: the last stop's raw `stop_name` for a
 * rail trip (null when the trip has no stop_times to take one from -- never
 * the number, which is the thing being replaced), `trip_headsign` otherwise.
 * Untranslated so the in-memory index can store it and resolve per request,
 * exactly as it does every other name.
 */
export function rawHeadsignOf(
  routeType: number | null, rawHeadsign: string | null, lastStopName: string | null,
): string | null {
  return routeType === RAIL_ROUTE_TYPE ? lastStopName : rawHeadsign;
}

/**
 * A SQL expression for a trip's last stop's raw name, evaluated ONLY for a
 * rail row: `CASE` short-circuits, so a bus row -- almost every row a board
 * returns -- pays nothing. For rail it is one probe of
 * `ix_stop_times_trip_seq (trip_ref, stop_sequence)`, read backwards.
 *
 * `tripRef` and `routeType` are column expressions from the caller's query
 * (e.g. `t.trip_ref`, `r.route_type`), never user input.
 */
export function railDestinationSql(tripRef: string, routeType: string): string {
  return `CASE WHEN ${routeType} = ${RAIL_ROUTE_TYPE} THEN (
    SELECT ls.stop_name FROM stop_times lst JOIN stops ls ON ls.stop_ref = lst.stop_ref
    WHERE lst.trip_ref = ${tripRef} ORDER BY lst.stop_sequence DESC LIMIT 1
  ) END`;
}

/** `headsign` (translated) and `tripNumber` for one trip row. */
export function tripHeadsignOf(
  tr: Translator, lang: Lang,
  row: { trip_headsign: string | null; route_type: number | null; rail_destination: string | null },
): { headsign: string | null; tripNumber: string | null } {
  return {
    headsign: tr.resolve(rawHeadsignOf(row.route_type, row.trip_headsign, row.rail_destination), lang),
    tripNumber: tripNumberOf(row.route_type, row.trip_headsign),
  };
}
