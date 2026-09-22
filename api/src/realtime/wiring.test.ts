import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestIndex } from "../transit/testIndex.js";
import type { TimetableIndex } from "../transit/index.js";
import type { CalendarRow } from "../transit/calendar.js";
import { baseEpochOfYmd } from "../transit/calendar.js";
import { config } from "../config.js";
import { RealtimeStore } from "./store.js";
import { SiriPoller } from "./poller.js";
import { StridePoller } from "./stridePoller.js";
import { OpenBusPoller } from "./openBusPoller.js";
import {
  createRealtimeResolver, createRealtimeRuntime, invalidateForIndexSwap, type ResolverIndexSource,
} from "./wiring.js";
import type { RealtimeJourney } from "./types.js";
import type { RealtimeConfig } from "../config.js";
import type { PollerScheduler, PollerTimerHandle } from "./poller.js";

const TZ = config.timezone;
const SERVICE_YMD = 20260824;
const SERVICE_DATE = "2026-08-24";

function epochOn(ymd: number, gtfsSeconds: number): number {
  return baseEpochOfYmd(ymd, TZ) + gtfsSeconds;
}

// Runs every day in a wide window, so both indices' single service is
// active on SERVICE_YMD regardless of which index is "current".
const CALENDAR: CalendarRow[] = [{ serviceId: "S1", days: 0b1111111, start: 20260101, end: 20261231 }];

/** Attaches the fields `makeTestIndex` doesn't set but the realtime path
 * needs -- routing (`match.ts`) and day-context (`raptor.ts`) fields alike,
 * mirroring `match.test.ts`'s own `withRealtimeFields` helper. */
function withRealtimeFields(
  ix: TimetableIndex,
  fields: { routeId: string; directionId: number; stopCodes: (string | null)[] },
): TimetableIndex {
  ix.routeIds = [fields.routeId];
  ix.tripRouteIdx = new Int32Array(ix.nTrips).fill(0);
  ix.tripDirection = new Int8Array(ix.nTrips).fill(fields.directionId);
  ix.stopCodes = fields.stopCodes;
  ix.serviceIds = ["S1"];
  ix.tripServiceIdx = new Int32Array(ix.nTrips).fill(0);
  return ix;
}

/** One trip, route `routeId`, direction 0, service S1, stops 0->1, departing
 * 08:00 -- always at tripIdx 0, so two indices built this way collide on
 * the SAME trip index while naming completely different trips. */
function oneTripIndex(routeId: string): TimetableIndex {
  const ix = makeTestIndex(2, [{ stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860] }]);
  return withRealtimeFields(ix, { routeId, directionId: 0, stopCodes: ["S0", "S1"] });
}

function journey(lineRef: string): RealtimeJourney {
  return {
    lineRef, directionId: 0, dataFrameRef: SERVICE_DATE, datedVehicleJourneyRef: null,
    originAimedDeparture: epochOn(SERVICE_YMD, 28800), operatorRef: null, publishedLineName: null,
    vehicleRef: null, confidence: null, lat: null, lon: null, recordedAt: null,
    calls: [{ stopCode: "S1", order: 2, expectedArrival: epochOn(SERVICE_YMD, 28860) }],
    distanceFromStart: null,
  };
}

function fakeSource(getIx: () => TimetableIndex | null): ResolverIndexSource {
  return { current: getIx, currentBundle: () => ({ calendar: CALENDAR }) };
}

test("resolves against the current index when there is one", () => {
  const ixA = oneTripIndex("R1");
  const resolve = createRealtimeResolver(fakeSource(() => ixA), TZ);
  const { resolved, stats } = resolve([journey("R1")], epochOn(SERVICE_YMD, 0));
  assert.equal(stats.resolved, 1);
  assert.equal(stats.unresolved, 0);
  assert.equal(resolved[0]!.tripIdx, 0);
});

test("the resolver hands back a bus whose slot is taken as an unscheduled run", () => {
  const ix = oneTripIndex("R1");
  const resolve = createRealtimeResolver(fakeSource(() => ix), TZ);
  const onTime = { ...journey("R1"), vehicleRef: "on-time" };
  const extra = { ...journey("R1"), vehicleRef: "extra", originAimedDeparture: epochOn(SERVICE_YMD, 28800 - 120) };
  const result = resolve([onTime, extra], epochOn(SERVICE_YMD, 0));
  assert.deepEqual(result.resolved.map((r) => r.journey.vehicleRef), ["on-time"]);
  assert.deepEqual(result.unscheduled?.map((u) => [u.journey.vehicleRef, u.offsetSeconds]), [["extra", -120]]);
});

