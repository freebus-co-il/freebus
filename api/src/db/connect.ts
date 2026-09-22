import Database from "better-sqlite3";
import { readlinkSync } from "node:fs";
import { join } from "node:path";

export interface DbHandle {
  db: Database.Database;
  /** Absolute path to the resolved versioned file. */
  path: string;
  /** The symlink's target basename, e.g. `gtfs-2026-08-21T....sqlite`. */
  target: string;
  version: string;
  fetchedAt: string;
  counts: Record<string, number>;
  close(): void;
}

const LIVE_LINK = "gtfs.sqlite";

/**
 * Reads the symlink target *every call*. The fetcher publishes a new version
 * by repointing this link; an already-open handle keeps serving the old inode
 * indefinitely, because an open file descriptor does not observe a rename.
 * Callers poll this to detect a swap (see transit/manager.ts).
 */
export function resolveLiveTarget(dataDir: string): string {
  const link = join(dataDir, LIVE_LINK);
  try {
    return readlinkSync(link);
  } catch (err) {
    throw new Error(`No live database symlink at ${link}`, { cause: err });
  }
}

/**
 * Opens an already-resolved database file directly, without re-resolving the
 * live symlink itself.
 *
 * A caller that needs to build more than one thing from "the current live
 * database" — as `IndexManager.rebuild()` does, building both the RAPTOR
 * index and the db-derived `AppBundle` (translator, calendar, route lookups)
 * from what should be the SAME feed version — must resolve the symlink
 * exactly once and pass the resulting path to every builder. Two independent
 * `resolveLiveTarget` calls a few lines apart are not atomic with each other;
 * a swap landing in that gap would let the index and the bundle disagree
 * about which feed version they each serve, which is precisely the
 * inconsistency this function exists to make impossible.
 */
export function openTransitDbAtPath(path: string, target: string): DbHandle {
  const db = new Database(path, { readonly: true, fileMustExist: true });

  const meta = new Map<string, string>();
  for (const row of db.prepare("SELECT key, value FROM feed_meta").iterate() as
       Iterable<{ key: string; value: string }>) {
    meta.set(row.key, row.value);
  }

  let counts: Record<string, number> = {};
  const rawCounts = meta.get("counts");
  if (rawCounts !== undefined) {
    // feed_meta is written by the fetcher, but a truncated or hand-edited
    // value must not take the whole service down at boot — the counts are
    // reporting metadata, not something any query depends on.
    try {
      counts = JSON.parse(rawCounts) as Record<string, number>;
    } catch {
      counts = {};
    }
  }

  return {
    db,
    path,
    target,
    version: meta.get("version") ?? "unknown",
    fetchedAt: meta.get("fetched_at") ?? "unknown",
    counts,
    close: () => db.close(),
  };
}

/**
 * Resolves the live symlink itself, then opens whatever it currently points
 * at. This is the one-shot convenience most callers want; a caller that must
 * keep more than one derived artifact consistent with the same resolved
 * target should call `resolveLiveTarget` once itself and use
 * `openTransitDbAtPath` directly instead (see its own comment).
 */
export function openTransitDb(dataDir: string): DbHandle {
  const target = resolveLiveTarget(dataDir);
  const path = join(dataDir, target);
  return openTransitDbAtPath(path, target);
}
