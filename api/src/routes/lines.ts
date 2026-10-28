import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { parseLang } from "../db/i18n.js";
import type { Lang, Translator } from "../db/i18n.js";
import {
  listRoutes, getRoute, getRouteShape, nextRuns, getLine, runsAround, tripBrief,
  type RouteRun,
} from "../db/lines.js";
import type { RealtimeStore } from "../realtime/store.js";
import type { TimetableIndex } from "../transit/index.js";
import { toIso } from "../transit/calendar.js";
import { runIdFor } from "./unscheduledRuns.js";
import { config } from "../config.js";

/**
 * A comma-separated list of GTFS `route_type` values, as `?type=` and
 * `?excludeTypes=` both take.
 *
 * Deliberately the same shape and the same strictness as `/plan`'s
 * `parseModes` (see `routes/plan.ts`), for the same reason: `Number("")` is
 * `0` and `Number("abc")` is `NaN`, so a lenient parse turns a typo into
 * either "tram only" or an empty filter that answers `200` with nothing --
 * indistinguishable, from the app's side, from "this operator runs no such
 * lines". Anything that is not an integer is a `400` naming the offending
 * value. Whitespace around an entry is tolerated (`type=3, 2` survives a
 * URL-decoded space); an empty entry is not.
 *
 * A local parser rather than an import of `parseModes`: these are
 * `route_type`s to FILTER ROUTE ROWS by, not modes to plan with, and the
 * message a client gets has to name the parameter it actually sent.
 */
