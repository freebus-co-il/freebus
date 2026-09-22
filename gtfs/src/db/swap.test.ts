import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPathFor, buildingPathFor, livePath, resolveLive, swapIn, gcVersions,
  sweepStaleBuilds,
} from "./swap.js";

const newDir = (): string => mkdtempSync(join(tmpdir(), "gtfs-swap-"));

test("resolveLive returns null before any swap", () => {
  assert.equal(resolveLive(newDir()), null);
});

test("swapIn points the live link at the new version", () => {
  const dir = newDir();
  const built = buildPathFor(dir, "v1");
  writeFileSync(built, "one");
  swapIn(dir, built);
  assert.equal(readFileSync(livePath(dir), "utf8"), "one");
  assert.equal(resolveLive(dir), built);
});

test("swapIn replaces an existing live link atomically", () => {
  const dir = newDir();
  const first = buildPathFor(dir, "v1");
  writeFileSync(first, "one");
  swapIn(dir, first);

  const second = buildPathFor(dir, "v2");
  writeFileSync(second, "two");
  swapIn(dir, second);

  assert.equal(readFileSync(livePath(dir), "utf8"), "two");
  assert.ok(existsSync(first), "previous version must survive for rollback");
});

test("gcVersions keeps the newest N and never removes the live one", () => {
  const dir = newDir();
  for (const v of ["v1", "v2", "v3"]) {
    const p = buildPathFor(dir, v);
    writeFileSync(p, v);
    swapIn(dir, p);
  }
  const removed = gcVersions(dir, 2);
  assert.deepEqual(removed, ["gtfs-v1.sqlite"]);
  const left = readdirSync(dir).filter((f) => f.startsWith("gtfs-")).sort();
  assert.deepEqual(left, ["gtfs-v2.sqlite", "gtfs-v3.sqlite"]);
  assert.equal(readFileSync(livePath(dir), "utf8"), "v3");
});

test("gcVersions removes WAL sidecars alongside their database", () => {
  const dir = newDir();
  for (const v of ["v1", "v2"]) {
    const p = buildPathFor(dir, v);
    writeFileSync(p, v);
    writeFileSync(`${p}-wal`, "");
    writeFileSync(`${p}-shm`, "");
    swapIn(dir, p);
  }
  gcVersions(dir, 1);
  assert.ok(!existsSync(`${buildPathFor(dir, "v1")}-wal`));
  assert.ok(!existsSync(`${buildPathFor(dir, "v1")}-shm`));
});

test("gcVersions protects the live version even when it is not the newest (rollback case)", () => {
  const dir = newDir();
  // Create three versions: v1, v2, v3
  for (const v of ["v1", "v2", "v3"]) {
    const p = buildPathFor(dir, v);
    writeFileSync(p, v);
    swapIn(dir, p);
  }
  // Live should currently point to v3
  assert.equal(resolveLive(dir), buildPathFor(dir, "v3"));

  // Simulate rollback: repoint live symlink to the oldest version (v1)
  const v1Path = buildPathFor(dir, "v1");
  swapIn(dir, v1Path);
  assert.equal(resolveLive(dir), v1Path);

  // Run GC with keep=1 (keep only 1 version)
  // Without protection, this would try to delete v1 and v2, keeping only v3
  // But v1 is live, so it should be protected
  const removed = gcVersions(dir, 1);

  // Assert the live version still exists
  assert.ok(existsSync(v1Path), "live version (v1) must still exist after gc");
  assert.equal(resolveLive(dir), v1Path, "live symlink must still resolve to v1");

  // Assert the actual resulting state:
  // Only v1 (live) and v3 (newest) should remain, v2 should be removed
  // So only 1 file removed (v2), not 2 as keep=1 would suggest
  const remaining = readdirSync(dir).filter((f) => f.startsWith("gtfs-")).sort();
  assert.deepEqual(remaining, ["gtfs-v1.sqlite", "gtfs-v3.sqlite"], "v1 (live) and v3 (newest) should remain, v2 should be removed");
  assert.deepEqual(removed, ["gtfs-v2.sqlite"], "only v2 should be removed");
});

// --- Builds in progress are not versions -----------------------------------
//
// A build is written under `.building` and only takes its final
// `gtfs-<version>.sqlite` name once finalized. Without that distinction, a
// partial build — from a dead socket, an OOM, or a SIGTERM mid-run — would
// match VERSION_RE exactly like a completed one. It would consume a
// retention slot and, being newer than everything else, could push a
// genuinely good rollback candidate off the end of the list, with an
// operator reading `ls` unable to tell the two apart either.

test("buildingPathFor is the version path plus a suffix that VERSION_RE cannot match", () => {
  const dir = newDir();
  assert.equal(buildingPathFor(dir, "v1"), `${buildPathFor(dir, "v1")}.building`);
});

test("gcVersions never counts an in-progress build as a version", () => {
  const dir = newDir();
  for (const v of ["v1", "v2"]) writeFileSync(buildPathFor(dir, v), v);
  swapIn(dir, buildPathFor(dir, "v2"));
  // A build in progress (or abandoned) for a *newer* version than either.
  writeFileSync(buildingPathFor(dir, "v3"), "partial");

  // keep: 2 with two real versions must delete nothing. If the .building
  // file were counted, versions.length would be 3 and v1 — the only rollback
  // target — would be evicted in favour of a truncated file.
  assert.deepEqual(gcVersions(dir, 2), []);
  assert.ok(existsSync(buildPathFor(dir, "v1")), "the rollback candidate must survive");
  assert.ok(existsSync(buildingPathFor(dir, "v3")), "gcVersions must not touch builds");
});

test("sweepStaleBuilds removes abandoned builds and their sidecars, and nothing else", () => {
  const dir = newDir();
  writeFileSync(buildPathFor(dir, "v1"), "published");
  swapIn(dir, buildPathFor(dir, "v1"));
  const orphan = buildingPathFor(dir, "v2");
  writeFileSync(orphan, "partial");
  writeFileSync(`${orphan}-wal`, "wal");
  writeFileSync(`${orphan}-shm`, "shm");

  assert.deepEqual(sweepStaleBuilds(dir), ["gtfs-v2.sqlite.building"]);
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.equal(existsSync(orphan + suffix), false, `orphan${suffix} must be gone`);
  }
  assert.ok(existsSync(buildPathFor(dir, "v1")), "published versions are untouched");
  assert.equal(resolveLive(dir), buildPathFor(dir, "v1"), "the live link is untouched");
});

test("sweepStaleBuilds is a no-op on a directory that does not exist yet", () => {
  assert.deepEqual(sweepStaleBuilds(join(newDir(), "not-created")), []);
});
