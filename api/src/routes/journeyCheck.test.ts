import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";
import { RealtimeStore } from "../realtime/store.js";
import type { ResolvedJourney } from "../realtime/match.js";
import type { RealtimeJourney } from "../realtime/types.js";

/** Bare fixture: T1 (R1, 1000->2000, 08:00->08:10), T2 (R1, 1000->2000,
 *  09:00->09:10), T3 (R2, 2000->4000, 25:30->25:40, past midnight). */
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * Extends the shared fixture with a same-stop connection: R103's T4 departs
 * stop 2000 -- where T1 (R1) alights -- at 08:15:00, 300 s after T1's
 * 08:10:00 scheduled arrival. T4E is a second, earlier R103 trip
 * (08:09:00 -> 08:19:00) purely so R103's pattern has a MEASURABLE headway
 * (360 s in hour 8) rather than reporting `NO_HEADWAY` and being charged
 * the flat `TRANSFER_MAX_SECONDS` cap -- at the default 0.25 factor this
 * gives a 90 s required margin, comfortably inside the 300 s the fixture
 * offers. Mirrors `routes/plan.test.ts`'s own `serveWithTransfer` fixture
 * exactly (same trips, same numbers) so the two endpoints are provably
 * looking at the same margin.
 *
 * T1 is trip index 0, T4 is trip index 3 (trip_ref 1..5 in insertion
 * order: T1, T2, T3, T4, T4E); stop 1000 is stop index 0, 2000 is index 1,
 * 5000 is index 4 (stop_ref 1, 2, 5).
 */
