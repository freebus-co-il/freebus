import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { Translator } from "./i18n.js";
import { loadCalendar } from "../transit/calendar.js";
import { buildIndex } from "../transit/index.js";
import { departuresAt, tripStopVisit } from "./departures.js";
import { getLine, getRoute, getTrip, nextRuns, runsAround, tripBrief } from "./lines.js";

const TZ = "Asia/Jerusalem";

/**
 * The fixture's rail trips carry train numbers in `trip_headsign`, as the
 * real feed does: T105 (R7) runs stop 1000 "מרכזית" -> 4000 "תחנת השלום/רציף 1"
 * at 16:00 -> 16:30, T106 (R8) runs 4000 -> 1000 at 17:00 -> 17:30. Stop
 * 1000 translates to "Central Station"; stop 4000 has no translation, so it
 * falls back to Hebrew in every language.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-headsign-"));
  const link = buildFixtureDb(dir);
  const h = openTransitDb(dir);
  return { h, link, tr: Translator.load(h.db), cal: loadCalendar(h.db) };
}

const PLATFORM = "תחנת השלום/רציף 1";

test("a rail departure is headed for its trip's last stop and carries the train number", () => {
  const { h, tr, cal } = fixture();
  // Monday: T1 (bus, 08:00) and T105 (rail, 16:00) both leave stop 1000.
  const out = departuresAt(h.db, tr, cal, {
    stopIds: ["1000"], at: new Date("2026-08-24T07:00:00+03:00"),
    windowSeconds: 12 * 3600, limit: 50, lang: "en", tz: TZ,
  });
  const rail = out.find((d) => d.tripId === "T105")!;
  assert.equal(rail.headsign, PLATFORM);
  assert.equal(rail.tripNumber, "105");
  const bus = out.find((d) => d.tripId === "T1")!;
  assert.equal(bus.headsign, "Herzl", "a bus headsign is unchanged, still translated");
  assert.equal(bus.tripNumber, null);
  h.close();
});

test("the rail destination is translated like any stop name", () => {
  const { h, tr, cal } = fixture();
  const [t106] = departuresAt(h.db, tr, cal, {
    stopIds: ["4000"], at: new Date("2026-08-24T16:30:00+03:00"),
    windowSeconds: 3600, limit: 5, lang: "en", tz: TZ,
  });
  assert.equal(t106!.tripId, "T106");
  assert.equal(t106!.headsign, "Central Station");
  assert.equal(t106!.tripNumber, "106");
  h.close();
});

test("tripStopVisit (unscheduled-run rows) follows the same rule", () => {
  const { h, tr } = fixture();
  const rail = tripStopVisit(h.db, tr, "T106", "4000", "en")!;
  assert.equal(rail.headsign, "Central Station");
  assert.equal(rail.tripNumber, "106");
  const bus = tripStopVisit(h.db, tr, "T1", "1000", "en")!;
  assert.equal(bus.headsign, "Herzl");
  assert.equal(bus.tripNumber, null);
  h.close();
});

test("getTrip and tripBrief name a train's destination and number", () => {
  const { h, tr, cal } = fixture();
  const opts = { calendar: cal, tz: TZ, now: new Date("2026-08-24T07:00:00+03:00") };
  const rail = getTrip(h.db, tr, "T105", "he", opts)!;
  assert.equal(rail.headsign, PLATFORM);
  assert.equal(rail.tripNumber, "105");
  const bus = getTrip(h.db, tr, "T1", "he", opts)!;
  assert.equal(bus.headsign, "הרצל");
  assert.equal(bus.tripNumber, null);

  assert.deepEqual(tripBrief(h.db, tr, "T106", "en"), {
    headsign: "Central Station", tripNumber: "106", directionId: 1,
  });
  assert.deepEqual(tripBrief(h.db, tr, "T1", "en"), {
    headsign: "Herzl", tripNumber: null, directionId: 0,
  });
  h.close();
});

test("a rail route's runs carry the destination and the train number", () => {
  const { h, tr, cal } = fixture();
  const runs = nextRuns(h.db, tr, cal, {
    routeId: "R8", limit: 5, lang: "en", tz: TZ, now: new Date("2026-08-24T12:00:00+03:00"),
  });
  assert.deepEqual(runs.map((r) => [r.tripId, r.headsign, r.tripNumber]), [["T106", "Central Station", "106"]]);

  const around = runsAround(h.db, tr, cal, {
    routeId: "R8", stopId: "4000", tripId: "T106", after: 2,
    lang: "en", tz: TZ, now: new Date("2026-08-24T16:50:00+03:00"),
  });
  assert.deepEqual(around.map((r) => [r.tripId, r.headsign, r.tripNumber]), [["T106", "Central Station", "106"]]);

  const busRuns = nextRuns(h.db, tr, cal, {
    routeId: "R1", limit: 5, lang: "en", tz: TZ, now: new Date("2026-08-24T07:00:00+03:00"),
  });
  assert.ok(busRuns.length > 0);
  assert.ok(busRuns.every((r) => r.headsign === "Herzl" && r.tripNumber === null));
  h.close();
});

test("a rail direction is headed for its representative trip's last stop", () => {
  const { h, tr } = fixture();
  assert.equal(getRoute(h.db, tr, "R8", "en")!.directions[0]!.headsign, "Central Station");
  assert.equal(getLine(h.db, tr, "route:R7", "he")!.directions[0]!.headsign, PLATFORM);
  // A bus direction keeps the feed's own headsign.
  assert.equal(getRoute(h.db, tr, "R1", "en")!.directions[0]!.headsign, "Herzl");
  h.close();
});

test("the timetable index swaps a rail trip's number for its destination", () => {
  const { h, link } = fixture();
  h.close();
  const ix = buildIndex(link);
  const t105 = ix.tripIdToIdx.get("T105")!;
  assert.equal(ix.tripHeadsigns[t105], PLATFORM, "raw, untranslated -- resolved per request");
  assert.equal(ix.tripNumbers[t105], "105");
  const t1 = ix.tripIdToIdx.get("T1")!;
  assert.equal(ix.tripHeadsigns[t1], "הרצל");
  assert.equal(ix.tripNumbers[t1], null);
  assert.equal(ix.tripNumbers.length, ix.nTrips);
});
