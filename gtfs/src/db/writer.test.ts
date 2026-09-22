import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBuildDb } from "./open.js";
import { FeedWriter, WriterFailure } from "./writer.js";
import { decodePolyline } from "../gtfs/polyline.js";

const newDb = () => openBuildDb(join(mkdtempSync(join(tmpdir(), "gtfs-")), "b.sqlite"));

// Uses two trips and two stops whose ref sequences diverge (trip_ref goes
// 1,1,2 while stop_ref goes 1,2,1) rather than a single trip/stop pair,
// where both refs would trivially both be 1. With only one pair, swapping
// trip_ref and stop_ref at the insert site (writer.ts's #writeStopTime)
// would leave this test green; with divergent sequences a swap either
// breaks the join (a ref value that doesn't exist on the other side) or
// pairs a stop_time row with the wrong trip/stop.
test("interns trip and stop ids consistently across files, even with divergent ref sequences", () => {
  const db = newDb();
  const w = new FeedWriter(db);
  // stop_times arrives first, as in the real archive.
  w.writeRow("stop_times.txt", {
    trip_id: "T1", stop_id: "S1", stop_sequence: "1",
    arrival_time: "05:10:00", departure_time: "05:10:00",
    pickup_type: "0", drop_off_type: "1", shape_dist_traveled: "0",
  });
  w.writeRow("stop_times.txt", {
    trip_id: "T1", stop_id: "S2", stop_sequence: "2", // trip reused, stop new
    arrival_time: "05:20:00", departure_time: "05:20:00",
    pickup_type: "0", drop_off_type: "1", shape_dist_traveled: "0",
  });
  w.writeRow("stop_times.txt", {
    trip_id: "T2", stop_id: "S1", stop_sequence: "3", // trip new, stop reused
    arrival_time: "06:00:00", departure_time: "06:00:00",
    pickup_type: "0", drop_off_type: "1", shape_dist_traveled: "0",
  });
  w.writeRow("stops.txt", {
    stop_id: "S1", stop_code: "38831", stop_name: "בי''ס בר לב",
    stop_desc: "", stop_lat: "32.183985", stop_lon: "34.917554",
    location_type: "0", parent_station: "", zone_id: "38831",
  });
  w.writeRow("stops.txt", {
    stop_id: "S2", stop_code: "38832", stop_name: "תחנה שנייה",
    stop_desc: "", stop_lat: "32.184000", stop_lon: "34.917600",
    location_type: "0", parent_station: "", zone_id: "38831",
  });
  w.writeRow("trips.txt", {
    trip_id: "T1", route_id: "R1", service_id: "S1", trip_headsign: "910",
    direction_id: "0", shape_id: "SH1", wheelchair_accessible: "1",
  });
  w.writeRow("trips.txt", {
    trip_id: "T2", route_id: "R2", service_id: "S2", trip_headsign: "911",
    direction_id: "0", shape_id: "SH2", wheelchair_accessible: "1",
  });
  w.finish();

  const rows = db.prepare(`
    SELECT t.trip_id, s.stop_id, st.arrival_time
    FROM stop_times st
    JOIN stops s ON s.stop_ref = st.stop_ref
    JOIN trips t ON t.trip_ref = st.trip_ref
    ORDER BY st.stop_sequence
  `).all() as { trip_id: string; stop_id: string; arrival_time: number }[];

  assert.equal(rows.length, 3, "every stop_time row must join to exactly one trip and one stop");
  assert.deepEqual(rows.map((r) => [r.trip_id, r.stop_id]), [
    ["T1", "S1"],
    ["T1", "S2"],
    ["T2", "S1"],
  ]);
  assert.deepEqual(rows.map((r) => r.arrival_time), [18600, 19200, 21600]);
  db.close();
});

