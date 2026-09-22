import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { buildServer } from "../server.js";
import { config } from "../config.js";
import { RealtimeStore } from "./store.js";
import { createRealtimeResolver } from "./wiring.js";
import { SiriPoller, type PollerScheduler, type PollerTimerHandle } from "./poller.js";

/**
 * The highest-value test in this directory. Every
 * other realtime test injects a stub at some seam (`plan.test.ts`/
 * `departures.test.ts` hand-build a `ResolvedJourney`; `poller.test.ts`
 * injects a stub resolver): well-tested individually, never run together.
 * This is the one test that runs the WHOLE chain for real --
 *
 *   SIRI JSON  --parseSiriResponse-->  RealtimeJourney
 *              --createRealtimeResolver/resolveSnapshot-->  ResolvedJourney
 *              --RealtimeStore.replace-->  stored snapshot
 *              --GET /plan-->  a populated `realtime` block
 *              --GET /vehicles-->  a coordinate a map can draw
 *
 * -- against the SAME fixture index every other route test in this
 * codebase uses, naming that fixture's OWN `route_id` ("R1"), `stop_code`s
 * ("38831"/"38832" -- see `testing/fixture.ts`), and T1's real scheduled
 * `OriginAimedDepartureTime` (08:00:00 on 2026-08-24, a Monday within
 * service S1's Sun-Thu window). If any one link in that chain is broken --
 * a wrong join-key assumption, a parser regression, a resolver
 * miswiring, a store key mismatch, or a route-handler lookup bug -- this
 * test fails loudly. It would turn a silent failure mode
 * (a wrong stop-code join leaving `resolved` high and every `realtime`
 * block `null`) into an immediate, visible test failure, which is exactly
 * why this is the natural home for a real captured
 * payload once one exists.
 *
 * Hermetic throughout: no network (the poller's `fetchJson` is a stub
 * returning the fixed payload below), no real timers (a fake
 * `PollerScheduler`, exactly like `poller.test.ts`'s own double, drives the
 * one tick this test needs).
 */

/** Stands in for real timers -- `setTimeout` never fires on its own; the
 * test calls the captured tick function itself. Mirrors `poller.test.ts`'s
 * own `makeFakeScheduler`, kept local since this is the only test in this
 * file that needs it. */
function makeFakeScheduler(): { scheduler: PollerScheduler; ticks: (() => void | Promise<void>)[] } {
  const ticks: (() => void | Promise<void>)[] = [];
  const scheduler: PollerScheduler = {
    setTimeout(fn) {
      ticks.push(fn);
      const handle: PollerTimerHandle = { unref() {} };
      return handle;
    },
    clearTimeout() {},
  };
  return { scheduler, ticks };
}

/**
 * An ICD-shaped `AllActiveTripsFilter&calls` snapshot naming this fixture's
 * OWN join-key facts: `LineRef` is `routes.route_id` ("R1"),
 * `StopPointRef`/`MonitoringRef` are `stops.stop_code` ("38831" for stop
 * 1000, "38832" for stop 2000 -- see `testing/fixture.ts`), `DirectionRef`
 * "1" is GTFS `direction_id` 0 (T1's own direction), and
 * `OriginAimedDepartureTime` is T1's real scheduled origin departure
 * (08:00:00 on 2026-08-24). The monitored call is the board stop, ON TIME;
 * the one onward call is the alight stop, 5 minutes late -- a real,
 * checkable delay for the assertion below to key on.
 */
function icdShapedActiveCallsPayload(): unknown {
  return {
    Siri: { ServiceDelivery: { StopMonitoringDelivery: [{
      MonitoredStopVisit: [{
        RecordedAtTime: "2026-08-24T07:58:00+03:00",
        MonitoringRef: "38831",
        MonitoredVehicleJourney: {
          LineRef: "R1",
          DirectionRef: "1",
          FramedVehicleJourneyRef: { DataFrameRef: "2026-08-24", DatedVehicleJourneyRef: "1" },
          PublishedLineName: "1",
          OperatorRef: "2",
          OriginRef: "38831",
          DestinationRef: "38832",
          OriginAimedDepartureTime: "2026-08-24T08:00:00+03:00",
          ConfidenceLevel: "reliable",
          VehicleLocation: { Longitude: "34.7800", Latitude: "32.0554" },
          VehicleRef: "veh-e2e-1",
          MonitoredCall: {
            StopPointRef: "38831", Order: "1",
            ExpectedArrivalTime: "2026-08-24T08:00:00+03:00",
          },
          OnwardCalls: { OnwardCall: [{
            StopPointRef: "38832", Order: "2",
            ExpectedArrivalTime: "2026-08-24T08:15:00+03:00",
          }] },
        },
      }],
    }] } },
  };
}

