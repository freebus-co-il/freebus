import {
  existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export const LIVE_LINK_NAME = "gtfs.sqlite";

/**
 * A published version. Anchored at both ends, so a build in progress
 * (`gtfs-<version>.sqlite.building`) deliberately does NOT match: an
 * in-progress or abandoned build is not a version, must never consume one of
 * gcVersions's `keep` slots, and must never be offered as a rollback target.
 */
const VERSION_RE = /^gtfs-(.+)\.sqlite$/;

/** Marks a database that is still being built and has not been published. */
export const BUILDING_SUFFIX = ".building";

export function buildPathFor(dataDir: string, version: string): string {
  return join(dataDir, `gtfs-${version}.sqlite`);
}

/**
 * Where a run writes while it is still building.
 *
 * A build carries this suffix until it has passed every gate and been
 * finalized, then is renamed to `buildPathFor(...)` immediately before the
 * swap. The point is that the final name becomes a *statement*: this file was
 * published. Without the distinction, a build killed halfway — OOM, SIGTERM,
 * a dead socket — left a truncated file that looked exactly like a completed
 * version to gcVersions and to an operator reading `ls`, took up a retention
 * slot, and could push a genuinely good rollback candidate off the end.
 */
export function buildingPathFor(dataDir: string, version: string): string {
  return buildPathFor(dataDir, version) + BUILDING_SUFFIX;
}

export function livePath(dataDir: string): string {
  return join(dataDir, LIVE_LINK_NAME);
}

export function resolveLive(dataDir: string): string | null {
  const link = livePath(dataDir);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return resolve(dataDir, readlinkSync(link));
}

/**
 * Atomically repoints the live symlink at `builtPath`.
 *
 * A symlink is used rather than renaming a database over the live path because
 * WAL sidecars (-wal, -shm) are keyed to the database filename and cannot be
 * swapped atomically alongside it. Each version owns its own sidecars.
 * Readers holding an open handle finish against the old file.
 */
export function swapIn(dataDir: string, builtPath: string): void {
  const link = livePath(dataDir);
  const staging = join(dataDir, `.${LIVE_LINK_NAME}.staging`);
  rmSync(staging, { force: true });
  // Relative target keeps the data directory relocatable.
  symlinkSync(basename(builtPath), staging);
  renameSync(staging, link); // atomic on POSIX within one filesystem
}

/** Removes all but the newest `keep` versions. Never removes the live one. */
export function gcVersions(dataDir: string, keep: number): string[] {
  const live = resolveLive(dataDir);
  const versions = readdirSync(dataDir)
    .filter((f) => VERSION_RE.test(f))
    .sort(); // version strings are lexicographically sortable timestamps

  const doomed = versions.slice(0, Math.max(0, versions.length - keep));
  const removed: string[] = [];

  for (const name of doomed) {
    const full = join(dataDir, name);
    if (live && resolve(full) === resolve(live)) continue;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(full + suffix)) rmSync(full + suffix, { force: true });
    }
    removed.push(name);
  }
  return removed;
}

/**
 * Removes abandoned `*.building` databases and their WAL sidecars.
 *
 * Safe to call unconditionally at the start of a run: this service is the
 * only writer of its data directory, and ImportRunner serialises runs
 * within the process.
 *
 * One caveat: because a run ceiling exists, a run that exceeds it is
 * *abandoned*, not cancelled — the lock is released while the abandoned run
 * may still be writing. So a build CAN be in progress when a new one starts.
 * That case fails safely rather than corrupting anything: the sweep deletes
 * the abandoned `.building` file, and the abandoned run then throws ENOENT at
 * its promotion rename, leaving nothing on disk and never touching the live
 * database. Verified by probe, not assumed.
 *
 * Without this sweep, every crashed or
 * wedged run leaks its partial database — up to 666 MB against the real feed
 * — with nothing that would ever clean it up, since gcVersions correctly
 * refuses to treat these files as versions.
 *
 * Never touches published versions or the live symlink: only names ending in
 * BUILDING_SUFFIX, plus the `-wal`/`-shm` sidecars SQLite derives from them.
 */
export function sweepStaleBuilds(dataDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return []; // no data directory yet; nothing to sweep
  }

  const removed: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(BUILDING_SUFFIX)) continue;
    const full = join(dataDir, name);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(full + suffix)) rmSync(full + suffix, { force: true });
    }
    removed.push(name);
  }
  return removed;
}
