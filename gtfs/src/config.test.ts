import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// config.ts validates and throws at MODULE LOAD time, not lazily on
// access — so the only faithful way to test "a bad env var makes the
// process fail loudly at boot" is to actually boot a fresh process with
// that env var set. Importing config.ts directly in this test process
// would only ever run once (module caching), and by the time any test in
// this suite runs, some earlier import may already have loaded it with a
// different env — a fresh child process is the only way to get a clean
// read on "would this value have made the service fail to start".
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "config.ts");

function loadConfigWith(env: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `import(${JSON.stringify(`file://${configPath}`)})`],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  return { status: result.status, stderr: result.stderr };
}

// The bare specifier "--import tsx" (used by loadConfigWith above) only
// resolves because those spawns keep this test file's own cwd, which has
// gtfs/node_modules on its resolution path. The tests below
// deliberately spawn from *other* working directories (repo root, the OS
// tmp dir) to prove dataDir doesn't depend on cwd — which means bare "tsx"
// would fail to resolve there for a reason that has nothing to do with the
// thing under test. Point node at tsx's own entry points by absolute path
// instead, so module resolution is unaffected by the spawned cwd.
const tsxDir = join(__dirname, "..", "node_modules", "tsx", "dist");
const tsxPreflight = join(tsxDir, "preflight.cjs");
const tsxLoader = `file://${join(tsxDir, "loader.mjs")}`;

/**
 * Same fresh-process rationale as `loadConfigWith`, but for reading back a
 * value out of `feedConfig` rather than just checking pass/fail — and
 * critically, run with an explicit `cwd` so the test can prove a claim
 * about *where the value came from*, not just what it equals when this
 * test file's own directory happens to be the working directory.
 */