// ---------------------------------------------------------------------
// `createRealtimeResolver` must offer a "tomorrow"
// DayContext too, not only `buildDayContexts`'s own fixed [today,
// yesterday] -- otherwise a `planned` trip the ministry frames on the NEXT
// service date (an after-midnight run) is silently unresolvable every
// evening.
// ---------------------------------------------------------------------

test("a trip whose service runs only on the day AFTER fetchedAt still resolves (the after-midnight case)", () => {
  // Tuesday 2026-08-25 only -- day bit 4 (sunday=1, monday=2, tuesday=4;
  // see calendar.ts). Deliberately NOT active on 2026-08-24 (fetchedAt's
  // own date) or 2026-08-23: only `[today, yesterday]` would never find
  // this trip active on any day they name, exactly the gap this covers.
  const tomorrowOnlyCalendar: CalendarRow[] = [
    { serviceId: "S1", days: 4, start: 20260825, end: 20260825 },
  ];
  const ix = withRealtimeFields(
    makeTestIndex(2, [{ stops: [0, 1], dep: [2_400, 2_460], arr: [2_400, 2_460] }]), // 00:40, 00:41
    { routeId: "R1", directionId: 0, stopCodes: ["S0", "S1"] },
  );
  const source: ResolverIndexSource = {
    current: () => ix,
    currentBundle: () => ({ calendar: tomorrowOnlyCalendar }),
  };
  const resolve = createRealtimeResolver(source, TZ);

  // fetchedAt: 2026-08-24 22:00 local -- an ordinary evening poll, well
  // before midnight, exactly the affected window.
  const fetchedAt = Date.parse("2026-08-24T22:00:00+03:00") / 1000;
  const tomorrowJourney: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: "2026-08-25", datedVehicleJourneyRef: null,
    originAimedDeparture: epochOn(20260825, 2_400), operatorRef: null, publishedLineName: null,
    vehicleRef: null, confidence: null, lat: null, lon: null, recordedAt: null,
    calls: [{ stopCode: "S1", order: 2, expectedArrival: epochOn(20260825, 2_460) }],
    distanceFromStart: null,
  };

  const { resolved, stats } = resolve([tomorrowJourney], fetchedAt);
  assert.equal(stats.resolved, 1, "a trip framed on TOMORROW's service date must resolve");
  assert.equal(resolved[0]!.tripIdx, 0);

  // Bounded, not unlimited: a journey framed TWO days out (a date this
  // service never runs, and outside [tomorrow, today, yesterday]) must
  // still be unresolved -- proving this offers exactly one extra day, not
  // an open-ended search.
  const twoDaysOutJourney: RealtimeJourney = {
    ...tomorrowJourney, dataFrameRef: "2026-08-26", originAimedDeparture: epochOn(20260826, 2_400),
  };
  const twoDaysOut = resolve([twoDaysOutJourney], fetchedAt);
  assert.equal(twoDaysOut.stats.resolved, 0, "two days out is still out of range");
  assert.equal(twoDaysOut.stats.unresolved, 1);
});

test("every journey is unresolved when there is no index yet", () => {
  const resolve = createRealtimeResolver(fakeSource(() => null), TZ);
  const { resolved, stats } = resolve([journey("R1"), journey("R2")], epochOn(SERVICE_YMD, 0));
  assert.deepEqual(resolved, []);
  assert.equal(stats.resolved, 0);
  assert.equal(stats.unresolved, 2);
});

