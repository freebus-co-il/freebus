import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBuildDb, openReadDb } from "./open.js";
import { FeedWriter } from "./writer.js";
import {
  createIndexes, buildDerived, runSanityGates, finalizeForRead,
} from "./finalize.js";

const newPath = () => join(mkdtempSync(join(tmpdir(), "gtfs-")), "b.sqlite");
const newDb = (path: string = newPath()) => openBuildDb(path);

/**
 * Writes a minimal but referentially complete dataset via a fresh FeedWriter,
 * without calling finish() — callers that need to add more rows (e.g. shape
 * points) before the batches flush can do so first.
 */
function seedWriter(db: ReturnType<typeof newDb>): FeedWriter {
  const w = new FeedWriter(db);
  w.writeRow("agency.txt", { agency_id: "2", agency_name: "רכבת ישראל", agency_url: "", agency_timezone: "Asia/Jerusalem", agency_lang: "he", agency_phone: "", agency_fare_url: "" });
  w.writeRow("routes.txt", { route_id: "R1", agency_id: "2", route_short_name: "1", route_long_name: "קו ראשון", route_desc: "", route_type: "3", route_color: "FF0000" });
  w.writeRow("calendar.txt", { service_id: "S1", sunday: "1", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "0", saturday: "0", start_date: "20260821", end_date: "20260920" });
  w.writeRow("stops.txt", { stop_id: "1", stop_code: "38831", stop_name: "בי''ס בר לב", stop_desc: "", stop_lat: "32.183985", stop_lon: "34.917554", location_type: "0", parent_station: "", zone_id: "" });
  w.writeRow("stops.txt", { stop_id: "2", stop_code: "38832", stop_name: "הרצל/צומת בילו", stop_desc: "", stop_lat: "31.869152", stop_lon: "34.819641", location_type: "0", parent_station: "", zone_id: "" });
  w.writeRow("trips.txt", { trip_id: "T1", route_id: "R1", service_id: "S1", trip_headsign: "910", direction_id: "0", shape_id: "SH1", wheelchair_accessible: "" });
  w.writeRow("stop_times.txt", { trip_id: "T1", stop_id: "1", stop_sequence: "1", arrival_time: "05:10:00", departure_time: "05:10:00", pickup_type: "0", drop_off_type: "1", shape_dist_traveled: "0" });
  w.writeRow("stop_times.txt", { trip_id: "T1", stop_id: "2", stop_sequence: "2", arrival_time: "05:12:23", departure_time: "05:12:23", pickup_type: "0", drop_off_type: "0", shape_dist_traveled: "714" });
  // shapes is a REQUIRED_TABLE: a referentially complete dataset always has
  // at least one shape row, since the real feed's shapes.txt is always
  // populated. Without this, every "pass on a referentially complete
  // dataset"-style test below would trip Gate 1 the moment shapes became
  // required.
  w.writeRow("shapes.txt", { shape_id: "SH1", shape_pt_lat: "32.183985", shape_pt_lon: "34.917554", shape_pt_sequence: "1" });
  w.writeRow("shapes.txt", { shape_id: "SH1", shape_pt_lat: "31.869152", shape_pt_lon: "34.819641", shape_pt_sequence: "2" });
  return w;
}

/** Minimal but referentially complete dataset. */
function seed(db: ReturnType<typeof newDb>): void {
  seedWriter(db).finish();
}

test("sanity gates pass on a referentially complete dataset", () => {
  const db = newDb();
  seed(db);
  createIndexes(db);
  const report = runSanityGates(db, null);
  assert.deepEqual(report.failures, []);
  assert.ok(report.ok);
  assert.equal(report.counts.stop_times, 2);
  db.close();
});

test("sanity gates catch an orphaned stop_times row", () => {
  const db = newDb();
  seed(db);
  db.prepare("INSERT INTO stop_times (trip_ref, stop_ref, stop_sequence) VALUES (999, 999, 1)").run();
  createIndexes(db);
  const report = runSanityGates(db, null);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => /orphan/i.test(f)), report.failures.join("; "));
  db.close();
});

