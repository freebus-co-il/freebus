import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseStrideRows, strideUrl, snapshotsUrl, latestLoadedSnapshotId,
} from "./stride.js";

/**
 * Six rows recorded from the live API on 2026-09-01, then shaped so every
 * branch the parser has is exercised by the real payload structure rather
 * than by a hand-written approximation of it:
 *
 *   0  usable, mid-journey (distance 4560)
 *   1  usable, distance 0 -- a vehicle sitting at its origin
 *   2  usable, distance null -- the feed did not say
 *   3  DROPPED: recorded_at_time two hours stale (a ghost ride)
 *   4  DROPPED: no siri_route__line_ref, so it can never match a trip
 *   5  usable, but with no vehicle_ref
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("./stride.fixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>[];

/** One minute after every fresh fixture row, so age is deliberate. */
const NOW = Math.floor(Date.parse("2026-09-01T10:46:00Z") / 1000);
const OPTS = { now: NOW, maxVehicleAgeSeconds: 600 };

/** The fixture's first row, with fields overridden per test. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FIXTURE[0]!, ...over };
}

test("parses the recorded fixture, keeping the usable rows and counting the rest", () => {
  const snap = parseStrideRows(FIXTURE, OPTS);
  assert.equal(snap.rowsSeen, 6);
  assert.equal(snap.journeys.length, 4);
  assert.equal(snap.rowsDropped, 2);
  // The identity every caller relies on to reason about coverage.
  assert.equal(snap.rowsSeen - snap.rowsDropped, snap.journeys.length);
});

test("scheduled_start_time is read as true UTC, not as naive local time", () => {
  // Verified against the live feed: the scheduled-hour histogram peaks at the
  // current UTC hour, not the current Israel hour. Reading it as local would
  // shift every journey by three hours and match nothing.
  const j = parseStrideRows([row({
    siri_ride__scheduled_start_time: "2026-09-01T10:20:00+00:00",
  })], OPTS).journeys[0]!;
  assert.equal(j.originAimedDeparture, Date.parse("2026-09-01T10:20:00Z") / 1000);
});

test("distance 0 is kept as 0; a null distance is kept as null", () => {
  // The whole point of `number | null`: 0 is a vehicle at its origin, and
  // `?? 0` or a falsy check would silently turn "unknown" into "at the start".
  assert.equal(parseStrideRows([row({ distance_from_journey_start: 0 })], OPTS)
    .journeys[0]!.distanceFromStart, 0);
  assert.equal(parseStrideRows([row({ distance_from_journey_start: null })], OPTS)
    .journeys[0]!.distanceFromStart, null);
});

test("a vehicle older than maxVehicleAgeSeconds is dropped as a ghost", () => {
  const ghost = row({ recorded_at_time: "2026-09-01T10:30:00+00:00" });   // 16 min
  const snap = parseStrideRows([ghost], OPTS);
  assert.equal(snap.journeys.length, 0);
  assert.equal(snap.rowsDropped, 1);
});

test("a vehicle just inside the age cutoff is kept", () => {
  // Guards the boundary in the right direction: Stride's own ingestion lag is
  // already 60-110 s, so an over-tight cutoff would discard live buses.
  const edge = row({ recorded_at_time: "2026-09-01T10:36:30+00:00" });    // 9.5 min
  assert.equal(parseStrideRows([edge], OPTS).journeys.length, 1);
});

test("a row missing any field needed to match a trip is dropped, never thrown on", () => {
  for (const field of [
    "siri_route__line_ref",
    "siri_ride__scheduled_start_time",
    "recorded_at_time",
    "siri_ride__journey_ref",
  ]) {
    const snap = parseStrideRows([row({ [field]: null })], OPTS);
    assert.equal(snap.journeys.length, 0, `${field} should be required`);
    assert.equal(snap.rowsDropped, 1, `${field} should count as dropped`);
  }
});

test("directionId is null — Stride never reports one", () => {
  // resolveJourney recovers it from the route; see match.ts.
  for (const j of parseStrideRows(FIXTURE, OPTS).journeys) {
    assert.equal(j.directionId, null);
  }
});

test("calls is always empty — this feed carries no predictions at all", () => {
  for (const j of parseStrideRows(FIXTURE, OPTS).journeys) {
    assert.deepEqual(j.calls, []);
  }
});

test("lineRef is the route id as a string, matching routes.route_id", () => {
  const j = parseStrideRows([row({ siri_route__line_ref: 8179 })], OPTS).journeys[0]!;
  assert.equal(j.lineRef, "8179");
});

test("dataFrameRef is the service date from journey_ref, not the UTC date", () => {
  // A 23:40 local departure falls on the previous UTC day for part of the
  // year, so the service date cannot be derived from the timestamps.
  const j = parseStrideRows([row({
    siri_ride__journey_ref: "2026-08-31-585444066",
    recorded_at_time: "2026-09-01T10:45:00+00:00",
  })], OPTS).journeys[0]!;
  assert.equal(j.dataFrameRef, "2026-08-31");
  assert.equal(j.datedVehicleJourneyRef, "2026-08-31-585444066");
});

test("a journey_ref that is not date-prefixed is dropped", () => {
  assert.equal(parseStrideRows([row({ siri_ride__journey_ref: "585444066" })], OPTS)
    .journeys.length, 0);
});

test("an absent vehicle_ref yields null rather than an empty string", () => {
  const j = parseStrideRows([row({ siri_ride__vehicle_ref: null })], OPTS).journeys[0]!;
  assert.equal(j.vehicleRef, null);
});

test("confidence is null — SIRI-VM has no such concept and it is not overloaded", () => {
  const j = parseStrideRows(FIXTURE, OPTS).journeys[0]!;
  assert.equal(j.confidence, null);
});

test("a non-array payload yields an empty snapshot rather than throwing", () => {
  // Every error this API produces is a non-array body: the "due to abuse"
  // cap message, a pydantic validation error, an HTML error page. The poller
  // decides what that means; this function only reports what it could read.
  for (const junk of [
    null, undefined, {}, "", 42,
    { message: "due to abuse, maximum limit per request is 15000 items" },
  ]) {
    const snap = parseStrideRows(junk, OPTS);
    assert.deepEqual(snap.journeys, []);
    assert.equal(snap.rowsSeen, 0);
    assert.equal(snap.rowsDropped, 0);
  }
});

test("junk entries inside an otherwise good array do not take the snapshot down", () => {
  const snap = parseStrideRows([row(), null, "nonsense", 7, row()], OPTS);
  assert.equal(snap.journeys.length, 2);
  assert.equal(snap.rowsDropped, 3);
});

test("strideUrl encodes the bbox, limit and offset", () => {
  const url = strideUrl("https://example.test", {
    minLat: 29.4, maxLat: 33.4, minLon: 34.2, maxLon: 35.9,
    limit: 15000, offset: 0, snapshotId: 42,
  });
  assert.ok(url.startsWith("https://example.test/siri_vehicle_locations/list?"));
  assert.match(url, /lat__greater_or_equal=29\.4/);
  assert.match(url, /lat__lower_or_equal=33\.4/);
  assert.match(url, /lon__greater_or_equal=34\.2/);
  assert.match(url, /lon__lower_or_equal=35\.9/);
  assert.match(url, /limit=15000/);
  assert.match(url, /offset=0/);
});

test("strideUrl orders by id so offset paging cannot repeat or skip rows", () => {
  const url = strideUrl("https://example.test", {
    minLat: 1, maxLat: 2, minLon: 3, maxLon: 4, limit: 10, offset: 20, snapshotId: 42,
  });
  assert.match(url, /order_by=id\+desc|order_by=id%20desc/);
  assert.match(url, /offset=20/);
});

test("strideUrl tolerates a base URL with a trailing slash", () => {
  const q = { minLat: 1, maxLat: 2, minLon: 3, maxLon: 4, limit: 10, offset: 0, snapshotId: 42 };
  assert.equal(strideUrl("https://example.test/", q), strideUrl("https://example.test", q));
});

test("latestLoadedSnapshotId picks the newest loaded row, skipping one still loading", () => {
  assert.equal(latestLoadedSnapshotId([
    { id: 900, etl_status: "loading" },
    { id: 899, etl_status: "loaded" },
    { id: 898, etl_status: "loaded" },
  ]), 899);
});

test("latestLoadedSnapshotId returns null when nothing has finished loading", () => {
  assert.equal(latestLoadedSnapshotId([{ id: 900, etl_status: "loading" }]), null);
  assert.equal(latestLoadedSnapshotId([]), null);
  assert.equal(latestLoadedSnapshotId({ message: "due to abuse" }), null);
  assert.equal(latestLoadedSnapshotId(null), null);
});

test("strideUrl scopes the query to one snapshot", () => {
  // Without this every vehicle comes back once per snapshot in the window,
  // and newest-first ordering then leaves the store holding the OLDEST
  // position for each trip.
  const url = strideUrl("https://example.test", {
    minLat: 1, maxLat: 2, minLon: 3, maxLon: 4, limit: 10, offset: 0, snapshotId: 2381539,
  });
  assert.match(url, /siri_snapshot_ids=2381539/);
});

test("snapshotsUrl asks for the newest snapshots first", () => {
  const url = snapshotsUrl("https://example.test");
  assert.ok(url.startsWith("https://example.test/siri_snapshots/list?"));
  assert.match(url, /order_by=id\+desc|order_by=id%20desc/);
});
