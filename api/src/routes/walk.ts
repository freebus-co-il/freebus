import type { FastifyPluginAsync } from "fastify";
import { haversineMeters, type LatLon } from "../geo.js";
import { ApiError } from "../errors.js";

/**
 * The longest walk this route will plan, as the crow flies. `/walk` exists to
 * re-route a rider who has strayed off a walk leg -- a few hundred metres, a
 * couple of kilometres at most -- not to turn this box into a free general
 * routing service for anyone who finds the endpoint.
 */
export const WALK_MAX_ROUTE_METERS = 5_000;

function parseLatLon(raw: string): LatLon | null {
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

/**
 * `GET /walk?from=lat,lon&to=lat,lon` -- one walk on the street network, with
 * its turns. What a running journey asks when the rider has walked off the
 * path it was guiding them along: the rest of the way to the same stop, from
 * where they actually are.
 *
 * Degrades like every other walk in this service: a slow or dead Valhalla
 * answers with the straight-line estimate (`estimated: true`, no geometry, no
 * steps) rather than an error, so the client can keep pointing at the stop.
 */
export const walkRoutes: FastifyPluginAsync = async (app) => {
  app.get("/walk", {
    schema: {
      querystring: {
        type: "object",
        required: ["from", "to"],
        properties: { from: { type: "string" }, to: { type: "string" } },
      },
    },
  }, async (req) => {
    const q = req.query as { from: string; to: string };
    const from = parseLatLon(q.from);
    const to = parseLatLon(q.to);
    if (from === null || to === null) {
      throw app.httpErrors.badRequest("from and to must each be lat,lon");
    }
    if (haversineMeters(from, to) > WALK_MAX_ROUTE_METERS) {
      throw new ApiError(
        422, "walk_too_long",
        `A walk is planned only up to ${WALK_MAX_ROUTE_METERS} m in a straight line.`,
      );
    }
    const walk = await app.valhalla.route(from, to);
    return {
      distanceMeters: Math.round(walk.distanceMeters),
      durationSeconds: walk.durationSeconds,
      geometry: walk.geometry,
      steps: walk.steps ?? [],
      estimated: walk.estimated,
    };
  });
};