function loadFeedConfigDataDir(
  cwd: string,
  env: Record<string, string> = {},
): { status: number | null; stderr: string; dataDir: string | undefined } {
  const script =
    `import(${JSON.stringify(`file://${configPath}`)})` +
    `.then((m) => { process.stdout.write(JSON.stringify({ dataDir: m.feedConfig.dataDir })); })`;
  const result = spawnSync(
    process.execPath,
    ["--require", tsxPreflight, "--import", tsxLoader, "--input-type=module", "-e", script],
    {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  const dataDir = result.status === 0
    ? (JSON.parse(result.stdout) as { dataDir: string }).dataDir
    : undefined;
  return { status: result.status, stderr: result.stderr, dataDir };
}

// The repo root as computed independently of config.ts's own logic: this
// test file lives at gtfs/src/config.test.ts, so "../.." from its
// own directory reaches the same repo root config.ts should resolve to.
const repoRoot = resolve(__dirname, "..", "..");
const expectedDefaultDataDir = join(repoRoot, "data");

test("rejects a non-numeric GTFS_MAX_BAD_ROW_RATIO instead of silently disabling the bad-row gate", () => {
  const { status, stderr } = loadConfigWith({ GTFS_MAX_BAD_ROW_RATIO: "abc" });
  assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
  assert.match(stderr, /Invalid GTFS_MAX_BAD_ROW_RATIO: abc/);
});

test("rejects a GTFS_MAX_BAD_ROW_RATIO above 1", () => {
  const { status, stderr } = loadConfigWith({ GTFS_MAX_BAD_ROW_RATIO: "1.5" });
  assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
  assert.match(stderr, /Invalid GTFS_MAX_BAD_ROW_RATIO: 1\.5/);
});

test("rejects a negative GTFS_MAX_BAD_ROW_RATIO", () => {
  const { status, stderr } = loadConfigWith({ GTFS_MAX_BAD_ROW_RATIO: "-0.1" });
  assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
  assert.match(stderr, /Invalid GTFS_MAX_BAD_ROW_RATIO: -0\.1/);
});

test("rejects a non-numeric GTFS_KEEP_VERSIONS instead of silently breaking GC arithmetic", () => {
  const { status, stderr } = loadConfigWith({ GTFS_KEEP_VERSIONS: "abc" });
  assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
  assert.match(stderr, /Invalid GTFS_KEEP_VERSIONS: abc/);
});

test("rejects a negative GTFS_KEEP_VERSIONS", () => {
  const { status, stderr } = loadConfigWith({ GTFS_KEEP_VERSIONS: "-1" });
  assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
  assert.match(stderr, /Invalid GTFS_KEEP_VERSIONS: -1/);
});

test("accepts valid GTFS_MAX_BAD_ROW_RATIO and GTFS_KEEP_VERSIONS overrides", () => {
  const { status, stderr } = loadConfigWith({
    GTFS_MAX_BAD_ROW_RATIO: "0.05", GTFS_KEEP_VERSIONS: "3",
  });
  assert.equal(status, 0, `expected a clean exit; stderr:\n${stderr}`);
});

// --- Timeout durations -----------------------------------------------------
//
// These four are the safety ceilings that keep a wedged run from becoming
// permanent, so the failure mode of a typo matters more here than for most
// settings. The value below is deliberately "6O000" — a capital O where a
// zero belongs, the realistic typo. `Number.parseInt("6O000", 10)` returns
// **6**, so a lenient parser would hand the service a six-millisecond stall
// timeout that aborts every healthy import while looking configured. These
// tests pin that such a value fails the process at boot instead.

for (const name of [
  "GTFS_STALL_TIMEOUT_MS",
  "GTFS_RUN_TIMEOUT_MS",
  "GTFS_CRON_JITTER_MS",
  "GTFS_STARTUP_MAX_AGE_MS",
]) {
  test(`rejects a non-numeric ${name} instead of silently removing the ceiling`, () => {
    const { status, stderr } = loadConfigWith({ [name]: "6O000" });
    assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
    assert.match(stderr, new RegExp(`Invalid ${name}: 6O000`));
  });

  test(`rejects a zero ${name}, which would disable the ceiling`, () => {
    const { status, stderr } = loadConfigWith({ [name]: "0" });
    assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
    assert.match(stderr, new RegExp(`Invalid ${name}: 0`));
  });

  test(`rejects a negative ${name}`, () => {
    const { status, stderr } = loadConfigWith({ [name]: "-1" });
    assert.notEqual(status, 0, `expected a non-zero exit; stderr:\n${stderr}`);
    assert.match(stderr, new RegExp(`Invalid ${name}: -1`));
  });
}

test("accepts valid timeout overrides", () => {
  const { status, stderr } = loadConfigWith({
    GTFS_STALL_TIMEOUT_MS: "90000",
    GTFS_RUN_TIMEOUT_MS: "3600000",
    GTFS_CRON_JITTER_MS: "60000",
    GTFS_STARTUP_MAX_AGE_MS: "86400000",
  });
  assert.equal(status, 0, `expected a clean exit; stderr:\n${stderr}`);
});

// --- dataDir: CWD-independence ---------------------------------------------
//
// The whole reason this default is anchored on import.meta.url instead of
// "data" (resolved against process.cwd() by every fs call downstream) is
// that a second service reading the same database must get the exact same
// path no matter which directory it was launched from. These tests boot a
// real child process — twice, from two different working directories — and
// pin that feedConfig.dataDir is identical both times, and equal to
// <repo-root>/data computed independently. A future refactor that
// reintroduces a `process.cwd()`-relative default would flip this from a
// same-value assertion to a different-value one, not silently pass.

test("resolves the default dataDir to <repo-root>/data regardless of process.cwd()", () => {
  const fromRepoRoot = loadFeedConfigDataDir(repoRoot);
  assert.equal(fromRepoRoot.status, 0, `expected a clean exit; stderr:\n${fromRepoRoot.stderr}`);
  assert.equal(fromRepoRoot.dataDir, expectedDefaultDataDir);

  const fromTmpDir = loadFeedConfigDataDir(tmpdir());
  assert.equal(fromTmpDir.status, 0, `expected a clean exit; stderr:\n${fromTmpDir.stderr}`);
  assert.equal(fromTmpDir.dataDir, expectedDefaultDataDir);

  // The real assertion: same cwd-independent answer both times.
  assert.equal(fromTmpDir.dataDir, fromRepoRoot.dataDir);
});

test("resolves a relative GTFS_DATA_DIR against the repo root, not process.cwd()", () => {
  const fromRepoRoot = loadFeedConfigDataDir(repoRoot, { GTFS_DATA_DIR: "custom-data" });
  assert.equal(fromRepoRoot.status, 0, `expected a clean exit; stderr:\n${fromRepoRoot.stderr}`);

  const fromTmpDir = loadFeedConfigDataDir(tmpdir(), { GTFS_DATA_DIR: "custom-data" });
  assert.equal(fromTmpDir.status, 0, `expected a clean exit; stderr:\n${fromTmpDir.stderr}`);

  const expected = join(repoRoot, "custom-data");
  assert.equal(fromRepoRoot.dataDir, expected);
  assert.equal(fromTmpDir.dataDir, expected);
});

test("passes an absolute GTFS_DATA_DIR through unchanged", () => {
  const absolute = join(tmpdir(), "some-absolute-data-dir");
  const { status, stderr, dataDir } = loadFeedConfigDataDir(repoRoot, { GTFS_DATA_DIR: absolute });
  assert.equal(status, 0, `expected a clean exit; stderr:\n${stderr}`);
  assert.equal(dataDir, absolute);
});
