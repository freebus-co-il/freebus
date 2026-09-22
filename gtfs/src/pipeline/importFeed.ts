import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fetchFeed, type FeedVersion } from "../feed/client.js";
import { zipEntries } from "../feed/zip.js";
import { csvRows } from "../feed/csv.js";
import { SKIPPED_FILES, specForFile } from "../gtfs/tables.js";
import { openBuildDb, openReadDb } from "../db/open.js";
import { FeedWriter } from "../db/writer.js";
import {
  buildDerived, createIndexes, finalizeForRead, runSanityGates,
} from "../db/finalize.js";
import {
  buildPathFor, buildingPathFor, gcVersions, resolveLive, sweepStaleBuilds,
  swapIn,
} from "../db/swap.js";

export type ImportOutcome =
  | { status: "unchanged" }
  | {
      status: "imported";
      version: string;
      counts: Record<string, number>;
      badRows: number;
      durationMs: number;
    }
  | { status: "rejected"; failures: string[] };

/** The persisted state of the live database, for reporting by ops endpoints. */
export interface LiveStatus {
  version: string;
  fetchedAt: string | null;
  sourceUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  counts: Record<string, number> | null;
  badRows: number | null;
  /** Resolved path of the version file the live symlink currently points at. */
  path: string;
}

/**
 * `/status`'s live-database report. Exactly one of `live`/`liveError` is
 * non-null (both null is the legitimate cold-start case: no database has
 * ever been published, and there is nothing to report and nothing wrong).
 *
 * Collapsing "nothing published yet" and "something was published but is
 * now missing/corrupt" into the same `live: null` would make `/status`
 * actively misleading during an incident: the former means "working as
 * designed, wait for the first import," the latter means "a database that
 * used to be live is gone or broken — investigate now." `liveError` is how
 * an operator (or a monitoring check) tells those apart.
 */
export interface LiveState {
  live: LiveStatus | null;
  /**
   * Null on a genuine cold start (no live symlink at all) or when `live`
   * is populated. Non-null only when a live symlink exists but its target
   * could not be read — e.g. missing (post-GC race, mid-swap), or open
   * but not a valid GTFS database. A short, safe-to-expose reason, never
   * a raw stack trace or full error object.
   */
  liveError: string | null;
}

/** Reduces a caught error to a short, non-sensitive reason string. */
function shortReason(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message.slice(0, 120);
  }
  return "unknown error";
}

/**
 * Reads the full persisted state of the live database — the counterpart to
 * readFeedMeta (which only surfaces what importFeed itself needs for its
 * next conditional request). This is for reporting: `/status` needs to
 * show an operator what is actually live on disk, independent of any
 * in-process run history, which is lost on every restart.
 *
 * Never throws, whatever state the filesystem is in — this backs an ops
 * endpoint that must stay useful (never 500) precisely when something is
 * already wrong. See LiveState's doc comment for how cold-start and
 * broken-live are distinguished in the result.
 */
