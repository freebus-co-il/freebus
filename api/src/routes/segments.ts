import type { FastifyPluginAsync } from "fastify";
import { parseLang, type Lang, type Translator } from "../db/i18n.js";
import { config, routeRateLimits } from "../config.js";
import { buildDayContexts } from "../transit/raptor.js";
import { findSegments, type SegmentRoute } from "../transit/segments.js";
import type { TimetableIndex } from "../transit/index.js";
import { ApiError } from "../errors.js";

/** Enough for a client to label and place a marker for the endpoint, nothing
 *  more -- distinct from `itinerary.ts`'s `Place` (no `type` discriminant,
 *  since a segment's endpoints are always resolved stops, never a
 *  coordinate). */
function stopSummary(
  ix: TimetableIndex, stopIdx: number, tr: Translator, lang: Lang,
): { stopId: string; name: string | null; lat: number; lon: number } {
  return {
    stopId: ix.stopIds[stopIdx]!,
    name: tr.resolve(ix.stopNames[stopIdx] ?? null, lang),
    lat: ix.stopLat[stopIdx]!,
    lon: ix.stopLon[stopIdx]!,
  };
}

export const segmentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/segments", {
    schema: {
      querystring: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          after: { type: "string" },
          results: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          lang: { type: "string" },
        },
      },
    },
    // Per-route ceiling on top of the global 300/min limit -- this route is
    // USER-INITIATED (a rider expands a transit leg) rather than polled or
    // a re-plan, and it is a LOOKUP over the in-memory RAPTOR index (see
    // `api/README.md`'s own description of this route), cheaper than a
    // `/plan` or `/plan/onboard` search, so it affords a higher ceiling.
    // See `routeRateLimits.segmentsPerMinute` in `../config.js` for why 120
    // specifically. `@fastify/rate-limit` reads per-route settings from
    // `config.rateLimit` because the plugin is registered globally in
    // `server.ts`.
    config: { rateLimit: { max: routeRateLimits.segmentsPerMinute, timeWindow: "1 minute" } },
  }, async (req) => {
    const q = req.query as {
      from: string; to: string; after?: string; results: number; lang?: string;
    };

    // Same convention as `/plan`: this route is a lookup over the in-memory
    // RAPTOR index, so it has nothing to answer with until the first build
    // completes. A deliberate, retryable 503 -- not a fault.
    const ix = app.index.current();
    if (ix === null) {
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }

    let lang: Lang;
    try { lang = parseLang(q.lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }

    // A segment needs two distinct stops; checked before either id is
    // resolved so `from=X&to=X` on an UNKNOWN id still reads as the 400 it
    // obviously is, not a 404 about an id that happens not to exist either.
    if (q.from === q.to) {
      throw app.httpErrors.badRequest("from and to must be distinct stops");
    }

    // Existence is decided by the in-memory index, not a database query --
    // this route has no other reason to touch the database at all. Same
    // `No stop with id ${id}` / `app.httpErrors.notFound` convention every
    // other route (trips.ts, departures.ts, stops.ts, lines.ts, plan.ts)
    // already uses for an unknown id.
    const fromIdx = ix.stopIdToIdx.get(q.from);
    if (fromIdx === undefined) throw app.httpErrors.notFound(`No stop with id ${q.from}`);
    const toIdx = ix.stopIdToIdx.get(q.to);
    if (toIdx === undefined) throw app.httpErrors.notFound(`No stop with id ${q.to}`);

    const after = q.after === undefined ? new Date() : new Date(q.after);
    if (Number.isNaN(after.getTime())) {
      throw app.httpErrors.badRequest(`Invalid after: ${q.after}`);
    }

    // Same DayContext machinery `/plan` uses: today's service day and the
    // previous one, so a trip that departed yesterday at 25:30 and is still
    // running now is found the same way a plan or a departures board finds
    // it. Read fresh from `app.calendar` on every request, like `/plan`.
    const days = buildDayContexts(ix, app.calendar, after, config.timezone);

    const routeOf = (routeIdx: number): SegmentRoute =>
      app.routeBriefByIdx[routeIdx]
      ?? { id: "", agencyId: null, shortName: null, longName: null, type: 3, color: null };

    const departures = findSegments(
      ix, days, fromIdx, toIdx, Math.floor(after.getTime() / 1000),
      { tr: app.translator, lang, tz: config.timezone, routeOf },
      { resultsLimit: q.results },
    );

    return {
      from: stopSummary(ix, fromIdx, app.translator, lang),
      to: stopSummary(ix, toIdx, app.translator, lang),
      departures,
    };
  });
};
