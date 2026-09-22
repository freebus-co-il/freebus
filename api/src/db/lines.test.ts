import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { openTransitDb } from "./connect.js";
import { Translator } from "./i18n.js";
import { listRoutes, getRoute, getRouteShape, getTrip, runsAround } from "./lines.js";
import { loadCalendar } from "../transit/calendar.js";
import { encodePolyline } from "../geo.js";
import { RailGeometry } from "../rail/railGeometry.js";

const TZ = "Asia/Jerusalem";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "transit-lines-"));
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  return { h, tr: Translator.load(h.db), cal: loadCalendar(h.db) };
}

test("lists routes with a total for pagination", () => {
  const { h } = fixture();
  const page = listRoutes(h.db, { limit: 1, offset: 0 });
  assert.equal(page.routes.length, 1);
  assert.equal(page.total, 8);
  h.close();
});

test("filters routes by short name", () => {
  const { h } = fixture();
  assert.equal(listRoutes(h.db, { q: "2", limit: 10, offset: 0 }).routes[0]!.routeId, "R2");
  h.close();
});

test("route detail carries a direction with its ordered stops", () => {
  const { h, tr } = fixture();
  const route = getRoute(h.db, tr, "R1", "he");
  assert.ok(route);
  assert.equal(route.directions.length, 1);
  assert.deepEqual(route.directions[0]!.stops.map((s) => s.stopId), ["1000", "2000"]);
  h.close();
});

test("route shape decodes to GeoJSON", () => {
  const { h } = fixture();
  const shape = getRouteShape(h.db, "R1", 0);
  assert.ok(shape);
  assert.equal(shape.geometry.type, "LineString");
  assert.equal(shape.geometryFallback, false);
  assert.equal(shape.geometry.coordinates.length, 2);
  // GeoJSON is [lon, lat], not [lat, lon] — inverting these silently puts
  // every route in the wrong hemisphere.
  assert.ok(shape.geometry.coordinates[0]![0] > 34 && shape.geometry.coordinates[0]![0] < 35);
  h.close();
});

// 1,085 trips in the real feed carry no shape_id. Their geometry must fall
// back to a stop-to-stop line and say so, never be silently fabricated.
test("a shapeless route falls back to a stop-to-stop line and flags it", () => {
  const { h } = fixture();
  const shape = getRouteShape(h.db, "R2", 0);
  assert.ok(shape);
  assert.equal(shape.geometryFallback, true);
  assert.equal(shape.geometry.coordinates.length, 2);
  h.close();
});

test("trip detail lists every stop with its times", () => {
  const { h, tr, cal } = fixture();
  // Wednesday 2026-08-26 — inside the fixture calendar, and S1 (Sun-Thu)
  // runs that day, so "the next date this trip runs" is that same date.
  const trip = getTrip(h.db, tr, "T1", "he",
    { calendar: cal, tz: TZ, now: new Date("2026-08-26T09:00:00+03:00") });
  assert.ok(trip);
  assert.equal(trip.stops.length, 2);
  assert.equal(trip.stops[0]!.departureSeconds, 28800);
  h.close();
});

// The feed's max departure_time is 105787 (29:23:07). Clamping or wrapping
// this would silently delete late-night service.
test("a past-midnight trip keeps its raw seconds above 86400", () => {
  const { h, tr, cal } = fixture();
  const trip = getTrip(h.db, tr, "T3", "he",
    { calendar: cal, tz: TZ, now: new Date("2026-08-26T09:00:00+03:00") });
  assert.equal(trip!.stops[0]!.departureSeconds, 91800);
  h.close();
});

