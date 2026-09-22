import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";
import { OpenBusPoller, createFetchSnapshot } from "./openBusPoller.js";
import { RealtimeStore } from "./store.js";
import type { SiriLogger } from "./poller.js";
import type { PollerScheduler, PollerTimerHandle } from "./stream.js";
import type { RealtimeJourney } from "./types.js";
import type { ResolvedJourney, MatchStats, UnscheduledRun } from "./match.js";

/** The recorded 2026-09-10 08:30 snapshot `openBus.test.ts` documents:
 *  six visits, four usable at NOW (one ghost, one with no LineRef). */
const SNAPSHOT: unknown = JSON.parse(
  readFileSync(new URL("./openBus.fixture.json", import.meta.url), "utf8"),
);
const NOW = Math.floor(Date.parse("2026-09-10T05:30:30Z") / 1000);
const POLL_SECONDS = 20;
const BASE = "https://requester.test";

function status(id: string): unknown {
  return { last_snapshot_id: id, last_datetime_utc: "2026-09-10 05:30:26" };
}

interface ScheduledCall { fn: () => void | Promise<void>; ms: number }

function fakeScheduler(): { scheduler: PollerScheduler; scheduled: ScheduledCall[] } {
  const scheduled: ScheduledCall[] = [];
  const scheduler: PollerScheduler = {
    setTimeout(fn, ms) {
      scheduled.push({ fn, ms });
      return { unref() {} } as PollerTimerHandle;
    },
    clearTimeout() {},
  };
  return { scheduler, scheduled };
}

interface Harness {
  poller: OpenBusPoller;
  store: RealtimeStore;
  statusUrls: string[];
  snapshotUrls: string[];
  warnings: string[];
  scheduled: ScheduledCall[];
  runNext: () => Promise<void>;
}

/**
 * `statuses` and `snapshots` are served in order, one per request; the last
 * entry repeats. A value that is an `Error` is thrown instead of returned.
 */
function harness(opts: {
  statuses?: unknown[];
  snapshots?: unknown[];
  now?: () => number;
  unscheduled?: UnscheduledRun[];
} = {}): Harness {
  const { scheduler, scheduled } = fakeScheduler();
  const statusUrls: string[] = [];
  const snapshotUrls: string[] = [];
  const warnings: string[] = [];
  const now = opts.now ?? (() => NOW);
  const store = new RealtimeStore("open-bus-vm", 180, now);
  const statuses = opts.statuses ?? [status("2026/09/10/05/30")];
  const snapshots = opts.snapshots ?? [SNAPSHOT];

  const serve = (list: unknown[], i: number): unknown => {
    const v = list[Math.min(i, list.length - 1)];
    if (v instanceof Error) throw v;
    return v;
  };

  const logger: SiriLogger = { warn: (m) => warnings.push(m), info: () => {} };

  // Matches everything, so these tests exercise fetching, dedupe and failure
  // handling rather than re-testing match.ts.
  const resolve = (journeys: readonly RealtimeJourney[]) => ({
    resolved: journeys.map((journey, i) => ({ tripIdx: i, journey, byStopIdx: new Map() })) as ResolvedJourney[],
    unscheduled: opts.unscheduled ?? [],
    stats: { resolved: journeys.length, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 } satisfies MatchStats,
  });

  const poller = new OpenBusPoller({
    baseUrl: BASE,
    pollSeconds: POLL_SECONDS,
    maxVehicleAgeSeconds: 600,
    store,
    resolve,
    fetchJson: async (url) => {
      statusUrls.push(url);
      return serve(statuses, statusUrls.length - 1);
    },
    fetchSnapshot: async (url) => {
      snapshotUrls.push(url);
      return serve(snapshots, snapshotUrls.length - 1);
    },
    now,
    logger,
    scheduler,
  });

  return {
    poller, store, statusUrls, snapshotUrls, warnings, scheduled,
    runNext: async () => {
      const call = scheduled.at(-1);
      assert.ok(call !== undefined, "expected a scheduled tick");
      await call.fn();
    },
  };
}

test("a tick reads the status, fetches that minute's snapshot, and stores its journeys", async () => {
  const h = harness();
  h.poller.start();
  await h.runNext();
  assert.deepEqual(h.statusUrls, [`${BASE}/daemon_status.json`]);
  assert.deepEqual(h.snapshotUrls, [`${BASE}/2026/09/10/05/30.br`]);
  // Six visits: the ghost and the one with no LineRef never reach the resolver.
  assert.equal(h.store.status(NOW).resolved, 4);
  assert.equal(h.store.status(NOW).health, "ok");
  assert.equal(h.poller.consecutiveFailures, 0);
});

test("a tick hands the resolver's unscheduled runs to the store", async () => {
  const run: UnscheduledRun = {
    templateTripIdx: 0, offsetSeconds: -300, serviceBaseEpoch: 0,
    journey: {
      lineRef: "17633", directionId: null, dataFrameRef: "2026-09-10", datedVehicleJourneyRef: null,
      originAimedDeparture: null, operatorRef: null, publishedLineName: null, vehicleRef: "extra",
      confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
    },
    byStopIdx: new Map([[7, { expectedArrival: NOW + 300, ambiguous: false }]]),
  };
  const h = harness({ unscheduled: [run] });
  h.poller.start();
  await h.runNext();
  assert.deepEqual(h.store.unscheduledAtStop(7).map((e) => e.run.journey.vehicleRef), ["extra"]);
});

