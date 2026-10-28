import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: { status: { type: "string" }, uptime: { type: "number" } },
          required: ["status", "uptime"],
        },
      },
    },
  }, async () => ({ status: "ok", uptime: process.uptime() }));
};
