import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { buildServer, type ServerDeps } from "../server.js";
import { RealtimeStore } from "../realtime/store.js";
import {
  SiriPoller, createFetchJson, type PollerScheduler, type PollerTimerHandle, type SiriLogger,
} from "../realtime/poller.js";
import type { ResolvedJourney } from "../realtime/match.js";
import type { RealtimeJourney } from "../realtime/types.js";

const ADMIN_TOKEN = "s3cret-reload-token";

async function serve(
  withIndex: boolean, adminToken: string | null = ADMIN_TOKEN, extra: Partial<ServerDeps> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "transit-meta-"));
  const link = buildFixtureDb(dir);
  // Build in-process rather than via a worker: the state machine is what is
  // under test, and spawning a worker per test is slow and noisy.
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  if (withIndex) await index.rebuild();
  return { app: await buildServer({ index, adminToken, ...extra }), index, dir };
}

/** A minimal RealtimeJourney -- only its presence matters here, never its
 *  fields, since none of these tests look inside a resolved journey. */
const STUB_JOURNEY: RealtimeJourney = {
  lineRef: "1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
  originAimedDeparture: null, operatorRef: null, publishedLineName: null,
  vehicleRef: null, confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
};

function resolvedJourney(tripIdx: number): ResolvedJourney {
  return { tripIdx, journey: STUB_JOURNEY, byStopIdx: new Map() };
}

/** Stands in for real timers, exactly like poller.test.ts's own double:
 *  `setTimeout` never fires on its own, a test fires a captured `fn()`
 *  explicitly. */
function makeFakeScheduler(): { scheduler: PollerScheduler; scheduled: (() => void | Promise<void>)[] } {
  const scheduled: (() => void | Promise<void>)[] = [];
  const scheduler: PollerScheduler = {
    setTimeout(fn) {
      scheduled.push(fn);
      const handle: PollerTimerHandle = { unref() {} };
      return handle;
    },
    clearTimeout() {},
  };
  return { scheduler, scheduled };
}

test("GET /meta reports the feed version and service window", async () => {
  const { app, index } = await serve(true);
  const body = (await app.inject({ url: "/meta" })).json() as {
    version: string; serviceWindow: { start: number; end: number };
    index: { state: string };
  };
  assert.equal(body.version, "2026-08-21T16-10-22-006Z");
  assert.deepEqual(body.serviceWindow, { start: 20260821, end: 20260920 });
  assert.equal(body.index.state, "ready");
  await app.close(); index.stop();
});

test("GET /ready is 503 before an index exists and 200 after", async () => {
  const { app, index } = await serve(false);
  assert.equal((await app.inject({ url: "/ready" })).statusCode, 503);
  await index.rebuild();
  assert.equal((await app.inject({ url: "/ready" })).statusCode, 200);
  await app.close(); index.stop();
});

test("GET /health answers even without an index", async () => {
  const { app, index } = await serve(false);
  assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
  await app.close(); index.stop();
});