async function serveWithTransfer(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-transfer-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
    INSERT INTO trips VALUES (5,'T4E','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,29340,29340,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,29940,29940,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * A chain that crosses midnight ENTIRELY within GTFS times > 86400, over
 * TWO legs: T3 (R2, 2000 -> 4000, 25:30 -> 25:40, already in the shared
 * fixture) followed by a new trip T6 (R106, 4000 -> 7000, 25:51 -> 26:01).
 * 660 s of scheduled slack at the connection, comfortably above the flat
 * 60 s floor and the 600 s cap alike (R106 is a single-trip, `NO_HEADWAY`
 * pattern, so it is charged the full cap) -- chosen so the connection
 * itself is never the thing under test, only whether both legs' times
 * render on the correct calendar date without wrapping.
 */
async function serveMidnightChain() {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-midnight-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R106','2','6','קו שישי',NULL,3,NULL);
    INSERT INTO stops VALUES (7,'7000','38837','תחנה שביעית',NULL,32.0500,34.7600,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T6','R106','S1','תחנה שביעית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,4,1,93060,93060,0,1,0);
    INSERT INTO stop_times VALUES (4,7,2,93660,93660,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * Extends `serveWithTransfer`'s fixture (T1, T4, T4E) with a THIRD leg,
 * T5 (route R104, stop 5000 -> stop 6000, 08:35 -> 08:45), giving a chain
 * with TWO connections -- needed to exercise `holds` AGGREGATION, which no
 * single-connection chain can: whether `false` correctly outranks `null`
 * when a response carries one of each, rather than the two being checked
 * in the wrong order (an easy mistake with no other test to catch it).
 *
 * T5 is a single-trip, `NO_HEADWAY` pattern; the 600 s gap it offers after
 * T4 (08:25 -> 08:35) equals `TRANSFER_MAX_SECONDS`'s default cap exactly,
 * so the schedule alone still satisfies it (`<=`, not `<`) regardless of
 * realtime -- the second connection's `holds` is therefore `null` only
 * because T4's own trip is never resolved in the store, not because the
 * schedule fell short too. tripIdx: T1=0, T2=1, T3=2, T4=3, T4E=4, T5=5.
 */
async function serveWithTwoTransfers(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-transfer2-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('R103','2','3','קו שלישי','67003-1-#',3,NULL);
    INSERT INTO stops VALUES (5,'5000','38835','תחנה שלישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO trips VALUES (4,'T4','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (4,5,2,30300,30300,1,0,900);
    INSERT INTO trips VALUES (5,'T4E','R103','S1','תחנה שלישית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,29340,29340,0,1,0);
    INSERT INTO stop_times VALUES (5,5,2,29940,29940,1,0,900);
    INSERT INTO routes VALUES ('R104','2','4','קו רביעי',NULL,3,NULL);
    INSERT INTO stops VALUES (6,'6000','38836','תחנה רביעית',NULL,32.0680,34.7650,0,NULL,'z1');
    INSERT INTO trips VALUES (6,'T5','R104','S1','תחנה רביעית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,5,1,30900,30900,0,1,0);
    INSERT INTO stop_times VALUES (6,6,2,31500,31500,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * A pattern (route RX, stops 9000 -> 10000) with three trips -- TX1 (07:50),
 * TX2 (07:55), TX3 (08:05) -- built so its measured headway differs sharply
 * either side of the 07:00-08:00/08:00-09:00 hour boundary: hour 7 has a
 * MEASURED median gap of 450 s (from the TX1->TX2 and TX2->TX3 gaps, both
 * attributed to hour 7 -- gaps are bucketed by the EARLIER departure's hour,
 * `headway.ts`'s `buildHeadwayTable`), while hour 8 is `NO_HEADWAY` (TX3,
 * the boarding trip under test, is the last active trip on the pattern and
 * contributes no gap of its own).
 *
 * TX3 itself departs 08:05:00 (hour 8), so a rule that only ever looks at
 * the ACTUAL departure's own hour bucket sees `NO_HEADWAY` -> the 600 s cap.
 * A rule that instead evaluates the CANDIDATE boarding instant -- here, the
 * connecting leg TY's own scheduled arrival (07:56:40) plus the flat 60 s
 * buffer, landing at 07:57:40, hour 7 -- sees the MEASURED 450 s headway ->
 * a scaled 113 s requirement instead. 600 vs 113 is exactly the 3.18 %
 * divergent case `requiredMarginFor`'s `reverseSourced` doc comment
 * describes: this fixture exists to make that divergence assertable rather
 * than coincidental, and to give the schedule-only `scheduledShort` path (no
 * realtime needed at all) something to fail on -- TY's scheduled arrival
 * (07:56:40) plus the 600 s reverse-rule requirement is 07:57:40 + 8:20 =
 * past TX3's 08:05:00 departure by exactly 100 s of shortfall (500 s of
 * schedule slack against a 600 s requirement).
 *
 * TY (route RY, stop 8000 -> stop 9000) is the connecting leg: it exists
 * only to arrive stop 9000 at 07:56:40, TX3's own board stop.
 *
 * tripIdx: T1=0, T2=1, T3=2, TY=3, TX1=4, TX2=5, TX3=6.
 */
async function serveWithHourBoundary(realtime: RealtimeStore | null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-hourboundary-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RY','2','Y','קו וואי',NULL,3,NULL);
    INSERT INTO routes VALUES ('RX','2','X','קו איקס',NULL,3,NULL);
    INSERT INTO stops VALUES (8,'8000','38838','תחנה שמינית',NULL,32.0500,34.7500,0,NULL,'z1');
    INSERT INTO stops VALUES (9,'9000','38839','תחנה תשיעית',NULL,32.0520,34.7520,0,NULL,'z1');
    INSERT INTO stops VALUES (10,'10000','38840','תחנה עשירית',NULL,32.0540,34.7540,0,NULL,'z1');

    INSERT INTO trips VALUES (4,'TY','RY','S1','תחנה תשיעית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,8,1,28200,28200,0,1,0);
    INSERT INTO stop_times VALUES (4,9,2,28600,28600,1,0,400);

    INSERT INTO trips VALUES (5,'TX1','RX','S1','תחנה עשירית',0,NULL,0);
    INSERT INTO stop_times VALUES (5,9,1,28200,28200,0,1,0);
    INSERT INTO stop_times VALUES (5,10,2,28260,28260,1,0,60);

    INSERT INTO trips VALUES (6,'TX2','RX','S1','תחנה עשירית',0,NULL,0);
    INSERT INTO stop_times VALUES (6,9,1,28500,28500,0,1,0);
    INSERT INTO stop_times VALUES (6,10,2,28560,28560,1,0,60);

    INSERT INTO trips VALUES (7,'TX3','RX','S1','תחנה עשירית',0,NULL,0);
    INSERT INTO stop_times VALUES (7,9,1,29100,29100,0,1,0);
    INSERT INTO stop_times VALUES (7,10,2,29700,29700,1,0,600);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * A two-leg chain crossing a calendar midnight where the FIRST leg's own
 * GTFS offset is ORDINARY (< 86400): TA (route TAR, stop P -> stop Q,
 * 23:30 -> 23:50) connects into TB (route TBR, stop Q -> stop R, 00:10 ->
 * 00:30 the NEXT calendar day, GTFS offset >= 86400). Both run on S1
 * (Sun-Thu), so both are active on Monday 2026-08-24 -- the service day
 * this fixture's tests query against.
 *
 * Pins a hazard in `dayFor`: rejecting a candidate day for landing before
 * `at`'s own calendar day began, rather than before `at` itself, would
 * discard TA's correct 23:30 boarding the moment `at` ticks past midnight --
 * even though that instant is only minutes away and the rider is plausibly
 * still riding TA at that exact moment. See `dayFor`'s own doc comment for
 * why the lookback is bound from `at` itself, not from midnight.
 *
 * tripIdx: T1=0, T2=1, T3=2, TA=3, TB=4. stopIdx: P=4 (7000), Q=5 (7100),
 * R=6 (7200) -- base fixture's refs 1-4 take indices 0-3.
 */
async function serveCrossBoundaryChain() {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-crossboundary-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('TAR','2','A','קו איי',NULL,3,NULL);
    INSERT INTO routes VALUES ('TBR','2','B','קו בי',NULL,3,NULL);
    INSERT INTO stops VALUES (5,'7000','38841','תחנה פ',NULL,32.0400,34.7400,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'7100','38842','תחנה ק',NULL,32.0420,34.7420,0,NULL,'z1');
    INSERT INTO stops VALUES (7,'7200','38843','תחנה ר',NULL,32.0440,34.7440,0,NULL,'z1');

    INSERT INTO trips VALUES (4,'TA','TAR','S1','תחנה ק',0,NULL,0);
    INSERT INTO stop_times VALUES (4,5,1,84600,84600,0,1,0);
    INSERT INTO stop_times VALUES (4,6,2,85800,85800,1,0,900);

    INSERT INTO trips VALUES (5,'TB','TBR','S1','תחנה ר',0,NULL,0);
    INSERT INTO stop_times VALUES (5,6,1,87000,87000,0,1,0);
    INSERT INTO stop_times VALUES (5,7,2,88200,88200,1,0,900);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

function resolvedJourney(
  tripIdx: number, byStopIdx: [number, number][],
): ResolvedJourney {
  const journey: RealtimeJourney = {
    lineRef: "R", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-1", confidence: "reliable", lat: null, lon: null,
    recordedAt: null, calls: [], distanceFromStart: null,
  };
  return {
    tripIdx, journey,
    byStopIdx: new Map(byStopIdx.map(([stopIdx, expectedArrival]) =>
      [stopIdx, { expectedArrival, ambiguous: false }])),
  };
}

interface CheckLegBody {
  tripId: string;
  route: { id: string; shortName: string | null; longName: string | null; type: number; color: string | null };
  headsign: string | null;
  from: { stopId: string; name: string | null; scheduledDeparture: string; departure: string; delaySeconds: number; predicted: boolean };
  to: { stopId: string; name: string | null; scheduledArrival: string; arrival: string; delaySeconds: number; predicted: boolean };
  durationSeconds: number;
  numStops: number;
}
interface ConnectionBody {
  afterLeg: number; slackSeconds: number; requiredSeconds: number; holds: boolean | null;
}
interface CheckBody {
  at: string;
  legs: CheckLegBody[];
  connections: ConnectionBody[];
  arrivalTime: string;
  holds: boolean | null;
}

test("a two-leg chain with comfortable, on-time slack holds true with zero delays", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  // `StopPrediction.expectedArrival` is an absolute epoch, not a raw GTFS
  // offset -- T1 exactly on schedule: 08:00 at stop 1000, 08:10 at stop 2000.
  store.replace(
    [resolvedJourney(0, [
      [0, Date.parse("2026-08-24T08:00:00+03:00") / 1000],
      [1, Date.parse("2026-08-24T08:10:00+03:00") / 1000],
    ])],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now,
  );
  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&leg=T4,2000,5000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;

    assert.equal(body.legs.length, 2);
    const [l1, l2] = body.legs;
    assert.equal(l1!.tripId, "T1");
    assert.equal(l1!.from.scheduledDeparture, "2026-08-24T08:00:00+03:00");
    assert.equal(l1!.from.departure, "2026-08-24T08:00:00+03:00");
    assert.equal(l1!.from.delaySeconds, 0);
    assert.equal(l1!.to.scheduledArrival, "2026-08-24T08:10:00+03:00");
    assert.equal(l1!.to.arrival, "2026-08-24T08:10:00+03:00");
    assert.equal(l1!.to.delaySeconds, 0);
    assert.equal(l1!.durationSeconds, 600);
    assert.equal(l1!.numStops, 1);
    assert.equal(l2!.tripId, "T4");

    assert.equal(body.connections.length, 1);
    const c = body.connections[0]!;
    assert.equal(c.afterLeg, 0);
    assert.equal(c.slackSeconds, 300);
    assert.equal(c.requiredSeconds, 90);
    assert.equal(c.holds, true);

    assert.equal(body.holds, true);
    assert.equal(body.arrivalTime, "2026-08-24T08:25:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("the same chain with the first leg late enough to break the connection reports false", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  // T1 arrives 250 s late at stop 2000 (08:14:10 instead of 08:10:00).
  // Required margin is 90 s, so 08:14:10 + 90s = 08:15:40 is past T4's
  // 08:15:00 departure.
  store.replace(
    [resolvedJourney(0, [
      [0, Date.parse("2026-08-24T08:00:00+03:00") / 1000],
      [1, Date.parse("2026-08-24T08:14:10+03:00") / 1000],
    ])],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now,
  );
  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&leg=T4,2000,5000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;

    const [l1] = body.legs;
    assert.equal(l1!.to.delaySeconds, 250);
    assert.equal(l1!.to.arrival, "2026-08-24T08:14:10+03:00");

    const c = body.connections[0]!;
    assert.equal(c.holds, false);
    // Computed from the SAME predicted-arrival instant `holds` was decided
    // on (08:14:10 + 90 s required > T4's 08:15:00): 08:15:00 - 08:14:10 =
    // 50 s of real slack left, less than the 90 s required -- consistent
    // with `holds: false`, not the 300 s of purely-scheduled slack.
    assert.equal(c.slackSeconds, 50);
    assert.equal(body.holds, false);
  } finally { await app.close(); index.stop(); }
});

test("a single-leg chain has no connections and holds is true", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    assert.equal(body.legs.length, 1);
    assert.deepEqual(body.connections, []);
    assert.equal(body.holds, true);
    assert.equal(body.arrivalTime, "2026-08-24T08:10:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("a chain crossing midnight resolves on the right service day, unwrapped", async () => {
  const { app, index } = await serveMidnightChain();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T3,2000,4000&leg=T6,4000,7000&at=2026-08-24T20:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    const [l1, l2] = body.legs;
    assert.equal(l1!.from.scheduledDeparture, "2026-08-25T01:30:00+03:00");
    assert.equal(l1!.to.scheduledArrival, "2026-08-25T01:40:00+03:00");
    assert.equal(l2!.from.scheduledDeparture, "2026-08-25T01:51:00+03:00");
    assert.equal(l2!.to.scheduledArrival, "2026-08-25T02:01:00+03:00");
    assert.equal(body.arrivalTime, "2026-08-25T02:01:00+03:00");
    // No realtime configured: never falsely `false` purely for lack of data.
    assert.equal(body.connections[0]!.holds, null);
    assert.equal(body.holds, null);
  } finally { await app.close(); index.stop(); }
});

test("an alighting stop that precedes the boarding stop on that trip is 400, naming the wrong-order reason", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,2000,1000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "bad_request");
    // Distinguishes this from "not served at all" -- the two 400s this
    // endpoint can give for a malformed chain must each name the real
    // problem, not collapse into one generic message.
    assert.match(body.message, /does not come after/);
  } finally { await app.close(); index.stop(); }
});

test("a trip that does not serve one of the stops is 400, naming the not-served reason", async () => {
  const { app, index } = await serve();
  try {
    // T1 (route R1) never visits stop 4000.
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,4000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "bad_request");
    assert.match(body.message, /does not serve stop 4000/);
  } finally { await app.close(); index.stop(); }
});

test("an unknown trip id is 404", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=NOPE,1000,2000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "not_found");
    assert.equal(body.message, "No trip with id NOPE");
  } finally { await app.close(); index.stop(); }
});

test("an unknown stop id is 404", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,NOPE,2000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "not_found");
    assert.equal(body.message, "No stop with id NOPE");
  } finally { await app.close(); index.stop(); }
});

