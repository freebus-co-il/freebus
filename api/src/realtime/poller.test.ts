import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  SiriPoller, createFetchJson,
  type PollerScheduler, type PollerTimerHandle, type SiriLogger, type FetchJson,
} from "./poller.js";
import { RealtimeStore } from "./store.js";
import type { RealtimeJourney } from "./types.js";
import type { ResolvedJourney, MatchStats } from "./match.js";

// ---- test doubles ---------------------------------------------------------

interface FakeHandle extends PollerTimerHandle { unrefCalled: boolean }
interface ScheduledCall { fn: () => void | Promise<void>; ms: number; handle: FakeHandle }

/**
 * Stands in for real timers. `setTimeout` never fires on its own -- the
 * test drives time by explicitly calling a captured `fn()` (and awaiting
 * whatever it returns) exactly when it wants a tick to run. This is what
 * "drive time explicitly... rather than sleeping" means for this poller:
 * no test here ever waits on a real interval.
 */
function makeFakeScheduler(): {
  scheduler: PollerScheduler; scheduled: ScheduledCall[]; cleared: PollerTimerHandle[];
  last: () => ScheduledCall;
} {
  const scheduled: ScheduledCall[] = [];
  const cleared: PollerTimerHandle[] = [];
  const scheduler: PollerScheduler = {
    setTimeout(fn, ms) {
      const handle: FakeHandle = { unrefCalled: false, unref() { handle.unrefCalled = true; } };
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
  return {
    scheduler, scheduled, cleared,
    // `scheduled` only ever grows by an explicitly-fired call's own
    // reschedule or a stream's `start()` call, so as long as a test
    // tracks which entries belong to which stream (or only fires one
    // stream's chain), "the last entry pushed" is that stream's next tick.
    last: () => {
      const call = scheduled.at(-1);
      assert.ok(call !== undefined, "expected a scheduled call");
      return call;
    },
  };
}

/** A logger that discards everything -- the default for tests that don't
 * assert on log content, so a mistaken real `console.warn` call would be
 * obvious in test output instead of blending into an unrelated logger. */
const SILENT_LOGGER: SiriLogger = { warn: () => {} };

function makeLogger(): { logger: SiriLogger; warnings: string[] } {
  const warnings: string[] = [];
  return { logger: { warn: (m: string) => warnings.push(m) }, warnings };
}

/**
 * Runs `body` against a throwaway local HTTP server (127.0.0.1, an
 * ephemeral port) that answers every request with `handler`'s result, and
 * closes that server whether or not `body` throws -- the try/finally is the
 * whole point (see `withStub` in `walking/valhalla.test.ts`, which this
 * mirrors: a failing assertion must never leak a listening socket into an
 * open handle that keeps `node --test` alive after the run finishes).
 *
 * `createFetchJson` is the one place in `realtime/` that performs real I/O
 * -- everything else in this module is injectable and tested without a
 * socket at all -- so it gets its own hermetic (loopback-only, no real
 * network) coverage here rather than none.
 */
async function withHttpStub(
  handler: (url: string) => { status: number; body: unknown },
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const { status, body: responseBody } = handler(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A valid, empty SIRI snapshot payload -- zero journeys, no error. */
function okPayload(): unknown {
  return { Siri: { ServiceDelivery: { StopMonitoringDelivery: [] } } };
}

/** A JSON body that is valid JSON but not a SIRI envelope at all -- e.g. a
 * gateway/proxy error page. Has no `StopMonitoringDelivery` key anywhere. */
function noEnvelopePayload(): unknown {
  return { message: "quota exceeded" };
}

function journeyPayload(opts: {
  lineRef: string;
  expectedArrival: string;
  originAimedDeparture?: string;
  dataFrameRef?: string;
}): unknown {
  return { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{
    MonitoredStopVisit: [{
      MonitoredVehicleJourney: {
        LineRef: opts.lineRef, DirectionRef: "1",
        ...(opts.originAimedDeparture === undefined
          ? {} : { OriginAimedDepartureTime: opts.originAimedDeparture }),
        ...(opts.dataFrameRef === undefined
          ? {} : { FramedVehicleJourneyRef: { DataFrameRef: opts.dataFrameRef } }),
        MonitoredCall: { StopPointRef: "1", Order: "1", ExpectedArrivalTime: opts.expectedArrival },
      },
    }],
  }] } } };
}

/**
 * One SIRI response carrying MULTIPLE `MonitoredStopVisit` entries -- one
 * per call -- all describing the SAME trip identity. `journeyPayload`
 * above (one visit, one `MonitoredCall`) is the ICD-documented shape for
 * `AllActiveTripsFilter&calls`; this is the shape stop-monitoring's OTHER
 * detail level (`normal`, what `planned` requests) and a real feed can
 * plausibly send: one visit per stop the trip is observed from, not one
 * visit carrying every stop.
 */
function journeyPayloadWithCalls(opts: {
  lineRef: string;
  originAimedDeparture?: string;
  dataFrameRef?: string;
  calls: { stopCode: string; order: string; expectedArrival: string }[];
}): unknown {
  const visits = opts.calls.map((c) => ({
    MonitoredVehicleJourney: {
      LineRef: opts.lineRef, DirectionRef: "1",
      ...(opts.originAimedDeparture === undefined
        ? {} : { OriginAimedDepartureTime: opts.originAimedDeparture }),
      ...(opts.dataFrameRef === undefined
        ? {} : { FramedVehicleJourneyRef: { DataFrameRef: opts.dataFrameRef } }),
      MonitoredCall: { StopPointRef: c.stopCode, Order: c.order, ExpectedArrivalTime: c.expectedArrival },
    },
  }));
  return { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{ MonitoredStopVisit: visits }] } } };
}

function errorConditionPayload(text: string): unknown {
  return { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{
    ErrorCondition: { OtherError: { ErrorText: text } },
  }] } } };
}

