import type Database from "better-sqlite3";
import { TABLE_SPECS, type ColumnSpec } from "../gtfs/tables.js";
import {
  encodePolyline, polylineLengthMeters, type LatLon,
} from "../gtfs/polyline.js";
import { parseFloat0, parseInt0, parseName, parseText } from "../gtfs/values.js";

const DEFAULT_BATCH = 5_000;

// Column-name arrays for the specially-handled files. Hoisted to module
// scope so the stop_times hot path (~10.4M rows) never allocates one of
// these per row.
const STOP_TIME_COLUMNS = [
  "trip_ref", "stop_ref", "stop_sequence", "arrival_time",
  "departure_time", "pickup_type", "drop_off_type", "shape_dist_traveled",
];
const TRIP_COLUMNS = [
  "trip_ref", "trip_id", "route_id", "service_id", "trip_headsign",
  "direction_id", "shape_id", "wheelchair_accessible",
];
const STOP_COLUMNS = [
  "stop_ref", "stop_id", "stop_code", "stop_name", "stop_desc",
  "stop_lat", "stop_lon", "location_type", "parent_station", "zone_id",
];
const SHAPE_COLUMNS = ["shape_id", "encoded_polyline", "point_count", "total_length_m"];

interface ShapeBuffer {
  shapeId: string;
  points: { seq: number; lat: number; lon: number }[];
}

/**
 * A failure that is emphatically NOT data noise.
 *
 * Everything thrown inside `writeRow` is otherwise swallowed into `#bad` and
 * measured against `maxBadRowRatio` — correct for a row that failed
 * coercion, catastrophic for anything else. A batch transaction failing
 * (SQLITE_FULL, SQLITE_IOERR, a corrupt page) loses an entire batch per
 * occurrence, and at the default 1% budget over ~10.4M rows roughly 104,000
 * rows could disappear into disk errors while the run still published: the
 * count-ratio gate cannot see a 1% dip, and the orphan gate finds nothing
 * wrong with stop_times rows that simply are not there. This class is how
 * such a failure escapes the catch-all instead of being paid for out of the
 * noise budget.
 */
export class WriterFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WriterFailure";
  }
}

/**
 * Column metadata for a file the generic insert path can handle.
 *
 * `columnNames` is null for files whose rows FeedWriter assembles itself
 * (stop_times, trips, stops, shapes). For those, TABLE_SPECS.columns
 * describes SOURCE CSV HEADERS and their coercions — `trip_id`, `stop_id` —
 * not destination columns, which are the interned `trip_ref`/`stop_ref`
 * forms. Carrying null rather than a wrong-but-plausible string[] is what
 * makes the difference visible: the generic path cannot silently emit
 * `INSERT INTO stop_times (trip_id, ...)` and have the resulting SQL error
 * land in the bad-row counter.
 */
interface PreparedSpec {
  table: string;
  columns: ColumnSpec[];
  columnNames: string[] | null;
  byHeader: Map<string, ColumnSpec>;
}

/**
 * Destination columns for the files FeedWriter assembles by hand, keyed by
 * table. Checked against the live schema at construction — see
 * #assertColumnsExist.
 */
const CUSTOM_TABLE_COLUMNS: Record<string, string[]> = {
  stop_times: STOP_TIME_COLUMNS,
  trips: TRIP_COLUMNS,
  stops: STOP_COLUMNS,
  shapes: SHAPE_COLUMNS,
};

/**
 * Buffers coerced rows and writes them in batched transactions.
 *
 * Two responsibilities beyond plain inserts:
 *  - Interning: trip_id and stop_id become INTEGER surrogate keys, because
 *    repeating a ~10-character trip_id across ~10.4M stop_times rows costs
 *    roughly 160 MB on its own. Keys may be allocated before the defining
 *    row arrives, since stop_times.txt precedes stops.txt and trips.txt.
 *  - Shape folding: shapes.txt point rows are accumulated per shape_id and
 *    emitted as a single encoded polyline.
 */
