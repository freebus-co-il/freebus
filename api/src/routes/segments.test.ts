import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureDb } from "../testing/fixture.js";
import { buildServer } from "../server.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex } from "../transit/index.js";

/**
 * `/segments` is a pure lookup over the in-memory RAPTOR index -- unlike
 * `/stops/:stopId/departures` (SQL-backed, works before the index is built),
 * it has nothing to answer with until `rebuild()` has actually run. Mirrors
 * `routes/plan.test.ts`'s own `serve()` for the same reason.
 */
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "transit-segments-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  await index.rebuild();
  const app = await buildServer({ index });
  return { app, index };
}

interface SegmentsBody {
  from: { stopId: string; name: string | null; lat: number; lon: number };
  to: { stopId: string; name: string | null; lat: number; lon: number };
  departures: {
    tripId: string;
    route: { id: string; shortName: string | null; longName: string | null; type: number; color: string | null };
    headsign: string | null;
    directionId: number;
    departureTime: string;
    arrivalTime: string;
    durationSeconds: number;
    numStops: number;
  }[];
}

test("an unknown from stop id is 404", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({ url: "/segments?from=NOPE&to=2000" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { statusCode: number; code: string; message: string };
    assert.equal(body.code, "not_found");
    assert.equal(body.message, "No stop with id NOPE");
  } finally { await app.close(); index.stop(); }
});

test("an unknown to stop id is 404", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({ url: "/segments?from=1000&to=NOPE" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { statusCode: number; code: string; message: string };
    assert.equal(body.code, "not_found");
    assert.equal(body.message, "No stop with id NOPE");
  } finally { await app.close(); index.stop(); }
});

test("from === to is 400, even when neither id exists", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({ url: "/segments?from=NOPE&to=NOPE" });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { statusCode: number; code: string };
    assert.equal(body.code, "bad_request");
  } finally { await app.close(); index.stop(); }
});

// The fixture's R1 runs T1 (08:00 -> 08:10) then T2 (09:00 -> 09:10) over
// stop 1000 -> 2000. Exercises the full response envelope end to end,
// against the same shape a client already knows from `/plan`'s TransitLeg
// and `/stops/:id/departures`.
test("returns a recognisable envelope, ordered by departure, with lang applied", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/segments?from=1000&to=2000&after=2026-08-24T07:00:00%2B03:00&lang=en",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SegmentsBody;
    assert.deepEqual(body.from, { stopId: "1000", name: "Central Station", lat: 32.0554, lon: 34.78 });
    assert.deepEqual(body.to, { stopId: "2000", name: "Herzl", lat: 32.06, lon: 34.775 });

    // T1 and T2 on R1, then line 67003's T101 and T102 over the same pair.
    assert.equal(body.departures.length, 4);
    const [t1, t2] = body.departures;
    assert.equal(t1!.tripId, "T1");
    assert.equal(t1!.headsign, "Herzl");
    assert.equal(t1!.directionId, 0);
    assert.equal(t1!.departureTime, "2026-08-24T08:00:00+03:00");
    assert.equal(t1!.arrivalTime, "2026-08-24T08:10:00+03:00");
    assert.equal(t1!.durationSeconds, 600);
    assert.equal(t1!.numStops, 1);
    assert.deepEqual(
      t1!.route,
      { id: "R1", agencyId: "2", shortName: "1", longName: "קו ראשון", type: 3, color: "FF0000" },
    );

    assert.equal(t2!.tripId, "T2");
    assert.equal(t2!.departureTime, "2026-08-24T09:00:00+03:00");
  } finally { await app.close(); index.stop(); }
});

// The other half of the departures-board contract this endpoint mirrors: a
// real pair with nothing running on this particular day is 200 and empty,
// not a 404 -- "no stop with this id" and "nothing serves this pair right
// now" are different answers a client must be able to tell apart.
test("a real pair with no service on this day is 200 and empty", async () => {
  const { app, index } = await serve();
  try {
    // 2026-08-22 is a Saturday; the fixture's only service on this pair (S1) is Sun-Thu.
    const res = await app.inject({
      url: "/segments?from=1000&to=2000&after=2026-08-22T07:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SegmentsBody;
    assert.deepEqual(body.departures, []);
  } finally { await app.close(); index.stop(); }
});

// End-to-end version of the previous-service-day/past-midnight case: the
// fixture's T3 (route R2, stop 2000 -> 4000) departs 25:30 on service S1
// (Sun-Thu). Queried just after midnight on FRIDAY (2026-08-28) rather than
// on a weekday: S1 does not run Fridays, so only the "yesterday" DayContext
// (Thursday 2026-08-27, S1 active) contributes T3 -- picking a weekday
// query instant instead would have S1 active on BOTH DayContexts (it runs
// every weekday), and without a forward window bounding the scan (see
// findSegments's own doc comment) T3 would then legitimately appear TWICE:
// once as Thursday's still-running late trip, once as its own ordinary
// recurrence departing the FOLLOWING day. That double appearance is correct
// behaviour, not a bug, but it is not what this test is isolating.
test("a trip on the previous service day departing after midnight is found end to end", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/segments?from=2000&to=4000&after=2026-08-28T01:00:00%2B03:00",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SegmentsBody;
    assert.equal(body.departures.length, 1);
    assert.equal(body.departures[0]!.tripId, "T3");
    assert.match(body.departures[0]!.departureTime, /^2026-08-28T01:30:00/);
  } finally { await app.close(); index.stop(); }
});

// `results` is a request-shaped concern (schema default/max), not core
// lookup logic -- covered at the unit level in transit/segments.test.ts.
// This just confirms the query param actually reaches the lookup.
test("results caps the response end to end", async () => {
  const { app, index } = await serve();
  try {
    const res = await app.inject({
      url: "/segments?from=1000&to=2000&after=2026-08-24T07:00:00%2B03:00&results=1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SegmentsBody;
    assert.equal(body.departures.length, 1);
    assert.equal(body.departures[0]!.tripId, "T1");
  } finally { await app.close(); index.stop(); }
});

test("the index not being built yet is a retryable 503, not a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-segments-noix-"));
  const link = buildFixtureDb(dir);
  const index = new IndexManager(dir, { buildFn: async () => buildIndex(link) });
  const app = await buildServer({ index }); // deliberately no rebuild()
  try {
    const res = await app.inject({ url: "/segments?from=1000&to=2000" });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { code: string };
    assert.equal(body.code, "index_not_ready");
  } finally { await app.close(); index.stop(); }
});

test("a rail segment is headed for the train's last stop and carries tripNumber", async () => {
  const { app, index } = await serve();
  try {
    const rail = (await app.inject({
      url: "/segments?from=4000&to=1000&after=2026-08-24T16:30:00%2B03:00&lang=en",
    })).json() as { departures: { tripId: string; headsign: string | null; tripNumber: string | null }[] };
    assert.deepEqual(
      rail.departures.map((d) => [d.tripId, d.headsign, d.tripNumber]),
      [["T106", "Central Station", "106"]],
    );
    const bus = (await app.inject({
      url: "/segments?from=1000&to=2000&after=2026-08-24T07:00:00%2B03:00&lang=en",
    })).json() as { departures: { headsign: string | null; tripNumber: string | null }[] };
    assert.ok(bus.departures.length > 0);
    assert.ok(bus.departures.every((d) => d.tripNumber === null));
  } finally { await app.close(); index.stop(); }
});