test("folds shape points into one encoded polyline per shape", () => {
  const db = newDb();
  const w = new FeedWriter(db);
  for (const [seq, lat, lon] of [
    [1, 32.164723, 34.848813],
    [2, 32.164738, 34.848972],
    [3, 32.164771, 34.849177],
  ] as const) {
    w.writeRow("shapes.txt", {
      shape_id: "SH1", shape_pt_lat: String(lat),
      shape_pt_lon: String(lon), shape_pt_sequence: String(seq),
    });
  }
  w.finish();

  const r = db.prepare("SELECT * FROM shapes").get() as {
    shape_id: string; encoded_polyline: string;
    point_count: number; total_length_m: number;
  };
  assert.equal(r.shape_id, "SH1");
  assert.equal(r.point_count, 3);
  assert.ok(r.total_length_m > 0);
  const pts = decodePolyline(r.encoded_polyline);
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[0]![0] - 32.164723) < 1e-6);
  db.close();
});

test("orders shape points by sequence even when rows arrive shuffled", () => {
  const db = newDb();
  const w = new FeedWriter(db);
  for (const [seq, lat] of [[3, 32.164771], [1, 32.164723], [2, 32.164738]] as const) {
    w.writeRow("shapes.txt", {
      shape_id: "SH1", shape_pt_lat: String(lat),
      shape_pt_lon: "34.848813", shape_pt_sequence: String(seq),
    });
  }
  w.finish();
  const pts = decodePolyline(
    (db.prepare("SELECT encoded_polyline p FROM shapes").get() as { p: string }).p,
  );
  assert.ok(pts[0]![0] < pts[1]![0] && pts[1]![0] < pts[2]![0]);
  db.close();
});

test("accepts a trip with an empty shape_id", () => {
  const db = newDb();
  const w = new FeedWriter(db);
  w.writeRow("trips.txt", {
    trip_id: "T2", route_id: "R2", service_id: "S2", trip_headsign: "917",
    direction_id: "1", shape_id: "", wheelchair_accessible: "",
  });
  w.finish();
  const r = db.prepare("SELECT shape_id FROM trips").get() as { shape_id: string | null };
  assert.equal(r.shape_id, null);
  db.close();
});

test("counts bad rows without aborting", () => {
  const db = newDb();
  const w = new FeedWriter(db);
  w.writeRow("stop_times.txt", {
    trip_id: "", stop_id: "", stop_sequence: "nope",
    arrival_time: "x", departure_time: "x",
    pickup_type: "", drop_off_type: "", shape_dist_traveled: "",
  });
  w.finish();
  assert.equal(w.badRows(), 1);
  assert.equal(w.rowsQueued().stop_times ?? 0, 0);
  db.close();
});

// --- Risk A: non-contiguous shape_id groups -------------------------------
//
// shapes.txt is grouped by shape_id in practice, but that is an assumption
// about today's feed, not a guarantee. #flushShape fires on shape_id change,
// so if a shape_id ever reappears *after* being flushed — non-contiguous
// grouping — a naive writer queues a second INSERT OR REPLACE row for the
// same primary key. Because the physical write happens in later batched
// transactions, the *second* occurrence's row silently overwrites the
// first's polyline with no error.
//
// Chosen handling: track every shape_id that has completed a flush. If a
// point for that shape_id arrives again, refuse to start a second group for
// it — count every point row belonging to the reappearance as bad, and keep
// the first group's polyline intact. The condition is also exposed
// separately via nonContiguousShapeIds() so a caller (the sanity gates)
// can distinguish "shapes.txt is not grouped, geometry truncated" from
// ordinary per-row noise like unparseable coordinates, instead of it
// disappearing into the same anonymous bad-row counter.
test("a non-contiguous shape_id does not silently overwrite the first group", () => {
  const db = newDb();
  const w = new FeedWriter(db);

  // First SH1 group: two points far south.
  w.writeRow("shapes.txt", {
    shape_id: "SH1", shape_pt_lat: "32.000000", shape_pt_lon: "34.800000", shape_pt_sequence: "1",
  });
  w.writeRow("shapes.txt", {
    shape_id: "SH1", shape_pt_lat: "32.000100", shape_pt_lon: "34.800100", shape_pt_sequence: "2",
  });
  // A different shape forces SH1's group to flush.
  w.writeRow("shapes.txt", {
    shape_id: "SH2", shape_pt_lat: "33.000000", shape_pt_lon: "35.000000", shape_pt_sequence: "1",
  });
  // SH1 reappears (non-contiguous) with different, bogus coordinates. This
  // must NOT land in the shapes table and overwrite the first group.
  w.writeRow("shapes.txt", {
    shape_id: "SH1", shape_pt_lat: "0.000000", shape_pt_lon: "0.000000", shape_pt_sequence: "1",
  });
  w.writeRow("shapes.txt", {
    shape_id: "SH1", shape_pt_lat: "0.000100", shape_pt_lon: "0.000100", shape_pt_sequence: "2",
  });
  w.finish();

  const rows = db.prepare("SELECT shape_id, encoded_polyline FROM shapes ORDER BY shape_id")
    .all() as { shape_id: string; encoded_polyline: string }[];
  assert.equal(rows.length, 2, "exactly one row per distinct shape_id, no duplicate PK writes");

  const sh1 = rows.find((r) => r.shape_id === "SH1")!;
  const pts = decodePolyline(sh1.encoded_polyline);
  assert.ok(
    Math.abs(pts[0]![0] - 32.0) < 1e-4,
    "SH1's stored polyline must be the FIRST group's geometry, not the reappearance's",
  );

  assert.equal(w.badRows(), 2, "both points of the reappeared SH1 group are counted as bad");
  assert.deepEqual(
    w.nonContiguousShapeIds(), ["SH1"],
    "the reappearing shape_id must be reported separately so a caller can fail the run loudly",
  );
  db.close();
});

