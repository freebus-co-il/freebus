import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { config, isProduction } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { statusRoutes } from "./routes/status.js";
import { refreshRoutes } from "./routes/refresh.js";
import type { ImportRunner } from "./scheduler.js";

export interface ServerDeps {
  runner: ImportRunner;
  /**
   * Directory holding the versioned databases and the live symlink.
   * Optional so existing callers/tests that only care about run state
   * (not the persisted live database) can keep constructing servers
   * without one; /status then reports `live: null`.
   */
  dataDir?: string;
}

/**
 * `pino-pretty` runs as a worker thread (via `thread-stream`), and neither
 * Fastify's `close()` nor pino itself terminates that thread on shutdown —
 * it is only reclaimed when the underlying stream is garbage-collected,
 * which is unbounded and, under CPU contention, can take far longer than a
 * test run. `node --test`'s parallel file runner is exactly that
 * contention: this suite's route tests (`routes/ops.test.ts`) call
 * `buildServer` ~9 times, each spinning up its own pretty-print worker
 * thread, and none of them are ever explicitly torn down. Left unref'd
 * threads accumulating like that is what produced the full-suite hang this
 * guards against — every subtest passed, but the file's own process never
 * went idle enough to exit before its test-runner parent gave up.
 * `NODE_TEST_CONTEXT` is set by node's test runner in every child process
 * it spawns, so this opts out of the worker thread precisely for that
 * runner without touching `npm run dev`'s pretty output.
 */
const usePrettyTransport = !isProduction && !process.env.NODE_TEST_CONTEXT;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(usePrettyTransport ? { transport: { target: "pino-pretty" } } : {}),
    },
    // Trust the reverse proxy in production so req.ip reflects the client.
    trustProxy: isProduction,
  });

  app.decorate("runner", deps.runner);
  app.decorate("dataDir", deps.dataDir ?? null);

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(statusRoutes);
  await app.register(refreshRoutes);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    runner: ImportRunner;
    dataDir: string | null;
  }
}