test("more than 12 legs is 400", async () => {
  const { app, index } = await serve();
  try {
    const one = "leg=T1,1000,2000";
    const url = `/journey/check?${Array(13).fill(one).join("&")}&at=2026-08-24T07:30:00%2B03:00`;
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string };
    assert.equal(body.code, "bad_request");
  } finally { await app.close(); index.stop(); }
});

test("no leg at all is 400", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({ url: "/journey/check?at=2026-08-24T07:30:00%2B03:00" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string };
    assert.equal(body.code, "bad_request");
  } finally { await app.close(); index.stop(); }
});

test("a leg that is not exactly three comma-separated parts is 400", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string };
    assert.equal(body.code, "bad_request");
  } finally { await app.close(); index.stop(); }
});

test("a stray space after the comma in a leg is trimmed, not treated as part of the stop id", async () => {
  const { app, index } = await serve();
  try {
    // A literal, un-trimmed " 1000" would 404 -- this pins that trimming
    // actually happens rather than merely being claimed in a comment.
    const res = await app.inject({
      url: "/journey/check?leg=T1,%201000,2000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    assert.equal(body.legs[0]!.from.stopId, "1000");
  } finally { await app.close(); index.stop(); }
});

test("with no realtime configured, every delaySeconds is 0 and holds is never false purely for lack of data", async () => {
  const { app, index } = await serveWithTransfer(null);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&leg=T4,2000,5000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    for (const leg of body.legs) {
      assert.equal(leg.from.delaySeconds, 0);
      assert.equal(leg.to.delaySeconds, 0);
    }
    assert.equal(body.connections[0]!.holds, null);
    assert.equal(body.holds, null);
  } finally { await app.close(); index.stop(); }
});

test("the index not being built yet is a retryable 503, not a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-journeycheck-noix-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index }); // deliberately no rebuild()
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { code: string };
    assert.equal(body.code, "index_not_ready");
  } finally { await app.close(); index.stop(); }
});