test("POST /admin/reload returns 202 for an authorised caller", async () => {
  const { app, index } = await serve(true);
  const res = await app.inject({
    method: "POST", url: "/admin/reload",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { status: "started" });
  await app.close(); index.stop();
});

// The endpoint starts a ~400 MB rebuild on a permissively-CORS'd public
// server. An anonymous caller must not be able to hold one running.
test("POST /admin/reload is 401 without a token, with a wrong token, and with a non-bearer header", async () => {
  const { app, index } = await serve(true);
  for (const headers of [
    {},
    { authorization: `Bearer ${ADMIN_TOKEN}x` },
    { authorization: ADMIN_TOKEN },
    { authorization: "Basic dXNlcjpwYXNz" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/admin/reload", headers });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { code: string }).code, "unauthorized");
  }
  await app.close(); index.stop();
});

// FAIL CLOSED. An unset TRANSIT_ADMIN_TOKEN must refuse everything rather
// than admit everyone -- including a caller who presents no token at all,
// and a caller who guesses the empty string.
test("POST /admin/reload refuses every request when no token is configured", async () => {
  const { app, index } = await serve(true, null);
  for (const headers of [{}, { authorization: "Bearer " }, { authorization: "Bearer anything" }]) {
    assert.equal(
      (await app.inject({ method: "POST", url: "/admin/reload", headers })).statusCode,
      401,
    );
  }
  await app.close(); index.stop();
});

// The fetcher publishes a new version by unlinking the symlink and
// recreating it. A reload landing inside that window is a transient state
// and must not reach `resolveLiveTarget`'s raw throw, which would answer 500
// with the symlink's ABSOLUTE SERVER PATH in the body: 503, and no path.
test("POST /admin/reload is 503 (never 500, never a path) while the live symlink is absent", async () => {
  const { app, index, dir } = await serve(true);
  unlinkSync(join(dir, "gtfs.sqlite"));
  const res = await app.inject({
    method: "POST", url: "/admin/reload",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(res.statusCode, 503);
  const body = res.json() as { code: string; message: string };
  assert.equal(body.code, "live_database_unavailable");
  assert.doesNotMatch(body.message, /\//, "no filesystem path may appear in the body");
  assert.doesNotMatch(res.body, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await app.close(); index.stop();
});

// The same transience, one level down: even if the symlink vanishes between
// the route's check and the rebuild, `rebuild()` must REJECT rather than
// throw synchronously -- `void index.rebuild().catch(...)` (how both the
// route and the poller call it) does not catch a synchronous throw.
test("IndexManager.rebuild rejects rather than throwing when the symlink is gone", async () => {
  const { app, index, dir } = await serve(true);
  unlinkSync(join(dir, "gtfs.sqlite"));
  assert.equal(index.liveTarget(), null);
  let rejected = false;
  // Deliberately called WITHOUT try/catch around the call itself: a
  // synchronous throw here would fail the test outright, which is the point.
  const p = index.rebuild();
  await p.catch(() => { rejected = true; });
  assert.equal(rejected, true);
  await app.close(); index.stop();
});

// /ready's 200 body is a SUCCESS body and keeps its own shape; its 503 is an
// error and must use the one shared envelope, so a client parsing failures
// needs no special case for this route.
test("GET /ready's 503 uses the shared error envelope while its 200 keeps its own shape", async () => {
  const { app, index } = await serve(false);
  const notReady = await app.inject({ url: "/ready" });
  assert.equal(notReady.statusCode, 503);
  assert.equal(notReady.headers["retry-after"], "5");
  const err = notReady.json() as {
    statusCode: number; code: string; message: string; requestId: string;
    details: { state: string };
  };
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "index_not_ready");
  assert.equal(err.details.state, "empty");
  assert.equal(typeof err.requestId, "string");

  await index.rebuild();
  const ready = await app.inject({ url: "/ready" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { ready: true, state: "ready" });
  await app.close(); index.stop();
});

/** The `streams` block `/meta` reports when no `SiriPoller` was ever
 * supplied -- `app.realtimeStreamStatuses`'s own default (server.ts). */
const NEVER_POLLED_STREAMS = {
  "active-calls": { lastSuccessAt: null, failures: 0, lastError: null },
  planned: { lastSuccessAt: null, failures: 0, lastError: null },
};

test("/meta reports realtime disabled when no key is configured", async () => {
  const { app, index } = await serve(true);
  const body = (await app.inject({ url: "/meta" })).json() as { realtime: unknown };
  assert.deepEqual(body.realtime, {
    source: null, health: "disabled", ageSeconds: null, journeys: 0, resolved: 0, unresolved: 0,
    resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0, streams: NEVER_POLLED_STREAMS, shift: null,
  });
  await app.close(); index.stop();
});

// A CONFIGURED store that has never (yet) received a usable snapshot --
// at boot before the first poll succeeds, or
// right after an index swap invalidates it -- must not read identically to
// "no key configured at all". Both would otherwise report "disabled" (that
// string is store.ts's own vocabulary for "never got anything"), which is
// exactly the confusion this health block exists to prevent: an operator
// with a correctly configured key would see the same string as one who
// forgot it.
test("/meta reports stale, not disabled, for a configured store that has not yet received data", async () => {
  const store = new RealtimeStore("siri-sm", 180); // never replace()'d
  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store });
  const body = (await app.inject({ url: "/meta" })).json() as { realtime: unknown };
  assert.deepEqual(body.realtime, {
    source: "siri-sm", health: "stale", ageSeconds: null, journeys: 0, resolved: 0, unresolved: 0,
    resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0, streams: NEVER_POLLED_STREAMS, shift: null,
  });
  await app.close(); index.stop();
});

test("/meta reports health, age and resolution rate when a store is present", async () => {
  // Real wall-clock fetchedAt: RealtimeStore.status(now) takes the CALLER's
  // instant (meta.ts uses Date.now()/1000), not the store's own injected
  // clock -- see store.ts's own comment on that split. A fixed test
  // timestamp far from "now" would make this report "stale" regardless of
  // maxAgeSeconds.
  const fetchedAt = Date.now() / 1000;
  const store = new RealtimeStore("siri-sm", 180);
  store.replace(
    [resolvedJourney(1), resolvedJourney(2)],
    { resolved: 2, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0 },
    fetchedAt,
  );

  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store });
  const body = (await app.inject({ url: "/meta" })).json() as {
    realtime: { health: string; ageSeconds: number; journeys: number; resolved: number; unresolved: number };
  };
  assert.equal(body.realtime.health, "ok");
  assert.equal(body.realtime.journeys, 3);
  assert.equal(body.realtime.resolved, 2);
  assert.equal(body.realtime.unresolved, 1);
  assert.equal(typeof body.realtime.ageSeconds, "number");
  assert.ok(body.realtime.ageSeconds >= 0 && body.realtime.ageSeconds < 5);
  await app.close(); index.stop();
});

test("/meta reports slot-matched and unscheduled counts", async () => {
  const store = new RealtimeStore("open-bus-vm", 180);
  store.replace(
    [resolvedJourney(1)],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 1, unscheduled: 2 },
    Date.now() / 1000,
  );
  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store });
  const body = (await app.inject({ url: "/meta" })).json() as { realtime: { attached: number; unscheduled: number; journeys: number } };
  assert.equal(body.realtime.attached, 1);
  assert.equal(body.realtime.unscheduled, 2);
  assert.equal(body.realtime.journeys, 3);
  await app.close(); index.stop();
});

