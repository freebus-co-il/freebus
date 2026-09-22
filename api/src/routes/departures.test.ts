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
import type { RealtimeJourney } from "../realtime/types.js";
import { baseEpochOfYmd } from "../transit/calendar.js";
import { config } from "../config.js";

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-depboard-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index });
  return { app, index };
}

/** Same fixture as `serve()`, wired with an explicit `realtime` dependency
 *  for realtime-annotation tests. The index must be built (via `rebuild()`)
 *  BEFORE the server is constructed here, unlike the plain `serve()` above --
 *  annotation reads `app.index.current()`, which is null until a build has
 *  actually completed. */
async function serveWithRealtime(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-depboard-rt-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  const app = await buildServer({ index, realtime });
  return { app, index };
}

/**
 * `annotateDepartures` reads `app.index.current()`, a coupling this route
 * does not otherwise have. Deliberately mirrors the plain `serve()` above
 * (no `rebuild()` call), so `app.index.current()` stays null -- exactly the
 * state during startup or
 * a feed reload, before the first RAPTOR build completes -- while still
 * wiring a real, non-null `realtime` store. `app.db`/`departuresAt` still
 * work regardless (built synchronously in `IndexManager`'s constructor --
 * see `manager.ts`), so the board itself must still succeed, just without
 * annotation.
 */