/** A SERVICE-level SIRI error -- `ServiceDelivery.ErrorCondition`, one
 * level above `errorConditionPayload`'s per-delivery shape -- and,
 * crucially, with NO `StopMonitoringDelivery` key anywhere, which is
 * exactly the shape a real service-level auth/rate-limit rejection is
 * expected to take (it never got as far as producing deliveries at all).
 * `hasStopMonitoringDelivery`
 * would otherwise gate this out as "not a SIRI envelope" before
 * `parseSiriResponse` (where the service-level check used to live alone)
 * ever saw it. */
function serviceLevelErrorPayload(text: string): unknown {
  return { Siri: { ServiceDelivery: { ErrorCondition: { OtherError: { ErrorText: text } } } } };
}

/** Trivial resolver: every journey "resolves" to its own array index. Real
 * resolution (natural-key matching against the RAPTOR
 * index) is match.ts's job, exercised in match.test.ts, not here. */
function trivialResolve(journeys: readonly RealtimeJourney[], _fetchedAt: number):
  { resolved: ResolvedJourney[]; stats: MatchStats } {
  const resolved = journeys.map((journey, tripIdx) => (
    { tripIdx, journey, byStopIdx: new Map() }
  ));
  return { resolved, stats: { resolved: resolved.length, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 } };
}

/**
 * A `SiriPoller` with every dependency defaulted to something inert, and
 * `scheduler` REQUIRED (not defaulted) -- every test needs its own
 * scheduler to inspect what got scheduled, so a hidden default here would
 * be dead weight at best and, if a test forgot to override it, a silent
 * mismatch between "the scheduler the test is watching" and "the scheduler
 * the poller actually uses" at worst.
 */
function baseOptions(
  scheduler: PollerScheduler,
  overrides: Partial<Omit<ConstructorParameters<typeof SiriPoller>[0], "scheduler">> = {},
): ConstructorParameters<typeof SiriPoller>[0] {
  return {
    baseUrl: "https://mot.example/siri",
    key: "SECRET123",
    pollSeconds: 15,
    plannedPollSeconds: 15,
    maxAgeSeconds: 180,
    store: new RealtimeStore("siri-sm", 180, () => 1_000),
    resolve: trivialResolve,
    fetchJson: (async () => okPayload()) as FetchJson,
    now: () => 1_000,
    logger: SILENT_LOGGER,
    scheduler,
    ...overrides,
  };
}

/** A minimal RealtimeJourney for tests that only need a ResolvedJourney to
 * exist, never to inspect its fields. */
function journeyPayloadStub(): RealtimeJourney {
  return {
    lineRef: "1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: null, confidence: null, lat: null, lon: null, recordedAt: null, calls: [], distanceFromStart: null,
  };
}

// ---- tests ------------------------------------------------------------
//
// Every poller built below runs exactly two streams (active-calls first,
// planned second -- SiriPoller's own construction order), and start()
// unconditionally arms both. So immediately after start(), `scheduled` has
// at least two entries and `scheduled[0]`/`scheduled[1]` are always
// defined -- the invariant behind every un-narrowed `scheduled[i]!` below.

test("a failed fetch keeps the previous snapshot", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  // Seed the store the way an earlier successful poll would have.
  const seeded: ResolvedJourney = { tripIdx: 42, journey: journeyPayloadStub(), byStopIdx: new Map() };
  store.replace([seeded], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, fetchJson: async () => { throw new Error("network down"); },
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.notEqual(store.journeyFor(42), null, "the seeded snapshot must survive a failed fetch");
});

test("an ErrorCondition is logged and does not replace the snapshot", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const seeded: ResolvedJourney = { tripIdx: 7, journey: journeyPayloadStub(), byStopIdx: new Map() };
  store.replace([seeded], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, logger, key: "SECRET123",
    fetchJson: async () => errorConditionPayload("API key is not authorized"),
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.notEqual(store.journeyFor(7), null, "an ErrorCondition must not replace the snapshot");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /not authorized/);
  // The key is a URL query parameter -- it must never reach the log.
  assert.doesNotMatch(warnings[0]!, /SECRET123/);
  assert.match(warnings[0]!, /Key=\*\*\*/);
});

// A SERVICE-level ErrorCondition (no
// StopMonitoringDelivery key at all) must reach the ministry's real error
// text THROUGH `tick()` -- not merely through calling `parseSiriResponse`
// directly, which `siri.test.ts`'s own coverage does and which does NOT
// prove the gate in `tick()` lets it through: `hasStopMonitoringDelivery`
// would otherwise run first and throw its own generic "not a
// SIRI envelope", discarding this text entirely.
test("a SERVICE-level ErrorCondition (no StopMonitoringDelivery at all) is logged with its real text, through a real tick", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const seeded: ResolvedJourney = { tripIdx: 9, journey: journeyPayloadStub(), byStopIdx: new Map() };
  store.replace([seeded], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, logger, key: "SECRET123",
    fetchJson: async () => serviceLevelErrorPayload("rate limit exceeded"),
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.notEqual(store.journeyFor(9), null, "a service-level ErrorCondition must not replace the snapshot");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /rate limit exceeded/, "the ministry's real text must survive, not \"not a SIRI envelope\"");
  assert.doesNotMatch(warnings[0]!, /not a SIRI envelope/);
  assert.doesNotMatch(warnings[0]!, /SECRET123/);
});