function parseTypes(param: string, raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid ${param} value: "${part}". `
        + `${param} must be a comma-separated list of integer GTFS route_type `
        + `values, e.g. ${param}=3,2. Omit the parameter entirely for no filter.`,
      );
    }
    if (!out.includes(Number(trimmed))) out.push(Number(trimmed));
  }
  return out;
}

/**
 * `?agency=` as a list. Agency ids are opaque TEXT, so unlike `type` there
 * is nothing to validate: an id that matches no row is a legitimate query
 * that returns nothing, not a malformed one. Splitting a bare `?agency=`
 * into `[""]` preserves today's behaviour for it exactly -- an empty id
 * matches no agency.
 */
function parseAgencies(raw: string): string[] {
  return raw.split(",").map((p) => p.trim());
}

/**
 * The unscheduled runs on `routeId` that are on the road right now, as run
 * list entries ordered by their own start: the template trip's first
 * departure plus the run's offset. They come before the timetable's upcoming
 * runs, because they have already started.
 */
function unscheduledRouteRuns(
  realtime: RealtimeStore, ix: TimetableIndex, db: Database.Database, tr: Translator,
  opts: { routeId: string; lang: Lang; tz: string },
): RouteRun[] {
  const taken = new Set<string>();
  const entries: { start: number; run: RouteRun }[] = [];
  for (const run of realtime.unscheduledOnRoute(opts.routeId)) {
    const tripId = ix.tripIds[run.templateTripIdx];
    if (tripId === undefined) continue;
    const brief = tripBrief(db, tr, tripId, opts.lang);
    if (brief === null) continue;
    const originSeconds = ix.departureTime[ix.tripTimeOffset[run.templateTripIdx]!]!;
    const start = run.serviceBaseEpoch + run.offsetSeconds + originSeconds;
    entries.push({
      start,
      run: {
        tripId, runId: runIdFor(tripId, run, taken), unscheduled: true,
        offsetSeconds: run.offsetSeconds, headsign: brief.headsign, tripNumber: brief.tripNumber,
        departureTime: toIso(start, opts.tz), directionId: brief.directionId,
      },
    });
  }
  return entries.sort((a, b) => a.start - b.start).map((e) => e.run);
}

export const lineRoutes: FastifyPluginAsync = async (app) => {
  app.get("/routes", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          agency: { type: "string" },
          // Strings, not integers: these carry comma-separated lists now.
          // `?type=3` still parses to `[3]` and behaves as it always has;
          // a malformed entry is rejected by `parseTypes` with a message
          // that names it, rather than by ajv's bare "must be integer".
          type: { type: "string" },
          excludeTypes: { type: "string" },
          q: { type: "string", maxLength: 100 },
          lineCode: { type: "string", maxLength: 40 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as {
      agency?: string; type?: string; excludeTypes?: string; q?: string;
      lineCode?: string; limit: number; offset: number;
    };
    let type: number[] | undefined;
    let excludeTypes: number[] | undefined;
    try {
      type = q.type === undefined ? undefined : parseTypes("type", q.type);
      excludeTypes = q.excludeTypes === undefined
        ? undefined : parseTypes("excludeTypes", q.excludeTypes);
    } catch (err) {
      throw app.httpErrors.badRequest((err as Error).message);
    }
    return listRoutes(app.db.db, {
      agency: q.agency === undefined ? undefined : parseAgencies(q.agency),
      type,
      excludeTypes,
      q: q.q,
      lineCode: q.lineCode,
      limit: q.limit,
      offset: q.offset,
    });
  });

  app.get("/routes/:routeId", {
    schema: {
      params: { type: "object", required: ["routeId"], properties: { routeId: { type: "string" } } },
      querystring: { type: "object", properties: { lang: { type: "string" } } },
    },
  }, async (req) => {
    const { routeId } = req.params as { routeId: string };
    const { lang } = req.query as { lang?: string };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    const route = getRoute(app.db.db, app.translator, routeId, parsed);
    if (route === null) throw app.httpErrors.notFound(`No route with id ${routeId}`);
    return route;
  });

  app.get("/routes/:routeId/trips", {
    schema: {
      params: { type: "object", required: ["routeId"], properties: { routeId: { type: "string" } } },
      querystring: {
        type: "object",
        properties: {
          lang: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
          // Together, never apart: the runs around trip `around`, timed at
          // `stopId` -- see `runsAround`. `limit` then bounds the runs after it.
          stopId: { type: "string" },
          around: { type: "string" },
        },
      },
    },
  }, async (req) => {
    const { routeId } = req.params as { routeId: string };
    const { lang, limit, stopId, around } = req.query as {
      lang?: string; limit: number; stopId?: string; around?: string;
    };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    if ((stopId === undefined) !== (around === undefined)) {
      throw app.httpErrors.badRequest("stopId and around must be given together");
    }
    // 404 for an unknown route rather than an empty list: "this line does
    // not exist" and "this line is not running this week" are different
    // answers and the app renders them differently.
    if (getRoute(app.db.db, app.translator, routeId, parsed) === null) {
      throw app.httpErrors.notFound(`No route with id ${routeId}`);
    }
    // `app.calendar` is a getter over the live bundle (see server.ts), so a
    // feed swap is picked up per request rather than pinned at boot.
    if (stopId !== undefined && around !== undefined) {
      return {
        runs: runsAround(app.db.db, app.translator, app.calendar, {
          routeId, stopId, tripId: around, after: limit, lang: parsed, tz: config.timezone,
        }),
      };
    }
    const timetable = nextRuns(app.db.db, app.translator, app.calendar, {
      routeId, limit, lang: parsed, tz: config.timezone,
    });
    const ix = app.index.current();
    // Prepended and outside `limit`: a route only ever has a few live
    // unscheduled runs, and they must not push the timetable off the strip.
    const live = app.realtime === null || ix === null
      ? []
      : unscheduledRouteRuns(app.realtime, ix, app.db.db, app.translator, {
        routeId, lang: parsed, tz: config.timezone,
      });
    return { runs: [...live, ...timetable] };
  });

  app.get("/routes/:routeId/shape", {
    schema: {
      params: { type: "object", required: ["routeId"], properties: { routeId: { type: "string" } } },
      querystring: {
        type: "object",
        properties: { direction: { type: "integer", minimum: 0, maximum: 1, default: 0 } },
      },
    },
  }, async (req) => {
    const { routeId } = req.params as { routeId: string };
    const { direction } = req.query as { direction: number };
    const shape = getRouteShape(app.db.db, routeId, direction);
    if (shape === null) {
      throw app.httpErrors.notFound(`No route ${routeId} in direction ${direction}`);
    }
    return shape;
  });

  app.get("/lines/:lineCode", {
    schema: {
      params: {
        type: "object", required: ["lineCode"],
        properties: { lineCode: { type: "string", maxLength: 40 } },
      },
      querystring: { type: "object", properties: { lang: { type: "string" } } },
    },
  }, async (req) => {
    const { lineCode } = req.params as { lineCode: string };
    const { lang } = req.query as { lang?: string };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    const line = getLine(app.db.db, app.translator, lineCode, parsed);
    if (line === null) throw app.httpErrors.notFound(`No line with code ${lineCode}`);
    return line;
  });
};
