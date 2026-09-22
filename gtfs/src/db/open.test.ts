import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBuildDb, openReadDb } from "./open.js";

const tmpDb = (): string =>
  join(mkdtempSync(join(tmpdir(), "gtfs-")), "build.sqlite");

test("creates every expected table", () => {
  const db = openBuildDb(tmpDb());
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: unknown) => (r as { name: string }).name);
  for (const t of [
    "agency", "routes", "stops", "calendar", "trips",
    "stop_times", "shapes", "translations", "feed_meta",
  ]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  db.close();
});

test("applies load-time pragmas", () => {
  const db = openBuildDb(tmpDb());
  assert.equal(String(db.pragma("journal_mode", { simple: true })).toLowerCase(), "memory");
  assert.equal(Number(db.pragma("foreign_keys", { simple: true })), 0);
  db.close();
});

test("stop_times has no declared primary key so bulk inserts stay cheap", () => {
  const db = openBuildDb(tmpDb());
  const info = db.pragma("table_info(stop_times)") as { pk: number }[];
  assert.ok(info.every((c) => c.pk === 0), "stop_times must not declare a PK");
  db.close();
});

test("calendar stores Sunday through Saturday", () => {
  const db = openBuildDb(tmpDb());
  const cols = (db.pragma("table_info(calendar)") as { name: string }[])
    .map((c) => c.name);
  for (const d of ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]) {
    assert.ok(cols.includes(d), `missing ${d}`);
  }
  db.close();
});

test("trips.shape_id is nullable", () => {
  const db = openBuildDb(tmpDb());
  const col = (db.pragma("table_info(trips)") as { name: string; notnull: number }[])
    .find((c) => c.name === "shape_id");
  assert.equal(col?.notnull, 0);
  db.close();
});

test("openReadDb opens read-only and rejects writes", () => {
  const path = tmpDb();
  const buildDb = openBuildDb(path);
  buildDb.close();

  const readDb = openReadDb(path);
  assert.throws(
    () => {
      readDb.exec("INSERT INTO feed_meta (key, value) VALUES ('test', 'value')");
    },
    (err) => {
      return String((err as Error).message).includes("readonly");
    }
  );
  readDb.close();
});

test("openReadDb rejects missing file (via readonly flag)", () => {
  // Note: readonly: true alone is sufficient to reject missing files (SQLITE_OPEN_READONLY
  // has no CREATE flag). The fileMustExist: true is redundant under readonly but is kept
  // to document intent at the call site. This test does not isolate fileMustExist behavior.
  const nonexistentPath = join(tmpdir(), "nonexistent-" + Date.now() + ".sqlite");
  assert.throws(
    () => {
      openReadDb(nonexistentPath);
    }
  );
});