// --- Risk B: batch-boundary correctness -----------------------------------
//
// #flushTable fires when a table's pending buffer reaches batchSize. Nothing
// in the brief's tests ever exercises more than one batch, so a bug where a
// batch reset drops a partial trailing batch, or double-counts a flushed
// batch, would only show up at the scale of the real feed (~10.4M rows) —
// impossible to diagnose there. Use a tiny batchSize and cross it multiple
// times, including a non-full trailing batch.
test("every row lands and rowsQueued stays accurate across multiple batch flushes", () => {
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 3 });

  const total = 7; // 3 + 3 + 1: two full batches plus a partial trailing batch
  for (let i = 0; i < total; i++) {
    w.writeRow("agency.txt", {
      agency_id: String(i), agency_name: `Agency ${i}`, agency_url: "http://x",
      agency_timezone: "Asia/Jerusalem", agency_lang: "he",
      agency_phone: "", agency_fare_url: "",
    });
  }
  w.finish();

  const rowCount = (db.prepare("SELECT COUNT(*) c FROM agency").get() as { c: number }).c;
  assert.equal(rowCount, total, "every row must land in the table, including the partial batch");
  assert.equal(w.rowsQueued().agency, total, "rowsQueued() must match the actual row count exactly");
  db.close();
});

// The batch test above only exercises the generic (default-path) insert.
// stop_times is the table batching exists for — 10.4M rows, plus the
// interning path — so it needs its own batch-boundary coverage rather than
// relying on the generic-path test to stand in for it.
test("batches stop_times across multiple flushes without losing interned rows", () => {
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 3 });

  const total = 7;
  for (let i = 0; i < total; i++) {
    w.writeRow("stop_times.txt", {
      trip_id: `T${i}`, stop_id: `S${i}`, stop_sequence: "1",
      arrival_time: "05:10:00", departure_time: "05:10:00",
      pickup_type: "0", drop_off_type: "0", shape_dist_traveled: "0",
    });
  }
  w.finish();

  const rowCount = (db.prepare("SELECT COUNT(*) c FROM stop_times").get() as { c: number }).c;
  assert.equal(rowCount, total, "every interned stop_times row must land, across multiple batches");
  assert.equal(w.rowsQueued().stop_times, total);
  db.close();
});

