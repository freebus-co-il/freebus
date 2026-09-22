import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex, attachFootpaths } from "../transit/index.js";
import { buildFootpaths } from "../transit/footpaths.js";
import { buildServer } from "../server.js";
import { RealtimeStore } from "../realtime/store.js";
import type { ResolvedJourney } from "../realtime/match.js";
import type { RealtimeJourney } from "../realtime/types.js";

/**
 * The rider's own vehicle, plus two ways off it.
 *
 * TB (route RB) is the bus the rider is aboard: 1000 08:00 -> 2000 08:10 ->
 * 5000 08:20 -> 6000 08:30. Four stops, deliberately, because the endpoint's
 * most useful answer is "stay aboard two more stops" and a two-stop trip
 * cannot express it.
 *
 * Two onward routes to the same destination (9000), one from each of the two
 * interesting alighting points:
 *
 *  - RX, from stop 2000: 08:00, 08:15, 08:25, 08:35 (gaps 900/600/600 in
 *    hour 8 -> median 600 -> required margin clamp(60, 0.25*600, 600) = 150 s).
 *    Every trip takes 50 minutes.
 *  - RY, from stop 5000: 08:05, 08:25, 08:45 (gaps 1200/1200 -> median 1200
 *    -> required margin clamp(60, 300, 600) = 300 s). Every trip takes 25
 *    minutes.
 *
 * So the rider who gets off at the first opportunity (2000, 08:10) catches
 * RX's 08:15 and lands 09:05, and the rider who stays aboard to 5000 (08:20)
 * catches RY's 08:25 and lands 08:50 -- fifteen minutes earlier, on a bus
 * they were already sitting on. That is the whole endpoint in one fixture.
 *
 * Index positions, both assigned by ascending ref (see `buildIndex`):
 * stop 1000=0, 2000=1, 3000=2, 4000=3, 5000=4, 6000=5, 9000=6, 12000=7;
 * trip T1=0, T2=1, T3=2, TB=3, TX0=4, TX1=5, TX2=6, TX3=7, TY0=8, TY1=9,
 * TY2=10, and the shared fixture's T101..T105 after those.
 */
