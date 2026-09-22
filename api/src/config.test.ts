import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveRealtimeConfig, resolveGeocoderConfig, floatEnv } from "./config.js";

// config.ts validates at MODULE LOAD time and throws. The only faithful way
// to test "a bad env var makes the process fail loudly at boot" is to boot a
// fresh process with that env var set — importing it here would be cached
// after the first load and could not be re-run with different env.
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "config.ts");

function loadConfigWith(env: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e",
     `import(${JSON.stringify(`file://${configPath}`)})`],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr };
}

test("a valid environment loads", () => {
  const { status } = loadConfigWith({ PORT: "3100" });
  assert.equal(status, 0);
});

test("a non-numeric PORT fails at boot, naming the value", () => {
  const { status, stderr } = loadConfigWith({ PORT: "abc" });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid PORT: abc/);
});

// Number.parseInt("6O000", 10) is 6 — a capital O for a zero. A 6 ms Valhalla
// timeout would fail every walk lookup while looking like a configured value.
// The parser must use Number(), which yields NaN, and reject it by name.
test("a typo'd duration fails rather than silently becoming a tiny number", () => {
  const { status, stderr } = loadConfigWith({ VALHALLA_TIMEOUT_MS: "6O000" });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid VALHALLA_TIMEOUT_MS: 6O000/);
});

test("WALK_MAX_METERS must be a positive integer", () => {
  const { status, stderr } = loadConfigWith({ WALK_MAX_METERS: "-5" });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid WALK_MAX_METERS: -5/);
});

// A negative factor would make requiredTransferSeconds return below
// baseSeconds -- i.e. make boarding EASIER than today's flat rule, the one
// global constraint this feature must never violate. Must fail at boot the
// same way every other malformed numeric setting here does.
test("a negative TRANSFER_HEADWAY_FACTOR fails at boot, naming the value", () => {
  const { status, stderr } = loadConfigWith({ TRANSFER_HEADWAY_FACTOR: "-0.1" });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid TRANSFER_HEADWAY_FACTOR: -0.1/);
});

// A cap below the floor makes requiredTransferSeconds return BELOW
// baseSeconds -- the clamp applies the cap last -- which is the same
// "boarding gets easier" violation a negative factor would cause, reached by
// a different route. raptor.ts floors the margin at zero regardless, but a
// config that can only produce nonsense must not be silently absorbed.
test("a TRANSFER_MAX_SECONDS below TRANSFER_MIN_SECONDS fails at boot", () => {
  const { status, stderr } = loadConfigWith({
    TRANSFER_MIN_SECONDS: "600", TRANSFER_MAX_SECONDS: "120",
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid TRANSFER_MAX_SECONDS: 120 is below TRANSFER_MIN_SECONDS: 600/);
});

test("a cap equal to the floor is allowed -- it is a degenerate but coherent setting", () => {
  const { status } = loadConfigWith({ TRANSFER_MIN_SECONDS: "600", TRANSFER_MAX_SECONDS: "600" });
  assert.equal(status, 0);
});

// TZ decides where every service-day boundary falls and what offset every
// ISO timestamp carries, so a typo in it produces no error anywhere -- just
// a service quietly wrong by hours, everywhere. It has to fail at boot like
// every other value in this file.
test("a bogus TZ fails at boot, naming the value", () => {
  const { status, stderr } = loadConfigWith({ TZ: "Asia/Jerusalemm" });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid TZ: Asia\/Jerusalemm/);
});

test("an empty TZ fails rather than silently becoming the platform default", () => {
  const { status, stderr } = loadConfigWith({ TZ: "" });
  assert.notEqual(status, 0);
  assert.match(stderr, /Invalid TZ/);
});

test("a real IANA zone loads", () => {
  assert.equal(loadConfigWith({ TZ: "Europe/Oslo" }).status, 0);
});

// ---- resolveRealtimeConfig -------------------------------------------
//
// Unlike every test above, these call `resolveRealtimeConfig` directly with
// an injected `env`/`warn` rather than spawning a fresh process: it is a
// pure function precisely so tests do not have to re-import config.ts under
// a different `process.env` to exercise it (see its own doc comment).
// This is config.ts's own gating/validation logic, not server decoration.

