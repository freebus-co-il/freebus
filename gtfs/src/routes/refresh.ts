import type { FastifyPluginAsync } from "fastify";

export const refreshRoutes: FastifyPluginAsync = async (app) => {
  app.post("/refresh", async (_req, reply) => {
    if (app.runner.isRunning()) {
      return reply.code(409).send({ status: "already_running" });
    }
    // Fire and forget: an import runs for minutes, far longer than a request.
    // The .catch here is load-bearing — without it, a rejected run would be
    // an unhandled promise rejection (ImportRunner.run() re-throws after
    // recording the failure in lastResult()).
    app.runner.run().catch((err: unknown) => {
      app.log.error({ err }, "refresh-triggered import failed");
    });
    return reply.code(202).send({ status: "started" });
  });
};