// A `SiriError`'s own message
// (`extractErrorText` -- free-form ministry text, e.g. a real auth
// rejection reading "Invalid API key: <the real key>") could reach the LOG
// LINE unredacted, because it never passes through `excerpt()` at all --
// only `createFetchJson`'s own thrown `TickError`s do. This is distinct
// from (and does not overlap with) the earlier `/meta` assertions: those
// pass on `publicSummary` alone and would keep passing even if this exact
// redaction were reverted, since `SiriError` already collapses to the
// fixed "SIRI ErrorCondition" for `/meta`. This test is the ONLY one that
// exercises the LOG side of that specific path.
test("a SiriError carrying the literal key in its own (ministry-authored) text never reaches the log line", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const SECRET = "REPRO-SECRET-KEY-0xFEEDFACE";

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, logger, key: SECRET,
    // Service-level (no StopMonitoringDelivery at all) -- the path that
    // makes a `SiriError`'s own text reachable through tick().
    fetchJson: async () => serviceLevelErrorPayload(`Invalid API key: ${SECRET}`),
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(
    warnings[0]!, new RegExp(SECRET),
    "the literal key must never reach the LOG line, not only /meta",
  );
  assert.match(
    warnings[0]!, /Invalid API key: \*\*\*/,
    "the rest of the ministry's own text must survive redaction untouched",
  );
});

test("consecutive failures back off, and recovery resets the backoff", async () => {
  const { scheduler, scheduled, last } = makeFakeScheduler();
  let call = 0;
  const fetchJson: FetchJson = async () => {
    call++;
    if (call <= 2) throw new Error(`transient failure ${call}`);
    return okPayload();
  };

  const poller = new SiriPoller(baseOptions(scheduler, { fetchJson }));
  poller.start();
  // scheduled[0] = active-calls' first tick (base interval, 15s floor).
  assert.equal(scheduled[0]!.ms, 15_000);

  await scheduled[0]!.fn(); // tick 1: fails
  assert.equal(last().ms, 30_000, "1st consecutive failure doubles the interval");

  await last().fn(); // tick 2: fails
  assert.equal(last().ms, 60_000, "2nd consecutive failure doubles it again");

  await last().fn(); // tick 3: succeeds
  assert.equal(last().ms, 15_000, "a success resets the backoff to the base interval");
});

test("the backoff delay is capped, so a long outage never grows past ~5 minutes between polls", async () => {
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const fetchJson: FetchJson = async () => { throw new Error("still down"); };

  const poller = new SiriPoller(baseOptions(scheduler, { fetchJson, pollSeconds: 15 }));
  poller.start();

  await scheduled[0]!.fn(); // 1st failure: 15s * 2 = 30s.
  for (let i = 0; i < 10; i++) {
    const delay = last().ms;
    assert.ok(
      delay <= FIVE_MINUTES_MS,
      `delay ${delay}ms after failure ${i + 2} must never exceed the 5-minute cap`,
    );
    await last().fn();
  }
  // Uncapped doubling from a 15s base would be well past an hour by the
  // 11th consecutive failure (15s * 2**11 ≈ 8.5 hours); it must have
  // saturated at the cap long before then, and stayed there.
  assert.equal(last().ms, FIVE_MINUTES_MS, "the delay must reach and STAY at the cap, not keep doubling");
});

test("the poll interval is never below the ICD's 15-second floor", () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const poller = new SiriPoller(baseOptions(scheduler, { pollSeconds: 5, plannedPollSeconds: 100 }));
  poller.start();

  // active-calls: configured well below the floor -> clamped UP to 15s.
  assert.equal(scheduled[0]!.ms, 15_000);
  // planned: configured comfortably above the floor -> passed through
  // unchanged, proving this is a floor, not a fixed override.
  assert.equal(scheduled[1]!.ms, 100_000);
});

test("a non-finite pollSeconds still floors to the ICD minimum", () => {
  // NaN or +/-Infinity must never reach setTimeout as a delay: Node fires
  // a NaN delay immediately, which against the real MOT endpoint is a hot
  // loop against their rate limit. Config validation is `resolveRealtimeConfig`'s
  // job; this is the last line of defence before it.
  const { scheduler, scheduled } = makeFakeScheduler();
  const poller = new SiriPoller(baseOptions(scheduler, {
    pollSeconds: Number.NaN, plannedPollSeconds: Number.POSITIVE_INFINITY,
  }));
  poller.start();

  assert.equal(scheduled[0]!.ms, 15_000);
  assert.equal(scheduled[1]!.ms, 15_000);
});

test("stop() clears the timer and no further fetch happens", async () => {
  // The simple case: nothing in flight, both streams' timers are armed,
  // stop() clears exactly those two handles.
  {
    const { scheduler, scheduled, cleared } = makeFakeScheduler();
    const poller = new SiriPoller(baseOptions(scheduler));
    poller.start();
    assert.equal(scheduled.length, 2, "both streams armed a timer");
    poller.stop();
    assert.equal(cleared.length, 2);
    assert.ok(cleared.includes(scheduled[0]!.handle));
    assert.ok(cleared.includes(scheduled[1]!.handle));
  }

  const { scheduler, scheduled, cleared } = makeFakeScheduler();
  let fetchCount = 0;
  let resolveFetch: ((payload: unknown) => void) | null = null;
  const fetchJson: FetchJson = () => new Promise((resolve) => {
    fetchCount++;
    resolveFetch = resolve;
  });

  const poller = new SiriPoller(baseOptions(scheduler, { fetchJson }));
  poller.start();
  assert.equal(scheduled.length, 2, "both streams armed a timer");

  // Fire the active-calls tick, but stop() BEFORE its in-flight fetch
  // resolves -- the async gap a real stop() can race against. While a
  // tick is in flight its stream holds no timer handle (it isn't waiting
  // on one), so only the OTHER, still-armed stream (planned) has anything
  // for stop() to clear here.
  const inFlight = scheduled[0]!.fn();
  poller.stop();
  assert.equal(cleared.length, 1, "the still-armed (planned) timer is cleared");
  assert.ok(cleared.includes(scheduled[1]!.handle));

  assert.ok(resolveFetch !== null);
  (resolveFetch as (payload: unknown) => void)(okPayload());
  await inFlight;

  assert.equal(fetchCount, 1, "no further fetch happens after stop()");
  assert.equal(scheduled.length, 2, "the in-flight tick's completion must not arm a new timer");
});

