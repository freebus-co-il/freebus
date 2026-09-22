import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseOpenBusSnapshot, latestSnapshotId, statusUrl, snapshotUrl,
} from "./openBus.js";

/**
 * One real per-minute snapshot from Hasadna's SIRI requester (2026-09-10
 * 08:30 local, the weekday morning peak), trimmed to six visits so every
 * branch the parser has is exercised by the payload's real structure:
 *
 *   0  usable, mid-journey (DistanceFromStop 36336, Order 16)
 *   1  usable, DistanceFromStop 0 at Order 1 -- a bus at its origin
 *   2  usable, but DistanceFromStop 0 at Order 8 and no VehicleLocation:
 *      the feed's "no fix" shape, so the distance is unknown, not zero
 *   3  DROPPED: RecordedAtTime 47 minutes before the response (a ghost)
 *   4  DROPPED: no LineRef (visit 0 with it removed)
 *   5  usable, but no VehicleRef (visit 0 with it removed)
 */
const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./openBus.fixture.json", import.meta.url), "utf8"),
);

/** 30 s after the snapshot's own ResponseTimestamp (08:30:00+03:00). */
const NOW = Math.floor(Date.parse("2026-09-10T05:30:30Z") / 1000);
const OPTS = { now: NOW, maxVehicleAgeSeconds: 600 };

function visits(payload: unknown): Record<string, unknown>[] {
  const p = payload as { Siri: { ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: Record<string, unknown>[] }[] } } };
  return p.Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit;
}

/** The fixture with its visit list replaced. */
function withVisits(list: unknown[]): unknown {
  const copy = JSON.parse(JSON.stringify(FIXTURE)) as never;
  (copy as { Siri: { ServiceDelivery: { StopMonitoringDelivery: { MonitoredStopVisit: unknown[] }[] } } })
    .Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit = list;
  return copy;
}

test("parses the recorded snapshot, keeping the usable visits and counting the rest", () => {
  const snap = parseOpenBusSnapshot(FIXTURE, OPTS)!;
  assert.equal(snap.rowsSeen, 6);
  assert.equal(snap.journeys.length, 4);
  assert.equal(snap.rowsDropped, 2);
});

test("a mid-journey visit carries the trip key, the fix, and DistanceFromStop as distance from start", () => {
  const j = parseOpenBusSnapshot(FIXTURE, OPTS)!.journeys[0]!;
  assert.equal(j.lineRef, "17633");
  assert.equal(j.dataFrameRef, "2026-09-10");
  assert.equal(j.originAimedDeparture, Date.parse("2026-09-10T04:45:00Z") / 1000);
  assert.equal(j.recordedAt, Date.parse("2026-09-10T05:29:27Z") / 1000);
  assert.equal(j.vehicleRef, "23463902");
  assert.equal(j.operatorRef, "24");
  assert.equal(j.lat, 33.24385);
  assert.equal(j.lon, 35.665073);
  // Despite its name, MOT's DistanceFromStop is metres from the journey's
  // start: 4,275 of 4,276 vehicles equal Stride's distance_from_journey_start
  // for the same report (checked 2026-09-13).
  assert.equal(j.distanceFromStart, 36336);
  // SIRI-VM content inside a SIRI-SM envelope: no direction, no ETAs.
  assert.equal(j.directionId, null);
  assert.deepEqual(j.calls, []);
});

test("DistanceFromStop 0 at Order 1 is a bus at its origin, and is kept as 0", () => {
  const j = parseOpenBusSnapshot(FIXTURE, OPTS)!.journeys[1]!;
  assert.equal(j.distanceFromStart, 0);
});

test("DistanceFromStop 0 past the first stop is the feed's no-fix shape, so the distance is unknown", () => {
  // 29 of 8,872 visits at the 2026-09-10 peak; all 8 with no VehicleLocation
  // are among them, and the one visit that disagreed with Stride was one.
  const j = parseOpenBusSnapshot(FIXTURE, OPTS)!.journeys[2]!;
  assert.equal(j.distanceFromStart, null);
  assert.equal(j.lat, null);
  assert.equal(j.lon, null);
});

test("a visit whose report is older than maxVehicleAgeSeconds is dropped as a ghost", () => {
  const fresh = parseOpenBusSnapshot(withVisits([visits(FIXTURE)[3]]), { now: NOW, maxVehicleAgeSeconds: 3_600 })!;
  assert.equal(fresh.journeys.length, 1, "the same visit survives a looser cutoff");
  const strict = parseOpenBusSnapshot(withVisits([visits(FIXTURE)[3]]), OPTS)!;
  assert.equal(strict.journeys.length, 0);
  assert.equal(strict.rowsDropped, 1);
});

test("a visit with no vehicle ref is still usable", () => {
  const j = parseOpenBusSnapshot(FIXTURE, OPTS)!.journeys[3]!;
  assert.equal(j.vehicleRef, null);
  assert.equal(j.distanceFromStart, 36336);
});

test("a visit missing its service date, origin departure, or report time is dropped, never thrown on", () => {
  const base = visits(FIXTURE)[0]!;
  const mvj = base["MonitoredVehicleJourney"] as Record<string, unknown>;
  const broken = [
    { ...base, MonitoredVehicleJourney: { ...mvj, FramedVehicleJourneyRef: {} } },
    { ...base, MonitoredVehicleJourney: { ...mvj, OriginAimedDepartureTime: "not a time" } },
    { ...base, RecordedAtTime: undefined },
    { RecordedAtTime: base["RecordedAtTime"] },
    "not an object",
  ];
  const snap = parseOpenBusSnapshot(withVisits(broken), OPTS)!;
  assert.equal(snap.journeys.length, 0);
  assert.equal(snap.rowsDropped, 5);
});

test("a body that is not a SIRI delivery is null, so the poller can fail the tick", () => {
  assert.equal(parseOpenBusSnapshot({ error: "nope" }, OPTS), null);
  assert.equal(parseOpenBusSnapshot("<html>", OPTS), null);
  assert.equal(parseOpenBusSnapshot(null, OPTS), null);
});

test("a well-formed delivery with no visits is a quiet feed, not a failure", () => {
  const snap = parseOpenBusSnapshot(withVisits([]), OPTS);
  assert.deepEqual(snap, { journeys: [], rowsSeen: 0, rowsDropped: 0 });
});

test("latestSnapshotId reads daemon_status.json", () => {
  assert.equal(
    latestSnapshotId({ last_snapshot_id: "2026/09/13/17/32", last_datetime_utc: "2026-09-13 17:32:26" }),
    "2026/09/13/17/32",
  );
});

test("latestSnapshotId refuses anything that is not a YYYY/MM/DD/HH/MM id", () => {
  // The id becomes a URL path; nothing but that exact shape may reach one.
  for (const bad of [
    {}, null, "2026/09/13/17/32", { last_snapshot_id: 5 },
    { last_snapshot_id: "../../etc/passwd" }, { last_snapshot_id: "2026/09/13/17" },
  ]) {
    assert.equal(latestSnapshotId(bad), null, JSON.stringify(bad));
  }
});

test("status and snapshot URLs tolerate a trailing slash on the base", () => {
  assert.equal(statusUrl("https://r.test/"), "https://r.test/daemon_status.json");
  assert.equal(snapshotUrl("https://r.test", "2026/09/13/17/32"), "https://r.test/2026/09/13/17/32.br");
});