async function serveWithRealtimeButNoIndex(realtime: RealtimeStore) {
  const dir = mkdtempSync(join(tmpdir(), "transit-depboard-noix-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index, realtime });
  return { app, index };
}

/**
 * Whether a stop exists is a property of the stop id. It is NOT a property
 * of `includeSiblings`, which only decides which platforms of an existing
 * station get merged into one board.
 *
 * Deciding existence from `siblingStopIds` instead would make an unknown id
 * a 404 with `includeSiblings=true` (an empty sibling list, which the route
 * would read as "no such stop") but a `200` with an empty `departures` array
 * with the flag off (nothing looked the stop up at all). Same endpoint, same
 * input, two different meanings, selected by an unrelated flag — and the 200
 * would be the actively harmful half, since "this stop id does not exist"
 * and "this stop has nothing departing in the next hour" are answers a
 * client must be able to tell apart.
 */
test("an unknown stop id is 404 regardless of includeSiblings", async () => {
  const { app, index } = await serve();
  for (const suffix of ["", "&includeSiblings=false", "&includeSiblings=true"]) {
    const res = await app.inject({ url: `/stops/NOPE/departures?window=60${suffix}` });
    assert.equal(res.statusCode, 404, suffix);
    const body = res.json() as { statusCode: number; code: string; message: string };
    assert.equal(body.statusCode, 404, suffix);
    assert.equal(body.code, "not_found", suffix);
    assert.equal(body.message, "No stop with id NOPE", suffix);
  }
  await app.close(); index.stop();
});

// The other half of the same contract: a stop that DOES exist but has
// nothing departing in the window is a 200 with an empty list, not a 404 —
// again regardless of the flag.
test("a real stop with no departures in the window is 200 and empty, either way", async () => {
  const { app, index } = await serve();
  for (const suffix of ["&includeSiblings=false", "&includeSiblings=true"]) {
    // 2026-08-22 is a Saturday; the fixture's only service (S1) is Sun-Thu.
    const res = await app.inject({
      url: `/stops/1000/departures?at=2026-08-22T07:30:00%2B03:00&window=60${suffix}`,
    });
    assert.equal(res.statusCode, 200, suffix);
    const body = res.json() as { stopId: string; departures: unknown[] };
    assert.equal(body.stopId, "1000", suffix);
    assert.deepEqual(body.departures, [], suffix);
  }
  await app.close(); index.stop();
});

test("a real stop returns its board", async () => {
  const { app, index } = await serve();
  const res = await app.inject({
    url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { departures: { tripId: string; departureTime: string }[] };
  assert.deepEqual(body.departures.map((d) => d.tripId), ["T1", "T2"]);
  await app.close(); index.stop();
});

// ---------------------------------------------------------------------
// Realtime annotation on GET /stops/:stopId/departures.
// ---------------------------------------------------------------------

interface RtDeparture {
  tripId: string; runId: string; unscheduled: boolean;
  stopId: string; stopSequence: number; departureTime: string;
  headsign: string | null; directionId: number;
  route: { routeId: string; shortName: string | null; longName: string | null;
           type: number; color: string | null };
  realtime: {
    predictedDeparture: string | null; predictedArrival: string | null;
    delaySeconds: number | null; vehicleRef: string | null;
    confidence: string | null; recordedAt: string | null;
  } | null;
}

test("departures are annotated with predicted times when resolved", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const journey: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-7", confidence: "veryReliable", lat: null, lon: null,
    recordedAt: Date.parse("2026-08-24T07:58:00+03:00") / 1000, calls: [], distanceFromStart: null,
  };
  // T1 is trip index 0, stop 1000 is stop index 0 (fixture's only trip_ref
  // is 1 and stop_ref 1000 is the lowest, both ascending -- see buildIndex).
  // T2 (trip index 1) is left unresolved.
  const predictedDeparture = Date.parse("2026-08-24T08:03:00+03:00") / 1000;
  store.replace(
    [{ tripIdx: 0, journey, byStopIdx: new Map([[0, { expectedArrival: predictedDeparture, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    const [t1, t2] = body.departures;
    assert.equal(t1!.tripId, "T1");
    assert.deepEqual(t1!.realtime, {
      predictedDeparture: "2026-08-24T08:03:00+03:00",
      predictedArrival: null,
      // Scheduled 08:00:00, predicted 08:03:00 -- 180 s late.
      delaySeconds: 180,
      vehicleRef: "veh-7",
      confidence: "veryReliable",
      recordedAt: "2026-08-24T07:58:00+03:00",
      source: "siri-sm",
    });
    assert.equal(t2!.tripId, "T2");
    assert.equal(t2!.realtime, null);
  } finally { await app.close(); index.stop(); }
});

test("with realtime disabled, a departures response is exactly the timetable rows", async () => {
  const { app, index } = await serveWithRealtime(null);
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      stopId: string; departures: RtDeparture[]; nextDeparture: RtDeparture | null;
    };
    assert.deepEqual(body, {
      stopId: "1000",
      // Null because the board is NOT empty -- the lookahead only runs when
      // there is nothing to report inside the window.
      nextDeparture: null,
      departures: [
        {
          tripId: "T1", runId: "T1", unscheduled: false, stopId: "1000", stopSequence: 1,
          departureTime: "2026-08-24T08:00:00+03:00",
          headsign: "הרצל", tripNumber: null, directionId: 0, lineCode: "67001", lineDirection: "1",
          route: { routeId: "R1", agencyId: "2", shortName: "1", longName: "קו ראשון", type: 3, color: "FF0000" },
          realtime: null,
        },
        {
          tripId: "T2", runId: "T2", unscheduled: false, stopId: "1000", stopSequence: 1,
          departureTime: "2026-08-24T09:00:00+03:00",
          headsign: "הרצל", tripNumber: null, directionId: 0, lineCode: "67001", lineDirection: "1",
          route: { routeId: "R1", agencyId: "2", shortName: "1", longName: "קו ראשון", type: 3, color: "FF0000" },
          realtime: null,
        },
      ],
    });
  } finally { await app.close(); index.stop(); }
});

test("an empty Shabbat board still names when service comes back", async () => {
  const { app, index } = await serveWithRealtime(null);
  try {
    // 2026-08-29 is a Saturday, and the fixture's only trips run Sun-Thu --
    // the same shape as the real feed, where most of the country stops for
    // Shabbat. The board is legitimately empty; "no departures" alone would
    // leave a rider unable to tell that from a stop that is never served.
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-29T10:00:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      departures: unknown[]; nextDeparture: { departureTime: string; tripId: string } | null;
    };
    assert.deepEqual(body.departures, []);
    // Sunday morning, the next day service actually runs.
    assert.equal(body.nextDeparture?.departureTime, "2026-08-30T08:00:00+03:00");
    assert.equal(body.nextDeparture?.tripId, "T1");
  } finally { await app.close(); index.stop(); }
});

test("a stop with nothing scheduled at all reports no next departure", async () => {
  const { app, index } = await serveWithRealtime(null);
  try {
    // Past the fixture calendar's end_date (20260920), so the lookahead runs
    // its full span and finds nothing -- which must read as null, not as an
    // error and not as a stale departure from inside the service window.
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-10-01T10:00:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: unknown[]; nextDeparture: unknown };
    assert.deepEqual(body.departures, []);
    assert.equal(body.nextDeparture, null);
  } finally { await app.close(); index.stop(); }
});

test("realtime enabled but the index not yet built degrades to realtime: null, not a crash", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const journey: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-9", confidence: "reliable", lat: null, lon: null,
    recordedAt: null, calls: [], distanceFromStart: null,
  };
  // Would resolve T1's board-stop prediction just fine IF the index were
  // built -- proving the null result below comes from the missing index,
  // not from an empty/unresolved store.
  store.replace(
    [{ tripIdx: 0, journey, byStopIdx: new Map([[0, { expectedArrival: 1_000, ambiguous: false }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, 1_000,
  );

  const { app, index } = await serveWithRealtimeButNoIndex(store);
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: { tripId: string; realtime: unknown }[] };
    assert.deepEqual(body.departures.map((d) => d.tripId), ["T1", "T2"]);
    for (const d of body.departures) assert.equal(d.realtime, null);
  } finally { await app.close(); index.stop(); }
});

/**
 * A store in which T1 (trip index 0) is running late: its board stop
 * (stop 1000, stop index 0) is predicted at `predictedIso` rather than at
 * its scheduled 08:00. `null` leaves the store resolved-but-silent -- a
 * journey matched to the trip with no prediction for this stop -- which is
 * how a real vehicle with no usable shape distance arrives.
 */
function storeWithLateT1(predictedIso: string | null): RealtimeStore {
  const store = new RealtimeStore("stride-vm", 180, () => 1_000);
  const journey: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-late", confidence: null, lat: null, lon: null,
    recordedAt: Date.parse("2026-08-24T08:04:00+03:00") / 1000,
    calls: [], distanceFromStart: 300,
  };
  const byStopIdx = predictedIso === null
    ? new Map<number, { expectedArrival: number; ambiguous: boolean }>()
    : new Map([[0, { expectedArrival: Date.parse(predictedIso) / 1000, ambiguous: false }]]);
  store.replace(
    [{ tripIdx: 0, journey, byStopIdx }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: predictedIso === null ? 1 : 0, nearMissCount: 0 },
    1_000,
  );
  return store;
}

/**
 * Why the lookback exists: the board is a SCHEDULE query
 * (`st.departure_time >= now`), and realtime only ever annotated the rows
 * that query returned. Without it, a bus running seven minutes late would be
 * filtered out by its SCHEDULED time before realtime got a chance to say it
 * had not arrived yet -- so a bus two minutes from the stop would vanish
 * from the board at exactly the moment a rider could still catch it, while
 * every health metric would report a perfectly successful poll.
 */
test("a late bus stays on the board after its scheduled time has passed", async () => {
  const { app, index } = await serveWithRealtime(storeWithLateT1("2026-08-24T08:07:00+03:00"));
  try {
    // 08:05: T1's scheduled 08:00 is five minutes gone, but it is predicted
    // at 08:07 and is still two minutes away.
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T08:05:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => d.tripId), ["T1", "T2"]);
    const [t1] = body.departures;
    assert.equal(t1!.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(t1!.realtime?.predictedDeparture, "2026-08-24T08:07:00+03:00");
    assert.equal(t1!.realtime?.delaySeconds, 420);
  } finally { await app.close(); index.stop(); }
});

/**
 * The other half of the contract, and the reason this is not simply a
 * wider window: a departure whose scheduled time has passed is resurrected
 * only on POSITIVE evidence that its bus has not been here yet. With no
 * live prediction we do not know whether it left on time five minutes ago,
 * and a board padded with buses that have already gone is its own kind of
 * lie.
 */
test("a departure past its scheduled time with no live prediction stays off the board", async () => {
  const { app, index } = await serveWithRealtime(storeWithLateT1(null));
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T08:05:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => d.tripId), ["T2"]);
  } finally { await app.close(); index.stop(); }
});