test("stop() then start() during an in-flight tick does not leak an unclearable timer", async () => {
  const { scheduler, scheduled, cleared } = makeFakeScheduler();
  let resolveFetch: ((payload: unknown) => void) | null = null;
  const fetchJson: FetchJson = () => new Promise((resolve) => { resolveFetch = resolve; });

  const poller = new SiriPoller(baseOptions(scheduler, { fetchJson }));
  poller.start();
  assert.equal(scheduled.length, 2);

  // Fire active-calls, but don't let its fetch resolve yet -- it is now
  // "in flight" and (Stream.run nulls it immediately) holds no timer
  // handle for stop() to find.
  const inFlight = scheduled[0]!.fn();
  poller.stop();
  poller.start(); // Re-arms BOTH streams, each under a new generation.
  assert.equal(scheduled.length, 4, "start() re-armed both streams");
  const freshActiveHandle = scheduled[2]!.handle;

  // Now let the STALE in-flight tick (started before the stop()/start()
  // cycle) finish.
  assert.ok(resolveFetch !== null);
  (resolveFetch as (payload: unknown) => void)(okPayload());
  await inFlight;

  // The stale tick's completion must not arm ANOTHER timer for
  // active-calls -- which would orphan `freshActiveHandle` (still armed,
  // but with no reference left anywhere to ever clear it) -- or clear the
  // fresh one out from under it.
  assert.equal(scheduled.length, 4, "the stale tick's completion must not arm a duplicate timer");
  assert.ok(!cleared.includes(freshActiveHandle), "the fresh timer must survive the stale tick's completion");
});

test("a fetch that throws never escapes the poller", async () => {
  for (const fetchJson of [
    // Rejects.
    (async () => { throw new TypeError("boom (async)"); }) as FetchJson,
    // Throws synchronously, without ever returning a promise.
    (() => { throw new Error("boom (sync)"); }) as unknown as FetchJson,
  ]) {
    const { scheduler, scheduled } = makeFakeScheduler();
    const { logger, warnings } = makeLogger();
    const poller = new SiriPoller(baseOptions(scheduler, { logger, fetchJson }));
    poller.start();

    await assert.doesNotReject(async () => scheduled[0]!.fn());
    assert.equal(warnings.length, 1);
  }
});

test("a resolver that throws never escapes the poller and does not replace the snapshot", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const seeded: ResolvedJourney = { tripIdx: 1, journey: journeyPayloadStub(), byStopIdx: new Map() };
  store.replace([seeded], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  const poller = new SiriPoller(baseOptions(scheduler, {
    logger, store, resolve: () => { throw new Error("resolver exploded"); },
  }));
  poller.start();

  await assert.doesNotReject(async () => scheduled[0]!.fn());
  assert.notEqual(store.journeyFor(1), null, "a throwing resolver must not touch the snapshot");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /resolver exploded/);
});

test("unref() is called so a poll never holds the process open", () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const poller = new SiriPoller(baseOptions(scheduler));
  poller.start();

  assert.equal((scheduled[0]!.handle as FakeHandle).unrefCalled, true);
  assert.equal((scheduled[1]!.handle as FakeHandle).unrefCalled, true);
});

test("a JSON body with no StopMonitoringDelivery is treated as a failed tick, not an empty snapshot", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const seeded: ResolvedJourney = { tripIdx: 3, journey: journeyPayloadStub(), byStopIdx: new Map() };
  store.replace([seeded], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000);

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, logger, fetchJson: async () => noEnvelopePayload(),
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.notEqual(store.journeyFor(3), null, "a non-SIRI JSON body must not wipe the previous snapshot");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /StopMonitoringDelivery/);
  // Says something about what was actually received,
  // not just that it was wrong -- here, the response's own top-level keys.
  assert.match(warnings[0]!, /top-level: object\{message\}/);
});

// A top-level FIELD NAME can literally be
// the key value (`object{<the real key>, other}`).
// `describePayloadShape` redacts its own
// output; this proves it end to end through a real `tick()`.
test("the literal key is redacted even when it appears as a top-level field NAME, not only a value", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const SECRET = "REPRO-SECRET-KEY-0xFEEDFACE";

  const poller = new SiriPoller(baseOptions(scheduler, {
    logger, key: SECRET,
    fetchJson: async () => ({ [SECRET]: "value", other: "field" }),
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0]!, new RegExp(SECRET));
  assert.match(warnings[0]!, /object\{\*\*\*, other\}/);
});

test("a legitimately empty SIRI envelope (zero visits) is still a valid empty snapshot", async () => {
  // Distinguishes "the envelope is missing entirely" (a failure, tested
  // above) from "the envelope says there is nothing right now" (a real,
  // usable answer) -- both parse to zero journeys, but only one is a
  // reason to distrust the tick.
  const { scheduler, scheduled } = makeFakeScheduler();
  const calls: unknown[] = [];
  const resolve = (journeys: readonly RealtimeJourney[], fetchedAt: number) => {
    calls.push(journeys);
    return trivialResolve(journeys, fetchedAt);
  };
  const poller = new SiriPoller(baseOptions(scheduler, { resolve, fetchJson: async () => okPayload() }));
  poller.start();
  await scheduled[0]!.fn();

  assert.equal(calls.length, 1, "an empty-but-present envelope must still reach resolve()");
});

