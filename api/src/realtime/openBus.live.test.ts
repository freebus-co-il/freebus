import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildIndex, openReadOnly } from "../transit/index.js";
import { loadCalendar } from "../transit/calendar.js";
import { paths, config, resolveRealtimeConfig } from "../config.js";
import { parseOpenBusSnapshot, latestSnapshotId, statusUrl, snapshotUrl } from "./openBus.js";
import { createFetchSnapshot } from "./openBusPoller.js";
import { createRealtimeResolver } from "./wiring.js";

// Gated so `npm test` stays hermetic; run with `npm run test:live`.
const live = process.env.TRANSIT_LIVE_TEST === "1";

const BASE = "https://open-bus-siri-requester.hasadna.org.il";

/**
 * The whole chain against the real requester and the real feed: status,
 * download, brotli, parse, match, derive. The unit tests prove the mechanism
 * is consistent with a recorded snapshot; this is what catches the file
 * format, the distance field, or the trip join changing underneath it.
 */
test("live: a real open-bus snapshot is fresh and resolves against the real index", { skip: !live }, async () => {
  const status = await (await fetch(statusUrl(BASE), { signal: AbortSignal.timeout(20_000) })).json();
  const snapshotId = latestSnapshotId(status);
  assert.notEqual(snapshotId, null, `daemon_status.json carried no usable id: ${JSON.stringify(status)}`);

  const t0 = Date.now();
  const payload = await createFetchSnapshot(60_000)(snapshotUrl(BASE, snapshotId!));
  const now = Math.floor(Date.now() / 1000);
  // The production default, so the drop count here is what a deployment sees.
  const { maxVehicleAgeSeconds } = resolveRealtimeConfig({}, () => {}).openBus!;
  const snap = parseOpenBusSnapshot(payload, { now, maxVehicleAgeSeconds });
  assert.notEqual(snap, null, "the snapshot should be a SIRI stop-monitoring delivery");
  console.log(
    `snapshot ${snapshotId}: ${snap!.rowsSeen} visits, ${snap!.rowsDropped} dropped, ` +
    `${snap!.journeys.length} journeys, fetched+decoded in ${Date.now() - t0} ms`,
  );
  assert.ok(snap!.journeys.length > 50, `only ${snap!.journeys.length} usable vehicles`);

  // The reason this feed exists. Stride's positions are 13-23 min old through
  // a weekday; these should be about a minute. Five is generous for load and
  // clock skew and still an order of magnitude inside Stride's lag.
  const ages = snap!.journeys.map((j) => now - (j.recordedAt ?? now)).sort((a, b) => a - b);
  const medianAge = ages[Math.floor(ages.length / 2)] ?? 0;
  console.log(`median vehicle report age: ${medianAge}s`);
  assert.ok(medianAge < 300, `median report age ${medianAge}s -- this feed should be about a minute old`);

  const ix = buildIndex(join(paths.dataDir, "gtfs.sqlite"));
  const db = openReadOnly(join(paths.dataDir, "gtfs.sqlite"));
  const calendar = loadCalendar(db);
  db.close();

  const resolve = createRealtimeResolver(
    { current: () => ix, currentBundle: () => ({ calendar }) }, config.timezone, "open-bus-vm",
  );
  const { resolved, stats } = resolve(snap!.journeys, now);
  const rate = stats.resolved / (stats.resolved + stats.unresolved);
  const withPredictions = resolved.filter((r) => r.byStopIdx.size > 0).length;
  console.log(
    `resolved ${stats.resolved}/${stats.resolved + stats.unresolved} (${(100 * rate).toFixed(1)}%), ` +
    `${stats.attached ?? 0} by slot, ${stats.unscheduled ?? 0} unscheduled, ` +
    `${withPredictions} with predictions, nearMiss ${stats.nearMissCount}`,
  );

  // Same thresholds as the Stride live check, for the same reasons: 50%
  // catches a broken join without failing on a day-old bundle, and a join
  // that resolves while predicting nothing is the silent failure to guard.
  assert.ok(rate > 0.5, `resolution rate ${(100 * rate).toFixed(1)}% -- is data/gtfs.sqlite current?`);
  assert.ok(withPredictions > stats.resolved * 0.5,
    `${stats.resolvedWithNoCalls} of ${stats.resolved} resolved with no predictions`);
});
