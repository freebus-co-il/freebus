import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { RealtimeStore } from "../realtime/store.js";
import type { RealtimeJourney, RealtimeSource } from "../realtime/types.js";

/**
 * The index must be BUILT before the server is constructed: this route
 * resolves a `tripId` through `app.index.current()`, which is null until a
 * build completes -- the same ordering `departures.test.ts` documents for
 * its own realtime tests.
 */
async function serve(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-vehicles-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  const app = await buildServer({ index, realtime });
  return { app, index };
}

/** Like `serve`, but with NO completed index build -- `app.index.current()`
 *  stays null, exactly as during startup or a feed reload. */
async function serveWithoutIndex(realtime: RealtimeStore) {
  const dir = mkdtempSync(join(tmpdir(), "transit-vehicles-noix-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index, realtime });
  return { app, index };
}

const NOW = 1_000;

function journeyAt(over: Partial<RealtimeJourney> = {}): RealtimeJourney {
  return {
    lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-7", confidence: "veryReliable",
    lat: 32.0853, lon: 34.7818,
    recordedAt: Date.parse("2026-08-24T07:58:00+03:00") / 1000,
    calls: [], distanceFromStart: null,
    ...over,
  };
}

/**
 * A store holding one journey on trip index 0 (`T1` in the fixture -- its
 * only trip_ref is 1 and ids ascend, see `buildIndex`). Trip index 1 (`T2`)
 * is deliberately left unresolved so every test has a known negative case.
 */
function storeWith(
  journey: RealtimeJourney, source: RealtimeSource = "siri-sm", fetchedAt = NOW,
): RealtimeStore {
  const store = new RealtimeStore(source, 180, () => NOW);
  store.replace(
    [{ tripIdx: 0, journey, byStopIdx: new Map() }],
    { resolved: 1, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0 },
    fetchedAt,
  );
  return store;
}

interface VehiclesBody {
  source: RealtimeSource | null;
  vehicles: {
    tripId: string; lat: number; lon: number;
    recordedAt: string | null; vehicleRef: string | null;
  }[];
}

test("a resolved trip returns its vehicle's position", async () => {
  const { app, index } = await serve(storeWith(journeyAt()));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1,T2" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json() as VehiclesBody, {
      source: "siri-sm",
      // T2 resolved to nothing and is simply absent -- the response lists
      // the vehicles that exist, it is not a per-trip result array.
      vehicles: [{
        tripId: "T1", lat: 32.0853, lon: 34.7818,
        recordedAt: "2026-08-24T07:58:00+03:00", vehicleRef: "veh-7",
      }],
    });
  } finally { await app.close(); index.stop(); }
});

/**
 * A dot on a map claims to be where the bus IS, so on a feed that derives
 * positions (every keyless feed) a bus is drawn only while its own report is
 * at most five minutes old -- the same line the store draws for trusting a
 * report enough to anchor an ETA on it. It is the report's age, not the
 * feed's name: Stride's weekday reports lag 13-23 minutes and stay off, and
 * so did all of Egged's on the raw feed on 2026-09-13 18:47Z, when they ran
 * ~21 minutes late. A 200 with a list, never a 404, either way.
 */
test("a keyless vehicle reported within the last five minutes is drawn", async () => {
  for (const age of [60, 300]) {
    const { app, index } = await serve(storeWith(journeyAt({ recordedAt: NOW - age }), "open-bus-vm"));
    try {
      const res = await app.inject({ url: "/vehicles?trips=T1" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as VehiclesBody;
      assert.equal(body.source, "open-bus-vm");
      assert.deepEqual(body.vehicles.map((v) => v.tripId), ["T1"], `${age}s old`);
    } finally { await app.close(); index.stop(); }
  }
});

test("a keyless vehicle whose report is over five minutes old is left off the map", async () => {
  const { app, index } = await serve(storeWith(journeyAt({ recordedAt: NOW - 301 }), "open-bus-vm"));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json() as VehiclesBody, { source: "open-bus-vm", vehicles: [] });
  } finally { await app.close(); index.stop(); }
});

test("a keyless vehicle with no report time is left off -- its age is unknown", async () => {
  const { app, index } = await serve(storeWith(journeyAt({ recordedAt: null }), "open-bus-vm"));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1" });
    assert.deepEqual((res.json() as VehiclesBody).vehicles, []);
  } finally { await app.close(); index.stop(); }
});

