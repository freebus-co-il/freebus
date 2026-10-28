// `npm run bake:rail` -- rebuilds assets/rail-geometry.json from OpenStreetMap.
//
// Run it when the rail network or the feed's stations change (a new line or
// station; the API logs "no baked line for station pair" when a pair is
// missing), then commit the file. The API only ever reads the result.
//
//   npm run bake:rail                               # fetch from Overpass
//   npm run bake:rail -- --overpass-file rail.json  # reuse a saved response
//   npm run bake:rail -- --force                    # write despite problems
//
// Needs the GTFS database (GTFS_DATA_DIR, default ../data) for the station
// pairs. Refuses to write when any pair is unroutable or a detour unless
// --force: a bad bake would otherwise replace good lines silently.

import { readFileSync, writeFileSync } from "node:fs";
import { paths } from "../config.js";
import { openTransitDb } from "../db/connect.js";
import { MAX_DETOUR_RATIO, bakeRailGeometry, parseOverpassRail, railStationPairs } from "./bake.js";
import { RailGraph } from "./railGraph.js";
import { DEFAULT_RAIL_GEOMETRY_FILE } from "./railGeometry.js";

// Tried in order: the main instance answers 504 when it is busy, which is
// often, and the query is the same everywhere.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// A bounding box, not Israel's admin area: the Tel Aviv-Jerusalem line runs
// outside that boundary for a stretch, and a station pair across it would be
// unroutable.
const OVERPASS_QUERY =
  "[out:json][timeout:180];way[\"railway\"=\"rail\"](29.4,34.2,33.4,35.95);out body geom;";

const MAX_OSM_AGE_DAYS = 30;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function fetchOverpass(): Promise<unknown> {
  const failures: string[] = [];
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "freebus-rail-bake/1.0" },
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Parsed here so a 200 carrying a timeout `remark` also moves on to
      // the next instance instead of failing the whole bake.
      const json = await res.json();
      const { osmTimestamp } = parseOverpassRail(json);
      // Mirrors can lag by months (one answered with 2026-06-01 data on
      // 2026-09-15, and that data baked a 9.2x detour the current map does
      // not have).
      const ageDays = (Date.now() - Date.parse(osmTimestamp)) / 86_400_000;
      if (!(ageDays <= MAX_OSM_AGE_DAYS)) {
        throw new Error(`its data is from ${osmTimestamp || "an unknown date"}, over ${MAX_OSM_AGE_DAYS} days old`);
      }
      return json;
    } catch (err) {
      failures.push(`${url}: ${(err as Error).message}`);
      console.warn(`Overpass failed, trying the next instance -- ${failures[failures.length - 1]}`);
    }
  }
  throw new Error(`every Overpass instance failed:\n  ${failures.join("\n  ")}`);
}

const overpassFile = argValue("--overpass-file");
const force = process.argv.includes("--force");

const { ways, osmTimestamp } = parseOverpassRail(
  overpassFile === undefined ? await fetchOverpass() : JSON.parse(readFileSync(overpassFile, "utf8")),
);
console.log(`OSM rail ways: ${ways.length} (data as of ${osmTimestamp || "unknown"})`);

const handle = openTransitDb(paths.dataDir);
const pairs = railStationPairs(handle.db);
handle.close();
const names = new Map(pairs.map((p) => [p.key, `${p.from.name ?? p.from.stopId} - ${p.to.name ?? p.to.stopId}`]));
console.log(`station pairs: ${pairs.length}`);

const { baked, unroutable, detours } = bakeRailGeometry(RailGraph.fromWays(ways), pairs, { osmTimestamp });
console.log(`baked: ${Object.keys(baked.lines).length}/${pairs.length}`);
for (const key of unroutable) console.log(`  UNROUTABLE ${key} ${names.get(key)}`);
for (const { key, ratio } of detours) {
  console.log(`  DETOUR ${ratio.toFixed(1)}x (> ${MAX_DETOUR_RATIO}x) ${key} ${names.get(key)}`);
}

if ((unroutable.length > 0 || detours.length > 0) && !force) {
  console.error("not written: fix the problems above, or re-run with --force to write anyway");
  process.exit(1);
}
writeFileSync(DEFAULT_RAIL_GEOMETRY_FILE, `${JSON.stringify(baked, null, 1)}\n`);
console.log(`wrote ${DEFAULT_RAIL_GEOMETRY_FILE}`);