test("with no key, realtime falls back to the open-bus raw feed and nothing warns", () => {
  // An unconfigured deployment reads the open-bus raw per-minute feed rather
  // than going dark; Stride's own ETL, by contrast, runs 13-23 min behind.
  // Still not a misconfiguration, so still no warning.
  const warnings: string[] = [];
  const cfg = resolveRealtimeConfig({}, (m) => warnings.push(m));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.source, "open-bus-vm");
  assert.deepEqual(warnings, [], "a genuinely unconfigured deployment is not a misconfiguration");
});

test("with a key but no base URL, realtime stays disabled and warns", () => {
  const warnings: string[] = [];
  const cfg = resolveRealtimeConfig({ MOT_SIRI_KEY: "s3cret-key" }, (m) => warnings.push(m));
  assert.equal(cfg.enabled, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /MOT_SIRI_BASE_URL/);
  assert.doesNotMatch(warnings[0]!, /s3cret-key/, "the key itself must never appear in the warning");
});

test("with a base URL but no key, realtime stays disabled and warns", () => {
  const warnings: string[] = [];
  const cfg = resolveRealtimeConfig(
    { MOT_SIRI_BASE_URL: "https://example.test" }, (m) => warnings.push(m),
  );
  assert.equal(cfg.enabled, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /MOT_SIRI_KEY/);
});

test("with both set, realtime is enabled and nothing warns", () => {
  const warnings: string[] = [];
  const cfg = resolveRealtimeConfig(
    { MOT_SIRI_KEY: "k", MOT_SIRI_BASE_URL: "https://example.test" }, (m) => warnings.push(m),
  );
  assert.equal(cfg.enabled, true);
  assert.deepEqual(warnings, []);
});

// An empty string is a when-not-if in practice (an operator clearing an env
// var in some deployment tools leaves it set to ""), and must behave
// exactly like unset, not like a configured empty key.
test("an empty-string key or base URL is treated as absent, not configured", () => {
  const warnings: string[] = [];
  const cfg = resolveRealtimeConfig(
    { MOT_SIRI_KEY: "", MOT_SIRI_BASE_URL: "https://example.test" }, (m) => warnings.push(m),
  );
  assert.equal(cfg.enabled, false);
  assert.match(warnings[0]!, /MOT_SIRI_KEY/);
});

// ICD §7.18.2: a snapshot request must not be made more often than
// once per 15 seconds. `poller.ts`'s own clamp is a last-line-of-defence
// against a non-finite value, not the primary check -- config.ts must fail
// loudly on a typo'd interval below the floor, the same way every other
// malformed numeric setting in this file already does.
test("REALTIME_POLL_SECONDS and REALTIME_PLANNED_POLL_SECONDS below the ICD's 15s floor fail at boot", () => {
  assert.throws(() => resolveRealtimeConfig({ REALTIME_POLL_SECONDS: "5" }, () => {}), /REALTIME_POLL_SECONDS/);
  assert.throws(
    () => resolveRealtimeConfig({ REALTIME_PLANNED_POLL_SECONDS: "5" }, () => {}),
    /REALTIME_PLANNED_POLL_SECONDS/,
  );
});

// ---- floatEnv -----------------------------------------------

test("floatEnv accepts a fractional value inside its range", () => {
  assert.equal(floatEnv("X", 2, 1, 5, { X: "1.5" } as NodeJS.ProcessEnv), 1.5);
});

test("floatEnv falls back when unset", () => {
  assert.equal(floatEnv("X", 2, 1, 5, {} as NodeJS.ProcessEnv), 2);
});

