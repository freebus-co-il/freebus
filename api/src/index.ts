import { config, paths, realtimeConfig, reloadPollMs, valhallaConfig, walkConfig } from "./config.js";
import { buildServer } from "./server.js";
import { IndexManager } from "./transit/manager.js";
import { RequestDrain } from "./requestDrain.js";
import { ValhallaClient } from "./walking/valhalla.js";
import { createRealtimeRuntime } from "./realtime/wiring.js";
import type { SiriLogger } from "./realtime/poller.js";

// Shared with buildServer below so IndexManager can tell, on a feed swap,
// once no in-flight request can still be reading through the database
// handle it is about to close. See requestDrain.ts.
const drain = new RequestDrain();

// SiriPoller warnings should go through the same structured logger as
// everything else, but `app.log` does not exist until `buildServer` returns
// -- and the runtime (and the poller inside it) has to exist BEFORE that
// call, so it can be handed in as a dependency (see ServerDeps.realtimePoller).
// This mutable cell lets the poller's logger start as `console` and switch
// to `app.log` the moment the server exists, with nothing about the
// runtime's own construction order changing.
let realtimeLogTarget: SiriLogger = console;
// `info` is forwarded the same way `warn` is: without
// this, `logger.info?.(...)` (used for a size/parse-duration line) would
// silently no-op in production forever, since neither `console` nor `app.log`
// (pino) is ever reached through a `SiriLogger` that only declares `warn` --
// a capability that exists only under a test double is worse than no
// capability, because it reads as covered. Both `console.info` and pino's
// `app.log.info` satisfy this.
// DELIBERATELY UNTESTED, and cannot be otherwise: this
// file is a side-effecting entrypoint script by design (see
// `createRealtimeRuntime`'s own doc comment on why the composition root
// lives in wiring.ts instead) -- nothing here is importable by a test. The
// `info` forwarding above was verified by hand: constructed a real
// `SiriLogger` this exact way, called `.info("x")` before and after
// reassigning `realtimeLogTarget`, and confirmed both `console.info` and a
// stand-in `app.log` received it. Absent here is a gap left open
// knowingly, not one that was missed.
const realtimeLogger: SiriLogger = {
  warn: (message) => realtimeLogTarget.warn(message),
  info: (message) => realtimeLogTarget.info?.(message),
};

const index = new IndexManager(paths.dataDir, {
  drain,
  // Wiring this in makes footpath attachment part of EVERY rebuild, not
  // just the first — see IndexManager.rebuild()'s and attachFootpathsTo's
  // own comments for why that matters (a feed swap that skipped this would
  // silently serve an index with zero walking transfers) and for the
  // cache-first/degrade-not-die policy applied on every call.
  footpaths: {
    client: new ValhallaClient({ ...valhallaConfig, speedMps: walkConfig.speedMps }),
    options: {
      maxMeters: walkConfig.maxMeters,
      sameStationSeconds: walkConfig.sameStationSeconds,
      transferMinSeconds: walkConfig.transferMinSeconds,
      batchSize: valhallaConfig.batchSize,
      speedMps: walkConfig.speedMps,
    },
    cacheDir: paths.cacheDir,
  },
});

// The single composition root for realtime -- see wiring.ts's own doc
// comment on why the "no key -> nothing constructed, no timer" and "a feed
// swap invalidates the store" guarantees live there, as one directly
// testable function, rather than as ternaries in this un-importable script.
// `realtimePoller` is constructed but not yet started; `onIndexSwap` (when
// present) must reach `index` before its next `rebuild()` completes.
const { store: realtimeStore, poller: realtimePoller, onIndexSwap } =
  createRealtimeRuntime(realtimeConfig, index, config.timezone, { logger: realtimeLogger });
if (onIndexSwap !== undefined) index.setOnIndexSwap(onIndexSwap);

const app = await buildServer({
  index, drain, realtime: realtimeStore, realtimePoller,
});
realtimeLogTarget = app.log;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    index.stop();
    realtimePoller?.stop();
    void app.close().then(
      // Read whatever bundle is CURRENT at shutdown time, not whatever was
      // current at boot -- a reload since then would have replaced it.
      () => { index.currentBundle().db.close(); process.exit(0); },
      (err: unknown) => { app.log.error({ err }, "shutdown failed"); process.exit(1); },
    );
  });
}

try {
  // Listen before building: /health and /meta must be answerable while the
  // index is still being built, so an orchestrator can see progress rather
  // than an unresponsive port. The db-derived bundle (and so /meta's
  // version/counts and every browse endpoint) is already available at this
  // point -- IndexManager builds it synchronously in its own constructor,
  // above, precisely so it does not have to wait on the index.
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ version: index.currentBundle().db.version }, "serving");

  // Builds the RAPTOR index AND attaches its footpaths (from cache, or via
  // Valhalla/straight-line) before either can be served -- see
  // IndexManager.rebuild()'s own comment. This is also what every later
  // feed swap runs, via startPolling below or POST /admin/reload.
  await index.rebuild();
  app.log.info(
    { patterns: index.current()?.nPatterns, footpaths: index.footpathMode() },
    "index ready",
  );

  index.startPolling(reloadPollMs);
  realtimePoller?.start();
  // `source` as well as `enabled`: with the keyless feeds there are three
  // ways to be enabled, and which feed is live changes how a prediction
  // should be read (an operator's own ETA vs. one derived from a position,
  // and how old that position is).
  app.log.info(
    { realtime: realtimeConfig.enabled, source: realtimeConfig.source },
    "realtime configuration resolved",
  );
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