/** A prediction that has itself passed is evidence the bus HAS been --
 *  it must not resurrect the row it belongs to. */
test("a departure whose predicted time has also passed stays off the board", async () => {
  const { app, index } = await serveWithRealtime(storeWithLateT1("2026-08-24T08:03:00+03:00"));
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T08:05:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => d.tripId), ["T2"]);
  } finally { await app.close(); index.stop(); }
});

/**
 * A board is ordered by when a rider can actually board, so a resurrected
 * departure sorts on its PREDICTED time -- otherwise a very late bus would
 * head the board on the strength of a scheduled time that has already been
 * and gone, which is the opposite of what the rider is reading it for.
 */
test("a late departure is ordered by its predicted time, not its scheduled one", async () => {
  const { app, index } = await serveWithRealtime(storeWithLateT1("2026-08-24T09:10:00+03:00"));
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T08:05:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    // T2 leaves at 09:00; T1, 70 minutes late, is not boardable until 09:10.
    assert.deepEqual(body.departures.map((d) => d.tripId), ["T2", "T1"]);
  } finally { await app.close(); index.stop(); }
});

/**
 * Seen live on 2026-09-13: a line 5 bus, stopped at a light 450 m before
 * Dizengoff Center, had a position-derived ETA that slid into the past while
 * it sat there. The board dropped it at 20:36:19; it arrived at 20:38:55.
 *
 * When the report was fresh, a bus it still places BEFORE this stop has not
 * been here yet, however the ETA derived from it has aged -- so it stays on
 * the board, due no earlier than now.
 */