test("Stride is held to the same rule: its lagging reports stay off, a fresh one is drawn", async () => {
  const lagging = await serve(storeWith(journeyAt({ recordedAt: NOW - 1_000 }), "stride-vm"));
  try {
    const res = await lagging.app.inject({ url: "/vehicles?trips=T1" });
    assert.deepEqual(res.json() as VehiclesBody, { source: "stride-vm", vehicles: [] });
  } finally { await lagging.app.close(); lagging.index.stop(); }

  const fresh = await serve(storeWith(journeyAt({ recordedAt: NOW - 60 }), "stride-vm"));
  try {
    const res = await fresh.app.inject({ url: "/vehicles?trips=T1" });
    assert.deepEqual((res.json() as VehiclesBody).vehicles.map((v) => v.tripId), ["T1"]);
  } finally { await fresh.app.close(); fresh.index.stop(); }
});

/** With a MOT key the operator's own feed is trusted as it was: a position
 *  with no RecordedAtTime is still drawn, and the client says nothing about
 *  its age rather than assuming "now". */
test("a siri-sm vehicle with no report time is still drawn", async () => {
  const { app, index } = await serve(storeWith(journeyAt({ recordedAt: null }), "siri-sm"));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1" });
    const body = res.json() as VehiclesBody;
    assert.deepEqual(body.vehicles.map((v) => [v.tripId, v.recordedAt]), [["T1", null]]);
  } finally { await app.close(); index.stop(); }
});

test("realtime disabled entirely reports a null source and no vehicles", async () => {
  const { app, index } = await serve(null);
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json() as VehiclesBody, { source: null, vehicles: [] });
  } finally { await app.close(); index.stop(); }
});

test("an unknown trip id is omitted, not an error", async () => {
  const { app, index } = await serve(storeWith(journeyAt()));
  try {
    const res = await app.inject({ url: "/vehicles?trips=NOPE,T1" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as VehiclesBody;
    assert.deepEqual(body.vehicles.map((v) => v.tripId), ["T1"]);
  } finally { await app.close(); index.stop(); }
});

/**
 * A journey can resolve to a trip and still carry no position -- SIRI-SM's
 * `VehicleLocation` is optional and `siri.ts` propagates its absence as
 * null rather than inventing a coordinate. Half a coordinate is the same
 * as none.
 */
test("a resolved journey with no position is omitted", async () => {
  for (const missing of [{ lat: null }, { lon: null }, { lat: null, lon: null }]) {
    const { app, index } = await serve(storeWith(journeyAt(missing)));
    try {
      const res = await app.inject({ url: "/vehicles?trips=T1" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual((res.json() as VehiclesBody).vehicles, [], JSON.stringify(missing));
    } finally { await app.close(); index.stop(); }
  }
});

/**
 * Staleness is `RealtimeStore`'s job and is inherited rather than
 * re-implemented: `journeyFor` already answers null past
 * `REALTIME_MAX_AGE_SECONDS`. Asserted here anyway because a map dot is the
 * consumer where a stale position is most actively misleading -- a rider
 * watches it and infers the bus is somewhere it is not.
 */
test("a stale snapshot yields no vehicles", async () => {
  // maxAgeSeconds is 180 and the store's clock is fixed at NOW.
  const { app, index } = await serve(storeWith(journeyAt(), "siri-sm", NOW - 181));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as VehiclesBody).vehicles, []);
  } finally { await app.close(); index.stop(); }
});

test("no index yet degrades to no vehicles rather than faulting", async () => {
  const { app, index } = await serveWithoutIndex(storeWith(journeyAt()));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json() as VehiclesBody, { source: "siri-sm", vehicles: [] });
  } finally { await app.close(); index.stop(); }
});

test("duplicate trip ids yield one vehicle each", async () => {
  const { app, index } = await serve(storeWith(journeyAt()));
  try {
    const res = await app.inject({ url: "/vehicles?trips=T1,T1,T1" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as VehiclesBody).vehicles.map((v) => v.tripId), ["T1"]);
  } finally { await app.close(); index.stop(); }
});

test("blank entries and surrounding whitespace are tolerated", async () => {
  const { app, index } = await serve(storeWith(journeyAt()));
  try {
    const res = await app.inject({ url: "/vehicles?trips=%20T1%20,,T2" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as VehiclesBody).vehicles.map((v) => v.tripId), ["T1"]);
  } finally { await app.close(); index.stop(); }
});

test("an empty or missing trips list is a 400", async () => {
  const { app, index } = await serve(storeWith(journeyAt()));
  try {
    for (const url of ["/vehicles", "/vehicles?trips=", "/vehicles?trips=,,"]) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 400, url);
      assert.equal((res.json() as { code: string }).code, "bad_request", url);
    }
  } finally { await app.close(); index.stop(); }
});

/** The same bound `journeyCheck.ts` puts on a rider's remaining chain, for
 *  the same reason: a journey never has this many legs, so anything larger
 *  is a client bug or an attempt to walk the index one request at a time. */
