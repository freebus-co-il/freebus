import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "./transit/index.js";
import { paths } from "./config.js";
import { join } from "node:path";

// Gated so `npm test` stays hermetic; run with `npm run test:live`.
const live = process.env.TRANSIT_LIVE_TEST === "1";

test("builds the real index within the measured budget", { skip: !live }, () => {
  const t0 = Date.now();
  const ix = buildIndex(join(paths.dataDir, "gtfs.sqlite"));
  const seconds = (Date.now() - t0) / 1000;

  // Measured 2026-08-22 against the live 666 MB database: 35,266 stops,
  // 261,634 trips, 6,901 patterns (6,893 raw stop-sequence groups plus 8
  // split out for overtaking) over 9,817,029 stop_times rows, in ~4.8 s. A
  // large drift in the pattern count means the grouping is wrong, which
  // would silently change every plan.
  assert.ok(ix.nStops > 30_000, `stops: ${ix.nStops}`);
  assert.ok(ix.nTrips > 200_000, `trips: ${ix.nTrips}`);
  assert.ok(ix.nPatterns > 5_000 && ix.nPatterns < 12_000, `patterns: ${ix.nPatterns}`);
  assert.ok(seconds < 30, `build took ${seconds}s`);
  console.log(`live index: ${ix.nStops} stops, ${ix.nTrips} trips, ${ix.nPatterns} patterns, ${seconds}s`);

  // Late-night service is real and must survive the load unclamped.
  let maxDeparture = 0;
  for (const t of ix.departureTime) if (t > maxDeparture) maxDeparture = t;
  assert.ok(maxDeparture > 86_400, `max departure ${maxDeparture} — times were clamped`);
});
