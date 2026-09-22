import type Database from "better-sqlite3";

// `shapes` is required: the real feed's shapes.txt is ~229 MB and always
// populated, so zero rows means a parse failure, never a legitimate state —
// a cold-start run (previousCounts === null) that produced no shapes would
// otherwise pass Gate 1 and publish a database with no map geometry at all.
// `translations` stays counted-but-not-required (see below): its absence
// degrades name resolution but does not break routing.
const REQUIRED_TABLES = [
  "agency", "routes", "stops", "calendar", "trips", "stop_times", "shapes",
] as const;

/** Built after the bulk load: one sort per index beats 10M btree inserts. */
export function createIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_stop_times_stop_dep
      ON stop_times (stop_ref, departure_time);
    CREATE INDEX IF NOT EXISTS ix_stop_times_trip_seq
      ON stop_times (trip_ref, stop_sequence);
    CREATE INDEX IF NOT EXISTS ix_trips_route   ON trips (route_id);
    CREATE INDEX IF NOT EXISTS ix_trips_service ON trips (service_id);
    CREATE INDEX IF NOT EXISTS ix_stops_code    ON stops (stop_code);
    CREATE INDEX IF NOT EXISTS ix_routes_agency ON routes (agency_id);
  `);
}

/**
 * Rebuilt from scratch each run; roughly 35k stops, so cost is trivial.
 *
 * FTS tokenizer: `unicode61` (the default FTS5 tokenizer) treats '/' as a
 * separator and folds Hebrew script into tokens on codepoint category, same
 * as any other letters — it does not need Hebrew-specific configuration.
 * Verified directly against this project's better-sqlite3 build: querying
 * "הרצל" against the stop name "הרצל/צומת בילו" matches, a prefix-only query
 * ("הר") and an unrelated word ("רכבת") both correctly miss. See
 * finalize.test.ts's FTS5 test for the executable proof, including the
 * negative controls.
 */
export function buildDerived(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS stops_rtree;
    CREATE VIRTUAL TABLE stops_rtree USING rtree(
      stop_ref, min_lat, max_lat, min_lon, max_lon
    );
    INSERT INTO stops_rtree (stop_ref, min_lat, max_lat, min_lon, max_lon)
      SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops
      WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL;

    DROP TABLE IF EXISTS stops_fts;
    CREATE VIRTUAL TABLE stops_fts USING fts5(
      stop_name, stop_ref UNINDEXED, tokenize='unicode61'
    );
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_name IS NOT NULL;
  `);
}

export interface SanityReport {
  ok: boolean;
  failures: string[];
  counts: Record<string, number>;
}

export interface SanityOptions {
  minRatio?: number;
  maxRatio?: number;
  /**
   * shape_ids that FeedWriter#nonContiguousShapeIds() reported: a shape_id
   * whose points reappeared in shapes.txt after that shape_id's group had
   * already been flushed. The writer keeps only the first contiguous run of
   * points and silently discards the rest, so the `shapes` row that survives
   * has an authoritative-looking but wrong point_count/total_length_m — the
   * database itself carries no trace of the truncation. This is the only
   * place that condition is visible, so it must be passed in explicitly.
   */
  nonContiguousShapeIds?: string[];
}

/**
 * Every gate must pass before the swap. A failure leaves the previous database
 * live, so a failed run is a no-op rather than a partial publication.
 */