test("the two streams' journeys are merged before resolving, not overwritten", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const calls: { journeys: readonly RealtimeJourney[]; fetchedAt: number }[] = [];
  const resolve = (journeys: readonly RealtimeJourney[], fetchedAt: number) => {
    calls.push({ journeys, fetchedAt });
    return trivialResolve(journeys, fetchedAt);
  };

  let now = 1_000;
  const poller = new SiriPoller(baseOptions(scheduler, {
    resolve, now: () => now,
    fetchJson: async (url: string) => (
      url.includes("AllPlannedTripsFilter")
        ? journeyPayload({ lineRef: "planned-line", expectedArrival: "2019-05-11T13:12:02+03:00" })
        : journeyPayload({ lineRef: "active-line", expectedArrival: "2019-05-11T13:12:02+03:00" })
    ),
  }));
  poller.start();

  // planned ticks first, at an earlier instant.
  now = 1_000;
  await scheduled[1]!.fn(); // scheduled[1] is the planned stream's first tick.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.journeys.map((j) => j.lineRef), ["planned-line"]);

  // active-calls ticks later; its snapshot must be merged WITH the
  // planned stream's still-current journeys, not replace them.
  now = 1_050;
  await scheduled[0]!.fn();
  assert.equal(calls.length, 2);
  const merged = calls[1]!.journeys.map((j) => j.lineRef).sort();
  assert.deepEqual(merged, ["active-line", "planned-line"]);
  // The merged fetchedAt is the OLDER of the two contributing snapshots,
  // so the combined view goes stale if EITHER stream stalls.
  assert.equal(calls[1]!.fetchedAt, 1_000);
});

test("the same trip in both streams serves the live active-calls prediction, not the stale planned one", async () => {
  // Regression for the bug where concatenation order (whichever stream
  // ticked most recently) decided which of the two survived a shared
  // `byTripIdx` slot -- planned's SCHEDULED time could silently win over
  // active-calls' LIVE, already-9-minutes-late prediction.
  const { scheduler, scheduled } = makeFakeScheduler();
  const calls: RealtimeJourney[][] = [];
  const resolve = (journeys: readonly RealtimeJourney[], fetchedAt: number) => {
    calls.push([...journeys]);
    return trivialResolve(journeys, fetchedAt);
  };

  const SCHEDULED_TIME = "2019-05-11T10:00:00+03:00";
  const LIVE_TIME = "2019-05-11T10:09:00+03:00"; // 9 minutes late
  const identity = { lineRef: "500", originAimedDeparture: SCHEDULED_TIME, dataFrameRef: "2019-05-11" };

  let now = 1_000;
  const poller = new SiriPoller(baseOptions(scheduler, {
    resolve, now: () => now,
    fetchJson: async (url: string) => (
      url.includes("AllPlannedTripsFilter")
        ? journeyPayload({ ...identity, expectedArrival: SCHEDULED_TIME })
        : journeyPayload({ ...identity, expectedArrival: LIVE_TIME })
    ),
  }));
  poller.start();

  now = 1_000;
  await scheduled[1]!.fn(); // planned ticks first: reports the scheduled time.
  now = 1_010;
  await scheduled[0]!.fn(); // active-calls ticks next: reports the live, late time.

  assert.equal(calls.length, 2);
  const merged = calls[1]!;
  assert.equal(merged.length, 1, "the two streams' entries for the same trip collapse to one");
  const survivor = merged[0]!;
  assert.equal(
    survivor.calls[0]!.expectedArrival,
    Math.floor(Date.parse(LIVE_TIME) / 1000),
    "the live active-calls prediction must win, not the stale planned one",
  );
});

test("two MonitoredStopVisit entries for one trip at different stops both survive the merge", async () => {
  // Regression for the bug where a shared journeyIdentity collapsed to
  // ONE journey wholesale: any stop-visit the losing journey carried and
  // the winner did not was silently dropped, with no error and no log
  // line. Both visits arrive in a SINGLE stream's response here (the
  // shape confirmed against the ICD's own §9.5 payload),
  // which the identity-level dedup alone -- inter-stream precedence only
  // -- would not have caught at all.
  const { scheduler, scheduled } = makeFakeScheduler();
  const calls: RealtimeJourney[][] = [];
  const resolve = (journeys: readonly RealtimeJourney[], fetchedAt: number) => {
    calls.push([...journeys]);
    return trivialResolve(journeys, fetchedAt);
  };
  const identity = { lineRef: "500", originAimedDeparture: "2019-05-11T10:00:00+03:00", dataFrameRef: "2019-05-11" };

  const poller = new SiriPoller(baseOptions(scheduler, {
    resolve,
    fetchJson: async () => journeyPayloadWithCalls({
      ...identity,
      calls: [
        { stopCode: "11", order: "1", expectedArrival: "2019-05-11T10:05:00+03:00" },
        { stopCode: "22", order: "2", expectedArrival: "2019-05-11T10:15:00+03:00" },
      ],
    }),
  }));
  poller.start();
  await scheduled[0]!.fn();

  assert.equal(calls.length, 1);
  const merged = calls[0]!;
  assert.equal(merged.length, 1, "the two visits for one trip collapse to one journey");
  const survivor = merged[0]!;
  assert.equal(survivor.calls.length, 2, "both stop-visits' calls must survive, not just one");
  const byStopCode = new Map(survivor.calls.map((c) => [c.stopCode, c.expectedArrival]));
  assert.equal(byStopCode.get("11"), Math.floor(Date.parse("2019-05-11T10:05:00+03:00") / 1000));
  assert.equal(byStopCode.get("22"), Math.floor(Date.parse("2019-05-11T10:15:00+03:00") / 1000));
});

test("the same trip-and-stop in both streams: the live value wins, other stops unaffected", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const calls: RealtimeJourney[][] = [];
  const resolve = (journeys: readonly RealtimeJourney[], fetchedAt: number) => {
    calls.push([...journeys]);
    return trivialResolve(journeys, fetchedAt);
  };
  const identity = { lineRef: "500", originAimedDeparture: "2019-05-11T10:00:00+03:00", dataFrameRef: "2019-05-11" };
  const SCHEDULED_TIME = "2019-05-11T10:00:00+03:00";
  const LIVE_TIME = "2019-05-11T10:09:00+03:00";

  let now = 1_000;
  const poller = new SiriPoller(baseOptions(scheduler, {
    resolve, now: () => now,
    fetchJson: async (url: string) => (
      url.includes("AllPlannedTripsFilter")
        ? journeyPayloadWithCalls({
            ...identity, calls: [{ stopCode: "11", order: "1", expectedArrival: SCHEDULED_TIME }],
          })
        : journeyPayloadWithCalls({
            ...identity, calls: [{ stopCode: "11", order: "1", expectedArrival: LIVE_TIME }],
          })
    ),
  }));
  poller.start();

  now = 1_000;
  await scheduled[1]!.fn(); // planned: stop 11 at the scheduled time.
  now = 1_010;
  await scheduled[0]!.fn(); // active-calls: the SAME stop 11, live and late.

  assert.equal(calls.length, 2);
  const merged = calls[1]!;
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.calls.length, 1, "one stop reported by both sides must collapse to one call");
  assert.equal(
    merged[0]!.calls[0]!.expectedArrival,
    Math.floor(Date.parse(LIVE_TIME) / 1000),
    "active-calls' value for the shared stop must win",
  );
});

