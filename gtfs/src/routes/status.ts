import type { FastifyPluginAsync } from "fastify";
import { readLiveState } from "../pipeline/importFeed.js";

export const statusRoutes: FastifyPluginAsync = async (app) => {
  app.get("/status", async () => {
    // readLiveState never throws (see its own doc comment) — it reports
    // the persisted state of the live database, which survives a process
    // restart even though runner.lastResult() does not. `live`/`liveError`
    // distinguish "nothing published yet" (both null) from "a database
    // was published but is now missing/unreadable" (liveError set) — an
    // ops endpoint that collapsed those two states would be misleading at
    // exactly the moment someone is relying on it during an incident.
    const { live, liveError } = app.dataDir
      ? readLiveState(app.dataDir)
      : { live: null, liveError: null };

    return {
      running: app.runner.isRunning(),
      lastRun: app.runner.lastResult(),
      live,
      liveError,
    };
  });
};
