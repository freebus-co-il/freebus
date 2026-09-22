import {
  parseGtfsTime, parseGtfsDate, parseInt0, parseFloat0, parseText, parseName,
} from "./values.js";

export interface ColumnSpec {
  /**
   * Destination SQLite column — **except** on the four files FeedWriter
   * assembles itself (stop_times, trips, stops, shapes), where these entries
   * describe source headers and their coercions only and `column` is not a
   * real column of the table. See TableSpec below; FeedWriter refuses to use
   * these lists for a generic INSERT and validates the ones it does use
   * against `PRAGMA table_info` at construction.
   */
  column: string;
  /** Source CSV header. Never a position. */
  header: string;
  coerce: (v: string) => unknown;
}

/**
 * Per-file load spec.
 *
 * A caveat enforced at construction, not just documented: for `stop_times`,
 * `trips`, `stops` and `shapes`, `columns` lists **CSV headers**, not the
 * table's SQLite columns. Those four are assembled by FeedWriter, which
 * interns `trip_id`/`stop_id` into `trip_ref`/`stop_ref` surrogate keys and
 * folds shapes.txt point rows into one polyline per shape, so their
 * destination column lists differ from their source headers in both names
 * and arity. Mapping `columns.map(c => c.column)` into an INSERT for one of
 * these produces SQL naming columns that do not exist.
 *
 * Nothing here declares which files those are — FeedWriter owns that list
 * (CUSTOM_TABLE_COLUMNS) and checks every column name it will actually
 * insert against `PRAGMA table_info` when it is constructed, so a mismatch
 * fails loudly at writer construction instead of turning into bad rows at
 * run time.
 */
export interface TableSpec {
  file: string;
  table: string;
  columns: ColumnSpec[];
}

const text = (column: string, header = column): ColumnSpec => ({
  column, header, coerce: parseText,
});
/** Feed name text: `text`, plus `fixFlippedGeresh`. */
const name = (column: string, header = column): ColumnSpec => ({
  column, header, coerce: parseName,
});
const int = (column: string, header = column): ColumnSpec => ({
  column, header, coerce: parseInt0,
});
const real = (column: string, header = column): ColumnSpec => ({
  column, header, coerce: parseFloat0,
});
const time = (column: string, header = column): ColumnSpec => ({
  column, header, coerce: parseGtfsTime,
});
const date = (column: string, header = column): ColumnSpec => ({
  column, header, coerce: parseGtfsDate,
});

export const SKIPPED_FILES: readonly string[] = [
  "fare_attributes.txt",
  "fare_rules.txt",
];

export const TABLE_SPECS: readonly TableSpec[] = [
  {
    file: "agency.txt", table: "agency",
    columns: [
      text("agency_id"), text("agency_name"), text("agency_url"),
      text("agency_timezone"), text("agency_lang"), text("agency_phone"),
      text("agency_fare_url"),
    ],
  },
  {
    file: "calendar.txt", table: "calendar",
    columns: [
      text("service_id"),
      int("sunday"), int("monday"), int("tuesday"), int("wednesday"),
      int("thursday"), int("friday"), int("saturday"),
      date("start_date"), date("end_date"),
    ],
  },
  {
    file: "routes.txt", table: "routes",
    columns: [
      text("route_id"), text("agency_id"), text("route_short_name"),
      name("route_long_name"), text("route_desc"), int("route_type"),
      text("route_color"),
    ],
  },
  {
    file: "stop_times.txt", table: "stop_times",
    columns: [
      text("trip_id"), text("stop_id"), int("stop_sequence"),
      time("arrival_time"), time("departure_time"),
      int("pickup_type"), int("drop_off_type"), real("shape_dist_traveled"),
    ],
  },
  {
    file: "stops.txt", table: "stops",
    columns: [
      text("stop_id"), text("stop_code"), name("stop_name"), text("stop_desc"),
      real("stop_lat"), real("stop_lon"), int("location_type"),
      text("parent_station"), text("zone_id"),
    ],
  },
  {
    file: "translations.txt", table: "translations",
    columns: [name("trans_id"), text("lang"), name("translation")],
  },
  {
    file: "trips.txt", table: "trips",
    columns: [
      text("trip_id"), text("route_id"), text("service_id"),
      text("trip_headsign"), int("direction_id"), text("shape_id"),
      int("wheelchair_accessible"),
    ],
  },
  {
    // Rows are folded into one polyline per shape by the writer; the column
    // list documents the source headers rather than destination columns.
    file: "shapes.txt", table: "shapes",
    columns: [
      text("shape_id"), real("shape_pt_lat"), real("shape_pt_lon"),
      int("shape_pt_sequence"),
    ],
  },
];

export function specForFile(file: string): TableSpec | undefined {
  return TABLE_SPECS.find((s) => s.file === file);
}
