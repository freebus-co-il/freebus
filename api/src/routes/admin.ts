import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../errors.js";

/**
 * Constant-time comparison of two secrets of ARBITRARY length.
 *
 * `timingSafeEqual` throws outright on a length mismatch, and the obvious
 * guard (`if (a.length !== b.length) return false`) leaks the expected
 * token's length to anyone who can time the endpoint. Hashing both sides
 * first makes every comparison exactly 32 bytes wide regardless of what was
 * presented, so the only thing the timing can reveal is what SHA-256 already
 * made public: nothing.
 */
function secretsMatch(expected: string, presented: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(expected, "utf8").digest(),
    createHash("sha256").update(presented, "utf8").digest(),
  );
}

/** The bearer token in an `Authorization` header, or null if there isn't one. */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!;
}

export const adminRoutes: FastifyPluginAsync<{ adminToken: string | null }> = async (
  app, opts,
) => {
  const { adminToken } = opts;

  app.post("/admin/reload", async (req, reply) => {
    // FAIL CLOSED. An unset TRANSIT_ADMIN_TOKEN refuses every request; it
    // does not mean "authentication is off". This is the only mutating
    // endpoint on a permissively-CORS'd public read-only API, and what it
    // starts is a ~400 MB index rebuild — an anonymous caller who could
    // reach it could keep one running continuously. See config.ts's own
    // comment on `adminToken`.
    const presented = bearerToken(req.headers.authorization);
    if (adminToken === null || presented === null || !secretsMatch(adminToken, presented)) {
      // Deliberately one indistinguishable answer for all three cases: not
      // configured, not presented, and wrong. Distinguishing them tells an
      // unauthenticated caller whether the deployment has a token at all.
      throw new ApiError(
        401,
        "unauthorized",
        "POST /admin/reload requires a valid `Authorization: Bearer <token>` header.",
        { headers: { "www-authenticate": "Bearer" } },
      );
    }

    if (app.index.state() === "building") {
      // Same single-flight shape as gtfs's POST /refresh.
      throw new ApiError(409, "rebuild_already_running", "An index rebuild is already in flight.");
    }

    // Checked before firing so the common case answers 503 rather than 202
    // followed by a silent background rejection. `rebuild()` re-resolves the
    // symlink itself and rejects the same way if it vanishes inside this
    // gap, so the check is an improvement to the reported status, never the
    // thing that makes the operation safe.
    if (app.index.liveTarget() === null) {
      throw new ApiError(
        503,
        "live_database_unavailable",
        "The live database is not currently available; retry shortly.",
        { headers: { "retry-after": "5" } },
      );
    }

    void app.index.rebuild().catch((err: unknown) => {
      app.log.error({ err }, "manual index rebuild failed");
    });
    return reply.code(202).send({ status: "started" });
  });
};
