# gtfs

Fastify + TypeScript service that fetches Israel's national GTFS public
transit feed (Israel MOT) on a schedule and loads it into a versioned,
read-only SQLite database for the public-transit route-builder app to query.

It does not serve transit data to end users — it exposes only operational
endpoints (below). A separate application layer reads the SQLite file this
service produces.

## Requirements

Node.js >= 22.

## Setup

```
npm install
cp .env.example .env
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with `tsx watch` (hot reload, pretty logs) |
| `npm run typecheck` | Type check without emitting |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the fixture-backed test suite |
| `npm run test:live` | Run one live test against the real feed (see below) |

## What a run does

On its schedule (or on demand), the service:

1. Sends a conditional `GET` to `GTFS_URL` with `If-None-Match` /
   `If-Modified-Since` from the last successful run. A `304` ends the run
   immediately — no download, no new database file.
2. Streams the returned zip archive (Zip64, ~139 MB compressed / ~800 MB
   uncompressed) directly into a fresh SQLite database under `GTFS_DATA_DIR`,
   without ever writing the archive to disk.
3. Builds indexes, an R\*Tree over stop coordinates, and an FTS5 index over
   stop names.
4. Runs sanity gates (required tables non-empty, row counts within a band of
   the previous run, zero foreign-key orphans, no duplicate
   `(trip_ref, stop_sequence)` pairs, `shapes.txt` grouped correctly). Any
   failure aborts the run and leaves the previous database live — **a failed
   run is always a no-op**. So does any *infrastructure* failure: a batch
   write that fails for a reason other than a constraint violation
   (`SQLITE_FULL`, `SQLITE_IOERR`, a corrupt page) fails the run outright
   rather than being charged to the bad-row budget, which would otherwise let
   ~1% of rows disappear into disk errors and still publish.
5. On success, renames the build to its published `gtfs-<version>.sqlite`
   name, atomically repoints the `gtfs.sqlite` symlink at it, and
   garbage-collects old versions beyond `GTFS_KEEP_VERSIONS`.

A run also happens at process start when the live database is missing,
unreadable, or older than `GTFS_STARTUP_MAX_AGE_MS` — so a service that was
down across its 03:00 window catches up on boot instead of serving stale data
until the next night.

Measured against the real feed on 2026-08-21: a full import (fetch through
finalized database) took ~53 s and produced a 636 MB database; an unchanged
(`304`) run completed in well under a second.

## Config

Server config, read in `src/config.ts`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the ops server |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `NODE_ENV` | `development` | Set to `production` in deployment; enables JSON logs and `trustProxy` |
| `LOG_LEVEL` | `info` | Pino log level |

Feed / import config, read in `src/config.ts` (`feedConfig`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GTFS_URL` | `https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip` | Source feed URL |
| `GTFS_DATA_DIR` | `<repo-root>/data` | Directory holding versioned databases and the `gtfs.sqlite` symlink |
| `GTFS_KEEP_VERSIONS` | `2` | How many past database versions to retain on disk. Must be a non-negative integer — a malformed value (e.g. a typo) fails the process at boot rather than silently breaking the garbage-collection arithmetic |
| `GTFS_MAX_BAD_ROW_RATIO` | `0.01` | Fraction of rows (0–1) allowed to fail coercion before a run is rejected. Must parse as a finite number in `[0, 1]` — a malformed value (e.g. a typo) fails the process at boot rather than silently disabling the bad-row gate |
| `GTFS_CRON` | `0 3 * * *` | Cron expression for the scheduled import |
| `GTFS_TZ` | `Asia/Jerusalem` | Timezone the cron expression is evaluated in |
| `GTFS_CRON_JITTER_MS` | `300000` (5 min) | Upper bound of a random delay added to each cron tick. The feed is a single shared government endpoint and 03:00 is the obvious hour for every consumer to pick |
| `GTFS_STALL_TIMEOUT_MS` | `60000` (60 s) | Idle timeout on the download. Re-armed on every chunk, so this bounds *silence*, not total transfer time — a slow but progressing download is never aborted |
| `GTFS_RUN_TIMEOUT_MS` | `1800000` (30 min) | Ceiling on a whole import (a real one takes ~53 s). A backstop: whatever wedges a run, the single-flight lock is released so the next scheduled run gets a real attempt |
| `GTFS_STARTUP_MAX_AGE_MS` | `93600000` (26 h) | How stale the live database may be at process start before an import is triggered immediately rather than waiting for the next cron |

