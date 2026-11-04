import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildFixtureDb } from "./fixture.js";
import { IndexManager } from "../transit/manager.js";
import { buildIndex, attachFootpaths } from "../transit/index.js";
import { buildFootpaths } from "../transit/footpaths.js";
import { RequestDrain } from "../requestDrain.js";
import { buildServer, type ServerDeps } from "../server.js";

/** A Valhalla client that is always down: footpaths fall back to straight
 *  lines, so no container is needed. */
export const VALHALLA_DOWN = {
  ping: async () => false,
  matrix: async () => { throw new Error("down"); },
} as never;

export function footpathOptions(maxMeters = 400) {
  return { maxMeters, sameStationSeconds: 180, transferMinSeconds: 60, batchSize: 10, speedMps: 1.33 };
}

export interface FixtureServerOptions {
  /** Temp directory prefix, for telling leftovers apart. */
  prefix?: string;
  /** Extra SQL run against the shared fixture (`testing/fixture.ts`) before
   *  the index is built. */
  sql?: string;
  /**
   * How footpaths are built:
   * - `"none"` (default): no footpaths.
   * - `"baked"`: built inside `buildFn` and attached to the index.
   * - `"managed"`: built by `IndexManager` itself, with a `RequestDrain`
   *   shared with the server, the way production wires it.
   */
  footpaths?: "none" | "baked" | "managed";
  /** Footpath radius. Default 400 m, below the 695 m gap between fixture
   *  stops 1000 and 2000, so that pair is never joined by a walk. */
  footpathMaxMeters?: number;
  realtime?: ServerDeps["realtime"];
  valhalla?: unknown;
}

export interface FixtureServer {
  app: FastifyInstance;
  index: IndexManager;
}

/** The shared GTFS fixture, optionally extended, behind a real server. */
export async function serveFixture(opts: FixtureServerOptions = {}): Promise<FixtureServer> {
  const dir = mkdtempSync(join(tmpdir(), `transit-plan-${opts.prefix ?? "fixture"}-`));
  const link = buildFixtureDb(dir);
  if (opts.sql !== undefined) {
    const raw = new Database(link);
    raw.exec(opts.sql);
    raw.close();
  }

  const options = footpathOptions(opts.footpathMaxMeters);
  const mode = opts.footpaths ?? "none";
  const drain = mode === "managed" ? new RequestDrain() : undefined;
  const index = new IndexManager(dir, {
    ...(drain === undefined ? {} : { drain }),
    buildFn: mode === "baked"
      ? async () => {
          const ix = buildIndex(link);
          const { arrays } = await buildFootpaths(ix, VALHALLA_DOWN, options);
          attachFootpaths(ix, arrays.offsets, arrays.targets, arrays.seconds);
          return ix;
        }
      : async () => buildIndex(link),
    ...(mode === "managed"
      ? { footpaths: { client: VALHALLA_DOWN, options, cacheDir: join(dir, "cache") } }
      : {}),
  });
  await index.rebuild();

  const app = await buildServer({
    index,
    ...(drain === undefined ? {} : { drain }),
    ...(opts.realtime === undefined ? {} : { realtime: opts.realtime }),
    ...(opts.valhalla === undefined ? {} : { valhalla: opts.valhalla as ServerDeps["valhalla"] }),
  });
  return { app, index };
}

/** Closes the server, the live database handle and the index poller. */
export async function shutdown({ app, index }: FixtureServer): Promise<void> {
  await app.close();
  index.currentBundle().db.close();
  index.stop();
}