// The raw seconds above are kept BECAUSE a GTFS-aware client needs them,
// and the ISO fields are added beside them so this endpoint still satisfies
// the API-wide "ISO everywhere" rule. Both must be present, and the ISO
// value must be the raw value rendered against the chosen service date.
test("trip stop times carry ISO fields alongside the raw seconds", () => {
  const { h, tr, cal } = fixture();
  const trip = getTrip(h.db, tr, "T1", "he",
    { calendar: cal, tz: TZ, now: new Date("2026-08-26T09:00:00+03:00") });
  assert.equal(trip!.serviceDate, 20260826);
  assert.equal(trip!.stops[0]!.departureSeconds, 28800);
  assert.equal(trip!.stops[0]!.departureTime, "2026-08-26T08:00:00+03:00");
  assert.equal(trip!.stops[0]!.arrivalTime, "2026-08-26T08:00:00+03:00");
  h.close();
});

// 91800 s is 25:30 on the service day, so its ISO rendering must land on the
// FOLLOWING calendar date at 01:30 — the whole reason the raw value is kept
// unclamped is that this is a real time, not an overflow.
test("a past-midnight raw value renders as the next calendar day in ISO", () => {
  const { h, tr, cal } = fixture();
  const trip = getTrip(h.db, tr, "T3", "he",
    { calendar: cal, tz: TZ, now: new Date("2026-08-26T09:00:00+03:00") });
  assert.equal(trip!.serviceDate, 20260826);
  assert.equal(trip!.stops[0]!.departureSeconds, 91800);
  assert.equal(trip!.stops[0]!.departureTime, "2026-08-27T01:30:00+03:00");
  h.close();
});

// S1 is Sun-Thu. Asked on a Friday, the rendered date must be the next
// SUNDAY, not "today" — rendering a timetable against a day the trip does
// not operate is the failure mode `nextServiceDate` exists to prevent.
test("the service date skips forward to a day the trip actually runs", () => {
  const { h, tr, cal } = fixture();
  // 2026-08-28 is a Friday; 2026-08-30 is the following Sunday.
  const trip = getTrip(h.db, tr, "T1", "he",
    { calendar: cal, tz: TZ, now: new Date("2026-08-28T09:00:00+03:00") });
  assert.equal(trip!.serviceDate, 20260830);
  assert.equal(trip!.stops[0]!.departureTime, "2026-08-30T08:00:00+03:00");
  h.close();
});

// Past the end of the service's calendar range there is no date left to
// render against; the raw seconds stay, the ISO fields go null, and
// `serviceDate` says so explicitly rather than inventing a date.
test("times past the end of the calendar range render as null, keeping raw seconds", () => {
  const { h, tr, cal } = fixture();
  // The fixture calendar ends 20260920.
  const trip = getTrip(h.db, tr, "T1", "he",
    { calendar: cal, tz: TZ, now: new Date("2027-01-01T09:00:00+03:00") });
  assert.equal(trip!.serviceDate, null);
  assert.equal(trip!.stops[0]!.departureSeconds, 28800);
  assert.equal(trip!.stops[0]!.departureTime, null);
  h.close();
});

// ---- Runs around one stop ---------------------------------------------------
//
// A rider who taps a departure on a station board opens the line on THAT
// run, with the run ahead of it and the ones behind -- timed at the rider's
// stop, not at the line's first stop. R1 calls at stop 1000 at 08:00 (T1)
// and 09:00 (T2) on weekdays.

function around(tripId: string, now: string, after = 3) {
  const dir = mkdtempSync(join(tmpdir(), "transit-around-"));
  buildFixtureDb(dir);
  const h = openTransitDb(dir);
  const runs = runsAround(h.db, Translator.load(h.db), loadCalendar(h.db), {
    routeId: "R1", stopId: "1000", tripId, after, lang: "he", tz: TZ, now: new Date(now),
  });
  h.close();
  return runs;
}

/**
 * `runsAround` never carries a live bus -- it is the
 * `stopId`+`around` mode of `/routes/:routeId/trips`, documented as
 * timetable-only (unlike the default mode's `unscheduledRouteRuns`
 * prepend). Every run it returns must therefore identify as an ordinary
 * timetable row: `runId` is bare `tripId` (never `runIdFor`'s `@vehicle`/
 * `@offset` shape), `unscheduled` is always `false`, and `offsetSeconds` is
 * always `0` (nothing shifts a timetable run's own times).
 */