/** A legitimately empty, valid SIRI envelope -- stands in for the
 * `planned` stream's own tick, which this test does not need to carry any
 * journeys for T1 (already active, not merely planned). */
function emptyEnvelope(): unknown {
  return { Siri: { ServiceDelivery: { StopMonitoringDelivery: [] } } };
}

test("SIRI JSON -> parse -> resolve -> store -> a populated /plan realtime block and a /vehicles position, end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-rt-e2e-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();

  const store = new RealtimeStore("siri-sm", 180, () => Date.parse("2026-08-24T07:59:00+03:00") / 1000);
  const resolve = createRealtimeResolver(index, config.timezone);
  const { scheduler, ticks } = makeFakeScheduler();

  const poller = new SiriPoller({
    baseUrl: "https://mot.example.test/siri",
    key: "test-key-never-logged",
    pollSeconds: 30,
    plannedPollSeconds: 60,
    maxAgeSeconds: 180,
    store,
    resolve,
    fetchJson: async (url: string) => (
      url.includes("AllPlannedTripsFilter") ? emptyEnvelope() : icdShapedActiveCallsPayload()
    ),
    now: () => Date.parse("2026-08-24T07:59:00+03:00") / 1000,
    logger: { warn: () => {} },
    scheduler,
  });

  poller.start();
  // ticks[0] is active-calls' first tick (constructed first -- see
  // SiriPoller's own constructor), the one carrying T1's journey.
  await ticks[0]!();

  // The chain actually resolved something, before even reaching /plan --
  // this exercises the resolvedWithNoCalls instrument for real.
  const status = store.status(Date.parse("2026-08-24T07:59:00+03:00") / 1000);
  assert.equal(status.resolved, 1, "the ICD-shaped payload must resolve to exactly T1");
  assert.equal(status.resolvedWithNoCalls, 0, "both calls must have survived resolution, not just the trip match");

  const app = await buildServer({ index, realtime: store });
  try {
    const res = await app.inject({
      url: "/plan?from=stop:1000&to=stop:2000&departAfter=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      itineraries: {
        legs: {
          type: string; tripId?: string;
          realtime?: {
            predictedDeparture: string | null; predictedArrival: string | null;
            delaySeconds: number | null; vehicleRef: string | null; confidence: string | null;
          } | null;
        }[];
      }[];
    };
    assert.ok(body.itineraries.length >= 1);
    const transit = body.itineraries[0]!.legs.find((l) => l.type === "transit")!;
    assert.equal(transit.tripId, "T1");
    assert.notEqual(transit.realtime, null, "the end-to-end chain must produce a populated realtime block");
    assert.deepEqual(transit.realtime, {
      predictedDeparture: "2026-08-24T08:00:00+03:00", // on time at the board stop
      predictedArrival: "2026-08-24T08:15:00+03:00", // scheduled 08:10:00, 5 min late
      delaySeconds: 300,
      vehicleRef: "veh-e2e-1",
      confidence: "reliable",
      recordedAt: "2026-08-24T07:58:00+03:00",
      source: "siri-sm",
    });

    /**
     * The same chain, one link further, ending at the map instead of the
     * itinerary: `VehicleLocation` off the SAME ICD-shaped payload above,
     * through the same parse and the same resolution, out of `GET /vehicles`
     * as a coordinate a client can draw.
     *
     * Worth asserting HERE rather than only in `routes/vehicles.test.ts`,
     * which hand-builds its `RealtimeJourney` and so cannot catch the one
     * assumption that matters most: that the ministry's `VehicleLocation`
     * really does arrive as `{Longitude, Latitude}` STRINGS on a
     * `MonitoredVehicleJourney`, and survives `parseVisit` as numbers. We
     * have no key yet, so this payload is the ICD's shape rather than a
     * captured response -- the day a real one is captured, this is the test
     * it belongs in.
     */
    const vehicles = await app.inject({ url: "/vehicles?trips=T1,T2" });
    assert.equal(vehicles.statusCode, 200);
    assert.deepEqual(vehicles.json(), {
      source: "siri-sm",
      vehicles: [{
        tripId: "T1",
        lat: 32.0554,
        lon: 34.78,
        recordedAt: "2026-08-24T07:58:00+03:00",
        vehicleRef: "veh-e2e-1",
      }],
    });
  } finally {
    poller.stop();
    await app.close();
    index.stop();
  }
});
