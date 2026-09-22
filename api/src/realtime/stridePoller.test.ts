import { test } from "node:test";
import assert from "node:assert/strict";
import { StridePoller } from "./stridePoller.js";
import { RealtimeStore } from "./store.js";
import type { SiriLogger } from "./poller.js";
import type { PollerScheduler, PollerTimerHandle } from "./stream.js";
import type { RealtimeJourney } from "./types.js";
import type { ResolvedJourney, MatchStats } from "./match.js";

const NOW = Math.floor(Date.parse("2026-09-01T10:46:00Z") / 1000);
const POLL_SECONDS = 60;
const PAGE_LIMIT = 5;
const SNAPSHOT_ID = 2_381_539;

/** One well-formed Stride row, fresh relative to NOW. */
function strideRow(i: number): Record<string, unknown> {
  return {
    siri_route__line_ref: 8179,
    siri_route__operator_ref: 15,
    siri_ride__journey_ref: `2026-09-01-${500000000 + i}`,
    siri_ride__scheduled_start_time: "2026-09-01T10:20:00+00:00",
    siri_ride__vehicle_ref: String(37900000 + i),
    recorded_at_time: "2026-09-01T10:45:00+00:00",
    lat: 31.25, lon: 34.81,
    distance_from_journey_start: 100 * i,
  };
}

function rows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => strideRow(i));
}

interface ScheduledCall { fn: () => void | Promise<void>; ms: number }

/**
 * Drives time explicitly: `setTimeout` never fires on its own, so a test
 * runs exactly one tick by awaiting the captured callback. No test here
 * waits on a real interval.
 */
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
  poller: StridePoller;
  store: RealtimeStore;
  urls: string[];
  warnings: string[];
  scheduled: ScheduledCall[];
  /** Fires the most recently scheduled tick and awaits it. */
  runNext: () => Promise<void>;
}

/**
 * `pages` is served in order, one entry per request. `fail` rejects every
 * fetch; `failFirst` rejects only the first, so a test can watch the
 * backoff reset.
 */
function harness(opts: {
  pages?: unknown[];
  snapshots?: unknown;
  fail?: boolean;
  failFirst?: boolean;
  limit?: number;
  maxPages?: number;
} = {}): Harness {
  const { scheduler, scheduled } = fakeScheduler();
  const urls: string[] = [];
  const warnings: string[] = [];
  const store = new RealtimeStore("stride-vm", 180, () => NOW);
  const pages = opts.pages ?? [rows(3)];
  let calls = 0;
  let snapshotCalls = 0;

  const logger: SiriLogger = {
    warn: (m) => warnings.push(m),
    info: () => {},
  };

  // A resolver that "matches" everything, so these tests exercise the
  // poller's own fetching, paging and failure handling rather than
  // re-testing match.ts.
  const resolve = (journeys: readonly RealtimeJourney[]) => ({
    resolved: journeys.map((journey, i) => ({
      tripIdx: i, journey, byStopIdx: new Map(),
    })) as ResolvedJourney[],
    stats: {
      resolved: journeys.length, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0,
    } satisfies MatchStats,
  });

  const poller = new StridePoller({
    baseUrl: "https://stride.test",
    pollSeconds: POLL_SECONDS,
    maxVehicleAgeSeconds: 600,
    pageLimit: opts.limit ?? PAGE_LIMIT,
    maxPages: opts.maxPages ?? 3,
    bbox: { minLat: 29.4, maxLat: 33.4, minLon: 34.2, maxLon: 35.9 },
    store,
    resolve,
    fetchJson: async (url) => {
      urls.push(url);
      // Every tick opens with the snapshot list, so the harness answers that
      // first and only then walks `pages` for the vehicle requests.
      if (url.includes("/siri_snapshots/list")) {
        if (opts.fail === true) throw new Error("network down");
        if (opts.failFirst === true && snapshotCalls++ === 0) {
          throw new Error("network down");
        }
        return opts.snapshots ?? [{ id: SNAPSHOT_ID, etl_status: "loaded" }];
      }
      const n = calls++;
      if (opts.fail === true) throw new Error("network down");
      return pages[n] ?? [];
    },
    now: () => NOW,
    logger,
    scheduler,
  });

  return {
    poller, store, urls, warnings, scheduled,
    runNext: async () => {
      const call = scheduled.at(-1);
      assert.ok(call !== undefined, "expected a scheduled tick");
      await call.fn();
    },
  };
}