test("floatEnv rejects out-of-range, non-numeric and infinite values", () => {
  for (const raw of ["0.5", "9", "abc", "Infinity", ""]) {
    assert.throws(
      () => floatEnv("X", 2, 1, 5, { X: raw } as NodeJS.ProcessEnv),
      /Invalid X/,
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------
// Realtime source selection. The truth table matters more
// than any single case: a half-set MOT pair must NOT fall through to
// Stride, or a typo'd key would present as a working system.
// ---------------------------------------------------------------------

const noWarn = (): void => {};

test("both MOT vars set selects siri-sm and builds no keyless settings", () => {
  const cfg = resolveRealtimeConfig(
    { MOT_SIRI_KEY: "k", MOT_SIRI_BASE_URL: "https://mot.test" }, noWarn,
  );
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.source, "siri-sm");
  assert.equal(cfg.stride, null);
  assert.equal(cfg.openBus, null);
});

test("neither MOT var set falls back to open-bus-vm with the public requester URL", () => {
  const cfg = resolveRealtimeConfig({}, noWarn);
  assert.equal(cfg.source, "open-bus-vm");
  assert.equal(cfg.openBus?.baseUrl, "https://open-bus-siri-requester.hasadna.org.il");
  assert.equal(cfg.stride, null);
});

test("the open-bus poll is well inside the one-minute publish cadence", () => {
  // A minute lands about 30 s past the minute; a 20 s poll picks it up within
  // 20 s of that, against a 60 s poll's worst case of a full minute more.
  const s = resolveRealtimeConfig({}, noWarn).openBus!;
  assert.equal(s.pollSeconds, 20);
});

test("open-bus settings are overridable", () => {
  const s = resolveRealtimeConfig({
    OPEN_BUS_BASE_URL: "https://mirror.test", OPEN_BUS_POLL_SECONDS: "30",
    OPEN_BUS_MAX_VEHICLE_AGE_SECONDS: "900",
  }, noWarn).openBus!;
  assert.deepEqual([s.baseUrl, s.pollSeconds, s.maxVehicleAgeSeconds], ["https://mirror.test", 30, 900]);
});

test("the open-bus ghost cutoff keeps a whole operator whose reports are running late", () => {
  // 2026-09-13 18:47Z: every one of Egged's 688 vehicles reported about 21 min
  // late (median 1,265 s) while other operators sat at 74-92 s. A ten-minute
  // cutoff dropped the country's largest operator from realtime entirely,
  // which Stride's 30-minute cutoff never did. How far to trust an old report
  // is the store's anchoring decision; whether to keep it at all is this one.
  const s = resolveRealtimeConfig({}, noWarn).openBus!;
  assert.ok(s.maxVehicleAgeSeconds > 1_265, `${s.maxVehicleAgeSeconds}s drops a 21-minute-late operator`);
});

test("an out-of-range open-bus numeric fails at boot", () => {
  // Their files change once a minute: a sub-10 s poll only re-reads the same
  // 84-byte status against a volunteer-run server.
  assert.throws(() => resolveRealtimeConfig({ OPEN_BUS_POLL_SECONDS: "5" }, noWarn),
    /OPEN_BUS_POLL_SECONDS/);
  assert.throws(() => resolveRealtimeConfig({ OPEN_BUS_MAX_VEHICLE_AGE_SECONDS: "10" }, noWarn),
    /OPEN_BUS_MAX_VEHICLE_AGE_SECONDS/);
});

test("REALTIME_KEYLESS_SOURCE=stride selects stride-vm with the public base URL", () => {
  const cfg = resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride" }, noWarn);
  assert.equal(cfg.source, "stride-vm");
  assert.equal(cfg.stride?.baseUrl, "https://open-bus-stride-api.hasadna.org.il");
  assert.equal(cfg.stride?.pollSeconds, 60);
  assert.equal(cfg.openBus, null);
});

test("REALTIME_KEYLESS_SOURCE=off keeps realtime dark when there is no MOT key", () => {
  const cfg = resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "off" }, noWarn);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.source, null);
  assert.equal(cfg.openBus, null);
  assert.equal(cfg.stride, null);
});

test("an unknown REALTIME_KEYLESS_SOURCE fails at boot rather than guessing", () => {
  // A typo must not silently pick a feed -- or silently pick none.
  assert.throws(() => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "strid" }, noWarn),
    /REALTIME_KEYLESS_SOURCE/);
});

test("a half-set MOT pair disables — it must NOT fall through to Stride", () => {
  for (const env of [{ MOT_SIRI_KEY: "k" }, { MOT_SIRI_BASE_URL: "https://mot.test" }]) {
    const warnings: string[] = [];
    const cfg = resolveRealtimeConfig(env, (m) => warnings.push(m));
    assert.equal(cfg.enabled, false, `${JSON.stringify(env)} must stay disabled`);
    assert.equal(cfg.source, null);
    assert.equal(cfg.stride, null);
    assert.equal(cfg.openBus, null);
    assert.equal(warnings.length, 1, "a misconfiguration must still warn");
  }
});

test("the legacy STRIDE_ENABLED=false still keeps realtime dark when there is no MOT key", () => {
  // It meant "no keyless realtime" when Stride was the only keyless feed; a
  // deployment that set it must not light up the new one without being asked.
  const cfg = resolveRealtimeConfig({ STRIDE_ENABLED: "false" }, noWarn);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.source, null);
  assert.equal(cfg.stride, null);
  assert.equal(cfg.openBus, null);
});

