import type { FastifyPluginAsync } from "fastify";
import { parseLang } from "../db/i18n.js";
import { searchStops, nearbyStops, getStop, stopsInBox, STOPS_BOX_MAX_SPAN_DEG } from "../db/stops.js";

export const stopRoutes: FastifyPluginAsync = async (app) => {
  app.get("/stops/search", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          q: { type: "string", maxLength: 100 },
          lang: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    const { q, lang, limit, offset } = req.query as
      { q?: string; lang?: string; limit: number; offset: number };
    // parseLang throws on an unsupported code; sensible's error handler turns
    // that into a 500, so translate it to a 400 here — a bad `lang` is the
    // client's mistake, not the server's.
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    return { stops: searchStops(app.db.db, app.translator, { q: q ?? "", lang: parsed, limit, offset }) };
  });

  app.get("/stops/nearby", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lon"],
        properties: {
          lat: { type: "number", minimum: -90, maximum: 90 },
          lon: { type: "number", minimum: -180, maximum: 180 },
          radius: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          lang: { type: "string" },
        },
      },
    },
  }, async (req) => {
    const { lat, lon, radius, limit, lang } = req.query as
      { lat: number; lon: number; radius: number; limit: number; lang?: string };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    return {
      stops: nearbyStops(app.db.db, app.translator, {
        lat, lon, radiusMeters: radius, limit, lang: parsed,
      }),
    };
  });

  // A map's visible box. Clients ask for fixed tiles rather than their exact
  // viewport, so a pan repeats URLs and the edge cache (Caddyfile, /stops*)
  // answers them.
  app.get("/stops/in-box", {
    schema: {
      querystring: {
        type: "object",
        required: ["minLat", "minLon", "maxLat", "maxLon"],
        properties: {
          minLat: { type: "number", minimum: -90, maximum: 90 },
          minLon: { type: "number", minimum: -180, maximum: 180 },
          maxLat: { type: "number", minimum: -90, maximum: 90 },
          maxLon: { type: "number", minimum: -180, maximum: 180 },
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
          lang: { type: "string" },
        },
      },
    },
  }, async (req) => {
    const { minLat, minLon, maxLat, maxLon, limit, lang } = req.query as
      { minLat: number; minLon: number; maxLat: number; maxLon: number; limit: number; lang?: string };
    if (minLat > maxLat || minLon > maxLon) {
      throw app.httpErrors.badRequest("min corner must be south-west of max corner");
    }
    if (maxLat - minLat > STOPS_BOX_MAX_SPAN_DEG || maxLon - minLon > STOPS_BOX_MAX_SPAN_DEG) {
      throw app.httpErrors.badRequest(`box spans more than ${STOPS_BOX_MAX_SPAN_DEG} degrees`);
    }
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    return { stops: stopsInBox(app.db.db, app.translator, { minLat, maxLat, minLon, maxLon, limit, lang: parsed }) };
  });

  app.get("/stops/:stopId", {
    schema: {
      params: { type: "object", required: ["stopId"], properties: { stopId: { type: "string" } } },
      querystring: { type: "object", properties: { lang: { type: "string" } } },
    },
  }, async (req) => {
    const { stopId } = req.params as { stopId: string };
    const { lang } = req.query as { lang?: string };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    const stop = getStop(app.db.db, app.translator, stopId, parsed);
    if (stop === null) throw app.httpErrors.notFound(`No stop with id ${stopId}`);
    return stop;
  });
};
