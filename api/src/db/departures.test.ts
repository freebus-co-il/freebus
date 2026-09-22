import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { Translator } from "./i18n.js";
import { loadCalendar } from "../transit/calendar.js";
import { departuresAt } from "./departures.js";

const TZ = "Asia/Jerusalem";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-dep-"));
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  return { h, tr: Translator.load(h.db), cal: loadCalendar(h.db) };
}

test("lists departures inside the window", () => {
  const { h, tr, cal } = fixture();
  // Monday 2026-08-24 at 07:30 local; T1 departs stop 1000 at 08:00.
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-08-24T07:30:00+03:00"),
    windowSeconds: 3600, limit: 10, lang: "he", tz: TZ,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tripId, "T1");
  assert.match(out[0]!.departureTime, /^2026-08-24T08:00:00/);
  h.close();
});

test("orders departures by time and honours the limit", () => {
  const { h, tr, cal } = fixture();
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-08-24T07:00:00+03:00"),
    windowSeconds: 4 * 3600, limit: 10, lang: "he", tz: TZ,
  });
  assert.deepEqual(out.map((d) => d.tripId), ["T1", "T2"]);
  h.close();
});

// limit: 10 above never exercises the limit at all — both results fit.
// With limit: 1 the query must keep the EARLIER departure (T1, 08:00) over
// the later one (T2, 09:00), which only holds if the limit is applied after
// the merge sort across service days, not before it.
test("limit keeps the earliest departure, not just any one", () => {
  const { h, tr, cal } = fixture();
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-08-24T07:00:00+03:00"),
    windowSeconds: 4 * 3600, limit: 1, lang: "he", tz: TZ,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tripId, "T1");
  h.close();
});

// The whole point of the previous-service-day rule: at 01:00 on the 25th,
// T3's 25:30 departure belongs to the 24th's service day.
test("surfaces a past-midnight departure from the previous service day", () => {
  const { h, tr, cal } = fixture();
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["2000"], at: new Date("2026-08-25T01:00:00+03:00"),
    windowSeconds: 3600, limit: 10, lang: "he", tz: TZ,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tripId, "T3");
  assert.match(out[0]!.departureTime, /^2026-08-25T01:30:00/);
  h.close();
});

test("returns nothing on a day the service does not run", () => {
  const { h, tr, cal } = fixture();
  // 2026-08-22 is a Saturday; S1 (Sun-Thu) does not run.
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-08-22T07:30:00+03:00"),
    windowSeconds: 3600, limit: 10, lang: "he", tz: TZ,
  });
  assert.equal(out.length, 0);
  h.close();
});

// pickup_type = 1 marks a stop where boarding is not possible — the trip's
// final stop. Showing it as a departure advertises a service nobody can take.
test("excludes stops where boarding is not allowed", () => {
  const { h, tr, cal } = fixture();
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["2000"], at: new Date("2026-08-24T07:30:00+03:00"),
    windowSeconds: 3600, limit: 10, lang: "he", tz: TZ,
  });
  // T1 arrives at 2000 as its last stop (pickup_type = 1) — not a departure.
  assert.equal(out.length, 0);
  h.close();
});

/**
 * A departure board straddling Israel's autumn fall-back.
 *
 * On 2026-10-25 the clocks go back at 02:00 IDT (+03:00) to 01:00 IST
 * (+02:00), so the two service days this board merges carry DIFFERENT UTC
 * offsets — and the local-time digits of one are not comparable with those
 * of the other at all:
 *
 *   TDST_LATE   service day 2026-10-24, GTFS 91800 (25:30)
 *               -> epoch 1792881000 -> "2026-10-25T01:30:00+03:00"
 *   TDST_EARLY  service day 2026-10-25, GTFS  4200 (01:10)
 *               -> epoch 1792883400 -> "2026-10-25T01:10:00+02:00"
 *
 * TDST_LATE is genuinely 40 minutes EARLIER, but sorts LATER as a string.
 * The previous `localeCompare` on the rendered ISO strings inverted these
 * two, and `limit` then kept the wrong one.
 */
function dstFixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-dep-dst-"));
  const link = buildFixtureDb(dir);
  // Written before the read-only handle is opened, the same way
  // routes/reload.test.ts mutates its own second fixture: keeps this case
  // out of the shared fixture, where it would perturb every other test.
  const w = new Database(link);
  w.exec(`
    INSERT INTO calendar VALUES ('SDST',1,1,1,1,1,1,1,20261001,20261031);
    INSERT INTO trips VALUES (10,'TDST_LATE','R1','SDST','late',0,NULL,0);
    INSERT INTO trips VALUES (11,'TDST_EARLY','R1','SDST','early',0,NULL,0);
    INSERT INTO stop_times VALUES (10,1,1,91800,91800,0,1,0);
    INSERT INTO stop_times VALUES (10,2,2,92400,92400,1,0,0);
    INSERT INTO stop_times VALUES (11,1,1,4200,4200,0,1,0);
    INSERT INTO stop_times VALUES (11,2,2,4800,4800,1,0,0);
  `);
  w.close();
  const h = openTransitDb(dir);
  return { h, tr: Translator.load(h.db), cal: loadCalendar(h.db) };
}

test("orders a board across a DST fall-back by absolute time, not by rendered string", () => {
  const { h, tr, cal } = dstFixture();
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-10-25T01:00:00+03:00"),
    windowSeconds: 2 * 3600, limit: 10, lang: "he", tz: TZ,
  });
  assert.deepEqual(out.map((d) => d.tripId), ["TDST_LATE", "TDST_EARLY"]);
  // The offsets really do differ, which is the whole reason string order
  // and epoch order disagree here.
  assert.equal(out[0]!.departureTime, "2026-10-25T01:30:00+03:00");
  assert.equal(out[1]!.departureTime, "2026-10-25T01:10:00+02:00");
  assert.ok(
    out[0]!.departureTime.localeCompare(out[1]!.departureTime) > 0,
    "the string comparison must disagree with the correct order, or this test proves nothing",
  );
  h.close();
});

// `limit` truncates AFTER the sort, so a mis-sorted board does not merely
// reorder the answer — it returns a different departure.
test("limit across a DST fall-back keeps the genuinely earliest departure", () => {
  const { h, tr, cal } = dstFixture();
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-10-25T01:00:00+03:00"),
    windowSeconds: 2 * 3600, limit: 1, lang: "he", tz: TZ,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tripId, "TDST_LATE");
  h.close();
});

test("departuresAt filters to one route when routeId is given", () => {
  const { h, tr, cal } = fixture();
  // 2026-08-24 is a Monday, so service S1 is active.
  const at = new Date("2026-08-24T05:00:00Z");
  const opts = {
    stopIds: ["1000"], at, windowSeconds: 12 * 3600,
    limit: 50, lang: "he" as const, tz: TZ,
  };

  const all = departuresAt(h.db, tr, cal, opts);
  const onlyR3 = departuresAt(h.db, tr, cal, { ...opts, routeId: "R3" });

  // Stop 1000 is served by R1, R3, R4, R5 and R7. NOTE: the new trips here
  // ended up as T101-T105 (not T4-T8) to avoid trip_ref collisions with the
  // five suites that extend this fixture, and they run 12:00-16:30 local.
  assert.ok(all.length > onlyR3.length);
  assert.ok(onlyR3.length > 0);
  assert.ok(onlyR3.every((d) => d.route.routeId === "R3"));
  h.close();
});