// "failing" folds the poller's own tick outcomes into a store that, by
// itself, still reports "ok" (its last snapshot is fresh) -- the exact
// silent-degradation window the health block exists to catch.
test("/meta reports failing when the poller has consecutive failures, even though the store itself is fresh", async () => {
  const store = new RealtimeStore("siri-sm", 180);
  store.replace(
    [resolvedJourney(1)],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    Date.now() / 1000,
  );
  const realtimePoller = { consecutiveFailures: 3, streamStatuses: NEVER_POLLED_STREAMS };

  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store, realtimePoller });
  const body = (await app.inject({ url: "/meta" })).json() as { realtime: { health: string } };
  assert.equal(body.realtime.health, "failing");
  await app.close(); index.stop();
});

// The key is a URL query parameter (buildSnapshotUrl), so anything that
// logs a request URL leaks it unless redacted -- this proves the whole
// wired path (a real SiriPoller, a real failing tick, and /meta reading the
// resulting store+poller) never lets it through anywhere observable.
test("the key never appears in /meta, in a log line, or in an error body", async () => {
  const SECRET = "TOTALLY-SECRET-MOT-KEY-0xDEADBEEF";
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const warnings: string[] = [];
  const logger: SiriLogger = { warn: (m) => warnings.push(m) };
  const { scheduler, scheduled } = makeFakeScheduler();

  const poller = new SiriPoller({
    baseUrl: "https://mot.example.test",
    key: SECRET,
    pollSeconds: 30,
    plannedPollSeconds: 60,
    maxAgeSeconds: 180,
    store,
    resolve: () => ({
      resolved: [], stats: { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    }),
    fetchJson: async () => { throw new Error("network down"); },
    logger,
    scheduler,
    now: () => 1_000,
  });
  poller.start();
  // Both streams' first tick -- each rejects, so each logs a warning.
  for (const fn of [...scheduled]) await fn();
  assert.ok(warnings.length >= 1);
  for (const w of warnings) assert.doesNotMatch(w, new RegExp(SECRET));
  assert.equal(poller.consecutiveFailures, 1);

  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store, realtimePoller: poller });

  const metaRes = await app.inject({ url: "/meta" });
  assert.doesNotMatch(metaRes.body, new RegExp(SECRET));
  const metaBody = metaRes.json() as {
    realtime: {
      health: string;
      streams: Record<string, { lastSuccessAt: number | null; failures: number; lastError: string | null }>;
    };
  };
  assert.equal(metaBody.realtime.health, "failing");
  // The per-stream block is where an operator would actually read the
  // failure text -- it must carry it. The binding constraint is stricter
  // for /meta than for a log line: "no base URL" (not merely "no key") --
  // so this must contain neither, even though the SAME failure's log line
  // (asserted on above) legitimately does carry the (key-redacted) base URL
  // for on-box debugging.
  for (const filter of ["active-calls", "planned"] as const) {
    const s = metaBody.realtime.streams[filter]!;
    assert.equal(s.failures, 1);
    assert.equal(s.lastSuccessAt, null);
    assert.ok(s.lastError !== null);
    assert.doesNotMatch(s.lastError, new RegExp(SECRET));
    // An unclassified thrown error collapses to the
    // fixed "fetch failed" in the PUBLIC lastError, never the raw message
    // -- see poller.ts's `tick` catch block. The raw "network down" text
    // (asserted nowhere here) still reaches the log line above.
    assert.equal(s.lastError, "fetch failed");
    assert.doesNotMatch(s.lastError, /mot\.example|https?:\/\//, "no base URL in a public /meta body");
  }

  // Same shared error envelope every other error in this service uses.
  const errRes = await app.inject({ url: "/does-not-exist" });
  assert.doesNotMatch(errRes.body, new RegExp(SECRET));

  poller.stop();
  await app.close(); index.stop();
});