test("sanity gates catch a duplicate (trip_ref, stop_sequence)", () => {
  const db = newDb();
  seed(db);
  db.prepare(
    "INSERT INTO stop_times (trip_ref, stop_ref, stop_sequence) SELECT trip_ref, stop_ref, stop_sequence FROM stop_times LIMIT 1",
  ).run();
  createIndexes(db);
  const report = runSanityGates(db, null);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => /unique|duplicate/i.test(f)));
  db.close();
});

test("sanity gates catch an empty required table", () => {
  const db = newDb();
  seed(db);
  db.prepare("DELETE FROM routes").run();
  createIndexes(db);
  const report = runSanityGates(db, null);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => /routes/.test(f) && /empty/i.test(f)));
  db.close();
});

test("sanity gates catch a collapse against the previous run", () => {
  const db = newDb();
  seed(db);
  createIndexes(db);
  const report = runSanityGates(db, { stop_times: 1000 });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => /stop_times/.test(f)));
  db.close();
});

test("sanity gates catch an all-empty shapes table (Important-1: shapes is required)", () => {
  const db = newDb();
  seed(db);
  db.prepare("DELETE FROM shapes").run();
  createIndexes(db);
  // previousCounts is null (cold start), so Gate 2 can't help here — this is
  // exactly the scenario a fresh deploy or a wiped history hits, and it must
  // be caught by Gate 1 alone.
  const report = runSanityGates(db, null);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((f) => /shapes/.test(f) && /empty/i.test(f)),
    report.failures.join("; "),
  );
  db.close();
});

test("ratio gate does not flag a table with no baseline in previousCounts", () => {
  const db = newDb();
  seed(db);
  createIndexes(db);
  // previousCounts mentions only "agency" — as if a caller's persisted
  // history predates stop_times being tracked, or this is the very first
  // comparison point recorded. stop_times has no baseline to compare
  // against, so it must not be flagged just because it's absent from the
  // map — only Gate 2's absence-of-baseline branch can produce this.
  const report = runSanityGates(db, { agency: 1 });
  assert.equal(report.ok, true, report.failures.join("; "));
});

test("ratio gate does not flag growth from a legitimately-empty table", () => {
  const db = newDb();
  seed(db);
  // translations is legitimately 0 in the seeded dataset (no
  // translations.txt rows written). Populate it now, so this run's count
  // goes from a previous baseline of 0 to a positive number — division by
  // zero would occur here if the prev===0 branch didn't short-circuit first,
  // and growth from empty must not itself be treated as a collapse.
  db.prepare("INSERT INTO translations (trans_id, lang, translation) VALUES ('x', 'he', 'y')").run();
  createIndexes(db);
  const report = runSanityGates(db, { translations: 0, stop_times: 2 });
  assert.equal(report.ok, true, report.failures.join("; "));
});

test("sanity gates pass when nonContiguousShapeIds is empty", () => {
  const db = newDb();
  seed(db);
  createIndexes(db);
  const report = runSanityGates(db, null, { nonContiguousShapeIds: [] });
  assert.deepEqual(report.failures, []);
  assert.ok(report.ok);
  db.close();
});