// The core invariant: the resolver must not outlive its
// bundle. ixA and ixB each have exactly one trip, both at tripIdx 0, but
// for DIFFERENT routes -- exactly the shape a real nightly feed swap
// produces (buildTripLookup's own doc comment: trip indices are dense and
// reused across rebuilds). A resolver that kept using ixA's TripLookup
// after the swap would still find a candidate at tripIdx 0 for R1 (the
// STALE key), and ixB's own day mask would happily mark ixB's tripIdx 0 as
// "active" (it's a real, active trip -- just R2, not R1) -- so the bug this
// guards against is not "throws" or "returns nothing", it is "silently
// resolves to the WRONG trip", which is exactly why this test checks the
// resolved journey's OWN lineRef/tripIdx pairing, not just that something
// resolved.
test("a lookup built against a superseded index does not survive an index swap", () => {
  const ixA = oneTripIndex("R1");
  const ixB = oneTripIndex("R2");
  let current: TimetableIndex = ixA;
  const resolve = createRealtimeResolver(fakeSource(() => current), TZ);

  // Against ixA: R1 resolves (it's ixA's own trip), R2 does not exist here.
  const beforeR1 = resolve([journey("R1")], epochOn(SERVICE_YMD, 0));
  assert.equal(beforeR1.stats.resolved, 1);
  assert.equal(beforeR1.resolved[0]!.tripIdx, 0);
  const beforeR2 = resolve([journey("R2")], epochOn(SERVICE_YMD, 0));
  assert.equal(beforeR2.stats.resolved, 0, "R2 does not exist in ixA");

  // Simulate IndexManager swapping in a fresh index (a feed reload).
  current = ixB;

  // Against ixB: R2 now resolves (ixB's own trip, correctly re-keyed).
  const afterR2 = resolve([journey("R2")], epochOn(SERVICE_YMD, 0));
  assert.equal(afterR2.stats.resolved, 1);
  assert.equal(afterR2.resolved[0]!.tripIdx, 0);
  assert.equal(afterR2.resolved[0]!.journey.lineRef, "R2");

  // R1 no longer exists in ixB and must NOT resolve via a leftover mapping
  // from ixA -- the exact "wrong bus" failure mode this guards against.
  const afterR1 = resolve([journey("R1")], epochOn(SERVICE_YMD, 0));
  assert.equal(afterR1.stats.resolved, 0, "R1's mapping from ixA must not survive the swap");
  assert.equal(afterR1.stats.unresolved, 1);
});