test("a dead stream's contribution expires out of the merge", async () => {
  const maxAgeSeconds = 180;
  let now = 1_000;
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const store = new RealtimeStore("siri-sm", maxAgeSeconds, () => now);
  const fetchJson: FetchJson = async (url) => (
    url.includes("AllPlannedTripsFilter")
      ? journeyPayload({ lineRef: "planned-line", expectedArrival: "2019-05-11T10:00:00+03:00" })
      : journeyPayload({ lineRef: "active-line", expectedArrival: "2019-05-11T10:00:00+03:00" })
  );

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, maxAgeSeconds, fetchJson, now: () => now,
  }));
  poller.start();

  // planned succeeds once, at t=1000, and is never polled again in this
  // test -- standing in for a stream that has stopped succeeding.
  now = 1_000;
  await scheduled[1]!.fn();
  assert.equal(store.status(now).journeys, 1);

  // active-calls keeps succeeding on schedule. While planned's t=1000
  // contribution is still within maxAgeSeconds, it keeps being merged in.
  now = 1_005;
  await scheduled[0]!.fn();
  assert.equal(store.status(now).journeys, 2, "planned's still-fresh contribution keeps being merged in");

  // Time passes well past planned's maxAgeSeconds (180s from its t=1000
  // fetch); active-calls keeps ticking on time throughout.
  now = 1_200; // planned's contribution is now 200s old.
  await last().fn();

  const status = store.status(now);
  assert.equal(status.health, "ok", "the live stream alone keeps the merged view fresh");
  assert.equal(status.ageSeconds, 0, "age must track the live stream, not stay pinned at planned's last success");
  assert.equal(status.journeys, 1, "the expired planned contribution must be dropped, not carried forever");
});

test("the live stream keeps the store answering even while the other stream always fails", async () => {
  const maxAgeSeconds = 180;
  let now = 1_000;
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const store = new RealtimeStore("siri-sm", maxAgeSeconds, () => now);
  const fetchJson: FetchJson = async (url) => {
    if (url.includes("AllPlannedTripsFilter")) throw new Error("planned is permanently down");
    return journeyPayload({ lineRef: "active-line", expectedArrival: "2019-05-11T10:00:00+03:00" });
  };

  const poller = new SiriPoller(baseOptions(scheduler, {
    store, maxAgeSeconds, fetchJson, now: () => now, logger: SILENT_LOGGER,
  }));
  poller.start();

  // planned fails immediately and forever; active-calls keeps succeeding
  // across several ticks. The store must never go stale or empty.
  now = 1_000;
  await scheduled[1]!.fn(); // planned: fails, store untouched (still empty/disabled).

  now = 1_005;
  await scheduled[0]!.fn(); // active-calls: succeeds.
  assert.equal(store.status(now).health, "ok");
  assert.notEqual(store.journeyFor(0), null);

  now = 1_035;
  await last().fn(); // active-calls: succeeds again, well within maxAgeSeconds.
  assert.equal(store.status(now).health, "ok");
  assert.notEqual(store.journeyFor(0), null);

  now = 1_065;
  await last().fn(); // active-calls: succeeds a third time.
  assert.equal(store.status(now).health, "ok", "the live stream alone must keep serving predictions");
  assert.notEqual(store.journeyFor(0), null);
});

test("consecutiveFailures reflects a stream that keeps failing, even while the other stream succeeds", async () => {
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const fetchJson: FetchJson = async (url) => {
    if (url.includes("AllPlannedTripsFilter")) throw new Error("planned is down");
    return okPayload();
  };
  const poller = new SiriPoller(baseOptions(scheduler, { fetchJson }));
  poller.start();
  assert.equal(poller.consecutiveFailures, 0);

  await scheduled[1]!.fn(); // planned: fails (1st time).
  const plannedRetry1 = last();
  assert.equal(poller.consecutiveFailures, 1);

  await scheduled[0]!.fn(); // active-calls: succeeds.
  assert.equal(poller.consecutiveFailures, 1, "the still-failing planned stream keeps the max elevated");

  await plannedRetry1.fn(); // planned: fails again (2nd time).
  assert.equal(poller.consecutiveFailures, 2);
});

// ---- Visit-drop and stream-regression logging -----------------

test("a tick that drops some visits logs a warning naming the counts", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  // One good visit, one missing LineRef -- 2 seen, 1 dropped, 1 journey.
  const payload = journeyPayloadWithCalls({
    lineRef: "500", calls: [{ stopCode: "1", order: "1", expectedArrival: "2019-05-11T13:12:02+03:00" }],
  }) as { Siri: { ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: unknown[] }[] } } };
  payload.Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit.push({
    MonitoredVehicleJourney: { DirectionRef: "1" }, // missing LineRef
  });

  const poller = new SiriPoller(baseOptions(scheduler, { logger, fetchJson: async () => payload }));
  poller.start();
  await scheduled[0]!.fn();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /active-calls: 1 journeys from 2 visits \(1 dropped\)/);
});