function assertAllTimetableRuns(runs: readonly { tripId: string; runId: string; unscheduled: boolean; offsetSeconds: number }[]): void {
  for (const r of runs) {
    assert.equal(r.runId, r.tripId, `runId must equal tripId for ${r.tripId}`);
    assert.equal(r.unscheduled, false, `${r.tripId} must not be unscheduled`);
    assert.equal(r.offsetSeconds, 0, `${r.tripId} must carry no offset`);
  }
}

test("runs around a trip are the one before it, it, and the ones after", () => {
  // 08:30: T1 left this stop half an hour ago and is still the run ahead.
  const runs = around("T2", "2026-08-24T08:30:00+03:00");
  assert.deepEqual(runs.map((r) => r.tripId), ["T1", "T2"]);
  assert.equal(runs[0]!.departureTime, "2026-08-24T08:00:00+03:00");
  assert.equal(runs[1]!.departureTime, "2026-08-24T09:00:00+03:00");
  assertAllTimetableRuns(runs);
});

test("the first run of the day has nothing before it", () => {
  const runs = around("T1", "2026-08-24T07:30:00+03:00");
  assert.deepEqual(runs.map((r) => r.tripId), ["T1", "T2"]);
  assertAllTimetableRuns(runs);
});

test("after bounds how many later runs are returned", () => {
  const runs = around("T1", "2026-08-24T07:30:00+03:00", 0);
  assert.deepEqual(runs.map((r) => r.tripId), ["T1"]);
  assertAllTimetableRuns(runs);
});

test("a trip that does not call at this stop in the window has no runs around it", () => {
  assert.deepEqual(around("T3", "2026-08-24T07:30:00+03:00"), []);
  assert.deepEqual(around("nope", "2026-08-24T07:30:00+03:00"), []);
});


// Israel Railways publishes no shapes; a rail route is drawn along track lines
// baked from OpenStreetMap instead. The fixture's rail route R7 runs its
// representative trip T105 from stop 1000 to stop 4000.
test("a shapeless rail route is drawn along its baked track, as real geometry", () => {
  const { h } = fixture();
  try {
    const rail = RailGeometry.fromBaked({
      osmTimestamp: "", attribution: "",
      lines: { "1000>4000": encodePolyline([[32.0556, 34.7802], [32.0630, 34.7870], [32.0699, 34.7899]]) },
    });
    const shape = getRouteShape(h.db, "R7", 0, rail);
    assert.ok(shape);
    assert.equal(shape.geometryFallback, false);
    const coords = shape.geometry.coordinates;
    assert.deepEqual(coords[0], [34.78, 32.0554], "starts on the first station, [lon, lat]");
    assert.deepEqual(coords[coords.length - 1], [34.7901, 32.0701], "ends on the last station");
    assert.ok(coords.some(([lon, lat]) => lon === 34.787 && lat === 32.063), "follows the track");
  } finally { h.close(); }
});

test("a shapeless rail trip's detail is drawn along its baked track, as real geometry", () => {
  const { h, tr, cal } = fixture();
  try {
    const rail = RailGeometry.fromBaked({
      osmTimestamp: "", attribution: "",
      lines: { "1000>4000": encodePolyline([[32.0556, 34.7802], [32.0630, 34.7870], [32.0699, 34.7899]]) },
    });
    const trip = getTrip(h.db, tr, "T105", "he",
      { calendar: cal, tz: TZ, now: new Date("2026-08-26T09:00:00+03:00"), rail });
    assert.ok(trip?.geometry);
    assert.equal(trip.geometryFallback, false);
    assert.ok(trip.geometry.coordinates.some(([lon, lat]) => lon === 34.787 && lat === 32.063));
  } finally { h.close(); }
});
