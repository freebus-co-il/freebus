import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

export const config = {
  port,
  host: process.env.HOST ?? "0.0.0.0",
  env: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;

export const isProduction = config.env === "production";

const keepVersions = Number.parseInt(process.env.GTFS_KEEP_VERSIONS ?? "2", 10);

// A malformed value here (e.g. a typo'd env var producing NaN) must fail
// loudly at boot, not silently: gcVersions's arithmetic
// (`versions.length - keep`) would misbehave on a non-integer or negative
// keep count with no error and no log line.
if (!Number.isInteger(keepVersions) || keepVersions < 0) {
  throw new Error(`Invalid GTFS_KEEP_VERSIONS: ${process.env.GTFS_KEEP_VERSIONS}`);
}

const maxBadRowRatio = Number.parseFloat(process.env.GTFS_MAX_BAD_ROW_RATIO ?? "0.01");

// Same failure mode as above, and a subtler one: `badRows / totalRows >
// maxBadRowRatio` is always false when the right-hand side is NaN, so a
// typo'd env var (e.g. "abc") wouldn't just misconfigure the threshold —
// it would silently disable the bad-row gate entirely, with the run
// still reporting success. A ratio is only meaningful in [0, 1].
if (!Number.isFinite(maxBadRowRatio) || maxBadRowRatio < 0 || maxBadRowRatio > 1) {
  throw new Error(`Invalid GTFS_MAX_BAD_ROW_RATIO: ${process.env.GTFS_MAX_BAD_ROW_RATIO}`);
}

/**
 * Parses a millisecond duration env var.
 *
 * Same class of failure as the two checks above: these are the ceilings that
 * stop a wedged run becoming permanent, so a typo must fail the process, not
 * quietly reconfigure a safety gate.
 *
 * `Number`, not `Number.parseInt`. `parseInt` stops at the first character it
 * cannot use and returns what it has: `Number.parseInt("6O000", 10)` — a
 * capital O for a zero — is **6**, and a six-millisecond stall timeout aborts
 * every healthy import while looking like a configured value. `Number` gives
 * NaN for the same string, which this check rejects by name.
 *
 * The floor is 1, not 0: "0 means disabled" is precisely the accidental state
 * we refuse to let a bad value produce. A deployment that genuinely wants no
 * ceiling has to say so in code, not in an env var.
 */
function durationMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

// Generous relative to the real feed: a full import (fetch through finalized
// database) measured ~53 s end to end on 2026-08-21, and bytes arrive
// continuously throughout. These ceilings exist to break a wedge, not to
// police a slow-but-progressing run, so they are set an order of magnitude
// above observed reality.

/** Idle timeout: how long the download may go without producing a byte. */
const stallTimeoutMs = durationMs("GTFS_STALL_TIMEOUT_MS", 60_000);

/** Backstop: how long a whole import may take before the runner gives up. */
const runTimeoutMs = durationMs("GTFS_RUN_TIMEOUT_MS", 30 * 60_000);

/**
 * Upper bound of the random delay applied to each cron tick. The MOT feed is
 * shared national infrastructure and 03:00 is the obvious hour for every
 * consumer to pick, so spreading the request over a window costs nothing and
 * avoids adding to a synchronised burst.
 */
const cronJitterMs = durationMs("GTFS_CRON_JITTER_MS", 5 * 60_000);

/**
 * Startup staleness threshold. A little over one publication cadence (daily),
 * so a service that was down across its 03:00 window imports on boot instead
 * of serving day-old data until the next night.
 */
const startupMaxAgeMs = durationMs("GTFS_STARTUP_MAX_AGE_MS", 26 * 60 * 60_000);

/**
 * The database directory is shared with a second, independent service, so
 * its location must not depend on which directory the process happened to
 * be launched from. `"data"` resolved against `process.cwd()` fails that:
 * run this service from the repo root instead of `gtfs/` and it
 * silently writes to (or reads from) a different, empty directory.
 *
 * Anchor on this module's own location instead, via `import.meta.url`, and
 * climb to the repo root: `src/config.ts` (dev, executed directly by tsx)
 * and the compiled `dist/config.js` (production, run with plain `node`) are
 * both exactly one level below `gtfs/`, which is itself one level
 * below the repo root. So the same two-hop `"../.."` reaches the repo root
 * from either file's directory — verified by resolving both at once and
 * checking they agree, not assumed.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..");
const defaultDataDir = resolve(repoRoot, "data");

/**
 * `GTFS_DATA_DIR` remains a valid override, but a *relative* override is
 * resolved against `repoRoot`, not `process.cwd()`. The whole point of
 * `defaultDataDir` above is CWD-independence; a relative override that fell
 * back to `process.cwd()` would quietly reintroduce the exact fragility
 * this change removes, just one env var away. `resolve()` ignores its first
 * argument when the second is already absolute, so an absolute override
 * still behaves exactly as given.
 */
const dataDir = process.env.GTFS_DATA_DIR === undefined
  ? defaultDataDir
  : resolve(repoRoot, process.env.GTFS_DATA_DIR);

export const feedConfig = {
  url: process.env.GTFS_URL ??
    "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip",
  dataDir,
  keepVersions,
  maxBadRowRatio,
  cron: process.env.GTFS_CRON ?? "0 3 * * *",
  timezone: process.env.GTFS_TZ ?? "Asia/Jerusalem",
  stallTimeoutMs,
  runTimeoutMs,
  cronJitterMs,
  startupMaxAgeMs,
} as const;