test("sanity gates catch a non-contiguous shape_id reported by the writer", () => {
  const db = newDb();
  const w = seedWriter(db);
  // X1/X2 are deliberately distinct from seedWriter's own "SH1" baseline
  // shape, so this test's outcome doesn't depend on how that baseline is
  // written. X1's group is flushed as soon as a differing shape_id (X2) is
  // seen; X1 then reappears, so the writer discards the second run and
  // reports it.
  w.writeRow("shapes.txt", { shape_id: "X1", shape_pt_lat: "32.0", shape_pt_lon: "34.9", shape_pt_sequence: "1" });
  w.writeRow("shapes.txt", { shape_id: "X1", shape_pt_lat: "32.01", shape_pt_lon: "34.91", shape_pt_sequence: "2" });
  w.writeRow("shapes.txt", { shape_id: "X2", shape_pt_lat: "32.1", shape_pt_lon: "34.8", shape_pt_sequence: "1" });
  w.writeRow("shapes.txt", { shape_id: "X1", shape_pt_lat: "32.2", shape_pt_lon: "34.95", shape_pt_sequence: "3" });
  w.finish();
  const nonContiguous = w.nonContiguousShapeIds();
  assert.deepEqual(nonContiguous, ["X1"]);

  createIndexes(db);
  const report = runSanityGates(db, null, { nonContiguousShapeIds: nonContiguous });
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((f) => /X1/.test(f) && /(non-contiguous|shape)/i.test(f)),
    report.failures.join("; "),
  );
  // This gate must be the only one that fired: the rest of the dataset is
  // referentially complete (including a non-empty `shapes` table from
  // seedWriter's baseline "SH1" shape), so no orphan/duplicate/empty-table
  // failure should be mixed in here.
  assert.equal(report.failures.length, 1, report.failures.join("; "));
  db.close();
});

test("R*Tree answers a proximity query", () => {
  const db = newDb();
  seed(db);
  buildDerived(db);
  const near = db.prepare(`
    SELECT s.stop_id FROM stops_rtree r
    JOIN stops s ON s.stop_ref = r.stop_ref
    WHERE r.min_lat <= ? AND r.max_lat >= ? AND r.min_lon <= ? AND r.max_lon >= ?
  `).all(32.19, 32.17, 34.93, 34.90) as { stop_id: string }[];
  assert.deepEqual(near.map((r) => r.stop_id), ["1"]);
  db.close();
});

test("FTS5 finds a Hebrew stop by name, and does not match unrelated text", () => {
  const db = newDb();
  seed(db);
  buildDerived(db);
  const hits = db.prepare(
    "SELECT stop_ref FROM stops_fts WHERE stops_fts MATCH ?",
  ).all("הרצל") as { stop_ref: number }[];
  assert.equal(hits.length, 1);

  // Negative control: unicode61 tokenizes on the '/' separator and on
  // whitespace, so a substring/prefix that isn't itself a token, and a word
  // that doesn't appear in either stop name, must both miss. Without this,
  // a MATCH that (bogusly) returned every row would still pass the positive
  // assertion above.
  const prefixOnly = db.prepare(
    "SELECT stop_ref FROM stops_fts WHERE stops_fts MATCH ?",
  ).all("הר") as { stop_ref: number }[];
  assert.equal(prefixOnly.length, 0);

  const unrelated = db.prepare(
    "SELECT stop_ref FROM stops_fts WHERE stops_fts MATCH ?",
  ).all("רכבת") as { stop_ref: number }[];
  assert.equal(unrelated.length, 0);
  db.close();
});

test("finalizeForRead switches the database to WAL", () => {
  const db = newDb();
  seed(db);
  createIndexes(db);
  finalizeForRead(db);
  assert.equal(String(db.pragma("journal_mode", { simple: true })).toLowerCase(), "wal");
  db.close();
});