async function serveOnboard(realtime: RealtimeStore | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-onboard-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RB','2','B','קו הנוסע',NULL,3,NULL);
    INSERT INTO routes VALUES ('RX','2','X','קו איקס',NULL,3,NULL);
    INSERT INTO routes VALUES ('RY','2','Y','קו יגרק',NULL,3,NULL);

    INSERT INTO stops VALUES (5,'5000','38835','תחנה חמישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'6000','38836','תחנה שישית',NULL,32.0680,34.7650,0,NULL,'z1');
    INSERT INTO stops VALUES (9,'9000','38839','יעד',NULL,32.0900,34.7500,0,NULL,'z1');
    -- No trip calls here and it is a long way outside any walking radius:
    -- the unreachable destination the test below asks for. Stop 1000 does
    -- not work for this: the shared fixture's line 67003 runs 4000 -> 1000
    -- in the afternoon, so the rider genuinely can get back there.
    INSERT INTO stops VALUES (12,'12000','38842','קצה העולם',NULL,32.8000,35.5000,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref IN (5,6,9,12);
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref IN (5,6,9,12);

    INSERT INTO trips VALUES (4,'TB','RB','S1','שישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29400,29400,0,0,600);
    INSERT INTO stop_times VALUES (4,5,3,30000,30000,0,0,1200);
    INSERT INTO stop_times VALUES (4,6,4,30600,30600,1,0,1800);

    INSERT INTO trips VALUES (5,'TX0','RX','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (5,9,2,31800,31800,1,0,3000);
    INSERT INTO trips VALUES (6,'TX1','RX','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (6,2,1,29700,29700,0,1,0);
    INSERT INTO stop_times VALUES (6,9,2,32700,32700,1,0,3000);
    INSERT INTO trips VALUES (7,'TX2','RX','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (7,2,1,30300,30300,0,1,0);
    INSERT INTO stop_times VALUES (7,9,2,33300,33300,1,0,3000);
    INSERT INTO trips VALUES (8,'TX3','RX','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (8,2,1,30900,30900,0,1,0);
    INSERT INTO stop_times VALUES (8,9,2,33900,33900,1,0,3000);

    INSERT INTO trips VALUES (9,'TY0','RY','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (9,5,1,29100,29100,0,1,0);
    INSERT INTO stop_times VALUES (9,9,2,30600,30600,1,0,2000);
    INSERT INTO trips VALUES (10,'TY1','RY','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (10,5,1,30300,30300,0,1,0);
    INSERT INTO stop_times VALUES (10,9,2,31800,31800,1,0,2000);
    INSERT INTO trips VALUES (11,'TY2','RY','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (11,5,1,31500,31500,0,1,0);
    INSERT INTO stop_times VALUES (11,9,2,33000,33000,1,0,2000);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}

/**
 * The margin fixture: one vehicle, one onward route, and a connection that
 * the headway-scaled margin refuses.
 *
 * TB is 1000 08:00 -> 2000 08:10 again. RM runs from 2000 at 08:00, 08:12 and
 * 08:40 -- gaps 720 and 1680 in hour 8, median 1200, so the required margin
 * is clamp(60, 0.25*1200, 600) = 300 s. A rider alighting at 08:10 has 120 s
 * to the 08:12 departure, well under that, so the margin pushes them to the
 * 08:40 and a 09:20 arrival.
 *
 * The same connection is comfortably legal for someone STANDING at stop 2000
 * at 08:10, because a journey's first boarding is exempt from the transfer
 * margin -- which is exactly what `/plan` returns for the paired query in
 * the test below, and exactly what `/plan/onboard` must not do.
 *
 * Index positions: stop 9000 = 6 (refs 1,2,3,4,9 -> 0..4... see the test that
 * uses them); trip TB=3, TM0=4, TM1=5, TM2=6.
 */
async function serveOnboardMargin() {
  const dir = mkdtempSync(join(tmpdir(), "transit-onboard-margin-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RB','2','B','קו הנוסע',NULL,3,NULL);
    INSERT INTO routes VALUES ('RM','2','M','קו מם',NULL,3,NULL);

    INSERT INTO stops VALUES (9,'9000','38839','יעד',NULL,32.0900,34.7500,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref = 9;
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref = 9;

    INSERT INTO trips VALUES (4,'TB','RB','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29400,29400,1,0,600);

    INSERT INTO trips VALUES (5,'TM0','RM','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (5,9,2,31200,31200,1,0,3000);
    INSERT INTO trips VALUES (6,'TM1','RM','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (6,2,1,29520,29520,0,1,0);
    INSERT INTO stop_times VALUES (6,9,2,31920,31920,1,0,3000);
    INSERT INTO trips VALUES (7,'TM2','RM','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (7,2,1,31200,31200,0,1,0);
    INSERT INTO stop_times VALUES (7,9,2,33600,33600,1,0,3000);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * The after-midnight fixture, entirely in GTFS times above 86400.
 *
 * The shared fixture's own T3 (route R2) is the vehicle: 2000 at 25:30 ->
 * 4000 at 25:40. TN (route RN) carries the rider on from 4000 at 25:55 to
 * 9000 at 26:15. RN is a single-trip pattern, so it reports NO_HEADWAY and is
 * charged the full 600 s cap: a rider alighting at 25:40 is ready at 25:41 +
 * 540 = 25:50, still inside the 25:55 departure, so the connection holds.
 *
 * Queried at 01:32 local on 2026-08-25, which is 25:32 on the 2026-08-24
 * service day -- the day-selection problem `journeyCheck.ts` got wrong twice.
 * Both days are active (S1 is Sun-Thu; the 24th is a Monday), so nothing but
 * "whichever boarding instant is nearest the query" resolves it.
 */
async function serveOnboardMidnight() {
  const dir = mkdtempSync(join(tmpdir(), "transit-onboard-midnight-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RN','2','N','קו נון',NULL,3,NULL);
    INSERT INTO stops VALUES (9,'9000','38839','יעד',NULL,32.0900,34.7500,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref = 9;
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref = 9;

    INSERT INTO trips VALUES (4,'TN','RN','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (4,4,1,93300,93300,0,1,0);
    INSERT INTO stop_times VALUES (4,9,2,94500,94500,1,0,3000);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}


/**
 * The LAYER-TWO retry fixture: a network where the scaled margin deletes
 * every itinerary and the flat-rule retry recovers one whose FIRST boarding
 * is sub-margin.
 *
 * TB puts the rider down at stop 2000 at 08:10. RM runs 2000 -> 7000 at
 * 08:00, 08:12 and 08:40 (gaps 720/1680 in hour 8 -> median 1200 -> required
 * 300 s). RZ runs 7000 -> 9000 at 08:30 and 08:50 (one 1200 s gap in hour 8 ->
 * required 300 s, and NO_HEADWAY -> the 600 s cap in hour 9).
 *
 * At the configured margin the rider is ready at 08:15, so RM's 08:12 is
 * refused and they take the 08:40 -- landing at 7000 at 09:00, by which time
 * RZ's last trip has gone. Nothing reaches 9000 at all. That is the CHAIN
 * effect layer one cannot close: every individual connection was handled
 * correctly (RM has a later trip, so `earliestTripOnDay`'s own fallback never
 * fires) and the journey still disappeared.
 *
 * The retry at the flat rule recovers it: 08:12 -> 7000 08:32 -> RZ 08:50 ->
 * 9000 09:00. Its first boarding is 120 s after the rider steps off a bus
 * that may be late, where the configured rule demanded 300 -- and no
 * transit-leg-to-transit-leg check can see it, because the vehicle the rider
 * is ON is not a leg of the itinerary.
 *
 * Index positions: stop 1000=0, 2000=1, 3000=2, 4000=3, 7000=4, 9000=5;
 * trip T1=0, T2=1, T3=2, TB=3, TM0=4, TM1=5, TM2=6, TZ0=7, TZ1=8.
 */
async function serveOnboardRetry(realtime: RealtimeStore | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "transit-onboard-retry-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RB','2','B','קו הנוסע',NULL,3,NULL);
    INSERT INTO routes VALUES ('RM','2','M','קו מם',NULL,3,NULL);
    INSERT INTO routes VALUES ('RZ','2','Z','קו זין',NULL,3,NULL);

    INSERT INTO stops VALUES (7,'7000','38837','צומת',NULL,32.0700,34.7600,0,NULL,'z1');
    INSERT INTO stops VALUES (9,'9000','38839','יעד',NULL,32.0900,34.7500,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref IN (7,9);
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref IN (7,9);

    INSERT INTO trips VALUES (4,'TB','RB','S1','הרצל',0,NULL,0);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29400,29400,1,0,600);

    INSERT INTO trips VALUES (5,'TM0','RM','S1','צומת',0,NULL,0);
    INSERT INTO stop_times VALUES (5,2,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (5,7,2,30000,30000,1,0,2000);
    INSERT INTO trips VALUES (6,'TM1','RM','S1','צומת',0,NULL,0);
    INSERT INTO stop_times VALUES (6,2,1,29520,29520,0,1,0);
    INSERT INTO stop_times VALUES (6,7,2,30720,30720,1,0,2000);
    INSERT INTO trips VALUES (7,'TM2','RM','S1','צומת',0,NULL,0);
    INSERT INTO stop_times VALUES (7,2,1,31200,31200,0,1,0);
    INSERT INTO stop_times VALUES (7,7,2,32400,32400,1,0,2000);

    INSERT INTO trips VALUES (8,'TZ0','RZ','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (8,7,1,30600,30600,0,1,0);
    INSERT INTO stop_times VALUES (8,9,2,31200,31200,1,0,2000);
    INSERT INTO trips VALUES (9,'TZ1','RZ','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (9,7,1,31800,31800,0,1,0);
    INSERT INTO stop_times VALUES (9,9,2,32400,32400,1,0,2000);
  `);
  raw.close();

  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index, realtime }), index };
}


/**
 * The alight-and-WALK fixture. TB runs 1000 -> 2000 -> 5000 -> 6000 as
 * always; stop 8000 sits ~73 m from 5000, and RW (8000 -> 9000, at 08:00,
 * 08:30 and 09:00 -- gaps 1800 s in hour 8, so a 450 s required margin) is
 * the only way to the destination.
 *
 * So the rider gets off at 5000, walks to 8000, and boards there. The point
 * under test is that `alightAt` names 5000 -- where they left the VEHICLE --
 * and not 8000, where they boarded. Footpaths are built at a 200 m radius,
 * which connects that one pair and no other (5000 is 556 m from 2000 and
 * 578 m from 6000), with a stub Valhalla that declines to route so the
 * straight-line fallback is used and no container is required.
 */
async function serveOnboardWalk() {
  const dir = mkdtempSync(join(tmpdir(), "transit-onboard-walk-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RB','2','B','קו הנוסע',NULL,3,NULL);
    INSERT INTO routes VALUES ('RW','2','W','קו וו',NULL,3,NULL);

    INSERT INTO stops VALUES (5,'5000','38835','תחנה חמישית',NULL,32.0650,34.7700,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'6000','38836','תחנה שישית',NULL,32.0680,34.7650,0,NULL,'z1');
    INSERT INTO stops VALUES (8,'8000','38838','ממול',NULL,32.0655,34.7705,0,NULL,'z1');
    INSERT INTO stops VALUES (9,'9000','38839','יעד',NULL,32.0900,34.7500,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref IN (5,6,8,9);
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref IN (5,6,8,9);

    INSERT INTO trips VALUES (4,'TB','RB','S1','שישית',0,NULL,0);
    INSERT INTO stop_times VALUES (4,1,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (4,2,2,29400,29400,0,0,600);
    INSERT INTO stop_times VALUES (4,5,3,30000,30000,0,0,1200);
    INSERT INTO stop_times VALUES (4,6,4,30600,30600,1,0,1800);

    INSERT INTO trips VALUES (5,'TW0','RW','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (5,8,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (5,9,2,29700,29700,1,0,2000);
    INSERT INTO trips VALUES (6,'TW1','RW','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (6,8,1,30600,30600,0,1,0);
    INSERT INTO stop_times VALUES (6,9,2,31500,31500,1,0,2000);
    INSERT INTO trips VALUES (7,'TW2','RW','S1','יעד',0,NULL,0);
    INSERT INTO stop_times VALUES (7,8,1,32400,32400,0,1,0);
    INSERT INTO stop_times VALUES (7,9,2,33300,33300,1,0,2000);
  `);
  raw.close();

  const index = new IndexManager(dir, {
    buildFn: async () => {
      const ix = buildIndex(link);
      const { arrays } = await buildFootpaths(
        ix,
        { ping: async () => false, matrix: async () => { throw new Error("no"); } } as never,
        { maxMeters: 200, sameStationSeconds: 180, transferMinSeconds: 60,
          batchSize: 10, speedMps: 1.33 },
      );
      attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
      return ix;
    },
  });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/**
 * The one fixture in this file built to make THREE candidates survive
 * `paretoRounds` at DIFFERENT transfer counts to the same destination, with
 * the CHEAPEST one neither first in round order nor the earliest arriver.
 *
 * That third property is load-bearing: with only two survivors,
 * `paretoRounds`'s own invariant (a later round is kept only when it beats
 * every earlier round's arrival -- see that function's doc comment) forces
 * the later-round survivor to ALWAYS arrive earlier than the earlier-round
 * one. So with two candidates, "the cheaper one" and "the earlier arriver"
 * are always the SAME candidate, and a test asserting `itineraries[0]` is
 * cheap cannot distinguish `rankItineraries` from a plain `sort by arrival
 * ascending` -- a bug that swapped one for the other would pass undetected.
 * Three survivors, with the MIDDLE one cheapest, break that tie: an arrival
 * sort would promote the LAST (earliest-arriving) survivor, not the middle
 * one.
 *
 * TR (route RR) is the rider's vehicle: 9000 (S0, last stop passed) 08:00:00
 * -> 9100 (A) 08:10:00 -> 9200 (B, terminus) 08:13:00. `AT` (08:05:00) falls
 * between S0 and A, so A and B are both live seeds (`secondsToReach` 300 s
 * and 480 s). The destination is the COORDINATE 32.057186,34.7600 (not a
 * stop), so `accessStops` -- not the footpath network -- supplies every
 * egress candidate by straight-line distance; Valhalla is unreachable in
 * this fixture (as in every other one here), so `refineAccessByWalking`
 * degrades to that same straight-line estimate untouched (see its own doc
 * comment: `refined: false` returns `[...candidates]` verbatim).
 *
 * Three ways from here to the destination coordinate:
 *
 *  - WALK OFF AT A -- round 0, zero transit legs. A is 799.05 m from the
 *    destination (haversine); `accessStops`' estimate is
 *    `round(799.05 * WALK_DETOUR_FACTOR(1.35) / speedMps(1.33))` = 811 s (NO
 *    boarding buffer -- that only applies to the footpath network's
 *    internal transfers, not an egress walk). Arrival: 08:10:00 + 811 s =
 *    **08:23:31**. `journeyCost` (durationSeconds 811, walkSeconds 811,
 *    transfers 0, `walkWeight` 2.0): `811 + 811*(2.0-1) = `**1622**.
 *
 *  - RIDE TO B, THEN TC1 -- round 1, one transit leg, to stop 9300 (E),
 *    29.97 m from the destination (egress 30 s). Route RC's TC0 (headway
 *    data only, departs before the rider even reaches B) and TC1 give a
 *    240 s gap in hour 8's bucket -> median 240 -> required margin
 *    `clamp(60, 0.25*240=60, 600)` = 60 s, the floor. `originsOnVehicle:
 *    true` charges the seed-to-boarding transfer that margin in full: ready
 *    = B's arrival (08:13:00) + `transferMinSeconds`(60) + extra(0, since
 *    required == base) = 08:14:00 = TC1's own departure, exactly. TC1
 *    reaches E at 08:17:20; + 30 s egress = **08:17:50**. `journeyCost`
 *    (durationSeconds 290 [08:13:00 -> 08:17:50], walkSeconds 30, transfers
 *    0): `290 + 30*(2.0-1) = `**320** -- the CHEAPEST of the three.
 *
 *  - RIDE TO B, THEN TF1, TRANSFER TO TG1 -- round 2, two transit legs
 *    (one transfer), to stop 9500 (F2), 10.01 m from the destination
 *    (egress 10 s). Same 240 s-gap trick gives both TF1 (B -> 9400/H2) and
 *    TG1 (H2 -> F2) a 60 s required margin: TF1 departs B at 08:14:00 (ready
 *    = B's arrival(08:13:00) + 60), reaches H2 at 08:14:10; TG1 departs H2
 *    at 08:15:10 (ready = H2's arrival(08:14:10) + 60, since a transit
 *    label is charged the buffer same as an onboard one), reaches F2 at
 *    08:15:20; + 10 s egress = **08:15:30** -- EARLIER than TC1's route,
 *    the strict improvement `paretoRounds` requires to keep a third entry.
 *    `journeyCost` (durationSeconds 150 [08:13:00 -> 08:15:30], walkSeconds
 *    10, transfers 1, `transferPenaltySeconds` 300): `150 + 10*(2.0-1) +
 *    300*1 = `**460**.
 *
 * So: arrival times are 08:23:31 > 08:17:50 > 08:15:30 (round 0 latest,
 * round 2 earliest -- `paretoRounds`' own invariant), while costs are
 * 1622 > 460 > 320 (round 1 cheapest). Ranking must therefore produce
 * `[round 1 (320, 08:17:50), round 2 (460, 08:15:30), round 0 (1622,
 * 08:23:31)]` -- round 1 on top despite round 2 arriving three and a half
 * minutes SOONER. No arrival-ascending sort produces that order (it would
 * put round 2 first); no round-order pass-through produces it either (that
 * is `[round 0, round 1, round 2]`, unchanged). Only cost-based ranking
 * does.
 */
async function serveOnboardRanking() {
  const dir = mkdtempSync(join(tmpdir(), "transit-onboard-ranking-"));
  const link = buildFixtureDb(dir);

  const raw = new Database(link);
  raw.exec(`
    INSERT INTO routes VALUES ('RR','2','R','קו הנוסע השני',NULL,3,NULL);
    INSERT INTO routes VALUES ('RC','2','C','קו המחבר',NULL,3,NULL);
    INSERT INTO routes VALUES ('RF','2','F','קו המעביר',NULL,3,NULL);
    INSERT INTO routes VALUES ('RG','2','G','קו הסופי',NULL,3,NULL);

    INSERT INTO stops VALUES (5,'9000','50001','מוצא',NULL,32.0400,34.7500,0,NULL,'z1');
    INSERT INTO stops VALUES (6,'9100','50002','ליד היעד הרחוק',NULL,32.0500,34.7600,0,NULL,'z1');
    INSERT INTO stops VALUES (7,'9200','50003','מחלף',NULL,32.0300,34.7400,0,NULL,'z1');
    INSERT INTO stops VALUES (8,'9300','50004','ליד היעד',NULL,32.057186,34.760318,0,NULL,'z1');
    INSERT INTO stops VALUES (9,'9400','50005','מחלף שני',NULL,32.0200,34.7300,0,NULL,'z1');
    INSERT INTO stops VALUES (10,'9500','50006','ממש ליד היעד',NULL,32.057096,34.7600,0,NULL,'z1');
    INSERT INTO stops_rtree SELECT stop_ref, stop_lat, stop_lat, stop_lon, stop_lon
      FROM stops WHERE stop_ref IN (5,6,7,8,9,10);
    INSERT INTO stops_fts (stop_name, stop_ref)
      SELECT stop_name, stop_ref FROM stops WHERE stop_ref IN (5,6,7,8,9,10);

    -- Rider's own vehicle: S0(9000) -> A(9100) -> B(9200, terminus).
    INSERT INTO trips VALUES (4,'TR','RR','S1','מחלף',0,NULL,0);
    INSERT INTO stop_times VALUES (4,5,1,28800,28800,0,1,0);
    INSERT INTO stop_times VALUES (4,6,2,29400,29400,0,0,600);
    INSERT INTO stop_times VALUES (4,7,3,29580,29580,1,0,780);

    -- RC: B(9200) -> E(9300), 30 m from the destination. TC0 is headway
    -- data only; TC1 is the one the rider actually boards.
    INSERT INTO trips VALUES (5,'TC0','RC','S1','ליד היעד',0,NULL,0);
    INSERT INTO stop_times VALUES (5,7,1,29400,29400,0,1,0);
    INSERT INTO stop_times VALUES (5,8,2,29600,29600,1,0,200);
    INSERT INTO trips VALUES (6,'TC1','RC','S1','ליד היעד',0,NULL,0);
    INSERT INTO stop_times VALUES (6,7,1,29640,29640,0,1,0);
    INSERT INTO stop_times VALUES (6,8,2,29840,29840,1,0,200);

    -- RF: B(9200) -> H2(9400), the round-2 chain's first hop. TF0 is
    -- headway data only; TF1 is boarded.
    INSERT INTO trips VALUES (7,'TF0','RF','S1','מחלף שני',0,NULL,0);
    INSERT INTO stop_times VALUES (7,7,1,29400,29400,0,1,0);
    INSERT INTO stop_times VALUES (7,9,2,29410,29410,1,0,10);
    INSERT INTO trips VALUES (8,'TF1','RF','S1','מחלף שני',0,NULL,0);
    INSERT INTO stop_times VALUES (8,7,1,29640,29640,0,1,0);
    INSERT INTO stop_times VALUES (8,9,2,29650,29650,1,0,10);

    -- RG: H2(9400) -> F2(9500), 10 m from the destination -- the round-2
    -- chain's transfer leg. TG0 is headway data only; TG1 is boarded.
    INSERT INTO trips VALUES (9,'TG0','RG','S1','ממש ליד היעד',0,NULL,0);
    INSERT INTO stop_times VALUES (9,9,1,29470,29470,0,1,0);
    INSERT INTO stop_times VALUES (9,10,2,29480,29480,1,0,10);
    INSERT INTO trips VALUES (10,'TG1','RG','S1','ממש ליד היעד',0,NULL,0);
    INSERT INTO stop_times VALUES (10,9,1,29710,29710,0,1,0);
    INSERT INTO stop_times VALUES (10,10,2,29720,29720,1,0,10);
  `);
  raw.close();

  // No custom footpath network, and none needed: the destination here is a
  // COORDINATE, so every egress candidate comes from `accessStops`' own
  // straight-line scan, not from the footpath graph -- exactly like
  // `serveOnboard()`/`serveOnboardMargin()` above, which build the index the
  // same plain way for the same reason.
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  return { app: await buildServer({ index }), index };
}

/** A transit leg's endpoints wrap a `stop` and carry times; a walk leg's
 *  endpoints ARE the place, with `stopId` directly on them (see
 *  `transit/itinerary.ts`'s `WalkLeg`/`TransitLeg`). One optional-field type
 *  covers both rather than two casts at every use. */
interface OnboardLeg {
  type: string;
  tripId?: string;
  from?: { stop?: { stopId: string }; stopId?: string; departureTime?: string };
  to?: { stop?: { stopId: string }; stopId?: string; arrivalTime?: string };
}
interface OnboardItinerary {
  departureTime: string;
  arrivalTime: string;
  transferAtRisk: boolean | null;
  legs: OnboardLeg[];
  alightAt: { stopId: string; name: string | null; arrivalTime: string };
}
interface OnboardBody {
  query: Record<string, unknown>;
  delaySource: string;
  itineraries: OnboardItinerary[];
}

const AT = "2026-08-24T08:05:00%2B03:00"; // Monday, mid-ride between 1000 and 2000

test("staying aboard longer wins when it should, and alightAt names the stop", async () => {
  const { app, index } = await serveOnboard();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    const it = body.itineraries[0]!;
    // Getting off at the first opportunity (2000, 08:10) catches RX's 08:15
    // and lands 09:05. Staying aboard to 5000 lands 08:50 instead.
    const transit = it.legs.find((l) => l.type === "transit")!;
    assert.equal(transit.tripId, "TY1");
    assert.equal(it.arrivalTime, "2026-08-24T08:50:00+03:00");
    assert.deepEqual(it.alightAt, {
      stopId: "5000", name: "תחנה חמישית", arrivalTime: "2026-08-24T08:20:00+03:00",
    });
    // The rider is on a vehicle, not standing at a door: the itinerary begins
    // when they get off it.
    assert.equal(it.departureTime, "2026-08-24T08:20:00+03:00");
    assert.equal(body.delaySource, "schedule");
  } finally { await app.close(); index.stop(); }
});

test("a delayed vehicle is routed onto a later connection than the schedule would have given", async () => {
  const { app, index } = await serveOnboard();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}&delaySeconds=900`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    const it = body.itineraries[0]!;
    // 15 minutes late: stop 5000 at 08:35, so RY's 08:25 is long gone and the
    // 08:45 is the connection that still works.
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TY2");
    assert.equal(it.arrivalTime, "2026-08-24T09:10:00+03:00");
    assert.equal(it.alightAt.arrivalTime, "2026-08-24T08:35:00+03:00");
    assert.equal(body.delaySource, "client");
    assert.equal(body.query["delaySeconds"], 900);
  } finally { await app.close(); index.stop(); }
});

test("with delaySeconds=0 the itinerary is the one /plan gives from that stop at that time", async () => {
  const { app, index } = await serveOnboard();
  try {
    const onboard = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}&delaySeconds=0`,
    });
    assert.equal(onboard.statusCode, 200);
    const it = (onboard.json() as OnboardBody).itineraries[0]!;
    assert.equal(it.alightAt.stopId, "5000");

    // The same journey, asked the ordinary way: standing at stop 5000 at the
    // instant the vehicle drops the rider there. Same legs, to the byte.
    const plan = await app.inject({
      url: "/plan?from=stop:5000&to=stop:9000&departAfter=2026-08-24T08:20:00%2B03:00",
    });
    assert.equal(plan.statusCode, 200);
    const planIt = (plan.json() as { itineraries: OnboardItinerary[] }).itineraries[0]!;
    assert.deepEqual(it.legs, planIt.legs);
    assert.equal(it.arrivalTime, planIt.arrivalTime);
    // `departureTime` is deliberately NOT the same: `/plan` re-anchors it on
    // the first boarding (08:25, see reoptimise.ts), while an onboard
    // itinerary begins when the rider steps off the vehicle they are on.
    assert.equal(it.departureTime, "2026-08-24T08:20:00+03:00");
    assert.equal(planIt.departureTime, "2026-08-24T08:25:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("the transfer margin is NOT waived on the first boarding off the rider's own vehicle", async () => {
  const { app, index } = await serveOnboardMargin();
  try {
    // Standing at stop 2000 at 08:10, the 08:12 departure is legal: a
    // journey's first boarding is exempt from the transfer margin, because a
    // rider on foot has no incoming vehicle that could be late. This half
    // must not change.
    const plan = await app.inject({
      url: "/plan?from=stop:2000&to=stop:9000&departAfter=2026-08-24T08:10:00%2B03:00",
    });
    assert.equal(plan.statusCode, 200);
    const planIt = (plan.json() as { itineraries: OnboardItinerary[] }).itineraries[0]!;
    assert.equal(planIt.legs.find((l) => l.type === "transit")!.tripId, "TM1");

    // ARRIVING at stop 2000 at 08:10 on a bus, the same 120 s connection is
    // refused: the incoming vehicle the exemption above assumes cannot exist
    // is the one the rider is sitting on, and the rule wants 300 s here.
    const onboard = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(onboard.statusCode, 200);
    const it = (onboard.json() as OnboardBody).itineraries[0]!;
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TM2");
    assert.equal(it.arrivalTime, "2026-08-24T09:20:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("a rider aboard after midnight resolves on the right service day", async () => {
  const { app, index } = await serveOnboardMidnight();
  try {
    const res = await app.inject({
      url: "/plan/onboard?onTrip=T3&onTripFromStop=2000&to=stop:9000"
        + "&at=2026-08-25T01:32:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    const it = body.itineraries[0]!;
    // T3 belongs to the 2026-08-24 service day (25:40 = 01:40 the next
    // morning). Picking 2026-08-25's own copy instead would put every time a
    // full day out; wrapping 92400 into 05:40 would put it 20 hours out.
    assert.equal(it.alightAt.stopId, "4000");
    assert.equal(it.alightAt.arrivalTime, "2026-08-25T01:40:00+03:00");
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TN");
    assert.equal(it.arrivalTime, "2026-08-25T02:15:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("realtime, when it has data for the trip, overrides delaySeconds and says so", async () => {
  const now = Date.parse("2026-08-24T08:05:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    lineRef: "RB", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-7", confidence: "reliable", lat: null, lon: null,
    recordedAt: now, calls: [], distanceFromStart: null,
  };
  // TB is trip index 3, stop 1000 is stop index 0 (see `serveOnboard`).
  // Scheduled 08:00 there, predicted 08:15: the vehicle is 900 s late.
  const resolved: ResolvedJourney = {
    tripIdx: 3,
    byStopIdx: new Map([
      [0, { expectedArrival: Date.parse("2026-08-24T08:15:00+03:00") / 1000, ambiguous: false }],
    ]),
    journey,
  };
  store.replace([resolved], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);

  const { app, index } = await serveOnboard(store);
  try {
    // The client says the bus is on time. The feed says it is 15 minutes
    // late. The feed wins, and the answer is the delayed one.
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}&delaySeconds=0`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    assert.equal(body.delaySource, "realtime");
    assert.equal(body.query["delaySeconds"], 900);
    const it = body.itineraries[0]!;
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TY2");
    assert.equal(it.alightAt.arrivalTime, "2026-08-24T08:35:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("a realtime store with nothing for this trip falls back to the client's own number", async () => {
  const now = Date.parse("2026-08-24T08:05:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  store.replace([], { resolved: 0, unresolved: 1, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);

  const { app, index } = await serveOnboard(store);
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}&delaySeconds=900`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    assert.equal(body.delaySource, "client");
    assert.equal(body.query["delaySeconds"], 900);
  } finally { await app.close(); index.stop(); }
});

test("with no realtime and no delaySeconds, delaySource is schedule", async () => {
  const { app, index } = await serveOnboard();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    assert.equal(body.delaySource, "schedule");
    assert.equal(body.query["delaySeconds"], 0);
  } finally { await app.close(); index.stop(); }
});

test("an unknown trip is a 404, and so is an unknown stop", async () => {
  const { app, index } = await serveOnboard();
  try {
    const badTrip = await app.inject({
      url: `/plan/onboard?onTrip=NOPE&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(badTrip.statusCode, 404);
    const badStop = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=99999&to=stop:9000&at=${AT}`,
    });
    assert.equal(badStop.statusCode, 404);
  } finally { await app.close(); index.stop(); }
});

test("a stop the trip does not serve is a 400, and so is the trip's last stop", async () => {
  const { app, index } = await serveOnboard();
  try {
    // 9000 is a real stop, and TB never goes there.
    const notServed = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=9000&to=stop:9000&at=${AT}`,
    });
    assert.equal(notServed.statusCode, 400);
    assert.match(notServed.json<{ message: string }>().message, /does not serve/);

    // 6000 IS on TB -- as its final stop, with nowhere left to alight.
    const lastStop = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=6000&to=stop:9000&at=${AT}`,
    });
    assert.equal(lastStop.statusCode, 400);
    assert.match(lastStop.json<{ message: string }>().message, /last stop/);
  } finally { await app.close(); index.stop(); }
});

test("arriveBy is a 400: you cannot re-plan backwards out of a vehicle you are on", async () => {
  const { app, index } = await serveOnboard();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`
        + "&arriveBy=2026-08-24T10:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ message: string }>().message, /arriveBy/);
  } finally { await app.close(); index.stop(); }
});

test("a trip with no active service day near `at` is a 422, not a wrong-day answer", async () => {
  const { app, index } = await serveOnboard();
  try {
    // Saturday 2026-08-29: S1 (Sun-Thu) does not run, so TB has no active
    // service day either side of the query.
    const res = await app.inject({
      url: "/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000"
        + "&at=2026-08-29T08:05:00%2B03:00",
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "trip_not_active");
    assert.match(body.message, /TB/);
  } finally { await app.close(); index.stop(); }
});

test("an unreachable destination is an empty itinerary list, not an error", async () => {
  const { app, index } = await serveOnboard();
  try {
    // Stop 12000 is served by nothing at all and is far outside walking
    // range of every stop the rider can reach.
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:12000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as OnboardBody).itineraries, []);
  } finally { await app.close(); index.stop(); }
});

test("no response carries a stop_ref or trip_ref", async () => {
  const { app, index } = await serveOnboard();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.includes("stop_ref"), false);
    assert.equal(res.payload.includes("trip_ref"), false);
  } finally { await app.close(); index.stop(); }
});

test("stops the vehicle has already passed are not offered as alighting points", async () => {
  const { app, index } = await serveOnboard();
  try {
    // Asked at 08:22, with the bus on time: it left 2000 at 08:10 and 5000 at
    // 08:20, so the only stop still ahead of the rider is 6000 at 08:30.
    const res = await app.inject({
      url: "/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000"
        + "&at=2026-08-24T08:22:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    assert.equal(body.query["alightStops"], 1);
    // Nothing runs onward from 6000, so there is no journey left -- which is
    // an answer, not an error.
    assert.deepEqual(body.itineraries, []);
  } finally { await app.close(); index.stop(); }
});

test("a coordinate destination gets an egress walk leg, exactly as /plan builds one", async () => {
  const { app, index } = await serveOnboard();
  try {
    // ~130 m from stop 9000, well inside the default walking radius.
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=32.0910,34.7510&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as OnboardBody).itineraries[0]!;
    const last = it.legs[it.legs.length - 1]!;
    assert.equal(last.type, "walk");
    // Still no ACCESS walk: the rider did not walk to their origin, they were
    // carried to it.
    assert.equal(it.legs[0]!.type, "transit");
    assert.equal(it.alightAt.stopId, "5000");
  } finally { await app.close(); index.stop(); }
});

test("a retry that recovers a sub-margin FIRST boarding flags it, rather than staying silent", async () => {
  const { app, index } = await serveOnboardRetry();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as OnboardBody).itineraries[0]!;
    // The margin-respecting search found nothing at all; this itinerary only
    // exists because the retry ran at the flat rule.
    const first = it.legs.find((l) => l.type === "transit")!;
    assert.equal(first.tripId, "TM1");
    assert.equal(it.alightAt.arrivalTime, "2026-08-24T08:10:00+03:00");
    assert.equal(first.from!.departureTime, "2026-08-24T08:12:00+03:00");
    assert.equal(first.from!.stop!.stopId, "2000");
    // 120 s off a bus that can be late, where the configured rule wanted 300.
    // The connection the whole endpoint exists to protect is the one no
    // transit-leg-to-transit-leg check can even see, so the route has to
    // price it itself.
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("...and it is flagged even when realtime confirms every VISIBLE connection is fine", async () => {
  const now = Date.parse("2026-08-24T08:05:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  const journey: RealtimeJourney = {
    lineRef: "RM", directionId: 0, dataFrameRef: null, datedVehicleJourneyRef: null,
    originAimedDeparture: null, operatorRef: null, publishedLineName: null,
    vehicleRef: "veh-9", confidence: "reliable", lat: null, lon: null,
    recordedAt: now, calls: [], distanceFromStart: null,
  };
  // TM1 is trip index 5, stop 7000 is stop index 4: running exactly to
  // schedule into the interchange, so the ONE transfer this itinerary has
  // that `transferPairs` can see resolves to `transferAtRisk: false`.
  const resolved: ResolvedJourney = {
    tripIdx: 5,
    byStopIdx: new Map([
      [4, { expectedArrival: Date.parse("2026-08-24T08:32:00+03:00") / 1000, ambiguous: false }],
    ]),
    journey,
  };
  store.replace([resolved], { resolved: 1, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);

  const { app, index } = await serveOnboardRetry(store);
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as OnboardBody).itineraries[0]!;
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TM1");
    // Without the first-boarding check this reads `false`: an AFFIRMATIVE
    // safety claim over a 120 s connection the planner's own rule refused.
    // Worse than the silent `null` above, and on the same itinerary.
    assert.equal(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

test("an ordinary onboard itinerary the margin never yielded on is NOT flagged", async () => {
  // The other half of "only ever raises": the first-boarding check must not
  // flag a connection that genuinely clears the margin, or the flag stops
  // meaning anything. Realtime configured so `computeTransferAtRisk` has a
  // real verdict of its own (`false` -- a single-transit-leg itinerary has no
  // pair to be unsure about) rather than the pessimistic `null`.
  const now = Date.parse("2026-08-24T08:05:00+03:00") / 1000;
  const store = new RealtimeStore("siri-sm", 180, () => now);
  store.replace([], { resolved: 0, unresolved: 0, resolvedWithNoCalls: 0, nearMissCount: 0 }, now);
  const { app, index } = await serveOnboard(store);
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as OnboardBody).itineraries[0]!;
    // Alight 5000 at 08:20, board RY's 08:25: 300 s, exactly what the rule
    // asks of this pattern in this hour.
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TY1");
    assert.equal(it.transferAtRisk, false);
  } finally { await app.close(); index.stop(); }
});

test("alightAt names where the rider left the VEHICLE, not where they walked to and boarded", async () => {
  const { app, index } = await serveOnboardWalk();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as OnboardBody).itineraries[0]!;
    assert.deepEqual(it.legs.map((l) => l.type), ["walk", "transit"]);
    assert.equal(it.legs[0]!.from!.stopId, "5000");
    assert.equal(it.legs[0]!.to!.stopId, "8000");
    assert.equal(it.legs[1]!.tripId, "TW1");
    // The stop they got OFF at, at the instant the bus put them there --
    // reading the walk's own endpoint here would name 8000 and a time two
    // minutes later, and the rider would look for a bus at the wrong stop.
    assert.deepEqual(it.alightAt, {
      stopId: "5000", name: "תחנה חמישית", arrivalTime: "2026-08-24T08:20:00+03:00",
    });
    // And the itinerary begins when they step off, not when the walk ends.
    assert.equal(it.departureTime, "2026-08-24T08:20:00+03:00");
  } finally { await app.close(); index.stop(); }
});

test("a stop the vehicle reaches at exactly `at` is still an alighting point", async () => {
  const { app, index } = await serveOnboard();
  try {
    // Asked at exactly 08:20, the instant TB reaches 5000: that seed's
    // `secondsToReach` is 0, and the drop rule is `< 0`, not `<= 0`. The
    // rider is standing in the doorway, not past it.
    const res = await app.inject({
      url: "/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000"
        + "&at=2026-08-24T08:20:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    // 5000 (now) and 6000 (08:30); 2000 is behind them.
    assert.equal(body.query["alightStops"], 2);
    const it = body.itineraries[0]!;
    assert.equal(it.alightAt.stopId, "5000");
    assert.equal(it.legs.find((l) => l.type === "transit")!.tripId, "TY1");
  } finally { await app.close(); index.stop(); }
});

test("when the vehicle already goes there, the answer is a zero-leg 'stay on'", async () => {
  const { app, index } = await serveOnboard();
  try {
    // Stop 6000 is on TB itself. There is nothing to plan: the honest answer
    // is "stay where you are, you arrive at 08:30" -- which is a round-0
    // Pareto pick with no transit leg of its own, not an empty result.
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:6000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const it = (res.json() as OnboardBody).itineraries[0]!;
    assert.deepEqual(it.legs, []);
    assert.deepEqual(it.alightAt, {
      stopId: "6000", name: "תחנה שישית", arrivalTime: "2026-08-24T08:30:00+03:00",
    });
    assert.equal(it.departureTime, "2026-08-24T08:30:00+03:00");
    assert.equal(it.arrivalTime, "2026-08-24T08:30:00+03:00");
    // No next boarding exists, so there is nothing to be at risk about --
    // `firstBoardingAtRisk` must not invent one.
    assert.notEqual(it.transferAtRisk, true);
  } finally { await app.close(); index.stop(); }
});

// A rider already on a vehicle has NO access leg, so "get off at stop 5000
// and walk the last 200 m" is a legitimate itinerary with ZERO transit legs.
// Applying /plan's walk-only filter here would delete exactly the answer
// this endpoint exists to give someone standing on a bus.
test("/plan/onboard still offers getting off and walking the rest", async () => {
  const { app, index } = await serveOnboardWalk();
  try {
    // ~200 m north of stop 5000, which TB calls at. Nothing needs to be
    // boarded to finish this journey.
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=32.0668,34.7700&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    assert.ok(body.itineraries.length > 0, "expected at least one itinerary");
    assert.ok(
      body.itineraries.some((itin) => !itin.legs.some((l) => l.type === "transit")),
      "a walk-from-here itinerary was filtered out of /plan/onboard",
    );
  } finally { await app.close(); index.stop(); }
});

// `alighting` is built index-for-index with `itineraries` inside `search` and
// is read back when the response is assembled. Ranking REORDERS, so the
// pairing has to move with it -- a mismatch here tells a rider to get off at
// another itinerary's stop, and no type check would catch it.
test("/plan/onboard keeps each itinerary's alighting stop after ranking", async () => {
  const { app, index } = await serveOnboardWalk();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TB&onTripFromStop=1000&to=stop:9000&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    assert.ok(body.itineraries.length > 0);
    for (const itin of body.itineraries) {
      const first = itin.legs[0]!;
      if (first.type !== "walk") continue;
      assert.equal(
        first.from!.stopId, itin.alightAt.stopId,
        "alightAt no longer matches the itinerary's own first leg",
      );
    }
  } finally { await app.close(); index.stop(); }
});

// The test the two above cannot be: `serveOnboardRanking()` (see its own doc
// comment for the arithmetic) makes THREE candidates survive `paretoRounds`,
// with the CHEAPEST one arriving neither first nor last -- so promoting it
// is a property no plain "sort by arrival" (ascending OR descending) can
// reproduce, only cost-based ranking. Comment out the ranking block in
// `planOnboard.ts` and this test is the one that goes red on `itineraries[0]`
// (index 0 becomes the round-0 walk-off, not the round-1 ride) -- verified
// by actually doing that and confirming the failure.
test("/plan/onboard ranks a cheaper middle-round ride above a costlier, earlier-arriving one", async () => {
  const { app, index } = await serveOnboardRanking();
  try {
    const res = await app.inject({
      url: `/plan/onboard?onTrip=TR&onTripFromStop=9000&to=32.057186,34.7600&at=${AT}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as OnboardBody;
    // Otherwise this test is inert again: fewer than three survivors means
    // there is no middle candidate for ranking to have promoted.
    assert.equal(
      body.itineraries.length, 3,
      `expected the walk-off, the direct ride and the ride+transfer to all ` +
      `survive paretoRounds, got ${body.itineraries.length}`,
    );

    // itineraries[0]: journeyCost 320, one transit leg (TC1) direct to a
    // stop 30 m from the destination. The cheapest of the three, and the
    // assertion that must go red without `rankItineraries`.
    const first = body.itineraries[0]!;
    assert.equal(first.legs.length, 2);
    assert.equal(first.legs[0]!.type, "transit");
    assert.equal(first.legs[0]!.tripId, "TC1");
    assert.equal(first.legs[1]!.type, "walk");
    assert.equal(first.departureTime, "2026-08-24T08:13:00+03:00");
    assert.equal(first.arrivalTime, "2026-08-24T08:17:50+03:00");

    // itineraries[1]: journeyCost 460 -- a transfer (TF1 -> TG1) to a stop
    // 10 m from the destination. ARRIVES EARLIER than itineraries[0]
    // (08:15:30 vs 08:17:50, since it is a later paretoRounds round) but
    // costs more (the extra transfer penalty), so ranking correctly keeps
    // it BELOW the cheaper, later-arriving itineraries[0].
    const second = body.itineraries[1]!;
    assert.equal(second.legs.length, 3);
    assert.equal(second.legs[0]!.type, "transit");
    assert.equal(second.legs[0]!.tripId, "TF1");
    assert.equal(second.legs[1]!.type, "transit");
    assert.equal(second.legs[1]!.tripId, "TG1");
    assert.equal(second.legs[2]!.type, "walk");
    assert.equal(second.departureTime, "2026-08-24T08:13:00+03:00");
    assert.equal(second.arrivalTime, "2026-08-24T08:15:30+03:00");

    // Pins the property this whole test exists to check: the promoted
    // itinerary is NOT the earliest arriver (itineraries[1] arrives sooner)
    // and is not simply "arrival ascending" or "arrival descending" over the
    // full set either. Without this explicit check, a future "simplified"
    // fixture could quietly drift back into a shape a plain arrival sort
    // would also satisfy, and nobody would notice from the assertions above
    // alone.
    assert.ok(
      Date.parse(first.arrivalTime) > Date.parse(second.arrivalTime),
      "itineraries[0] must arrive LATER than itineraries[1] -- otherwise a " +
      "plain arrival-ascending sort would pass this test too, and the test " +
      "would no longer isolate cost-based ranking from arrival ordering",
    );

    // itineraries[2]: the walk-off, journeyCost 1622 -- first in ROUND order
    // (round 0) and latest in wall-clock arrival, but ranking correctly
    // sinks it to the bottom on cost.
    const third = body.itineraries[2]!;
    assert.equal(third.legs.length, 1);
    assert.equal(third.legs[0]!.type, "walk");
    assert.equal(third.departureTime, "2026-08-24T08:10:00+03:00");
    assert.equal(third.arrivalTime, "2026-08-24T08:23:31+03:00");

    // `alighting`'s pairing with `itineraries` survives the reorder, checked
    // across all three. Unlike a walk-off-only check, this exercises
    // TRANSIT-first itineraries too: their boarding stop lives at
    // `from.stop.stopId`, not `from.stopId` (see `OnboardLeg`'s own comment).
    const boardStopIdOf = (leg: OnboardLeg): string | undefined =>
      leg.type === "walk" ? leg.from?.stopId : leg.from?.stop?.stopId;
    for (const itin of body.itineraries) {
      assert.equal(
        boardStopIdOf(itin.legs[0]!), itin.alightAt.stopId,
        "alightAt no longer matches the itinerary's own first leg's boarding stop",
      );
    }
    assert.equal(first.alightAt.stopId, "9200");
    assert.equal(second.alightAt.stopId, "9200");
    assert.equal(third.alightAt.stopId, "9100");
  } finally { await app.close(); index.stop(); }
});