export function readLiveState(dataDir: string): LiveState {
  const live = resolveLive(dataDir);
  if (!live) return { live: null, liveError: null }; // cold start: no symlink at all

  try {
    const db = openReadDb(live);
    try {
      const rows = db.prepare("SELECT key, value FROM feed_meta").all() as {
        key: string; value: string;
      }[];
      const meta = new Map(rows.map((r) => [r.key, r.value]));
      const version = meta.get("version");
      if (!version) {
        return { live: null, liveError: "feed_meta is missing its version key" };
      }
      return {
        live: {
          version,
          fetchedAt: meta.get("fetched_at") || null,
          sourceUrl: meta.get("source_url") || null,
          etag: meta.get("etag") || null,
          lastModified: meta.get("last_modified") || null,
          counts: meta.has("counts")
            ? (JSON.parse(meta.get("counts")!) as Record<string, number>)
            : null,
          badRows: meta.has("bad_rows") ? Number(meta.get("bad_rows")) : null,
          path: live,
        },
        liveError: null,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    // The symlink exists but its target couldn't be opened/read as a GTFS
    // database — missing file, permission error, or a corrupt/mid-swap
    // file. That is meaningfully different from "nothing published yet."
    return { live: null, liveError: `unreadable: ${shortReason(err)}` };
  }
}

export interface ImportOptions {
  url: string;
  dataDir: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
  keepVersions?: number;
  maxBadRowRatio?: number;
  /** Idle timeout for the download; see fetchFeed. */
  stallTimeoutMs?: number;
  /** Non-fatal warnings (e.g. an unreadable live database). */
  onWarn?: (message: string) => void;
}

/** Removes a build database and its WAL sidecars, if present. */
function cleanupBuild(buildPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(buildPath + suffix, { force: true });
  }
}

/**
 * Reads the previous run's feed version and row counts from the live database.
 *
 * `onWarn` is called when the live database exists but cannot be read. That
 * case is not cosmetic: this function's `counts` is the *only* baseline
 * Gate 2 (row counts within 50–200% of the previous run) has, and returning
 * `counts: null` turns that gate off for the run. Silently. A corrupt live
 * database would therefore cost the next import its ratio check with no
 * trace anywhere — the very run most likely to need it. The failure is
 * still non-fatal (a cold-start-shaped import is better than no import), but
 * it must be audible.
 */
export function readFeedMeta(
  dataDir: string,
  onWarn: (message: string) => void = (m) => console.warn(m),
): {
  version: FeedVersion | null;
  counts: Record<string, number> | null;
} {
  const live = resolveLive(dataDir);
  if (!live) return { version: null, counts: null };
  let db;
  try {
    // db.close() lives in a `finally`, matching readLiveState. Without it a
    // throw anywhere between open and close leaks the SQLite handle for the
    // process's lifetime — and this runs once per import, on a service whose
    // whole job is to run forever.
    db = openReadDb(live);
    const rows = db.prepare("SELECT key, value FROM feed_meta").all() as {
      key: string; value: string;
    }[];
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    return {
      version: {
        // Empty string means "absent" — a first-ever run persists "" for
        // both fields, and treating that as truthy would send an empty
        // If-None-Match on the next attempt, which some servers answer
        // with 304, leaving the service without a database while its logs
        // claim success.
        etag: meta.get("etag") || null,
        lastModified: meta.get("last_modified") || null,
      },
      counts: meta.has("counts")
        ? (JSON.parse(meta.get("counts")!) as Record<string, number>)
        : null,
    };
  } catch (err) {
    onWarn(
      `could not read feed_meta from the live database at ${live}: `
      + `${shortReason(err)} — this run has no baseline row counts, so the `
      + "count-ratio sanity gate will not be applied",
    );
    return { version: null, counts: null };
  } finally {
    try { db?.close(); } catch { /* never opened, or already closed */ }
  }
}

/**
 * Whether a run should be kicked off at process start, and why.
 *
 * A run is kicked off at process start when the live database is missing
 * **or older than a configurable staleness threshold**. This guards against
 * a service that was down across its 03:00 window coming back up and
 * serving day-old (or older) data until the next night, reporting healthy
 * the whole time.
 *
 * Returns a human-readable reason, or null when the live database is fresh
 * enough to wait for the next scheduled tick.
 */
export function startupImportReason(
  state: LiveState,
  now: Date,
  maxAgeMs: number,
): string | null {
  if (state.liveError) return `live database is unreadable (${state.liveError})`;
  if (!state.live) return "no live database found";

  const fetchedAt = state.live.fetchedAt;
  if (!fetchedAt) return "live database records no fetch time";
  const fetchedMs = Date.parse(fetchedAt);
  // An unparseable timestamp is treated as stale rather than fresh: the
  // failure mode of importing unnecessarily is one wasted run, and the
  // failure mode of the opposite is serving stale data indefinitely.
  if (!Number.isFinite(fetchedMs)) {
    return `live database records an unparseable fetch time (${fetchedAt})`;
  }

  const ageMs = now.getTime() - fetchedMs;
  if (ageMs > maxAgeMs) {
    return `live database was fetched ${Math.round(ageMs / 60_000)} minutes ago, `
      + `over the ${Math.round(maxAgeMs / 60_000)} minute staleness threshold`;
  }
  return null;
}

/** Filesystem-safe, lexicographically sortable version stamp. */
function versionStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function importFeed(opts: ImportOptions): Promise<ImportOutcome> {
  const started = Date.now();
  const keepVersions = opts.keepVersions ?? 2;
  const maxBadRowRatio = opts.maxBadRowRatio ?? 0.01;

  mkdirSync(opts.dataDir, { recursive: true });

  // Any *.building file present now is by definition orphaned: this service
  // is the single writer of dataDir and ImportRunner serialises runs within
  // the process, so nothing else can be building right now. Sweeping them
  // here is what keeps a crashed or wedged run from leaking up to 666 MB
  // per incident indefinitely.
  sweepStaleBuilds(opts.dataDir);

  const previous = readFeedMeta(opts.dataDir, opts.onWarn);

  const result = await fetchFeed(opts.url, previous.version, {
    fetchImpl: opts.fetchImpl,
    stallTimeoutMs: opts.stallTimeoutMs,
  });
  if (result.status === "unchanged") return { status: "unchanged" };

  const version = versionStamp(opts.now());
  // Two names, one file. The build is written under `.building` and only
  // renamed to its published `gtfs-<version>.sqlite` name in the instant
  // before the swap. Building directly at the final name made a partial
  // build — from a crash, an OOM, or a SIGTERM mid-run — indistinguishable
  // from a completed version: it matched swap.ts's VERSION_RE, consumed one
  // of the `keep` slots, and could evict a good rollback candidate in favour
  // of a truncated file nobody could tell was truncated. Under the final
  // name, a file's existence is the statement "this version was published".
  const finalPath = buildPathFor(opts.dataDir, version);
  const buildPath = buildingPathFor(opts.dataDir, version);

  // Under a real cron this can't collide (millisecond timestamps), but an
  // injected fixed clock (as this module's own tests use) could produce the
  // same version stamp twice against one dataDir. Checked up front so a
  // collision costs nothing rather than being discovered after a full
  // ~800 MB load — and checked against *any* retained version, not just the
  // live one, because the promotion rename would silently overwrite either.
  // Definite-assignment: both are set by the try below, whose catch always
  // rethrows, so neither is readable while unassigned.
  let db!: ReturnType<typeof openBuildDb>;
  let writer!: FeedWriter;
  try {
    if (existsSync(finalPath)) {
      const existingLive = resolveLive(opts.dataDir);
      const isLive = existingLive && resolve(existingLive) === resolve(finalPath);
      throw new Error(
        `refusing to build version "${version}": ${finalPath} already exists`
        + (isLive ? " and is the live database" : ""),
      );
    }
    cleanupBuild(buildPath);
    db = openBuildDb(buildPath);
    writer = new FeedWriter(db);
  } catch (err) {
    // Everything between fetchFeed returning and the first byte being piped
    // is a window where we hold a live response body that nothing is
    // consuming. A throw here — a version collision, a database that will
    // not open, a writer whose columns do not match the schema — would
    // otherwise abandon the body, and fetch/undici keep an abandoned body's
    // connection open for the life of the process.
    result.body.destroy();
    cleanupBuild(buildPath);
    throw err;
  }
  let totalRows = 0;
  // Set the instant swapIn() returns. Once true, buildPath IS the live
  // database (swapIn's rename is the last, atomic step of publication) —
  // so the catch block below must never delete it again, no matter what
  // runs after the swap and throws. This makes that a structural
  // guarantee rather than one that depends on every future line added
  // after swapIn() remembering not to reach the cleanup path.
  let published = false;
  // Which name the build currently lives under. The promotion rename is the
  // one moment this changes, and the catch below must clean up whichever
  // name is real at the time it runs.
  let currentPath = buildPath;

  try {
    for await (const entry of zipEntries(result.body)) {
      if (SKIPPED_FILES.includes(entry.name) || !specForFile(entry.name)) {
        entry.skip();
        continue;
      }
      for await (const row of csvRows(entry.stream())) {
        writer.writeRow(entry.name, row);
        totalRows++;
      }
    }
    writer.finish();

    // Distinct from the bad-row budget below, and deliberately not folded
    // into it. A row that fails coercion is upstream data noise, which the
    // ratio gate exists to tolerate up to a point; a batch transaction that
    // fails (SQLITE_FULL, SQLITE_IOERR, a corrupt page) is this machine
    // failing, and 5,000 rows vanish per occurrence. Budgeted at the default
    // 1% over ~10.4M rows, ~104,000 rows could be lost to disk errors and
    // the run would still publish — Gate 2's 50–200% band cannot see a 1%
    // dip, and Gate 3 finds no orphans for merely-missing stop_times rows.
    // FeedWriter raises these out of writeRow/finish rather than counting
    // them, so in practice the throw has already happened by the time we get
    // here. This check is the structural half of the guarantee: it makes
    // "an infrastructure failure can never reach the publish path" true of
    // this function on its own, not merely inherited from the writer
    // continuing to throw.
    const flushFailure = writer.flushFailure();
    if (flushFailure) throw flushFailure;

    const badRows = writer.badRows();
    if (totalRows > 0 && badRows / totalRows > maxBadRowRatio) {
      db.close();
      cleanupBuild(buildPath);
      return {
        status: "rejected",
        failures: [
          `bad-row ratio ${(badRows / totalRows).toFixed(4)} exceeds ${maxBadRowRatio}`,
        ],
      };
    }

    createIndexes(db);
    buildDerived(db);

    // nonContiguousShapeIds comes from *this* writer instance — the writer is
    // the only place a shapes.txt group reappearing after its flush is ever
    // visible; nothing queryable in the database itself reveals it.
    const report = runSanityGates(db, previous.counts, {
      nonContiguousShapeIds: writer.nonContiguousShapeIds(),
    });
    if (!report.ok) {
      db.close();
      cleanupBuild(buildPath);
      return { status: "rejected", failures: report.failures };
    }

    const setMeta = db.prepare(
      "INSERT OR REPLACE INTO feed_meta (key, value) VALUES (?, ?)",
    );
    setMeta.run("etag", result.version.etag ?? "");
    setMeta.run("last_modified", result.version.lastModified ?? "");
    setMeta.run("version", version);
    setMeta.run("source_url", opts.url);
    setMeta.run("fetched_at", opts.now().toISOString());
    setMeta.run("counts", JSON.stringify(report.counts));
    setMeta.run("bad_rows", String(badRows));

    // finalizeForRead runs on this single connection to the build database;
    // no other connection is ever opened against it (readFeedMeta only ever
    // opens the *previous*, already-finalized live database, and only
    // before this connection exists) — the concurrent-opener scenario
    // finalizeForRead guards against must never apply to the build file
    // itself, or its WAL checkpoint would spuriously fail.
    finalizeForRead(db);
    db.close();

    // Promotion: the build is complete, gated and self-contained, so it may
    // now take the name that means "published version". Re-checked rather
    // than trusting the up-front check, because renameSync overwrites
    // silently and the cost of being wrong is destroying a retained version
    // (or the live database) with no error.
    if (existsSync(finalPath)) {
      throw new Error(
        `refusing to promote version "${version}": ${finalPath} appeared during the run`,
      );
    }
    renameSync(buildPath, finalPath);
    currentPath = finalPath;

    swapIn(opts.dataDir, finalPath);
    published = true;

    // gcVersions runs after the swap has already committed: the import has
    // already succeeded and buildPath is now the live database. A failure
    // here (e.g. a permission error removing an old version) must never
    // propagate to the catch block below — that cleanupBuild(buildPath)
    // exists to delete a build that failed *before* publication, and would
    // otherwise delete the file the live symlink now points to, turning a
    // successful import into data loss. Garbage collection is a nicety, not
    // part of the publish contract. (`published` above is the structural
    // guarantee; this inner try/catch just avoids failing the call over a
    // non-fatal cleanup nicety.)
    try {
      gcVersions(opts.dataDir, keepVersions);
    } catch {
      /* old versions may leak until the next successful run's GC; the
       * just-published database is unaffected. */
    }

    return {
      status: "imported",
      version,
      counts: report.counts,
      badRows,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    try { db.close(); } catch { /* already closed, or never fully opened */ }
    // Release the response body's socket. Once iteration has begun, zip.ts's
    // `pipeline` already tears the body down when the consumer breaks out,
    // so in the common case this is a second, harmless destroy. It is here
    // for the paths where that is not true — a throw before the first
    // `for await` iteration, or any future step added between the fetch and
    // the loop — because an abandoned fetch body holds its connection open
    // until the process exits (undici does not release it on garbage
    // collection), and this service is meant to run for months.
    result.body.destroy();
    // Once published, currentPath is the live database (swapIn's rename is
    // atomic and is its last step) — deleting it here on some later,
    // unrelated throw (a log call, a metrics emit, anything added after
    // swapIn in the future) would destroy data a successful run already
    // committed. Only a build that failed *before* publication may be
    // cleaned up.
    if (!published) cleanupBuild(currentPath);
    throw err;
  }
}