test("a bus freshly reported short of the stop stays on the board after its ETA has aged", async () => {
  const at = Date.parse("2026-08-24T08:05:00+03:00") / 1000;
  const store = new RealtimeStore("open-bus-vm", 180, () => at);
  const journey: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-stuck", confidence: null, lat: null, lon: null,
    recordedAt: at - 180, calls: [], distanceFromStart: 300,
  };
  // Seen at 08:02 and due at 08:03 on the timetable's pace; at 08:05 that is
  // two minutes gone, but nothing has placed the bus past stop 1000.
  store.replace(
    [{ tripIdx: 0, journey, byStopIdx: new Map([[0, { expectedArrival: at - 120, ambiguous: false, anchorAt: at - 180 }]]) }],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 },
    at,
  );
  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T08:05:00%2B03:00&window=60",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => d.tripId), ["T1", "T2"]);
    // 08:03 + half of the 3 min since 08:02 = 08:04:30, already past, so
    // the ETA is the first instant that is not.
    assert.equal(body.departures[0]!.realtime?.predictedDeparture, "2026-08-24T08:05:01+03:00");
  } finally { await app.close(); index.stop(); }
});

// ---------------------------------------------------------------------
// Unscheduled runs get their own rows on the departure board.
// ---------------------------------------------------------------------

/**
 * A store holding one unscheduled run on T1's slot (T1 is trip index 0, stop
 * 1000 is stop index 0 -- see the first realtime test above): a bus starting
 * `offsetSeconds` from T1's 08:00, predicted at stop 1000 at `predictedIso`.
 */
