import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb, resolveLiveTarget } from "./connect.js";

const newDir = () => mkdtempSync(join(tmpdir(), "transit-db-"));

test("opens the database through the symlink and reads feed_meta", () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const handle = openTransitDb(dir);
  assert.equal(handle.version, "2026-08-21T16-10-22-006Z");
  assert.equal(handle.counts.stops, 4);
  assert.match(handle.target, /^gtfs-.*\.sqlite$/);
  handle.close();
});

test("the connection is read-only", () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const handle = openTransitDb(dir);
  assert.throws(
    () => handle.db.exec("DELETE FROM stops"),
    /readonly|SQLITE_READONLY/i,
  );
  handle.close();
});

// The fetcher publishes a new version by repointing the symlink. A consumer
// must resolve it at connect time, not once at process start — an open handle
// keeps serving the old inode forever.
test("resolveLiveTarget follows a repointed symlink", () => {
  const dir = newDir();
  buildFixtureDb(dir);
  const before = resolveLiveTarget(dir);
  unlinkSync(join(dir, "gtfs.sqlite"));
  symlinkSync("gtfs-9999.sqlite", join(dir, "gtfs.sqlite"));
  assert.notEqual(resolveLiveTarget(dir), before);
  assert.equal(resolveLiveTarget(dir), "gtfs-9999.sqlite");
});

test("a missing symlink throws a message naming the directory", () => {
  const dir = newDir();
  assert.throws(() => openTransitDb(dir), new RegExp(dir));
});