test("invalidateForIndexSwap makes an existing snapshot read as immediately absent", () => {
  let now = 1_000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  store.replace(
    [{ tripIdx: 5, journey: journey("R1"), byStopIdx: new Map([[1, { expectedArrival: 1_500, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    1_000,
  );
  assert.equal(store.predictionFor(5, 1), 1_500);
  assert.equal(store.status(now).health, "ok");

  invalidateForIndexSwap(store);

  // A full reset (RealtimeStore.clear()), not merely "stale": the previous
  // counts describe trips resolved against the SUPERSEDED index, which may
  // not even be the trips those numbers now imply, so they are zeroed
  // rather than carried forward.
  assert.equal(store.predictionFor(5, 1), null);
  assert.equal(store.journeyFor(5), null);
  assert.deepEqual(store.status(now), {
    source: "siri-sm", health: "disabled", ageSeconds: null, journeys: 0, resolved: 0, unresolved: 0,
    resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 0,
  });

  // A later poll succeeding (a fresh replace()) still works normally --
  // invalidation is not a one-way trip into a broken state.
  now = 1_050;
  store.replace(
    [{ tripIdx: 7, journey: journey("R2"), byStopIdx: new Map([[2, { expectedArrival: 1_600, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    now,
  );
  assert.equal(store.predictionFor(7, 2), 1_600);
  assert.equal(store.status(now).health, "ok");
});

// ---- createRealtimeRuntime -----------------------------------------------
//
// The connection between "no key configured" and "no poller, no timer, no
// swap hook" used to live only in index.ts, a side-effecting entrypoint
// script no test can import. These tests exercise that connection directly.

const DISABLED_CFG: RealtimeConfig = {
  enabled: false, source: null, key: null, baseUrl: null, openBus: null, stride: null,
  pollSeconds: 30, plannedPollSeconds: 60, maxAgeSeconds: 180, timeoutMs: 20_000,
};

const ENABLED_CFG: RealtimeConfig = {
  enabled: true, source: "siri-sm", key: "s3cret", baseUrl: "https://mot.example.test",
  openBus: null, stride: null,
  pollSeconds: 30, plannedPollSeconds: 60, maxAgeSeconds: 180, timeoutMs: 20_000,
};

/** Counts (and refuses to actually schedule) every `setTimeout` call, so a
 * test can assert one was never made -- not merely infer it from the
 * import list. `unref()` is a no-op; nothing here ever really waits.
 * `calls()` is a method, not a destructured field, so callers see the LIVE
 * count rather than a value snapshotted at the moment of destructuring. */
function countingScheduler(): { scheduler: PollerScheduler; calls: () => number } {
  let count = 0;
  const scheduler: PollerScheduler = {
    setTimeout(_fn) {
      count++;
      const handle: PollerTimerHandle = { unref() {} };
      return handle;
    },
    clearTimeout() {},
  };
  return { scheduler, calls: () => count };
}

test("createRealtimeRuntime returns a null store, no poller, and no swap hook when disabled", () => {
  const source = fakeSource(() => null);
  const runtime = createRealtimeRuntime(DISABLED_CFG, source, TZ);
  assert.equal(runtime.store, null);
  assert.equal(runtime.poller, null);
  assert.equal(runtime.onIndexSwap, undefined);
});

test("createRealtimeRuntime returns a wired store, poller and swap hook when enabled", () => {
  const source = fakeSource(() => null);
  const { scheduler } = countingScheduler();
  const runtime = createRealtimeRuntime(
    ENABLED_CFG, source, TZ,
    { fetchJson: async () => ({}), scheduler, logger: { warn: () => {} } },
  );
  assert.notEqual(runtime.store, null);
  assert.notEqual(runtime.poller, null);
  assert.notEqual(runtime.onIndexSwap, undefined);

  // The returned onIndexSwap must invalidate the SAME store the runtime
  // returned -- not a different instance, and not a no-op -- which is the
  // whole point of returning all three "wired to each other" rather than
  // separately.
  const store = runtime.store!;
  // Real wall-clock fetchedAt: this store was built with no injected `now`,
  // so it checks freshness against Date.now(), not a test clock.
  store.replace(
    [{ tripIdx: 1, journey: journey("R1"), byStopIdx: new Map() }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, Date.now() / 1000,
  );
  assert.notEqual(store.journeyFor(1), null);
  runtime.onIndexSwap!({} as unknown as TimetableIndex);
  assert.equal(store.journeyFor(1), null, "onIndexSwap must clear the runtime's own store");
});

// This must be a test that would actually
// FAIL if buildServer (or anything else) armed a timer -- not one that
// merely reads the import list and hopes. Constructing the runtime -- what
// every buildServer-based test effectively does once realtime is wired --
// must never call the scheduler; only an explicit `.start()` (index.ts's
// job, never buildServer's) does.
test("constructing the runtime never arms a timer, even when configured", () => {
  const source = fakeSource(() => null);
  const { scheduler, calls } = countingScheduler();
  const runtime = createRealtimeRuntime(
    ENABLED_CFG, source, TZ,
    { fetchJson: async () => ({}), scheduler, logger: { warn: () => {} } },
  );
  assert.equal(calls(), 0, "construction alone must not call setTimeout");
  // Only start() arms it -- proving the scheduler double is actually wired
  // in and not merely unused.
  runtime.poller!.start();
  assert.equal(calls(), 2, "start() arms exactly the two streams' timers");
  runtime.poller!.stop();
});

test("with no key, no poller is even constructed, so the scheduler is never touched", () => {
  const source = fakeSource(() => null);
  const { scheduler, calls } = countingScheduler();
  const runtime = createRealtimeRuntime(DISABLED_CFG, source, TZ, { scheduler });
  assert.equal(runtime.poller, null);
  assert.equal(calls(), 0);
});

// ---------------------------------------------------------------------
// Source selection. The composition root is the only place that decides
// which feed runs, so these assert the whole triple (store source, poller
// class, swap hook) rather than any one of them.
// ---------------------------------------------------------------------

const STRIDE_CFG: RealtimeConfig = {
  enabled: true, source: "stride-vm", key: null, baseUrl: null, openBus: null,
  stride: {
    baseUrl: "https://stride.test",
    pollSeconds: 60, pageLimit: 15_000, maxPages: 3, maxVehicleAgeSeconds: 600,
    minLat: 29.4, maxLat: 33.4, minLon: 34.2, maxLon: 35.9,
  },
  pollSeconds: 30, plannedPollSeconds: 60, maxAgeSeconds: 180, timeoutMs: 20_000,
};

test("a stride-vm config builds a StridePoller and a store carrying that source", () => {
  const ix = oneTripIndex("R1");
  const rt = createRealtimeRuntime(STRIDE_CFG, fakeSource(() => ix), TZ, {
    fetchJson: async () => [],
    scheduler: { setTimeout: () => ({}), clearTimeout: () => {} },
  });
  assert.ok(rt.poller instanceof StridePoller);
  assert.equal(rt.store!.feedSource, "stride-vm");
  assert.notEqual(rt.onIndexSwap, undefined);
});

const OPEN_BUS_CFG: RealtimeConfig = {
  enabled: true, source: "open-bus-vm", key: null, baseUrl: null, stride: null,
  openBus: { baseUrl: "https://requester.test", pollSeconds: 20, maxVehicleAgeSeconds: 600 },
  pollSeconds: 30, plannedPollSeconds: 60, maxAgeSeconds: 180, timeoutMs: 20_000,
};

const NO_TIMERS: PollerScheduler = { setTimeout: () => ({}), clearTimeout: () => {} };

test("an open-bus-vm config builds an OpenBusPoller and a store carrying that source", () => {
  const ix = oneTripIndex("R1");
  const rt = createRealtimeRuntime(OPEN_BUS_CFG, fakeSource(() => ix), TZ, {
    fetchJson: async () => ({}), scheduler: NO_TIMERS,
  });
  assert.ok(rt.poller instanceof OpenBusPoller);
  assert.equal(rt.store!.feedSource, "open-bus-vm");
  assert.notEqual(rt.onIndexSwap, undefined);
});

test("an open-bus-vm resolver derives predictions from the vehicle's distance", () => {
  // SIRI-VM content: no calls at all, only how far along the trip the bus is.
  // Resolved with the SIRI-SM builder it would match the trip and predict
  // nothing -- a perfect match rate doing nothing at all.
  const ix = withRealtimeFields(
    makeTestIndex(2, [{ stops: [0, 1], dep: [28800, 29400], arr: [28800, 29400], dist: [0, 1000] }]),
    { routeId: "R1", directionId: 0, stopCodes: ["S0", "S1"] },
  );
  const vm: RealtimeJourney = {
    ...journey("R1"), directionId: null, calls: [],
    distanceFromStart: 500, recordedAt: epochOn(SERVICE_YMD, 29160),
  };
  const openBus = createRealtimeResolver(fakeSource(() => ix), TZ, "open-bus-vm");
  const { resolved } = openBus([vm], epochOn(SERVICE_YMD, 29160));
  assert.equal(resolved.length, 1);
  // Halfway (scheduled 08:05) at 08:06 => 60 s late at stop 1 (08:10).
  assert.equal(resolved[0]!.byStopIdx.get(1)?.expectedArrival, epochOn(SERVICE_YMD, 29400 + 60));
});

test("a siri-sm config still builds a SiriPoller", () => {
  const ix = oneTripIndex("R1");
  const rt = createRealtimeRuntime(ENABLED_CFG, fakeSource(() => ix), TZ, {
    fetchJson: async () => ({}),
    scheduler: { setTimeout: () => ({}), clearTimeout: () => {} },
  });
  assert.ok(rt.poller instanceof SiriPoller);
  assert.equal(rt.store!.feedSource, "siri-sm");
});

test("a disabled config builds nothing at all", () => {
  const rt = createRealtimeRuntime(DISABLED_CFG, fakeSource(() => oneTripIndex("R1")), TZ);
  assert.equal(rt.store, null);
  assert.equal(rt.poller, null);
  assert.equal(rt.onIndexSwap, undefined);
});

test("the resolver uses the distance builder for stride-vm and the calls builder for siri-sm", () => {
  // One index, one journey shape, two feeds: the SM resolver reads the
  // journey's calls, the VM resolver ignores them and reads the distance.
  // Proving they differ here is what stops a mis-wired composition root
  // silently running SIRI-SM logic over SIRI-VM data (which would resolve
  // every trip and predict nothing -- a 100% "healthy" match rate doing
  // nothing at all).
  const ix = withRealtimeFields(
    makeTestIndex(2, [{
      stops: [0, 1], dep: [28800, 28860], arr: [28800, 28860], dist: [0, 1000],
    }]),
    { routeId: "R1", directionId: 0, stopCodes: ["S0", "S1"] },
  );
  const fetchedAt = epochOn(SERVICE_YMD, 28800);

  const vmJourney: RealtimeJourney = {
    ...journey("R1"),
    directionId: null,
    calls: [],
    distanceFromStart: 0,
    recordedAt: epochOn(SERVICE_YMD, 28860),   // 60 s late at the origin
  };

  const vm = createRealtimeResolver(fakeSource(() => ix), TZ, "stride-vm");
  const vmResult = vm([vmJourney], fetchedAt);
  assert.equal(vmResult.stats.resolved, 1, "the VM resolver must recover the direction");
  assert.equal(
    vmResult.resolved[0]!.byStopIdx.get(1)!.expectedArrival,
    epochOn(SERVICE_YMD, 28860 + 60),
  );

  // The same journey through the SM resolver: no calls means nothing to
  // read, so it resolves the trip but predicts nothing.
  const sm = createRealtimeResolver(fakeSource(() => ix), TZ, "siri-sm");
  const smResult = sm([{ ...vmJourney, directionId: 0 }], fetchedAt);
  assert.equal(smResult.stats.resolved, 1);
  assert.equal(smResult.stats.resolvedWithNoCalls, 1);
});