function storeWithUnscheduledOnT1(offsetSeconds: number, predictedIso: string): RealtimeStore {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const journey: RealtimeJourney = {
    lineRef: "R1", directionId: 0, dataFrameRef: "2026-08-24", datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-extra", confidence: null, lat: null, lon: null, recordedAt: null,
    calls: [], distanceFromStart: null,
  };
  store.replace(
    [],
    { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 1 },
    1_000,
    [{
      templateTripIdx: 0, offsetSeconds, serviceBaseEpoch: baseEpochOfYmd(20260824, config.timezone), journey,
      byStopIdx: new Map([[0, { expectedArrival: Date.parse(predictedIso) / 1000, ambiguous: false }]]),
    }],
  );
  return store;
}

test("an unscheduled run gets its own row, at its own shifted time, beside the timetable row", async () => {
  // Starts 07:55 (T1's 08:00 minus 5 min), predicted at stop 1000 at 07:57.
  const { app, index } = await serveWithRealtime(storeWithUnscheduledOnT1(-300, "2026-08-24T07:57:00+03:00"));
  try {
    const res = await app.inject({ url: "/stops/1000/departures?at=2026-08-24T07:50:00%2B03:00&window=60" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => [d.runId, d.unscheduled]), [["T1@veh-extra", true], ["T1", false]]);
    const [extra] = body.departures;
    assert.equal(extra!.tripId, "T1");
    assert.equal(extra!.departureTime, "2026-08-24T07:55:00+03:00");
    assert.equal(extra!.realtime?.predictedDeparture, "2026-08-24T07:57:00+03:00");
    assert.equal(extra!.realtime?.delaySeconds, 120);
    assert.equal(extra!.realtime?.vehicleRef, "veh-extra");
  } finally { await app.close(); index.stop(); }
});

test("an unscheduled run predicted outside the board's window is left off", async () => {
  const { app, index } = await serveWithRealtime(storeWithUnscheduledOnT1(-300, "2026-08-24T09:20:00+03:00"));
  try {
    const res = await app.inject({ url: "/stops/1000/departures?at=2026-08-24T07:50:00%2B03:00&window=60" });
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => d.runId), ["T1"]);
  } finally { await app.close(); index.stop(); }
});

test("with realtime off, every row still carries runId = tripId and unscheduled: false", async () => {
  const { app, index } = await serveWithRealtime(null);
  try {
    const res = await app.inject({ url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180" });
    const body = res.json() as { departures: RtDeparture[] };
    assert.deepEqual(body.departures.map((d) => [d.tripId, d.runId, d.unscheduled]), [["T1", "T1", false], ["T2", "T2", false]]);
  } finally { await app.close(); index.stop(); }
});

/**
 * The board must sort by BOARDABLE (predicted) time, not by a row's
 * nominal/scheduled one -- an unscheduled row's "scheduled"
 * time is itself a derived, shifted value (the template's time + offset), so
 * this is the one case where schedule order and boardable order can point
 * opposite ways within a single response.
 *
 * Fixture: T1 departs stop 1000 at 08:00, T2 at 09:00 (no realtime for
 * either, so each is boardable exactly at its scheduled time). The
 * unscheduled run templates T1 (offsetSeconds = +3900 = 65 min), so its own
 * SHIFTED schedule is 08:00 + 65 min = 09:05 -- LATER than T2's 09:00, so a
 * naive schedule sort would read: T1 (08:00), T2 (09:00), extra (09:05).
 * But its live prediction places it at 07:45 (80 min ahead of that 09:05
 * schedule) -- so the actual boardable order is: extra (07:45), T1 (08:00),
 * T2 (09:00). That is what `boardableEpoch` must produce, and with
 * `limit=1` only `extra` -- the earliest BOARDABLE row, from the array
 * `unscheduledDepartures` builds separately and merges in -- survives the
 * truncation, not whichever of T1/T2 the scheduled query happened to list
 * first.
 */
test("the board sorts unscheduled rows by predicted time, and an unscheduled row can win a tight limit", async () => {
  const store = storeWithUnscheduledOnT1(3900, "2026-08-24T07:45:00+03:00");
  const { app, index } = await serveWithRealtime(store);
  try {
    const full = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180",
    });
    assert.equal(full.statusCode, 200);
    const fullBody = full.json() as { departures: RtDeparture[] };
    assert.deepEqual(
      fullBody.departures.map((d) => d.runId), ["T1@veh-extra", "T1", "T2"],
      "boardable order: extra's 07:45 ETA, then T1's 08:00, then T2's 09:00",
    );

    const limited = await app.inject({
      url: "/stops/1000/departures?at=2026-08-24T07:00:00%2B03:00&window=180&limit=1",
    });
    assert.equal(limited.statusCode, 200);
    const limitedBody = limited.json() as { departures: RtDeparture[] };
    assert.deepEqual(
      limitedBody.departures.map((d) => d.runId), ["T1@veh-extra"],
      "limit=1 keeps the earliest BOARDABLE row -- the unscheduled one -- even though its own shifted schedule (09:05) is the latest of the three",
    );
  } finally { await app.close(); index.stop(); }
});

