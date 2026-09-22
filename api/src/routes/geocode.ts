import type { FastifyPluginAsync } from "fastify";
import { parseLang } from "../db/i18n.js";

/** Google's own limit for a session token is 36 URL-safe base64 characters. */
const SESSION = { type: "string", pattern: "^[A-Za-z0-9_-]{1,36}$" } as const;

export const geocodeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/geocode/search", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", minLength: 1, maxLength: 100 },
          lang: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
          session: SESSION,
          // Rank results near here. Both or neither -- one alone is ignored.
          lat: { type: "number", minimum: -90, maximum: 90 },
          lon: { type: "number", minimum: -180, maximum: 180 },
        },
      },
    },
  }, async (req) => {
    const { q, lang, limit, session, lat, lon } = req.query as {
      q: string; lang?: string; limit: number; session?: string; lat?: number; lon?: number;
    };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    const near = lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
    const places = await app.geocoder.search(q, parsed, limit, { session, near });
    return { places };
  });

  // Resolves a search result that came back with a `placeId` instead of a
  // position (the Google backend). Called once, for the result the rider
  // picked, with the same `session` its searches used.
  app.get("/geocode/place", {
    schema: {
      querystring: {
        type: "object",
        required: ["id"],
        properties: {
          // Google place ids are URL-safe base64. Constraining it also keeps
          // it from ever being a path segment that means anything else.
          id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" },
          session: SESSION,
        },
      },
    },
  }, async (req) => {
    const { id, session } = req.query as { id: string; session?: string };
    const location = await app.geocoder.place(id, session);
    return { location };
  });

  app.get("/geocode/reverse", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lon"],
        properties: {
          lat: { type: "number", minimum: -90, maximum: 90 },
          lon: { type: "number", minimum: -180, maximum: 180 },
          lang: { type: "string" },
        },
      },
    },
  }, async (req) => {
    const { lat, lon, lang } = req.query as { lat: number; lon: number; lang?: string };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    const place = await app.geocoder.reverse(lat, lon, parsed);
    return { place };
  });
};
