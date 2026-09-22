import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildIndex } from "../transit/index.js";
import { loadCalendar } from "../transit/calendar.js";
import { openReadOnly } from "../transit/index.js";
import { paths, config } from "../config.js";
import {
  parseStrideRows, strideUrl, snapshotsUrl, latestLoadedSnapshotId,
} from "./stride.js";
import { createRealtimeResolver } from "./wiring.js";

// Gated so `npm test` stays hermetic; run with `npm run test:live`.
const live = process.env.TRANSIT_LIVE_TEST === "1";

/**
 * The whole chain against the real API and the real feed: fetch, parse,
 * match, derive. Unit tests can only prove the mechanism is internally
 * consistent -- this is the one that would catch the join itself silently
 * breaking, which is exactly what happens when the ministry reissues
 * trip_ids or changes how it frames a service date.
 */
test("live: a real Stride snapshot resolves against the real index", { skip: !live }, async () => {
  const t0 = Date.now();
  const ix = buildIndex(join(paths.dataDir, "gtfs.sqlite"));
  const db = openReadOnly(join(paths.dataDir, "gtfs.sqlite"));
  const calendar = loadCalendar(db);
  db.close();
  console.log(`index: ${ix.nTrips} trips in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Scope to the newest LOADED snapshot, exactly as the poller does. An
  // unscoped query returns every vehicle once per snapshot in the window.
  const B = "https://open-bus-stride-api.hasadna.org.il";
  const snapList = await (await fetch(snapshotsUrl(B))).json();
  const snapshotId = latestLoadedSnapshotId(snapList);
  assert.notEqual(snapshotId, null, "there should be a loaded snapshot");

  const url = strideUrl(B, {
    minLat: 29.4, maxLat: 33.4, minLon: 34.2, maxLon: 35.9,
    limit: 15_000, offset: 0, snapshotId: snapshotId!,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.equal(res.status, 200, "Stride should answer 200");
  const payload = await res.json();
  assert.ok(Array.isArray(payload), "a non-array body means an API error, not a snapshot");

  const now = Math.floor(Date.now() / 1000);
  // 30 min, matching the STRIDE_MAX_VEHICLE_AGE_SECONDS default. Stride's
  // ETL runs 14-19 min behind through the whole service peak, so a tighter
  // cutoff discards the entire feed during the day -- which is exactly how
  // this test first earned its keep.
  const snap = parseStrideRows(payload, { now, maxVehicleAgeSeconds: 1_800 });
  const ages = snap.journeys
    .map((j) => now - (j.recordedAt ?? now))
    .sort((a, b) => a - b);
  console.log(`snapshot: ${snap.rowsSeen} rows, ${snap.rowsDropped} dropped, ` +
    `${snap.journeys.length} journeys; median vehicle age ` +
    `${((ages[Math.floor(ages.length / 2)] ?? 0) / 60).toFixed(1)} min`);
  assert.ok(snap.journeys.length > 100, `only ${snap.journeys.length} usable vehicles`);

  const resolve = createRealtimeResolver(
    { current: () => ix, currentBundle: () => ({ calendar }) },
    config.timezone,
    "stride-vm",
  );
  const { resolved, stats } = resolve(snap.journeys, now);

  const rate = stats.resolved / (stats.resolved + stats.unresolved);
  const withPredictions = resolved.filter((r) => r.byStopIdx.size > 0).length;
  console.log(
    `resolved ${stats.resolved}/${stats.resolved + stats.unresolved} ` +
    `(${(100 * rate).toFixed(1)}%), ${withPredictions} with predictions, ` +
    `${stats.resolvedWithNoCalls} without, nearMiss ${stats.nearMissCount}`,
  );

  // Measured 87.5% on 2026-09-01 against a same-day bundle. Asserting 50%
  // catches a broken join without failing on ordinary day-to-day variation
  // (a stale bundle alone costs a couple of points).
  assert.ok(rate > 0.5, `resolution rate ${(100 * rate).toFixed(1)}%`);

  // The instrument from the SIRI-SM design, carried over: if the DISTANCE
  // join were wrong the way a bad stop-code join would be, every journey
  // would resolve while predicting nothing -- a perfectly healthy-looking
  // match rate doing nothing at all.
  assert.ok(
    withPredictions > stats.resolved * 0.5,
    `${stats.resolvedWithNoCalls} of ${stats.resolved} resolved with no predictions`,
  );

  // Delays should look like a bus network, not like a timezone slip. A
  // systematic hours-long offset is the classic symptom of reading
  // scheduled_start_time as local rather than UTC, or of the wrong service
  // day base epoch.
  const delays: number[] = [];
  for (const r of resolved) {
    const first = [...r.byStopIdx.values()][0];
    if (first === undefined || r.journey.recordedAt === null) continue;
    delays.push(first.expectedArrival - r.journey.recordedAt);
  }
  delays.sort((a, b) => a - b);
  const median = delays[Math.floor(delays.length / 2)] ?? 0;
  console.log(`median first-stop-ahead lead: ${median}s over ${delays.length} vehicles`);
  assert.ok(
    Math.abs(median) < 3 * 3600,
    `median lead ${median}s looks like a timezone or service-day error`,
  );
});