// --- A failed flush must not poison the buffer -------------
//
// #flushTable clears the buffer (buf.length = 0) in a `finally`, not only
// after a successful transaction. If the transaction throws (e.g. a NOT NULL
// constraint violation on one row in the batch), the whole batch is rolled
// back by better-sqlite3; without unconditionally clearing the buffer, the
// next writeRow call would push onto an already-full buffer, which
// immediately re-triggers a flush attempt (since length >= batchSize), which
// fails again, forever — the buffer would grow without bound and every
// subsequent row for that table would be lost, undercounted as a single bad
// row per call instead of the whole lost batch. On stop_times (10.4M rows)
// that is an OOM; on finish() an uncaught exception would kill the entire
// import after every other table had already been written.
test("a failed flush clears the buffer and counts the whole batch as bad, without aborting the import", () => {
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 2 });

  // translations.lang is NOT NULL; a blank lang violates that constraint at
  // insert time (inside the batched transaction), not at coercion time —
  // parseText legitimately returns null for a blank field.
  w.writeRow("translations.txt", { trans_id: "T1", lang: "en", translation: "hello" });
  w.writeRow("translations.txt", { trans_id: "T2", lang: "", translation: "bad" }); // flush #1 (batchSize=2) — fails
  w.writeRow("translations.txt", { trans_id: "T3", lang: "en", translation: "world" });
  w.writeRow("translations.txt", { trans_id: "T4", lang: "fr", translation: "monde" }); // flush #2 — succeeds

  w.finish(); // must not throw: a failed batch must not abort the rest of the import

  const rowCount = (db.prepare("SELECT COUNT(*) c FROM translations").get() as { c: number }).c;
  // T1 shared a transaction with the constraint-violating T2, so it is
  // rolled back too — an accepted batching trade-off. What must hold is
  // that this is counted correctly and the run continues.
  assert.equal(rowCount, 2, "only the second, all-good batch actually lands");
  assert.equal(w.badRows(), 2, "the whole failed batch (T1 + T2) counts as bad, not just 1");
  assert.equal(w.rowsQueued().translations, 2, "rowsQueued must reflect only the successfully written batch");
  db.close();
});

// A poisoned batch must not leave the buffer oversized for the NEXT table
// that shares the writer either — regression coverage for the buffer
// actually being cleared (not just "happens to look right" from counts
// alone). Cross the batch boundary many times with only bad rows, then
// confirm a subsequent good batch on the same table still flushes at
// exactly batchSize, rather than accumulating across every failed attempt.
test("repeated failed flushes on the same table never accumulate an unbounded buffer", () => {
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 3 });

  // 9 consecutive bad rows (blank lang): three failed batches of 3.
  for (let i = 0; i < 9; i++) {
    w.writeRow("translations.txt", { trans_id: `B${i}`, lang: "", translation: "bad" });
  }
  // A final good batch of exactly batchSize.
  for (let i = 0; i < 3; i++) {
    w.writeRow("translations.txt", { trans_id: `G${i}`, lang: "en", translation: "ok" });
  }
  w.finish();

  assert.equal(w.badRows(), 9, "bad count must equal the actual rows lost, not grow per failed flush attempt");
  const rowCount = (db.prepare("SELECT COUNT(*) c FROM translations").get() as { c: number }).c;
  assert.equal(rowCount, 3, "the trailing good batch must still land cleanly");
  assert.equal(w.rowsQueued().translations, 3);
  db.close();
});

// --- Infrastructure failures are not data noise ----------------------------
//
// Only a CONSTRAINT violation lands in #bad, budgeted identical to a
// malformed CSV row. Treating every flush failure that way would make disk
// or I/O errors *budgeted* too: at the default 1% ratio over ~10.4M rows,
// roughly 104,000 rows could be lost that way and the run would still
// publish. Gate 2's 50–200% band cannot see a 1% dip and Gate 3 finds no
// orphans for stop_times rows that are merely absent, so nothing downstream
// would catch it either.
//
// The discriminator is the SQLite error code. A CONSTRAINT violation is the
// row's fault and stays budgeted (see the two tests above, which still pass
// unchanged); anything else is the machine's fault and fails the run.