test("a stream that goes from producing journeys to producing none logs a warning", async () => {
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  let produceJourney = true;
  const poller = new SiriPoller(baseOptions(scheduler, {
    logger,
    fetchJson: async () => (produceJourney
      ? journeyPayload({ lineRef: "500", expectedArrival: "2019-05-11T13:12:02+03:00" })
      : okPayload()),
  }));
  poller.start();

  await scheduled[0]!.fn(); // 1st tick: produces a journey.
  assert.equal(warnings.length, 0, "an ordinary productive tick logs nothing");

  produceJourney = false;
  await last().fn(); // 2nd tick: a legitimately empty envelope, but a regression.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /active-calls: 0 journeys from 0 visits \(previously produced journeys\)/);
});

test("a stream's first-ever tick producing zero journeys is NOT treated as a regression", async () => {
  const { scheduler, scheduled } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  const poller = new SiriPoller(baseOptions(scheduler, { logger, fetchJson: async () => okPayload() }));
  poller.start();
  await scheduled[0]!.fn();

  assert.equal(warnings.length, 0, "a quiet feed that has never produced anything is not surprising");
});

// ---- Per-stream diagnostics -----------------------------------

test("streamStatuses reports each stream's own last-success instant, failures and last error separately", async () => {
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  let now = 1_000;
  const poller = new SiriPoller(baseOptions(scheduler, {
    now: () => now, logger,
    fetchJson: async (url) => {
      if (url.includes("AllPlannedTripsFilter")) throw new Error("planned is down");
      return okPayload();
    },
  }));
  poller.start();

  const disabled = poller.streamStatuses;
  assert.deepEqual(disabled["active-calls"], { lastSuccessAt: null, failures: 0, lastError: null });
  assert.deepEqual(disabled.planned, { lastSuccessAt: null, failures: 0, lastError: null });

  now = 1_000;
  await scheduled[0]!.fn(); // active-calls: succeeds.
  now = 1_010;
  await scheduled[1]!.fn(); // planned: fails.

  const status = poller.streamStatuses;
  assert.equal(status["active-calls"].lastSuccessAt, 1_000);
  assert.equal(status["active-calls"].failures, 0);
  assert.equal(status["active-calls"].lastError, null);
  assert.equal(status.planned.lastSuccessAt, null, "planned has never succeeded");
  assert.equal(status.planned.failures, 1);
  // An UNCLASSIFIED thrown error (a plain `new Error`,
  // not a `TickError`/`SiriError`) collapses to the fixed "fetch failed" in
  // the PUBLIC `lastError` -- never the raw message, which could carry a
  // base URL or other detail Node's own error wording sometimes includes.
  // The full detail still reaches the (non-public) LOG line, asserted below.
  assert.equal(status.planned.lastError, "fetch failed");
  assert.ok(warnings.some((w) => /planned is down/.test(w)), "the full detail must still reach the log");

  // A later active-calls failure must not touch planned's own entry, and
  // must not reset active-calls' own remembered lastSuccessAt.
  now = 1_020;
  await last().fn(); // planned retries and fails again.
  now = 1_030;
  const finalStatus = poller.streamStatuses;
  assert.equal(finalStatus["active-calls"].lastSuccessAt, 1_000, "unaffected by planned's own failures");
  assert.equal(finalStatus.planned.failures, 2);
});

test("a stream's lastSuccessAt survives its own later failure", async () => {
  const { scheduler, scheduled, last } = makeFakeScheduler();
  const { logger, warnings } = makeLogger();
  let succeed = true;
  let now = 1_000;
  const poller = new SiriPoller(baseOptions(scheduler, {
    now: () => now, logger,
    fetchJson: async () => { if (!succeed) throw new Error("now failing"); return okPayload(); },
  }));
  poller.start();

  now = 1_000;
  await scheduled[0]!.fn(); // succeeds
  assert.equal(poller.streamStatuses["active-calls"].lastSuccessAt, 1_000);

  succeed = false;
  now = 1_030;
  await last().fn(); // fails

  const status = poller.streamStatuses["active-calls"];
  assert.equal(status.lastSuccessAt, 1_000, "the last GOOD instant is remembered, not reset by a failure");
  assert.equal(status.failures, 1);
  assert.equal(status.lastError, "fetch failed", "the public field is the fixed vocabulary, never the raw message");
  assert.ok(warnings.some((w) => /now failing/.test(w)), "the full detail must still reach the log");
});

// ---- createFetchJson: the one place this module touches real HTTP -------

const TEST_KEY = "test-key-not-a-real-secret";

test("createFetchJson fetches and parses a real JSON response", async () => {
  await withHttpStub(
    (url) => { assert.match(url, /Key=abc/); return { status: 200, body: okPayload() }; },
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, TEST_KEY);
      const result = await fetchJson(`${baseUrl}/2.8/json?Key=abc`);
      assert.deepEqual(result, okPayload());
    },
  );
});

test("createFetchJson rejects on a non-2xx response, with a redacted body excerpt", async () => {
  await withHttpStub(
    () => ({ status: 500, body: { error: "boom", detail: "upstream on fire" } }),
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, TEST_KEY);
      await assert.rejects(fetchJson(baseUrl), /HTTP 500/);
      try {
        await fetchJson(baseUrl);
        assert.fail("expected fetchJson to reject");
      } catch (err) {
        assert.match((err as Error).message, /upstream on fire/);
      }
    },
  );
});