/** Just the vehicle-location requests, dropping the snapshot-list one that
 *  now opens every tick. */
function vehicleUrls(h: Harness): string[] {
  return h.urls.filter((u) => u.includes("/siri_vehicle_locations/list"));
}

test("a tick inside one page resolves and stores every journey", async () => {
  const h = harness({ pages: [rows(3)] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 1);
  assert.equal(h.store.status(NOW).resolved, 3);
  assert.equal(h.store.status(NOW).health, "ok");
});

test("pages until a short page ends the tick", async () => {
  const h = harness({ limit: 5, pages: [rows(5), rows(5), rows(2)] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 3);
  assert.match(vehicleUrls(h)[1]!, /offset=5/);
  assert.match(vehicleUrls(h)[2]!, /offset=10/);
  assert.equal(h.store.status(NOW).resolved, 12);
  assert.equal(h.warnings.length, 0, "a naturally-ended page walk is not a shortfall");
});

test("stops at maxPages and logs the shortfall rather than walking forever", async () => {
  const h = harness({ limit: 5, maxPages: 2, pages: [rows(5), rows(5), rows(5)] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 2);
  // Bounded coverage must never present as full coverage.
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!, /2 pages/);
  assert.match(h.warnings[0]!, /10 rows/);
  assert.match(h.warnings[0]!, /STRIDE_MAX_PAGES/);
  // The rows it DID get are still stored -- a truncated tick is degraded,
  // not failed.
  assert.equal(h.store.status(NOW).resolved, 10);
});

test("an exactly-full single page that is also the last allowed page warns", async () => {
  const h = harness({ limit: 5, maxPages: 1, pages: [rows(5)] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.warnings.length, 1);
});

test("a page that exactly fills the limit but has no successor does not warn", async () => {
  const h = harness({ limit: 5, maxPages: 3, pages: [rows(5), []] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 2);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.store.status(NOW).resolved, 5);
});

test("a failed fetch fails the tick and backs off", async () => {
  const h = harness({ fail: true });
  h.poller.start();
  const firstDelay = h.scheduled.at(-1)!.ms;
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 1);
  assert.ok(h.scheduled.at(-1)!.ms > firstDelay, "a failure must lengthen the next delay");
  // Nothing was ever stored, so the store still reads as never-received.
  assert.equal(h.store.status(NOW).health, "disabled");
});

test("the abuse-cap error body is a failure, not a legitimately empty snapshot", async () => {
  // This is the trap: parseStrideRows reports a well-formed EMPTY snapshot
  // for any non-array body, so without an explicit Array.isArray check the
  // tick would look successful and silently wipe the store.
  const h = harness({
    pages: [{ message: "due to abuse, maximum limit per request is 15000 items" }],
  });
  h.poller.start();
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 1);
  assert.equal(h.store.status(NOW).health, "disabled");
});

test("an empty array is a quiet feed, not a failure", async () => {
  const h = harness({ pages: [[]] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 0);
  assert.equal(h.store.status(NOW).resolved, 0);
  assert.equal(h.store.status(NOW).health, "ok");
});

test("a partial page walk is discarded rather than stored half-national", async () => {
  let n = 0;
  const { scheduler, scheduled } = fakeScheduler();
  const store = new RealtimeStore("stride-vm", 180, () => NOW);
  const poller = new StridePoller({
    baseUrl: "https://stride.test",
    pollSeconds: POLL_SECONDS,
    maxVehicleAgeSeconds: 600,
    pageLimit: 5,
    maxPages: 3,
    bbox: { minLat: 29.4, maxLat: 33.4, minLon: 34.2, maxLon: 35.9 },
    store,
    resolve: (journeys) => ({
      resolved: [] as ResolvedJourney[],
      stats: {
        resolved: journeys.length, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0,
      },
    }),
    // First page succeeds and is full; the second throws.
    fetchJson: async () => {
      if (n++ === 0) return rows(5);
      throw new Error("network down");
    },
    now: () => NOW,
    scheduler,
  });
  poller.start();
  await scheduled.at(-1)!.fn();
  assert.equal(poller.consecutiveFailures, 1);
  assert.equal(store.status(NOW).health, "disabled", "a partial snapshot must not be stored");
});

test("a successful tick after a failure resets the backoff", async () => {
  const h = harness({ failFirst: true, pages: [rows(3)] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 1);
  await h.runNext();
  assert.equal(h.poller.consecutiveFailures, 0);
  assert.equal(h.scheduled.at(-1)!.ms, POLL_SECONDS * 1000);
});

test("ghost rows are dropped before matching", async () => {
  const stale = { ...strideRow(0), recorded_at_time: "2026-09-01T09:00:00+00:00" };
  const h = harness({ pages: [[strideRow(1), stale]] });
  h.poller.start();
  await h.runNext();
  assert.equal(h.store.status(NOW).resolved, 1);
});

test("every request carries the configured bbox", async () => {
  const h = harness({ pages: [rows(1)] });
  h.poller.start();
  await h.runNext();
  assert.match(vehicleUrls(h)[0]!, /lat__greater_or_equal=29\.4/);
  assert.match(vehicleUrls(h)[0]!, /lon__lower_or_equal=35\.9/);
});

test("stop() prevents any further tick from being scheduled", async () => {
  const h = harness({ pages: [rows(1)] });
  h.poller.start();
  await h.runNext();
  const after = h.scheduled.length;
  h.poller.stop();
  await h.runNext();
  assert.equal(h.scheduled.length, after, "a stopped poller must not rearm");
});

// ---------------------------------------------------------------------
// Snapshot scoping. Found by running the real service: an unscoped query
// returns every vehicle once per snapshot in the window (measured: 45,000
// rows for 8,841 distinct rides), and because rows arrive newest-first the
// store ended up holding each vehicle's OLDEST position.
// ---------------------------------------------------------------------

test("every vehicle request is scoped to the newest loaded snapshot", async () => {
  const h = harness({
    snapshots: [
      // Newest, but still being written -- must be skipped.
      { id: 900, etl_status: "loading" },
      { id: 899, etl_status: "loaded" },
      { id: 898, etl_status: "loaded" },
    ],
    pages: [rows(3)],
  });
  h.poller.start();
  await h.runNext();
  for (const u of vehicleUrls(h)) assert.match(u, /siri_snapshot_ids=899/);
});

test("a still-loading snapshot is skipped — a partial write looks like an empty country", async () => {
  const h = harness({ snapshots: [{ id: 900, etl_status: "loading" }], pages: [rows(3)] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 0, "must not query a half-written snapshot");
  assert.equal(h.poller.consecutiveFailures, 1);
  assert.match(h.warnings[0]!, /no loaded snapshot/);
});

test("a failed snapshot-list request fails the tick without querying vehicles", async () => {
  const h = harness({ snapshots: { message: "boom" }, pages: [rows(3)] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 0);
  assert.equal(h.poller.consecutiveFailures, 1);
});

test("one snapshot's worth of vehicles fits in a single page, so no truncation warning", async () => {
  // The whole point of scoping: ~9,700 vehicles in a snapshot against a
  // 15,000 cap. Before this, the poller walked maxPages every single tick
  // and warned about incomplete coverage that was not actually incomplete.
  const h = harness({ limit: 15_000, maxPages: 3, pages: [rows(9_700)] });
  h.poller.start();
  await h.runNext();
  assert.equal(vehicleUrls(h).length, 1);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.store.status(NOW).resolved, 9_700);
});