/**
 * Two unscheduled runs sharing one template trip and one stop must still
 * leave the board with distinct `runId`s end to end,
 * exercising `runIdFor`'s own collision handling through the whole route
 * (`unscheduledDepartures`'s per-request `taken` set), not merely at the unit
 * level.
 */
test("two unscheduled runs on the same template and stop get distinct runIds through the route", async () => {
  const store = new RealtimeStore("siri-sm", 180, () => 1_000);
  const journeyOf = (vehicleRef: string | null): RealtimeJourney => ({
    lineRef: "R1", directionId: 0, dataFrameRef: "2026-08-24", datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef, confidence: null, lat: null, lon: null, recordedAt: null,
    calls: [], distanceFromStart: null,
  });
  // Both start 5 min before T1 (offsetSeconds -300) and predict the same
  // stop, but carry no vehicle ref -- so `runIdFor`'s base id, `T1@-300`, is
  // identical for both, and only the `taken` set tells them apart.
  store.replace(
    [],
    { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0, attached: 0, unscheduled: 2 },
    1_000,
    [
      {
        templateTripIdx: 0, offsetSeconds: -300,
        serviceBaseEpoch: baseEpochOfYmd(20260824, config.timezone), journey: journeyOf(null),
        byStopIdx: new Map([[0, { expectedArrival: Date.parse("2026-08-24T07:57:00+03:00") / 1000, ambiguous: false }]]),
      },
      {
        templateTripIdx: 0, offsetSeconds: -300,
        serviceBaseEpoch: baseEpochOfYmd(20260824, config.timezone), journey: journeyOf(null),
        byStopIdx: new Map([[0, { expectedArrival: Date.parse("2026-08-24T07:58:00+03:00") / 1000, ambiguous: false }]]),
      },
    ],
  );
  const { app, index } = await serveWithRealtime(store);
  try {
    const res = await app.inject({ url: "/stops/1000/departures?at=2026-08-24T07:50:00%2B03:00&window=60" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: RtDeparture[] };
    const unscheduledRows = body.departures.filter((d) => d.unscheduled);
    assert.equal(unscheduledRows.length, 2);
    assert.deepEqual(
      unscheduledRows.map((d) => d.runId).sort(), ["T1@-300", "T1@-300#2"],
      "same template, same offset, no vehicle ref: the second collides on the base id and gets #2",
    );
    for (const d of unscheduledRows) assert.equal(d.tripId, "T1");
  } finally { await app.close(); index.stop(); }
});

test("a rail board row is headed for the train's last stop and carries tripNumber", async () => {
  const { app, index } = await serve();
  try {
    // T106 (rail, train 106) leaves 4000 at 17:00 for stop 1000 "Central Station".
    const res = await app.inject({
      url: "/stops/4000/departures?at=2026-08-24T16:30:00%2B03:00&window=60&lang=en",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { departures: { tripId: string; headsign: string | null; tripNumber: string | null }[] };
    assert.deepEqual(
      body.departures.map((d) => [d.tripId, d.headsign, d.tripNumber]),
      [["T106", "Central Station", "106"]],
    );
  } finally { await app.close(); index.stop(); }
});