test("STRIDE_ENABLED=false does not disable a properly configured MOT key", () => {
  const cfg = resolveRealtimeConfig(
    { MOT_SIRI_KEY: "k", MOT_SIRI_BASE_URL: "https://mot.test", STRIDE_ENABLED: "false" },
    noWarn,
  );
  assert.equal(cfg.source, "siri-sm");
});

test("the default Stride bbox covers Israel", () => {
  const s = resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride" }, noWarn).stride!;
  assert.ok(s.minLat < 29.6 && s.maxLat > 33.2, "latitude span must cover Eilat to Metula");
  assert.ok(s.minLon < 34.4 && s.maxLon > 35.7);
});

test("the Stride bbox is overridable", () => {
  const s = resolveRealtimeConfig({
    REALTIME_KEYLESS_SOURCE: "stride",
    STRIDE_MIN_LAT: "31.9", STRIDE_MAX_LAT: "32.3",
    STRIDE_MIN_LON: "34.6", STRIDE_MAX_LON: "35.0",
  }, noWarn).stride!;
  assert.deepEqual(
    [s.minLat, s.maxLat, s.minLon, s.maxLon], [31.9, 32.3, 34.6, 35.0],
  );
});

test("an empty or inverted Stride bbox fails at boot", () => {
  // A configuration that can only ever return nothing must fail loudly once,
  // not run forever looking like a feed outage.
  assert.throws(
    () => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride", STRIDE_MIN_LAT: "33.4", STRIDE_MAX_LAT: "29.4" }, noWarn),
    /STRIDE bbox/,
  );
  assert.throws(
    () => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride", STRIDE_MIN_LON: "35.9", STRIDE_MAX_LON: "34.2" }, noWarn),
    /STRIDE bbox/,
  );
});

test("an out-of-range Stride numeric fails at boot", () => {
  assert.throws(() => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride", STRIDE_POLL_SECONDS: "3" }, noWarn),
    /STRIDE_POLL_SECONDS/);
  assert.throws(() => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride", STRIDE_MAX_PAGES: "0" }, noWarn),
    /STRIDE_MAX_PAGES/);
  // Above their own hard cap: asking for more returns an error, not a bigger page.
  assert.throws(() => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride", STRIDE_PAGE_LIMIT: "20000" }, noWarn),
    /STRIDE_PAGE_LIMIT/);
  assert.throws(() => resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride", STRIDE_MAX_VEHICLE_AGE_SECONDS: "10" }, noWarn),
    /STRIDE_MAX_VEHICLE_AGE_SECONDS/);
});

test("the per-vehicle ghost cutoff is far looser than the snapshot staleness", () => {
  // They measure different things: 180 s is how old the whole snapshot may
  // be, while Stride's own ingestion lag is already 60-110 s. Reusing the
  // snapshot number per row would discard buses reporting every two minutes.
  const cfg = resolveRealtimeConfig({ REALTIME_KEYLESS_SOURCE: "stride" }, noWarn);
  assert.ok(cfg.stride!.maxVehicleAgeSeconds > cfg.maxAgeSeconds * 2);
});

test("GEOCODER defaults to photon, with no Google settings", () => {
  const c = resolveGeocoderConfig({});
  assert.equal(c.backend, "photon");
  assert.equal(c.google, null);
});

test("GEOCODER=google carries the key and the cost ceiling", () => {
  const c = resolveGeocoderConfig({ GEOCODER: "google", GOOGLE_MAPS_API_KEY: "k", GOOGLE_MAPS_DAILY_REQUEST_LIMIT: "500" });
  assert.equal(c.backend, "google");
  assert.equal(c.google?.apiKey, "k");
  assert.equal(c.google?.dailyRequestLimit, 500);
});

test("GEOCODER=google without a key fails at boot rather than silently finding nothing", () => {
  assert.throws(() => resolveGeocoderConfig({ GEOCODER: "google", GOOGLE_MAPS_API_KEY: "" }), /requires GOOGLE_MAPS_API_KEY/);
});

test("an unknown GEOCODER fails at boot, naming the value", () => {
  assert.throws(() => resolveGeocoderConfig({ GEOCODER: "gogle" }), /Invalid GEOCODER: gogle/);
});