test("more than 12 trip ids is a 400", async () => {
  const { app, index } = await serve(storeWith(journeyAt()));
  try {
    const trips = Array.from({ length: 13 }, (_, i) => `T${i}`).join(",");
    const res = await app.inject({ url: `/vehicles?trips=${trips}` });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "bad_request");
    assert.match(body.message, /12/);
  } finally { await app.close(); index.stop(); }
});

// ---- GET /routes/:routeId/vehicles ------------------------------------------
//
// The line page's map: every bus on the road for one route (one direction of
// a line), found by scanning the snapshot rather than by trip id -- the page
// only knows runs that have not started yet, and those are exactly the buses
// that are not on the map.

/** A store holding a journey on each of T1 and T2 (route R1) and T3 (route
 *  R2) -- trip indexes 0, 1 and 2 in the fixture. */
function storeWithEach(
  journeys: { tripIdx: number; journey: RealtimeJourney }[],
  source: RealtimeSource = "siri-sm", fetchedAt = NOW,
): RealtimeStore {
  const store = new RealtimeStore(source, 180, () => NOW);
  store.replace(
    journeys.map(({ tripIdx, journey }) => ({ tripIdx, journey, byStopIdx: new Map() })),
    { resolved: journeys.length, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    fetchedAt,
  );
  return store;
}

test("a route's vehicles are every bus on that route, and none from another", async () => {
  const store = storeWithEach([
    { tripIdx: 0, journey: journeyAt({ vehicleRef: "veh-1" }) },
    { tripIdx: 1, journey: journeyAt({ vehicleRef: "veh-2", lat: 32.1, lon: 34.8 }) },
    { tripIdx: 2, journey: journeyAt({ vehicleRef: "veh-3" }) },
  ]);
  const { app, index } = await serve(store);
  try {
    const res = await app.inject({ url: "/routes/R1/vehicles" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as VehiclesBody;
    assert.equal(body.source, "siri-sm");
    assert.deepEqual(
      body.vehicles.map((v) => [v.tripId, v.vehicleRef]).sort(),
      [["T1", "veh-1"], ["T2", "veh-2"]],
    );
    assert.deepEqual(body.vehicles.find((v) => v.tripId === "T2"), {
      tripId: "T2", lat: 32.1, lon: 34.8,
      recordedAt: "2026-08-24T07:58:00+03:00", vehicleRef: "veh-2",
    });
  } finally { await app.close(); index.stop(); }
});

test("a route's vehicles are held to the same freshness rule as /vehicles", async () => {
  const store = storeWithEach([
    { tripIdx: 0, journey: journeyAt({ recordedAt: NOW - 60 }) },
    { tripIdx: 1, journey: journeyAt({ recordedAt: NOW - 301 }) },
  ], "open-bus-vm");
  const { app, index } = await serve(store);
  try {
    const res = await app.inject({ url: "/routes/R1/vehicles" });
    assert.deepEqual((res.json() as VehiclesBody).vehicles.map((v) => v.tripId), ["T1"]);
  } finally { await app.close(); index.stop(); }
});

test("a route bus with no position is omitted", async () => {
  const store = storeWithEach([{ tripIdx: 0, journey: journeyAt({ lat: null }) }]);
  const { app, index } = await serve(store);
  try {
    const res = await app.inject({ url: "/routes/R1/vehicles" });
    assert.deepEqual((res.json() as VehiclesBody).vehicles, []);
  } finally { await app.close(); index.stop(); }
});

/** Never a 404: this endpoint never touches the database, and "no such route"
 *  and "nothing running on it" draw the same empty map. */
test("an unknown route, no realtime, no index and a stale snapshot all answer no vehicles", async () => {
  const one = [{ tripIdx: 0, journey: journeyAt() }];

  const unknown = await serve(storeWithEach(one));
  try {
    const res = await unknown.app.inject({ url: "/routes/NOPE/vehicles" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json() as VehiclesBody, { source: "siri-sm", vehicles: [] });
  } finally { await unknown.app.close(); unknown.index.stop(); }

  const disabled = await serve(null);
  try {
    const res = await disabled.app.inject({ url: "/routes/R1/vehicles" });
    assert.deepEqual(res.json() as VehiclesBody, { source: null, vehicles: [] });
  } finally { await disabled.app.close(); disabled.index.stop(); }

  const noIndex = await serveWithoutIndex(storeWithEach(one));
  try {
    const res = await noIndex.app.inject({ url: "/routes/R1/vehicles" });
    assert.deepEqual(res.json() as VehiclesBody, { source: "siri-sm", vehicles: [] });
  } finally { await noIndex.app.close(); noIndex.index.stop(); }

  const stale = await serve(storeWithEach(one, "siri-sm", NOW - 181));
  try {
    const res = await stale.app.inject({ url: "/routes/R1/vehicles" });
    assert.deepEqual((res.json() as VehiclesBody).vehicles, []);
  } finally { await stale.app.close(); stale.index.stop(); }
});