test("requiredSeconds uses the reverse-pass window-maximum rule (not the forward pointwise one) when they diverge, and a schedule-only shortfall reports false with no realtime at all", async () => {
  const { app, index } = await serveWithHourBoundary(null);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=TY,8000,9000&leg=TX3,9000,10000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    const c = body.connections[0]!;
    // The forward pointwise rule, evaluated at TY's own candidate boarding
    // instant (07:56:40 + 60 s = hour 7's measured 450 s headway), would
    // give 113 s here. Asserting the actual 600 s (the reverse rule's
    // window maximum, dominated by hour 8's NO_HEADWAY) pins that this
    // endpoint really takes the more conservative of the two, not merely
    // "a" margin -- flipping `reverseSourced` to `false` at the call site
    // makes this assertion fail.
    assert.equal(c.requiredSeconds, 600);
    // 500 s of scheduled slack (07:56:40 -> 08:05:00) against 600 s
    // required: the schedule alone already falls short, so this is false
    // regardless of realtime -- and no realtime is configured at all here.
    assert.equal(c.holds, false);
    assert.equal(c.slackSeconds, 500);
    assert.equal(body.holds, false);
  } finally { await app.close(); index.stop(); }
});

test("holds and slackSeconds stay consistent when a schedule-only shortfall coincides with an early realtime prediction", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  // TY (tripIdx 3) predicted 100 s EARLY at stop 9000: 07:56:40 - 100 s =
  // 07:55:00. If `holds` and `slackSeconds` were computed from different
  // instants (the schedule for one, this early prediction for the other),
  // the early arrival would inflate `slackSeconds` past `requiredSeconds`
  // while `holds` still reports `false` -- a client checking
  // `slack >= required` on its own would disagree with the server.
  store.replace(
    // Stop index, not stop_ref: `9000`'s stop_ref is 9, but `buildIndex`
    // assigns indices by ascending stop_ref over ALL rows -- base fixture
    // refs 1-4 take indices 0-3, so refs 8/9/10 (this fixture's own W/X/Z)
    // land at indices 4/5/6. Index 5 is `9000` (X), TX3's own board stop.
    [resolvedJourney(3, [[5, Date.parse("2026-08-24T07:55:00+03:00") / 1000]])],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now,
  );
  const { app, index } = await serveWithHourBoundary(store);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=TY,8000,9000&leg=TX3,9000,10000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    const c = body.connections[0]!;
    assert.equal(c.holds, false);
    // Computed from the SCHEDULED arrival (07:56:40), the instant the
    // `scheduledShort` verdict was actually decided against -- NOT from the
    // early 07:55:00 prediction, which would report 600 s (>= the 600 s
    // required) and contradict `holds: false`.
    assert.equal(c.slackSeconds, 500);
  } finally { await app.close(); index.stop(); }
});