test("a minute already stored is not fetched again, and the tick still succeeds", async () => {
  // The status is polled every 20 s but changes once a minute; re-downloading
  // the same ~270 KB file three times a minute is load on a volunteer-run
  // server for nothing.
  const h = harness();
  h.poller.start();
  await h.runNext();
  await h.runNext();
  await h.runNext();
  assert.equal(h.statusUrls.length, 3);
  assert.equal(h.snapshotUrls.length, 1);
  assert.equal(h.poller.consecutiveFailures, 0);
  assert.equal(h.scheduled.at(-1)!.ms, POLL_SECONDS * 1000, "an unchanged minute is not a failure to back off from");
});

test("an unchanged minute leaves the store's age running, so a stalled requester goes stale", async () => {
  // If their requester stops, the id stops changing. Re-stamping the old
  // snapshot as freshly fetched would keep serving it as live forever.
  let now = NOW;
  const h = harness({ now: () => now });
  h.poller.start();
  await h.runNext();
  now += 200;
  await h.runNext();
  assert.equal(h.store.status(now).health, "stale");
});

test("a new minute replaces the store", async () => {
  let now = NOW;
  const h = harness({
    now: () => now,
    statuses: [status("2026/09/10/05/30"), status("2026/09/10/05/31")],
    snapshots: [SNAPSHOT, { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{ MonitoredStopVisit: [] }] } } }],
  });
  h.poller.start();
  await h.runNext();
  now += 60;
  await h.runNext();
  assert.deepEqual(h.snapshotUrls, [`${BASE}/2026/09/10/05/30.br`, `${BASE}/2026/09/10/05/31.br`]);
  assert.equal(h.store.status(now).resolved, 0);
  assert.equal(h.store.status(now).ageSeconds, 0);
});

test("a status with no usable snapshot id fails the tick without fetching a snapshot", async () => {
  const h = harness({ statuses: [{ last_snapshot_id: "../../secrets" }] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.snapshotUrls.length, 0);
  assert.equal(h.poller.consecutiveFailures, 1);
  assert.match(h.warnings[0]!, /snapshot id/);
  assert.equal(h.store.status(NOW).health, "disabled");
});

test("a snapshot body that is not a SIRI delivery fails the tick and leaves the store untouched", async () => {
  const h = harness({ snapshots: [{ message: "not found" }] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 1);
  assert.equal(h.store.status(NOW).health, "disabled");
});

test("a failed snapshot fetch is retried on the next tick, not skipped as done", async () => {
  const h = harness({ snapshots: [new Error("connection reset"), SNAPSHOT] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 1);
  await h.runNext();
  assert.equal(h.snapshotUrls.length, 2);
  assert.equal(h.snapshotUrls[1], `${BASE}/2026/09/10/05/30.br`);
  assert.equal(h.store.status(NOW).resolved, 4);
  assert.equal(h.poller.consecutiveFailures, 0);
});

test("a failed status fetch fails the tick and backs off", async () => {
  const h = harness({ statuses: [new Error("network down")] });
  h.poller.start();
  const firstDelay = h.scheduled.at(-1)!.ms;
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 1);
  assert.ok(h.scheduled.at(-1)!.ms > firstDelay, "a failure must lengthen the next delay");
});

test("stop() prevents any further tick from being scheduled", async () => {
  const h = harness();
  h.poller.start();
  await h.runNext();
  const after = h.scheduled.length;
  h.poller.stop();
  await h.runNext();
  assert.equal(h.scheduled.length, after, "a stopped poller must not rearm");
});

// ---- createFetchSnapshot, against a real local server ---------------------

async function withServer(
  handler: (url: string) => { status: number; body: Buffer },
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const r = handler(req.url ?? "");
    // What the requester really sends: the brotli bytes as an opaque file,
    // with NO Content-Encoding, so fetch hands them over undecoded.
    res.writeHead(r.status, { "content-type": "application/octet-stream" });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("createFetchSnapshot decodes a brotli-compressed JSON snapshot", async () => {
  await withServer(
    () => ({ status: 200, body: brotliCompressSync(JSON.stringify(SNAPSHOT)) }),
    async (base) => {
      const fetchSnapshot = createFetchSnapshot(2_000);
      assert.deepEqual(await fetchSnapshot(`${base}/2026/09/10/05/30.br`), SNAPSHOT);
    },
  );
});

test("createFetchSnapshot rejects a non-2xx response", async () => {
  await withServer(
    () => ({ status: 404, body: Buffer.from("<html>404</html>") }),
    async (base) => {
      await assert.rejects(createFetchSnapshot(2_000)(`${base}/x.br`), /HTTP 404/);
    },
  );
});

test("createFetchSnapshot rejects bytes that are not brotli", async () => {
  await withServer(
    () => ({ status: 200, body: Buffer.from("definitely not brotli") }),
    async (base) => {
      await assert.rejects(createFetchSnapshot(2_000)(`${base}/x.br`), /decode/);
    },
  );
});

test("createFetchSnapshot rejects a compressed body over its cap", async () => {
  await withServer(
    () => ({ status: 200, body: brotliCompressSync(JSON.stringify(SNAPSHOT)) }),
    async (base) => {
      const fetchSnapshot = createFetchSnapshot(2_000, { maxCompressedBytes: 10 });
      await assert.rejects(fetchSnapshot(`${base}/x.br`), /too large/);
    },
  );
});

test("createFetchSnapshot rejects a body that decodes past its cap, however small it arrived", async () => {
  // A few hundred compressed bytes can expand to gigabytes; the cap on what
  // arrives says nothing about what it decodes to.
  const bomb = brotliCompressSync(Buffer.alloc(5_000_000, 0x20));
  await withServer(
    () => ({ status: 200, body: bomb }),
    async (base) => {
      const fetchSnapshot = createFetchSnapshot(2_000, { maxDecodedBytes: 1_000_000 });
      await assert.rejects(fetchSnapshot(`${base}/x.br`), /too large/);
    },
  );
});