test("a failed flush caused by the storage layer raises instead of being counted as bad rows", () => {
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 2 });
  // query_only makes every write fail with SQLITE_READONLY — a stand-in for
  // the SQLITE_FULL / SQLITE_IOERR / corrupt-page family, which cannot be
  // produced on demand but reach this catch by exactly the same route.
  db.pragma("query_only = ON");

  assert.throws(
    () => {
      w.writeRow("translations.txt", { trans_id: "T1", lang: "en", translation: "a" });
      w.writeRow("translations.txt", { trans_id: "T2", lang: "en", translation: "b" });
    },
    (err: unknown) =>
      err instanceof WriterFailure && /infrastructure failure/.test((err as Error).message),
  );

  assert.equal(
    w.badRows(), 0,
    "an I/O failure must never be charged to the bad-row budget",
  );
  assert.ok(w.flushFailure(), "the failure must be recorded for importFeed to gate on");
  db.close();
});

test("a raised flush failure still empties the buffer, not just a counted one", () => {
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 2 });
  db.pragma("query_only = ON");

  // Keep writing past the failure, as a caller that swallowed the throw
  // would. Without the `finally` that clears the buffer, each new row would
  // push onto an already-full buffer and re-trigger a flush immediately —
  // unbounded growth over a 10.4M-row table.
  let flushAttempts = 0;
  for (let i = 0; i < 20; i++) {
    try {
      w.writeRow("translations.txt", { trans_id: `T${i}`, lang: "en", translation: "x" });
    } catch {
      flushAttempts++;
    }
  }
  // One attempt per full batch of 2, never more: 20 rows / batchSize 2 = 10.
  assert.equal(
    flushAttempts, 10,
    "a flush must fire once per batch boundary, not once per row past a stuck buffer",
  );
  db.close();
});

// --- Column names are checked against the real schema ----------------------
//
// TABLE_SPECS.columns names CSV *headers*, not DB columns, for stop_times,
// trips and stops: `trip_id`/`stop_id` where the columns are the interned
// `trip_ref`/`stop_ref`. The only thing that stopped those arrays reaching an
// INSERT was a `switch` in writeRow. Deleting a case produced SQL naming
// columns that do not exist — an error the catch-all then reported as bad
// rows, pointing the diagnosis at the upstream feed.

test("a writer refuses to construct against a schema its INSERTs would not fit", () => {
  const db = newDb();
  // Simulate the column drift the check exists to catch: rename the
  // destination column out from under the writer.
  db.exec("ALTER TABLE stop_times RENAME COLUMN trip_ref TO trip_reference");

  assert.throws(
    () => new FeedWriter(db),
    (err: unknown) =>
      err instanceof WriterFailure
      && /stop_times/.test((err as Error).message)
      && /trip_ref/.test((err as Error).message),
    "construction must fail loudly, naming the table and the missing column",
  );
  db.close();
});

test("the hand-written column arrays for the custom tables match the live schema", () => {
  // The positive half of the check above, stated as its own assertion: if
  // schema.ts and writer.ts's STOP_TIME_COLUMNS/TRIP_COLUMNS/STOP_COLUMNS/
  // SHAPE_COLUMNS ever drift, or if the `custom` treatment is dropped so
  // stop_times falls back to its header names, every FeedWriter in the suite
  // stops constructing — starting here.
  const db = newDb();
  assert.doesNotThrow(() => new FeedWriter(db));
  db.close();
});

test("a flush that fails while PREPARING still empties the buffer", () => {
  // The narrow case the previous test cannot reach: db.prepare() succeeds
  // under query_only, so a read-only database only ever fails at execution
  // time, safely inside the try. Dropping the table makes prepare() itself
  // throw instead — confirming that throw is still inside the try/finally
  // that clears the buffer. Were it not, the buffer would stay at or past
  // batchSize forever, so every single subsequent row would re-trigger and
  // re-fail a flush: unbounded growth over a 10.4M-row table.
  const db = newDb();
  const w = new FeedWriter(db, { batchSize: 2 });
  db.exec("DROP TABLE translations");

  let flushAttempts = 0;
  for (let i = 0; i < 20; i++) {
    try {
      w.writeRow("translations.txt", { trans_id: `T${i}`, lang: "en", translation: "x" });
    } catch {
      flushAttempts++;
    }
  }
  assert.equal(
    flushAttempts, 10,
    "one attempt per batch boundary (20/2); more means the buffer was never cleared",
  );
  db.close();
});