test("createFetchJson rejects an invalid-JSON body, with a body excerpt", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{not actually json");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const fetchJson = createFetchJson(1_000, TEST_KEY);
    try {
      await fetchJson(`http://127.0.0.1:${port}`);
      assert.fail("expected fetchJson to reject");
    } catch (err) {
      assert.match((err as Error).message, /invalid JSON body/);
      assert.match((err as Error).message, /not actually json/);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------
// The literal key value can appear in a response body
// in forms `redactKey`'s `[?&]Key=[^&]*` pattern never matches -- a plain
// JSON field is the concrete case the ministry's own ICD §9 note about
// echoing the request predicts. These two tests are split so each proves
// ONE thing: the first proves
// whitespace-collapsing works on its own, with no key involved at all
// (the earlier combined test could pass merely because a greedy
// `redactKey` match swallowed the newline ALONG WITH the key, proving
// nothing about the whitespace step); the second proves literal-key
// redaction specifically, with content AFTER the key in the body so a
// "redact everything to end of string" bug could not hide behind it.
// ---------------------------------------------------------------------

test("excerpt collapses multi-line bodies to a single line, independent of any key redaction", async () => {
  await withHttpStub(
    () => ({ status: 500, body: { error: "boom", detail: "line one\nline two\nline three" } }),
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, TEST_KEY);
      try {
        await fetchJson(baseUrl);
        assert.fail("expected fetchJson to reject");
      } catch (err) {
        const message = (err as Error).message;
        assert.ok(!message.includes("\n"), "the excerpt must be a single line");
        assert.match(message, /line one/);
        assert.match(message, /line three/, "content after a newline must survive, not just before it");
      }
    },
  );
});

test("the literal key is redacted even when it appears as a plain JSON field, not merely inside a URL", async () => {
  const SECRET = "SECRET-KEY-123";
  await withHttpStub(
    (url) => ({
      status: 401,
      body: {
        error: "unauthorized",
        // The literal key as a bare JSON field value -- redactKey's
        // `[?&]Key=[^&]*` never matches this shape at all.
        Key: SECRET,
        // Also echoed inside a URL, the shape redactKey DOES match, so
        // this test covers both forms in the one body.
        request: `http://mot.example.test${url}`,
        // Content the redaction must NOT also eat, proving it is precise
        // rather than "replace everything from the key to end of string".
        marker: "CONTENT-AFTER-THE-KEY",
      },
    }),
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, SECRET);
      try {
        await fetchJson(`${baseUrl}/2.8/json?Key=${SECRET}&MonitoringRef=AllActiveTripsFilter`);
        assert.fail("expected fetchJson to reject");
      } catch (err) {
        const message = (err as Error).message;
        assert.ok(!message.includes(SECRET), "the literal key must never survive, in any form");
        assert.match(message, /CONTENT-AFTER-THE-KEY/, "redaction must be precise, not a swallow-to-end-of-string");
      }
    },
  );
});

test("createFetchJson rejects outright when Content-Length declares a body over the cap, without reading it", async () => {
  // A tiny actual body but a Content-Length that lies about being huge --
  // this must reject on the header alone, never on the (much smaller) real
  // body, proving the check runs before any read.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    res.end("{}"); // fewer bytes than declared; the connection simply hangs open otherwise
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const fetchJson = createFetchJson(1_000, TEST_KEY, { maxBytes: 10 });
    await assert.rejects(
      fetchJson(`http://127.0.0.1:${port}`),
      /too large.*Content-Length/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("createFetchJson rejects an oversized body even without a trustworthy Content-Length", async () => {
  const bigBody = JSON.stringify({ Siri: { pad: "x".repeat(1_000) } });
  await withHttpStub(
    () => ({ status: 200, body: JSON.parse(bigBody) }),
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, TEST_KEY, { maxBytes: 100 });
      await assert.rejects(fetchJson(baseUrl), /too large/);
    },
  );
});

test("createFetchJson logs Content-Length and parse duration on a successful fetch", async () => {
  const infos: string[] = [];
  const logger: SiriLogger = { warn: () => {}, info: (m) => infos.push(m) };
  await withHttpStub(
    () => ({ status: 200, body: okPayload() }),
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, "SECRET999", { logger });
      await fetchJson(`${baseUrl}/2.8/json?Key=SECRET999`);
    },
  );
  assert.equal(infos.length, 1);
  assert.match(infos[0]!, /bytes=\d+/);
  assert.match(infos[0]!, /parseMs=\d+/);
  assert.ok(!infos[0]!.includes("SECRET999"), "the key must never appear in the diagnostic log line either");
  assert.match(infos[0]!, /Key=\*\*\*/);
});

// `bytes=` must reflect actual BYTES, not UTF-16 code
// units -- a Hebrew-heavy body (this feed's own normal content) has more
// UTF-8 bytes than `.length` code units per character in the non-ASCII
// range, so `.length` alone under-reports.
test("the logged byte count is real UTF-8 bytes, not UTF-16 code units (Hebrew text under-reports otherwise)", async () => {
  const infos: string[] = [];
  const logger: SiriLogger = { warn: () => {}, info: (m) => infos.push(m) };
  // A Hebrew string whose UTF-8 byte length is roughly double its JS
  // `.length` (2 bytes per character for this range, versus 1 UTF-16 code
  // unit per character) -- if the log ever regresses to `text.length`,
  // this ratio check will fail.
  const hebrewPayload = { Siri: { note: "תחנה".repeat(50) } };
  const text = JSON.stringify(hebrewPayload);
  await withHttpStub(
    () => ({ status: 200, body: hebrewPayload }),
    async (baseUrl) => {
      const fetchJson = createFetchJson(1_000, TEST_KEY, { logger });
      await fetchJson(`${baseUrl}/2.8/json?Key=${TEST_KEY}`);
    },
  );
  assert.equal(infos.length, 1);
  const match = /bytes=(\d+)/.exec(infos[0]!);
  assert.ok(match !== null);
  const loggedBytes = Number(match![1]);
  assert.equal(loggedBytes, Buffer.byteLength(text, "utf8"));
  assert.ok(loggedBytes > text.length, "a Hebrew-heavy body must report more bytes than UTF-16 code units");
});

test("createFetchJson rejects when the server is unreachable", async () => {
  // Port 1 on loopback: nothing listens there, so the connection is
  // refused immediately -- exercises the network-failure path without
  // waiting out a real timeout (same technique as valhalla.test.ts).
  const fetchJson = createFetchJson(1_000, TEST_KEY);
  await assert.rejects(fetchJson("http://127.0.0.1:1"));
});
