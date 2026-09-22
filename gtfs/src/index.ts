import { config, feedConfig } from "./config.js";
import { buildServer } from "./server.js";
import { ImportRunner, startSchedule } from "./scheduler.js";
import {
  importFeed, readLiveState, startupImportReason,
} from "./pipeline/importFeed.js";

// Set once the server exists, so warnings raised by an import go to the same
// structured log as everything else. Imports can only be triggered after the
// server is built (cron arming and the startup check both happen below), so
// this is never read while still null in practice — the fallback is there so
// a future caller reordering the bootstrap degrades to stderr rather than
// throwing.
let warn: (message: string) => void = (message) => console.warn(message);

const runner = new ImportRunner(
  () =>
    importFeed({
      url: feedConfig.url,
      dataDir: feedConfig.dataDir,
      now: () => new Date(),
      keepVersions: feedConfig.keepVersions,
      maxBadRowRatio: feedConfig.maxBadRowRatio,
      stallTimeoutMs: feedConfig.stallTimeoutMs,
      onWarn: (message) => warn(message),
    }),
  { runTimeoutMs: feedConfig.runTimeoutMs },
);

const app = await buildServer({ runner, dataDir: feedConfig.dataDir });
warn = (message) => app.log.warn(message);

const schedule = startSchedule(
  runner,
  feedConfig.cron,
  feedConfig.timezone,
  (err) => app.log.error({ err }, "scheduled import failed"),
  { jitterMs: feedConfig.cronJitterMs },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    schedule.stop();
    void app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ nextRun: schedule.nextRun() }, "schedule armed");

  // Bootstrap rather than waiting for the first cron — not only when the
  // data directory is empty, but also when what is live has gone stale,
  // which is what happens to a service that was down across its 03:00
  // window. See startupImportReason.
  const reason = startupImportReason(
    readLiveState(feedConfig.dataDir),
    new Date(),
    feedConfig.startupMaxAgeMs,
  );
  if (reason) {
    app.log.info({ reason }, "importing on startup");
    runner.run().catch((err: unknown) => {
      app.log.error({ err }, "initial import failed");
    });
  }
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