export class FeedWriter {
  readonly #db: Database.Database;
  readonly #batchSize: number;
  readonly #pending = new Map<string, unknown[][]>();
  readonly #columnsByTable = new Map<string, string[]>();
  readonly #rowsQueued: Record<string, number> = {};
  readonly #tripRefs = new Map<string, number>();
  readonly #stopRefs = new Map<string, number>();
  // shape_ids that have already completed a #flushShape. shapes.txt is
  // grouped by shape_id in every feed observed so far, but that is an
  // assumption about today's data, not a guarantee across daily
  // regenerations. #flushShape fires purely on shape_id change, so a
  // reappearing shape_id would otherwise queue a second INSERT OR REPLACE
  // row for the same primary key — and because the physical write happens
  // later, in a batched transaction, the *second* occurrence would silently
  // overwrite the first's polyline with no error. Tracking completed ids
  // lets #writeShapePoint refuse to start a second group for a shape_id
  // that already flushed, counting the reappearance as bad rows instead of
  // corrupting previously-written geometry.
  readonly #flushedShapeIds = new Set<string>();
  // shape_ids for which a non-contiguous reappearance was actually detected
  // and rejected (a subset of #bad). Exposed separately via
  // nonContiguousShapeIds() so a caller (the sanity gates) can tell
  // "shapes.txt is not grouped, and geometry has been silently truncated"
  // apart from ordinary per-row noise like unparseable coordinates.
  readonly #nonContiguousShapeIds = new Set<string>();
  // Column metadata for every plain-insert file, computed once per writer
  // rather than once per row. Building `new Map(spec.columns.map(...))`
  // and column-name arrays inside the stop_times row path (~10.4M calls)
  // was the dominant GC cost of the whole import.
  readonly #specsByFile = new Map<string, PreparedSpec>();
  #shape: ShapeBuffer | null = null;
  #bad = 0;
  // First infrastructure failure seen, kept so importFeed can assert on it
  // structurally even if a future refactor stops the throw propagating.
  #flushFailure: WriterFailure | null = null;