Every one of these is validated eagerly at module load: an invalid value throws
immediately at process startup with a message naming the bad value, instead of
failing quietly later during a run. That matters most for the timeouts, where
lenient parsing is actively dangerous — `Number.parseInt("6O000", 10)` (a
capital O for a zero) is **6**, which would abort every healthy import while
looking like a configured value. The durations are parsed strictly and must be
positive integers; there is deliberately no "0 disables it" escape hatch, since
a disabled ceiling is exactly the state a typo must not be able to produce.

### `GTFS_DATA_DIR` resolution

The default is **not** `"data"` resolved against `process.cwd()` — it is
anchored on `config.ts`'s own module location (`import.meta.url`) and resolved
two directories up to the **repo root**, giving `<repo-root>/data` regardless
of which directory the process was launched from. This matters because the
database directory is shared with a second, independent service (see below):
a CWD-relative default would have one service silently writing to (or reading
from) a different, empty directory the moment it was launched from somewhere
other than `gtfs/`.

If you set `GTFS_DATA_DIR` yourself: an **absolute** path is used as given. A
**relative** path is resolved against the repo root, not against
`process.cwd()` — for the same reason as the default. A relative override
that fell back to `process.cwd()` would reintroduce the exact fragility this
default removes, just one env var away.

## `data/` layout