export function runSanityGates(
  db: Database.Database,
  previousCounts: Record<string, number> | null,
  opts: SanityOptions = {},
): SanityReport {
  const minRatio = opts.minRatio ?? 0.5;
  const maxRatio = opts.maxRatio ?? 2.0;
  const nonContiguousShapeIds = opts.nonContiguousShapeIds ?? [];
  const failures: string[] = [];
  const counts: Record<string, number> = {};

  const countOf = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  // `translations` is tracked for the ratio gate and reporting, but
  // deliberately excluded from REQUIRED_TABLES: many feeds ship with no
  // translations.txt at all, so an empty table here is normal, not a defect.
  for (const t of [...REQUIRED_TABLES, "translations"]) {
    counts[t] = countOf(t);
  }

  // Gate 1: required tables are non-empty.
  for (const t of REQUIRED_TABLES) {
    if (counts[t] === 0) failures.push(`table ${t} is empty`);
  }

  // Gate 2: counts within band of the previous successful run.
  //
  // The key set to compare is the union of this run's counts and
  // previousCounts's keys, not just previousCounts's keys: this module does
  // not control or verify that the caller persisted a full counts map, so
  // trusting previousCounts's own keys as the complete comparison set would
  // silently skip any table it happens to be missing.
  if (previousCounts) {
    const tables = new Set([...Object.keys(counts), ...Object.keys(previousCounts)]);
    for (const t of tables) {
      const now = counts[t];
      const prev = previousCounts[t];
      if (now === undefined) {
        // Tracked by the previous run but not produced by this one at all —
        // not a ratio question. If it's one of REQUIRED_TABLES, Gate 1
        // already failed the run; otherwise there is nothing to compare.
        continue;
      }
      if (!prev) {
        // `prev` is either undefined (no baseline recorded for this table —
        // first run ever, or a table added after the caller's persisted
        // history was written) or legitimately 0 (previously empty). Both
        // are handled the same way and for the same reason: a ratio needs
        // two real data points, and "no history" / "growing from empty"
        // are not collapses — dividing by zero or undefined would otherwise
        // produce Infinity/NaN, which is exactly the kind of implicit
        // fallthrough this explicit check replaces. A table that must never
        // legitimately be empty is Gate 1's job, not this gate's.
        continue;
      }
      const ratio = now / prev;
      if (ratio < minRatio || ratio > maxRatio) {
        failures.push(
          `table ${t} row count ${now} is ${ratio.toFixed(2)}x the previous ${prev}`,
        );
      }
    }
  }

  // Gate 3: no foreign-key orphans. Checked here because loading runs with
  // foreign_keys off — stop_times.txt precedes stops.txt and trips.txt.
  const orphanChecks: [string, string][] = [
    ["stop_times -> trips", "SELECT COUNT(*) AS n FROM stop_times st LEFT JOIN trips t ON t.trip_ref = st.trip_ref WHERE t.trip_ref IS NULL"],
    ["stop_times -> stops", "SELECT COUNT(*) AS n FROM stop_times st LEFT JOIN stops s ON s.stop_ref = st.stop_ref WHERE s.stop_ref IS NULL"],
    ["trips -> routes", "SELECT COUNT(*) AS n FROM trips t LEFT JOIN routes r ON r.route_id = t.route_id WHERE r.route_id IS NULL"],
    ["trips -> calendar", "SELECT COUNT(*) AS n FROM trips t LEFT JOIN calendar c ON c.service_id = t.service_id WHERE c.service_id IS NULL"],
  ];
  for (const [label, sql] of orphanChecks) {
    const { n } = db.prepare(sql).get() as { n: number };
    if (n > 0) failures.push(`${n} orphan rows in ${label}`);
  }

  // Gate 4: (trip_ref, stop_sequence) uniqueness, since no PK enforces it.
  const { n: dupes } = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT trip_ref, stop_sequence FROM stop_times
      GROUP BY trip_ref, stop_sequence HAVING COUNT(*) > 1
    )
  `).get() as { n: number };
  if (dupes > 0) {
    failures.push(`${dupes} duplicate (trip_ref, stop_sequence) pairs in stop_times`);
  }

  // Gate 5: shapes.txt must have been grouped by shape_id. If FeedWriter
  // reports a shape_id as non-contiguous, the corresponding row in `shapes`
  // holds a truncated polyline whose point_count/total_length_m look valid
  // but aren't — nothing queryable in the database reveals this, so the
  // condition has to be supplied by the caller from the writer.
  if (nonContiguousShapeIds.length > 0) {
    const shown = nonContiguousShapeIds.slice(0, 5).join(", ");
    const more = nonContiguousShapeIds.length > 5
      ? ` (+${nonContiguousShapeIds.length - 5} more)`
      : "";
    failures.push(
      `${nonContiguousShapeIds.length} shape_id(s) reappeared in shapes.txt after their group `
      + `was flushed, so their polyline is truncated: ${shown}${more}`,
    );
  }

  return { ok: failures.length === 0, failures, counts };
}

interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/**
 * Prepare the finished database for readers.
 *
 * better-sqlite3 (and SQLite generally) only runs its automatic WAL
 * checkpoint at `close()` when the closing connection is the *last* open
 * connection to that database file. The live database is opened
 * concurrently via `openReadDb` to read `feed_meta`, so a second connection
 * being open at close time is a designed, expected part of this system —
 * not an edge case. When that happens, the passive checkpoint silently does
 * not run at all: `close()` raises nothing, and any rows committed while in
 * WAL mode stay in the `-wal` sidecar. A naive publish step that copies (or
 * moves) only the main `.sqlite` file, on the assumption that a closed
 * database is self-contained, then silently loses those rows with no error
 * anywhere in the chain. Version garbage collection already assumes
 * `-wal`/`-shm` must travel with their database (it collects them
 * together), but the only way to make the handoff safe regardless of what
 * future callers do is to make the file self-contained the moment this
 * function returns.
 *
 * So: force the checkpoint here explicitly, and verify it actually
 * completed. `wal_checkpoint(TRUNCATE)` reports `{busy, log, checkpointed}`
 * and does NOT throw on a partial checkpoint — confirmed directly against
 * this project's better-sqlite3 build: with a second connection holding an
 * open read transaction, the call returns `{busy: 1, log: 1, checkpointed:
 * 0}` and leaves the `-wal` file exactly as it was, with no exception. A
 * silent partial checkpoint is exactly the failure this function exists to
 * prevent, so it is treated as a hard error rather than a warning.
 */
export function finalizeForRead(db: Database.Database): void {
  db.exec("ANALYZE");
  db.pragma("journal_mode = WAL");

  const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as WalCheckpointResult[];
  if (!result || result.busy !== 0 || result.checkpointed !== result.log) {
    throw new Error(
      "wal_checkpoint(TRUNCATE) did not fully checkpoint the database "
      + `(busy=${result?.busy}, log=${result?.log}, checkpointed=${result?.checkpointed}). `
      + "A concurrent connection is likely holding an open snapshot; the -wal "
      + "sidecar may retain committed rows the main .sqlite file lacks.",
    );
  }
}