  constructor(db: Database.Database, opts: { batchSize?: number } = {}) {
    this.#db = db;
    this.#batchSize = opts.batchSize ?? DEFAULT_BATCH;
    for (const spec of TABLE_SPECS) {
      const custom = CUSTOM_TABLE_COLUMNS[spec.table] !== undefined;
      if (spec.file !== "shapes.txt") {
        this.#specsByFile.set(spec.file, {
          table: spec.table,
          columns: spec.columns,
          // Null for custom tables: their TABLE_SPECS.columns list source
          // headers, not destination columns. See PreparedSpec.
          columnNames: custom ? null : spec.columns.map((c) => c.column),
          byHeader: new Map(spec.columns.map((c) => [c.header, c])),
        });
      }
      this.#assertColumnsExist(
        spec.table,
        CUSTOM_TABLE_COLUMNS[spec.table] ?? spec.columns.map((c) => c.column),
      );
    }
  }

  /**
   * Verifies at construction that every column name this writer will put in
   * an INSERT actually exists on its table.
   *
   * This is the guard that makes the header-vs-column distinction impossible
   * to get wrong silently. Three tables (stop_times, trips, stops) have
   * TABLE_SPECS.columns naming CSV headers rather than SQLite columns —
   * `trip_id` where the column is `trip_ref` — and the only thing that ever
   * stopped those reaching an INSERT was a `switch` in writeRow routing them
   * elsewhere. Delete one `case` and the generic path emits SQL against a
   * column that does not exist; the error lands in writeRow's catch-all and
   * is reported as bad rows, so the run fails (or worse, publishes) with a
   * diagnosis pointing at the upstream feed.
   *
   * Running the check against `PRAGMA table_info` rather than a hand-kept
   * duplicate of the DDL means the two cannot drift: rename a column in
   * schema.ts and every FeedWriter in the suite fails to construct, naming
   * the column and the table. Eight pragma queries once per writer against
   * a ~10.4M-row import is not measurable.
   */
  #assertColumnsExist(table: string, columns: string[]): void {
    const info = this.#db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (info.length === 0) {
      throw new WriterFailure(`table ${table} does not exist in this database`);
    }
    const actual = new Set(info.map((c) => c.name));
    const missing = columns.filter((c) => !actual.has(c));
    if (missing.length > 0) {
      throw new WriterFailure(
        `FeedWriter would insert into ${table} column(s) that do not exist: `
        + `${missing.join(", ")} (table has: ${[...actual].join(", ")})`,
      );
    }
  }

  #internTrip(tripId: string): number {
    let ref = this.#tripRefs.get(tripId);
    if (ref === undefined) {
      ref = this.#tripRefs.size + 1;
      this.#tripRefs.set(tripId, ref);
    }
    return ref;
  }

  #internStop(stopId: string): number {
    let ref = this.#stopRefs.get(stopId);
    if (ref === undefined) {
      ref = this.#stopRefs.size + 1;
      this.#stopRefs.set(stopId, ref);
    }
    return ref;
  }

  writeRow(file: string, row: Record<string, string>): void {
    // Every file, including shapes.txt, goes through this one try/catch so
    // a downstream failure (e.g. a batch flush failing on a constraint
    // violation) is handled identically regardless of which path triggered
    // it — see #flushTable for why that failure is now always recoverable
    // rather than propagating out.
    try {
      if (file === "shapes.txt") {
        this.#writeShapePoint(row);
        return;
      }
      const spec = this.#specsByFile.get(file);
      if (!spec) return;

      switch (file) {
        case "stop_times.txt":
          this.#writeStopTime(row, spec.byHeader);
          return;
        case "trips.txt":
          this.#writeTrip(row);
          return;
        case "stops.txt":
          this.#writeStop(row);
          return;
        default: {
          if (!spec.columnNames) {
            // Reachable only by deleting one of the cases above. Loud and
            // fatal rather than a SQL error laundered into the bad-row
            // count — see PreparedSpec.
            throw new WriterFailure(
              `${file} must be written by a dedicated FeedWriter path: its `
              + "TABLE_SPECS columns name CSV headers, not the columns of "
              + `table ${spec.table}`,
            );
          }
          const values = spec.columns.map((c) => c.coerce(row[c.header] ?? ""));
          this.#queue(spec.table, spec.columnNames, values);
        }
      }
    } catch (err) {
      // Infrastructure failures are not data noise and must never be paid
      // for out of maxBadRowRatio. Everything else here is a row that failed
      // coercion, which is exactly what that budget is for.
      if (err instanceof WriterFailure) throw err;
      this.#bad++;
    }
  }

  #writeStopTime(row: Record<string, string>, byHeader: Map<string, ColumnSpec>): void {
    const tripId = parseText(row.trip_id ?? "");
    const stopId = parseText(row.stop_id ?? "");
    const seq = parseInt0(row.stop_sequence ?? "");
    if (tripId === null || stopId === null || seq === null) {
      this.#bad++;
      return;
    }
    this.#queue(
      "stop_times",
      STOP_TIME_COLUMNS,
      [
        this.#internTrip(tripId),
        this.#internStop(stopId),
        seq,
        byHeader.get("arrival_time")!.coerce(row.arrival_time ?? ""),
        byHeader.get("departure_time")!.coerce(row.departure_time ?? ""),
        byHeader.get("pickup_type")!.coerce(row.pickup_type ?? ""),
        byHeader.get("drop_off_type")!.coerce(row.drop_off_type ?? ""),
        byHeader.get("shape_dist_traveled")!.coerce(row.shape_dist_traveled ?? ""),
      ],
    );
  }

  #writeTrip(row: Record<string, string>): void {
    const tripId = parseText(row.trip_id ?? "");
    if (tripId === null) {
      this.#bad++;
      return;
    }
    this.#queue(
      "trips",
      TRIP_COLUMNS,
      [
        this.#internTrip(tripId),
        tripId,
        parseText(row.route_id ?? ""),
        parseText(row.service_id ?? ""),
        parseText(row.trip_headsign ?? ""),
        parseInt0(row.direction_id ?? ""),
        parseText(row.shape_id ?? ""),
        parseInt0(row.wheelchair_accessible ?? ""),
      ],
    );
  }

  #writeStop(row: Record<string, string>): void {
    const stopId = parseText(row.stop_id ?? "");
    if (stopId === null) {
      this.#bad++;
      return;
    }
    this.#queue(
      "stops",
      STOP_COLUMNS,
      [
        this.#internStop(stopId),
        stopId,
        parseText(row.stop_code ?? ""),
        parseName(row.stop_name ?? ""),
        parseText(row.stop_desc ?? ""),
        parseFloat0(row.stop_lat ?? ""),
        parseFloat0(row.stop_lon ?? ""),
        parseInt0(row.location_type ?? ""),
        parseText(row.parent_station ?? ""),
        parseText(row.zone_id ?? ""),
      ],
    );
  }

  #writeShapePoint(row: Record<string, string>): void {
    const shapeId = parseText(row.shape_id ?? "");
    const lat = parseFloat0(row.shape_pt_lat ?? "");
    const lon = parseFloat0(row.shape_pt_lon ?? "");
    const seq = parseInt0(row.shape_pt_sequence ?? "");
    if (shapeId === null || lat === null || lon === null || seq === null) {
      this.#bad++;
      return;
    }
    if (this.#shape && this.#shape.shapeId !== shapeId) this.#flushShape();

    if (this.#shape === null) {
      // Starting a new group. If this shape_id already completed a flush
      // earlier, this is a non-contiguous reappearance: refuse to start a
      // second group for it so we never queue a duplicate-PK row that would
      // silently overwrite the already-flushed polyline. Every point of the
      // reappearance is counted as a bad row, and the shape_id is recorded
      // separately so callers can detect the condition itself, not just an
      // anonymous bump in the noise-catchall bad-row count.
      if (this.#flushedShapeIds.has(shapeId)) {
        this.#bad++;
        this.#nonContiguousShapeIds.add(shapeId);
        return;
      }
      this.#shape = { shapeId, points: [] };
    }
    this.#shape.points.push({ seq, lat, lon });
  }

  #flushShape(): void {
    const shape = this.#shape;
    this.#shape = null;
    if (!shape || shape.points.length === 0) return;

    this.#flushedShapeIds.add(shape.shapeId);

    // shapes.txt is grouped and ordered in practice; sort defensively so a
    // shuffled feed still produces a correctly ordered polyline.
    shape.points.sort((a, b) => a.seq - b.seq);
    const points: LatLon[] = shape.points.map((p) => [p.lat, p.lon] as const);
    this.#queue(
      "shapes",
      SHAPE_COLUMNS,
      [
        shape.shapeId,
        encodePolyline(points),
        points.length,
        polylineLengthMeters(points),
      ],
    );
  }

  #queue(table: string, columns: string[], values: unknown[]): void {
    let buf = this.#pending.get(table);
    if (!buf) {
      buf = [];
      this.#pending.set(table, buf);
      this.#columnsByTable.set(table, columns);
    }
    buf.push(values);
    if (buf.length >= this.#batchSize) this.#flushTable(table);
  }

  #flushTable(table: string): void {
    const buf = this.#pending.get(table);
    const columns = this.#columnsByTable.get(table);
    if (!buf || !columns || buf.length === 0) return;

    const count = buf.length;
    try {
      // prepare() and transaction() are inside the try, not above it.
      // Outside, a throw from either skipped the `finally` below and left
      // the buffer full — which is precisely the unbounded-growth cycle
      // that finally exists to prevent: the next writeRow pushes onto an
      // already-full buffer, immediately re-triggers a flush, and re-fails,
      // forever.
      const sql =
        `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) ` +
        `VALUES (${columns.map(() => "?").join(",")})`;
      const stmt = this.#db.prepare(sql);
      const insertAll = this.#db.transaction((rows: unknown[][]) => {
        for (const r of rows) stmt.run(r);
      });
      insertAll(buf);
      this.#rowsQueued[table] = (this.#rowsQueued[table] ?? 0) + count;
    } catch (cause) {
      // better-sqlite3 rolls the whole transaction back on any throw, so
      // none of these `count` rows landed — not just the one that failed.
      //
      // Two very different things can land here, and treating them alike was
      // the bug. A CONSTRAINT violation is caused by the row: a blank
      // NOT NULL field, a duplicate key. That is upstream data noise, it is
      // what maxBadRowRatio exists to tolerate, and the import continues.
      // Anything else — SQLITE_FULL, SQLITE_IOERR, SQLITE_CORRUPT,
      // SQLITE_READONLY, or a plain SQLITE_ERROR from SQL naming a column
      // that does not exist — is the machine or this code failing, and has
      // nothing to do with the feed. Counting those as bad rows made them
      // *budgeted*: at the default 1% over ~10.4M rows, roughly 104,000 rows
      // could vanish into disk errors and the run would still publish, with
      // Gate 2's 50–200% band blind to a 1% dip and Gate 3 finding no
      // orphans for stop_times rows that are merely absent.
      //
      // The code prefix is the discriminator better-sqlite3 gives us:
      // SqliteError#code is the extended result code name, e.g.
      // "SQLITE_CONSTRAINT_NOTNULL". Anything not recognisably a constraint
      // — including an error carrying no code at all — is treated as
      // infrastructure, so an unfamiliar failure fails the run rather than
      // being quietly absorbed.
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        this.#bad += count;
      } else {
        // Raised, not counted — and raised at the first occurrence rather
        // than after grinding the remaining ten million rows into a disk
        // that is already full.
        const failure = new WriterFailure(
          `flushing ${count} row(s) into ${table} failed with `
          + `${typeof code === "string" ? code : "no SQLite error code"}; `
          + "this is an infrastructure failure, not bad input, so the run "
          + "cannot publish",
          { cause },
        );
        this.#flushFailure ??= failure;
        throw failure;
      }
    } finally {
      // Always clear, success or failure — including on the throw above,
      // which propagates only after this runs. Without it a failing batch
      // stays in the buffer; the next writeRow call pushes onto an
      // already-full buffer, which immediately re-triggers (and re-fails)
      // a flush, forever — unbounded memory growth on a 10.4M-row table.
      // This invariant holds regardless of whether a flush failure is
      // counted as bad or raised: a caller that chooses to keep writing
      // after a flush failure still cannot make the buffer grow without
      // bound.
      buf.length = 0;
    }
  }

  finish(): void {
    this.#flushShape();
    for (const table of [...this.#pending.keys()]) this.#flushTable(table);
  }

  /** Rows actually written per table. Not a live COUNT(*): under
   * INSERT OR REPLACE, a repeated key across two different batches is
   * counted twice here even though it occupies one row in the table. */
  rowsQueued(): Record<string, number> {
    return { ...this.#rowsQueued };
  }

  badRows(): number {
    return this.#bad;
  }

  /**
   * The first infrastructure failure this writer hit, or null.
   *
   * Deliberately separate from `badRows()`: these two numbers answer
   * different questions ("is the upstream feed malformed?" versus "is this
   * machine broken?") and have different consequences (budgeted versus
   * fatal). Collapsing them was the bug — see WriterFailure.
   */
  flushFailure(): WriterFailure | null {
    return this.#flushFailure;
  }

  /**
   * shape_ids for which a shapes.txt point arrived after that shape_id's
   * group had already been flushed — i.e. shapes.txt was not grouped by
   * shape_id as expected. When this is non-empty, the corresponding rows in
   * the `shapes` table hold only the first contiguous run of points: their
   * point_count and total_length_m are not authoritative for the full
   * shape. Callers (the sanity gates) should treat a non-empty result
   * as a hard failure rather than publishing truncated geometry.
   */
  nonContiguousShapeIds(): string[] {
    return [...this.#nonContiguousShapeIds];
  }
}