// ---------------------------------------------------------------------
// Reproduces the leak end to end -- a real `createFetchJson` (not a stub)
// against a real local HTTP server whose 401 body echoes the request's key
// back as a literal JSON field (the ICD §9 behaviour this excerpt exists to
// surface at all), run through a real `SiriPoller` tick and read back off a
// real `/meta`.
// ---------------------------------------------------------------------

test("a 401 body that echoes the key as a JSON field never reaches /meta -- reproduced end to end", async () => {
  const SECRET = "REPRO-SECRET-KEY-0xFEEDFACE";
  const server = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "unauthorized",
      Key: SECRET, // literal key as a plain JSON field -- not URL-shaped
      request: `http://mot.example.test${req.url}`, // also echoed inside a URL
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const store = new RealtimeStore("siri-sm", 180, () => 1_000);
    const { scheduler, scheduled } = makeFakeScheduler();
    const poller = new SiriPoller({
      baseUrl: `http://127.0.0.1:${port}`,
      key: SECRET,
      pollSeconds: 30,
      plannedPollSeconds: 60,
      maxAgeSeconds: 180,
      store,
      resolve: () => ({
        resolved: [], stats: { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
      }),
      fetchJson: createFetchJson(5_000, SECRET),
      scheduler,
      now: () => 1_000,
    });
    poller.start();
    for (const fn of [...scheduled]) await fn();

    const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store, realtimePoller: poller });
    const metaRes = await app.inject({ url: "/meta" });
    assert.doesNotMatch(metaRes.body, new RegExp(SECRET), "the literal key must never reach /meta");
    const body = metaRes.json() as {
      realtime: { streams: Record<string, { lastError: string | null }> };
    };
    // The fixed vocabulary, not a body-derived excerpt at all -- see
    // poller.ts's `TickError`/`tick` catch block.
    assert.equal(body.realtime.streams["active-calls"]!.lastError, "HTTP 401");

    poller.stop();
    await app.close(); index.stop();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------
// /meta must be able to say WHICH stream is broken, not only "at least one
// is".
// ---------------------------------------------------------------------

test("/meta's per-stream block tells one dead stream apart from a healthy one", async () => {
  const store = new RealtimeStore("siri-sm", 180);
  store.replace(
    [resolvedJourney(1)],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    Date.now() / 1000,
  );
  const realtimePoller = {
    consecutiveFailures: 4,
    streamStatuses: {
      "active-calls": { lastSuccessAt: Date.now() / 1000, failures: 0, lastError: null },
      // No base URL here, even key-redacted -- see poller.ts's own comment
      // on `streamDiagnostics`: `lastError` is the bare error detail, never
      // the full log line, precisely because this value is read straight
      // into a public /meta response.
      // Matches the fixed vocabulary a real TickError would carry as its
      // publicSummary (poller.ts) -- see that file for the full list.
      planned: { lastSuccessAt: null, failures: 4, lastError: "HTTP 401" },
    },
  };

  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store, realtimePoller });
  const body = (await app.inject({ url: "/meta" })).json() as {
    realtime: {
      streams: Record<string, { lastSuccessAt: number | null; failures: number; lastError: string | null }>;
    };
  };
  assert.deepEqual(body.realtime.streams["active-calls"], {
    lastSuccessAt: realtimePoller.streamStatuses["active-calls"].lastSuccessAt, failures: 0, lastError: null,
  });
  assert.equal(body.realtime.streams.planned!.failures, 4);
  assert.equal(body.realtime.streams.planned!.lastSuccessAt, null);
  assert.match(body.realtime.streams.planned!.lastError!, /HTTP 401/);
  await app.close(); index.stop();
});

test("/meta names the configured realtime source even before any poll succeeds", async () => {
  // An operator diagnosing a silent process needs to know which feed it
  // would read; "disabled" alone cannot distinguish "off" from "configured,
  // nothing received yet".
  const store = new RealtimeStore("stride-vm", 180, () => 1000);
  const { app, index } = await serve(true, ADMIN_TOKEN, { realtime: store });
  const body = (await app.inject({ url: "/meta" })).json() as {
    realtime: { source: string | null; health: string };
  };
  assert.equal(body.realtime.source, "stride-vm");
  await app.close(); index.stop();
});