test("finalizeForRead fully checkpoints so the main file alone holds every committed row, even with a reader connection open", () => {
  // better-sqlite3's automatic WAL checkpoint on close() only runs when the
  // closing connection is the LAST connection to the database — opening the
  // live database concurrently to read feed_meta is exactly this scenario.
  // Open a reader, switch to WAL, commit one more row, finalize, close the
  // writer while the reader stays open, then copy ONLY the main .sqlite
  // file (no -wal/-shm) and check every committed row survived.
  const path = newPath();
  const db = newDb(path);
  seed(db);
  createIndexes(db);

  db.pragma("journal_mode = WAL");
  const reader = openReadDb(path);
  assert.equal((reader.prepare("SELECT COUNT(*) n FROM stop_times").get() as { n: number }).n, 2);

  // A write that lands after the switch to WAL — analogous to whatever the
  // last committed batch of a real run looks like.
  db.prepare(
    "INSERT INTO stop_times (trip_ref, stop_ref, stop_sequence, arrival_time, departure_time, pickup_type, drop_off_type, shape_dist_traveled) VALUES (1, 1, 3, 2000, 2000, 0, 0, 0)",
  ).run();

  finalizeForRead(db);
  db.close(); // reader is still open here — the designed concurrent-reader scenario.

  assert.ok(existsSync(`${path}-wal`), "expected a -wal sidecar to exist");

  const copyPath = join(mkdtempSync(join(tmpdir(), "gtfs-")), "copy.sqlite");
  copyFileSync(path, copyPath); // naive publish step: copies ONLY the main file.
  const copyDb = openReadDb(copyPath);
  assert.equal(
    (copyDb.prepare("SELECT COUNT(*) n FROM stop_times").get() as { n: number }).n,
    3,
    "the main-file-only copy is missing a row that was committed before finalizeForRead ran — the checkpoint did not fully persist it",
  );
  copyDb.close();
  reader.close();
});

test("finalizeForRead throws rather than silently accepting a partial checkpoint", () => {
  // Forces the specific busy/blocked path: a reader holding an explicit,
  // uncommitted read transaction pins a WAL snapshot, so
  // wal_checkpoint(TRUNCATE) cannot complete. SQLite reports this as
  // { busy: 1, checkpointed: 0, log: 1 } without throwing — finalizeForRead
  // must be the one to turn that into a hard failure instead of silently
  // returning as if the database were safely self-contained.
  const path = newPath();
  const db = newDb(path);
  seed(db);
  createIndexes(db);
  db.pragma("journal_mode = WAL");

  const reader = openReadDb(path);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) n FROM stop_times").get();

  db.prepare(
    "INSERT INTO stop_times (trip_ref, stop_ref, stop_sequence, arrival_time, departure_time, pickup_type, drop_off_type, shape_dist_traveled) VALUES (1, 1, 3, 2000, 2000, 0, 0, 0)",
  ).run();

  assert.throws(() => finalizeForRead(db), /checkpoint/i);

  reader.exec("COMMIT");
  reader.close();
  db.close();
});

/**
 * The six indexes are the product contract with the route-builder app: they
 * are what make "departures from this stop" and "stops on this trip" cheap
 * over ~10.4M stop_times rows. Nothing asserted they existed, so an empty
 * `createIndexes` body would have passed the entire suite while every query
 * downstream silently degraded to a full table scan — a performance
 * regression, never a test failure.
 */
test("createIndexes creates exactly the six indexes downstream queries rely on", () => {
  const db = newDb();
  seedWriter(db).finish();
  createIndexes(db);

  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix_%' ORDER BY name",
  ).all() as { name: string }[]).map((r) => r.name);

  assert.deepEqual(names, [
    "ix_routes_agency",
    "ix_stop_times_stop_dep",
    "ix_stop_times_trip_seq",
    "ix_stops_code",
    "ix_trips_route",
    "ix_trips_service",
  ]);
  db.close();
});

test("the stop_times indexes cover the two shapes of lookup the app makes", () => {
  // Names alone would survive an index being redefined over the wrong
  // columns, so pin the column lists too — and prove the planner actually
  // reaches for them rather than scanning.
  const db = newDb();
  seedWriter(db).finish();
  createIndexes(db);

  const columnsOf = (index: string): string[] =>
    (db.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[])
      .map((r) => r.name);

  assert.deepEqual(columnsOf("ix_stop_times_stop_dep"), ["stop_ref", "departure_time"]);
  assert.deepEqual(columnsOf("ix_stop_times_trip_seq"), ["trip_ref", "stop_sequence"]);

  const plan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM stop_times WHERE stop_ref = 1 ORDER BY departure_time",
  ).all() as { detail: string }[];
  assert.match(
    plan.map((r) => r.detail).join(" "),
    /ix_stop_times_stop_dep/,
    "the departures-from-a-stop query must use its index, not scan 10M rows",
  );
  db.close();
});