The data directory lives at `<repo-root>/data` — one level **above**
`gtfs/`, alongside it, not inside it — specifically so a second
service in this repo can read the same files without depending on
`gtfs`'s internals or its own working directory. See
["For a second service reading this database"](#for-a-second-service-reading-this-database)
below if you're building that consumer.

```
data/
  gtfs-<version>.sqlite            one file per COMPLETED, PUBLISHED import
  gtfs-<version>.sqlite-shm        WAL sidecars for that version (present briefly)
  gtfs-<version>.sqlite-wal
  gtfs-<version>.sqlite.building   a run in progress (or one that died)
  gtfs.sqlite -> gtfs-<version>.sqlite   symlink to the current live version
```

A run writes to the `.building` name and renames to the published name only
after every sanity gate has passed, immediately before the swap. So the
published name is a statement, not a guess: a build interrupted by a crash, an
OOM or a `SIGTERM` keeps its `.building` suffix, is never counted as a version
by garbage collection, and can never be picked as a rollback target or push a
good one out of the retention window. Leftover `.building` files are swept at
the start of the next run.

`<version>` is the import's start time, ISO-8601 with `:` and `.` replaced by
`-` (e.g. `gtfs-2026-08-21T16-10-22-006Z.sqlite`), so filenames sort
lexicographically in creation order.

The live pointer is a **symlink**, not a renamed file, because WAL sidecar
files are keyed to the database's filename and cannot be swapped atomically
alongside it — each version owns its own sidecars. A reader with an open
handle to the old file keeps working against it; new connections resolve the
symlink to the new version.

After each successful import, versions beyond `GTFS_KEEP_VERSIONS` are
deleted — except the version the live symlink currently points at, which is
never removed by garbage collection regardless of its age.

## Ops endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness check; stays responsive during an import |
| `GET /status` | `{ running, lastRun, live, liveError }` — whether an import is in flight, the last run's start/finish time and outcome (`imported` with counts, `unchanged`, `rejected` with failure reasons, or `error`), and the persisted state of the live database read straight from disk. `lastRun` is in-process only and resets to `null` on every restart; `live` does not — it is read fresh from `feed_meta` in the live SQLite file on every request, so it reflects what is actually being served even right after a deploy, crash, or reboot |
| `POST /refresh` | Triggers a manual import. Returns `202 { status: "started" }`, or `409 { status: "already_running" }` if one is already in flight — overlapping triggers (a manual refresh during the nightly cron, say) share the same run rather than starting a second multi-gigabyte load |

`live` and `liveError` together report three distinct states — **read both
fields**, since `live: null` alone is ambiguous between the first two:

- **Healthy** — a database is live and readable. `live` is populated,
  `liveError` is `null`:

  ```json
  {
    "live": {
      "version": "2026-08-21T16-10-22-006Z",
      "fetchedAt": "2026-08-21T16:11:13.189Z",
      "sourceUrl": "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip",
      "etag": "2fbc145fc130dd1:0",
      "lastModified": "Thu, 20 Aug 2026 16:31:37 GMT",
      "counts": { "agency": 36, "routes": 7605, "stops": 35266, "stop_times": 9817029 },
      "badRows": 0,
      "path": "data/gtfs-2026-08-21T16-10-22-006Z.sqlite"
    },
    "liveError": null
  }
  ```

- **Cold start** — no database has ever been published (fresh
  `GTFS_DATA_DIR`, before the first import completes). Working as
  designed; just wait for the first run. Both fields are `null`:

  ```json
  { "live": null, "liveError": null }
  ```

- **Broken** — a database *was* published (the live symlink exists) but
  its target can no longer be read: deleted out from under it, a
  permission error, or a corrupt/mid-swap file. This means something is
  wrong *right now* and is worth alerting on — unlike cold start, waiting
  will not fix it. `liveError` holds a short reason (never a raw stack
  trace or full error object):

  ```json
  { "live": null, "liveError": "unreadable: SQLITE_CANTOPEN" }
  ```

`/status` never returns 5xx over any of this — a broken or missing live
database is reported in the body, not as a failed request, since this is
precisely the endpoint someone reaches for when something has already gone
wrong.

### Triggering a manual refresh

```
curl -X POST http://localhost:3000/refresh
curl http://localhost:3000/status   # poll until running: false
```

## Rolling back

Every successful import is versioned and the previous version(s) are kept
(`GTFS_KEEP_VERSIONS`, default 2). To roll back to the prior version, repoint
the `gtfs.sqlite` symlink at it directly — no code change or restart required,
since every reader resolves the symlink on each new connection:

```
cd <GTFS_DATA_DIR>   # default: <repo-root>/data
ls -la               # find the previous gtfs-<version>.sqlite you want
ln -sfn gtfs-<previous-version>.sqlite gtfs.sqlite
```

`ln -sfn` replaces the symlink atomically (same mechanism the service itself
uses via `rename()`), so there is no window where `gtfs.sqlite` points at
nothing. The rolled-back-to version must not have already been garbage
collected — check `GTFS_KEEP_VERSIONS` if it's missing.

## For a second service reading this database

The database directory (`<repo-root>/data`, one level above `gtfs/`)
is designed to be shared: this service is the only writer, but any number of
read-only consumers can open `gtfs.sqlite` directly. If you're building that
second service, this section is for you.

**Path.** `<repo-root>/data/gtfs.sqlite`. It is a **symlink** — its target is
a bare filename (e.g. `gtfs-2026-08-21T16-10-22-006Z.sqlite`), resolved
relative to the directory it lives in, so the whole `data/` directory can be
moved without breaking it (this is exactly how it got to its current
location). Never hardcode a versioned filename; always go through the
symlink.

**Open read-only, and reconnect.** Open the connection read-only
(`new Database(path, { readonly: true })` in better-sqlite3, or your driver's
equivalent). Resolve the symlink at connect time, not once at process start —
and reconnect periodically or on a signal (e.g. `SIGHUP`), not just on error.
This is by design, not a workaround: swaps happen via `rename()` on the
symlink so in-flight readers of the old file are never disrupted, which
necessarily means a connection opened before a swap keeps serving the *old*
inode after one. An open handle does not "see" the symlink move — it silently
keeps reading yesterday's data until it is closed and reopened. A consumer
that connects once at startup and never reconnects will never observe a
newer import.

**WAL mode and read-only access — verified empirically.** The database runs
in WAL (`journal_mode = wal`). A plain read-only open works fine as long as
the `-shm`/`-wal` sidecar files already exist next to the target (which they
normally do — the writer keeps them present, though `-wal` is often 0 bytes
between writes). If those sidecars are **absent**, SQLite needs to create
them even for a nominally read-only connection, and creating a file requires
write permission on the containing **directory**, not just on the database
file. Tested directly (better-sqlite3, `readonly: true`):

| Directory writable? | Sidecars present? | Result |
| --- | --- | --- |
| yes | yes | opens, reads fine |
| yes | no | opens fine — SQLite silently creates the missing `-shm`/`-wal` |
| **no** | **no** | **fails**: `SqliteError: attempt to write a readonly database` |
| no | yes | opens, reads fine |

So a purely read-only consumer (one with no write permission on `data/`)
**can** fail to open the database, specifically if it connects at a moment
the sidecars happen to be missing. In practice the writer (this service)
keeps them present, so this is unlikely to bite in steady state — but a
second service that wants to be robust against it should ensure it has write
permission on the `data/` directory itself (not just read permission on the
`.sqlite` file), even though it never writes to the database.

**Schema gotchas.**

- Times (`arrival_time`, `departure_time`, etc.) are **`INTEGER` seconds
  after midnight, and legitimately exceed 86400** — GTFS represents a trip
  past midnight as, e.g., `29:23:00` rather than wrapping to `05:23:00` the
  next day. In the current database, 101,317 rows exceed 86400, with a
  maximum of 105787 (29:23:07). Don't clamp, mod, or reject these as
  invalid — they're real and normal in a metro network with late-night
  service.
- `stop_times` joins via **interned `stop_ref` / `trip_ref` `INTEGER`
  keys**, not the original GTFS string ids. The original ids live on
  `stops.stop_id` and `trips.trip_id`; join through those columns (or through
  `stop_ref`/`trip_ref` directly, if you already have the interned key) —
  don't try to join `stop_times` to `stops`/`trips` on `stop_id`/`trip_id`
  directly, since `stop_times` doesn't carry those string columns at all.

## Test suite reliability

`npm test` runs `node --test` with its default (parallel, one-process-per-file)
concurrency, plus `--test-timeout=30000`. Each of the 16 test files is
independently fast (~9s for the full suite in parallel, ~25s run serially),
so no concurrency limit is needed.

The timeout exists as a backstop, not a routine safeguard: an earlier version
of `server.ts` built every test `Fastify` instance with a `pino-pretty` log
transport, which runs as an unref'd-nowhere worker thread. Neither Fastify's
`close()` nor pino terminates that thread — it is only reclaimed when its
stream is garbage-collected, which is unbounded and, under the CPU
contention of 16 files' worth of SQLite writers, Fastify servers, and croner
timers all running at once, could take long enough to stall the whole suite
indefinitely (`routes/ops.test.ts` builds ~9 servers; every subtest passed,
but its file-level process never went idle enough to exit). `buildServer` now
skips the pretty transport when `NODE_TEST_CONTEXT` is set — the env var
node's test runner sets in every child process it spawns — so tests get
pino's plain (unbuffered, thread-free) writer instead, and `npm run dev`
keeps its pretty output. If `--test-timeout=30000` ever fires, treat it as a
regression of this class (a resource with no bounded teardown), not as a slow
test to relax the timeout for.

## Running the live test

The test suite (`npm test`) runs entirely against a small fixture archive and
never touches the network. One additional test imports the **real** feed and
is gated behind an environment variable so it never runs by accident:

```
npm run test:live
```

This downloads the live archive (~139 MB compressed) and runs the full
pipeline against it into a scratch temporary directory — expect it to take
roughly a minute or more, and to fail loudly (not silently) if the upstream
WAF serves a challenge page instead of the archive, or if a sanity gate trips
on the real data.

## Layout

```
src/
  index.ts              bootstrap: server + scheduler + startup import
  config.ts              env parsing (server config + feedConfig)
  server.ts              buildServer(): plugin + route registration
  scheduler.ts           cron + single-flight import lock
  routes/
    health.ts            GET  /health
    status.ts            GET  /status
    refresh.ts           POST /refresh
  feed/
    client.ts            conditional streaming GET, retry, WAF guards
    zip.ts               Zip64 streaming entry iterator
    csv.ts               CSV stream -> row records (BOM, CRLF, embedded quotes)
  gtfs/
    tables.ts            per-file column spec and coercion rules
    polyline.ts           precision-6 polyline encode/decode
    values.ts             scalar coercion helpers
  db/
    schema.ts             DDL
    open.ts               connection + pragmas
    writer.ts              batched prepared-statement inserts, interning
    finalize.ts             indexes, derived tables (R*Tree, FTS5), sanity gates
    swap.ts                 versioned file, symlink swap, GC
  pipeline/
    importFeed.ts          orchestration: fetch -> parse -> load -> gate -> swap
```

Add new routes as Fastify plugins under `src/routes/` and register them in
`src/server.ts`.