test("false outranks null when a chain has one connection of each", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  // Only T1 (tripIdx 0) is resolved, 250 s late -- breaking the first
  // connection. T4 (tripIdx 3) is never resolved, leaving the second
  // connection's status genuinely unknown (`null`), not confirmed either
  // way. A chain with only ONE connection can never exercise which of
  // `false`/`null` wins when a response carries both.
  store.replace(
    [resolvedJourney(0, [
      [0, Date.parse("2026-08-24T08:00:00+03:00") / 1000],
      [1, Date.parse("2026-08-24T08:14:10+03:00") / 1000],
    ])],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now,
  );
  const { app, index } = await serveWithTwoTransfers(store);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&leg=T4,2000,5000&leg=T5,5000,6000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    assert.equal(body.connections.length, 2);
    assert.equal(body.connections[0]!.holds, false);
    assert.equal(body.connections[1]!.holds, null);
    // `false` must outrank `null`, not the reverse -- swapping the
    // aggregation's check order would report `null` here instead.
    assert.equal(body.holds, false);
  } finally { await app.close(); index.stop(); }
});

test("a rider checking a wraparound leg just after midnight resolves the same-night boarding instant, not one 24h later", async () => {
  const { app, index } = await serve();
  try {
    // T3 departs stop 2000 at GTFS 25:30 (01:30 the next calendar day).
    // Queried at 01:00 the SAME night the trip is actually running:
    // `ymdOf(at)` is one calendar day past T3's own service date, so
    // "today"'s DayContext places T3's board a full 24 h too late
    // (2026-08-26T01:30) unless the "yesterday" DayContext -- whose board
    // instant lands only 30 min after `at` -- is preferred instead.
    const res = await app.inject({
      url: "/journey/check?leg=T3,2000,4000&at=2026-08-25T01:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    assert.equal(body.legs[0]!.from.scheduledDeparture, "2026-08-25T01:30:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("a trip inactive on every day near `at` is rejected rather than answered with a stale, wrong-day time", async () => {
  const { app, index } = await serve();
  try {
    // T1 runs S1 (Sun-Thu). 2026-08-28 is a Friday: "today" (Friday) is
    // inactive, and "yesterday" (Thursday) IS active -- but placing T1's
    // ordinary 08:00 there lands on Thursday itself, before Friday's own
    // start, which is a stale, unrelated recurrence of the trip, not a
    // wraparound continuation into `at`'s own day. Neither day is a
    // legitimate answer.
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&at=2026-08-28T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "trip_not_active");
    assert.match(body.message, /T1/);
  } finally { await app.close(); index.stop(); }
});

test("a leg boarded just before midnight stays eligible when checked just after it", async () => {
  const { app, index } = await serveCrossBoundaryChain();
  try {
    // Correct at 23:58: both legs resolve on Monday's own service day, 20
    // min (1200 s) of scheduled slack at the connection, no realtime
    // configured so the connection's own status is genuinely unknown.
    const before = await app.inject({
      url: "/journey/check?leg=TA,7000,7100&leg=TB,7100,7200&at=2026-08-24T23:58:00%2B03:00",
    });
    assert.equal(before.statusCode, 200);
    const beforeBody = before.json() as CheckBody;
    assert.equal(beforeBody.legs[0]!.from.scheduledDeparture, "2026-08-24T23:30:00+03:00");
    assert.equal(beforeBody.legs[1]!.from.scheduledDeparture, "2026-08-25T00:10:00+03:00");
    assert.equal(beforeBody.connections[0]!.slackSeconds, 1200);
    assert.equal(beforeBody.connections[0]!.holds, null);

    // The boundary this fixture is built to test: 32 s later, `at` ticks
    // past midnight. TA's 23:30 boarding is still only 31 min in the past
    // -- the rider is plausibly still on the vehicle -- and must resolve
    // to the SAME instant as above, not silently jump 24 h forward.
    const after = await app.inject({
      url: "/journey/check?leg=TA,7000,7100&leg=TB,7100,7200&at=2026-08-25T00:00:01%2B03:00",
    });
    assert.equal(after.statusCode, 200);
    const afterBody = after.json() as CheckBody;
    assert.equal(afterBody.legs[0]!.from.scheduledDeparture, "2026-08-24T23:30:00+03:00");
    assert.equal(afterBody.legs[1]!.from.scheduledDeparture, "2026-08-25T00:10:00+03:00");
    assert.equal(afterBody.connections[0]!.slackSeconds, 1200);
    assert.equal(afterBody.connections[0]!.holds, null);
  } finally { await app.close(); index.stop(); }
});

test("a single already-boarded leg checked just after midnight does not silently jump 24h forward", async () => {
  const { app, index } = await serveCrossBoundaryChain();
  try {
    const res = await app.inject({
      url: "/journey/check?leg=TA,7000,7100&at=2026-08-25T00:02:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CheckBody;
    assert.equal(body.legs[0]!.from.scheduledDeparture, "2026-08-24T23:30:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("predicted says which leg ends came from the realtime store, even when on time", async () => {
  const now = Date.parse("2026-08-24T07:00:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  store.replace(
    [resolvedJourney(0, [
      [0, Date.parse("2026-08-24T08:00:00+03:00") / 1000],
      [1, Date.parse("2026-08-24T08:10:00+03:00") / 1000],
    ])],
    { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now,
  );
  const { app, index } = await serveWithTransfer(store);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&leg=T4,2000,5000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const [l1, l2] = (res.json() as CheckBody).legs;
    // On time AND live: the case `delaySeconds: 0` alone cannot tell apart
    // from "no prediction at all".
    assert.equal(l1!.from.delaySeconds, 0);
    assert.equal(l1!.from.predicted, true);
    assert.equal(l1!.to.predicted, true);
    // T4 has no journey in the store.
    assert.equal(l2!.from.predicted, false);
    assert.equal(l2!.to.predicted, false);
  } finally { await app.close(); index.stop(); }
});

test("with no realtime configured, no leg end is predicted", async () => {
  const { app, index } = await serveWithTransfer(null);
  try {
    const res = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&leg=T4,2000,5000&at=2026-08-24T07:30:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    for (const leg of (res.json() as CheckBody).legs) {
      assert.equal(leg.from.predicted, false);
      assert.equal(leg.to.predicted, false);
    }
  } finally { await app.close(); index.stop(); }
});

test("a checked rail leg is headed for the train's last stop and carries tripNumber", async () => {
  const { app, index } = await serve();
  try {
    type Body = { legs: (CheckLegBody & { tripNumber: string | null })[] };
    const railRes = await app.inject({
      url: "/journey/check?leg=T106,4000,1000&at=2026-08-24T16:30:00%2B03:00&lang=en",
    });
    const rail = railRes.json() as Body;
    assert.equal(railRes.statusCode, 200, JSON.stringify(rail));
    assert.equal(rail.legs[0]!.headsign, "Central Station");
    assert.equal(rail.legs[0]!.tripNumber, "106");
    const busRes = await app.inject({
      url: "/journey/check?leg=T1,1000,2000&at=2026-08-24T07:30:00%2B03:00&lang=en",
    });
    const bus = busRes.json() as Body;
    assert.equal(busRes.statusCode, 200, JSON.stringify(bus));
    assert.equal(bus.legs[0]!.headsign, "Herzl");
    assert.equal(bus.legs[0]!.tripNumber, null);
  } finally { await app.close(); index.stop(); }
});
