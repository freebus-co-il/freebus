import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from "fastify";
import { parseLang } from "../db/i18n.js";
import { serviceWindow, ymdOf } from "../transit/calendar.js";
import { buildDayContexts, runRaptor, type Label, type RaptorAccess } from "../transit/raptor.js";
import { buildItinerary } from "../transit/itinerary.js";
import { annotateAlternatives } from "../transit/alternatives.js";
import { shiftsFor } from "../transit/shift.js";
import type { TimetableIndex } from "../transit/index.js";
import { headwayTableFor, type TransferMargin } from "../transit/headway.js";
import type { LatLon } from "../geo.js";
import {
  walkConfig, config, rankConfig, alternativesConfig, routeRateLimits,
} from "../config.js";
import { ApiError } from "../errors.js";
import { rankItineraries } from "../transit/rank.js";
import { resolveLegGeometry } from "./legGeometry.js";
import { resolveWalkGeometry } from "./walkGeometry.js";
import { refineAccessByWalking } from "./accessRefine.js";
import {
  parsePlace, parseModes, accessStops, nearestStops, NEAREST_STOP_FALLBACK_COUNT,
  buildWalkLeg, type ParsedPlace,
} from "./plan/places.js";
import { annotateTransferRisk } from "./plan/transferRisk.js";
import { annotateRealtime } from "./plan/realtime.js";
import { searchBoth, type LiveShift, type SearchContext, type SharedQuery } from "./plan/search.js";
import { planSchema } from "./plan/schema.js";

interface PlanQuery {
  from: string; to: string; departAfter?: string; arriveBy?: string;
  maxWalkMeters?: number; maxTransfers: number; results: number;
  modes?: string; wheelchair: boolean; lang?: string;
}

/** One endpoint's candidate stops, and whether their walk times are real
 *  Valhalla durations rather than straight-line estimates. */
interface Endpoint {
  place: ParsedPlace;
  stops: RaptorAccess[];
  point: LatLon | null;
  refined: boolean;
  /** For log lines: "origin"/"access" or "destination"/"egress". */
  name: "origin" | "destination";
  walk: "access" | "egress";
}

function badRequest<T>(app: FastifyInstance, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw app.httpErrors.badRequest((err as Error).message);
  }
}

/** Replaces an endpoint's straight-line walk estimates with Valhalla walking
 *  times. Only a coordinate endpoint has a walk to route. */
async function refineEndpoint(
  app: FastifyInstance, log: FastifyBaseLogger, ix: TimetableIndex, end: Endpoint, maxWalk: number,
): Promise<void> {
  if (end.place.kind !== "coord" || end.point === null) return;
  const refined = await refineAccessByWalking(
    app.valhalla, end.point, end.stops, { ix, maxWalkMeters: maxWalk });
  end.stops = refined.stops;
  end.refined = refined.refined;
  // The only server-side sign that Valhalla is down: log it here, since
  // accessRefine.ts has no logger.
  if (!end.refined) {
    log.warn(
      { endpoint: end.name, candidates: end.stops.length },
      `${end.walk} walk refinement did not run; using straight-line estimates`,
    );
  }
}

/**
 * The nearest-stop fallback: a coordinate endpoint left with no stop within
 * `maxWalkMeters` gets the nearest few instead, with no walking cap. A 422
 * serves someone in a sparse area worst. Valhalla can still drop a candidate
 * that has no pedestrian path at all, and a Valhalla outage keeps the
 * straight-line estimates rather than emptying the set.
 */
async function nearestStopFallback(
  app: FastifyInstance, log: FastifyBaseLogger, ix: TimetableIndex, end: Endpoint,
): Promise<void> {
  if (end.place.kind !== "coord" || end.point === null || end.stops.length !== 0) return;
  const nearest = nearestStops(ix, end.point, NEAREST_STOP_FALLBACK_COUNT, walkConfig.speedMps);
  const refined = await refineAccessByWalking(
    app.valhalla, end.point, nearest, { ix, maxWalkMeters: Infinity });
  end.stops = refined.stops;
  end.refined = refined.refined;
  if (!end.refined) {
    log.warn(
      { endpoint: end.name, candidates: end.stops.length },
      `nearest-stop fallback engaged; ${end.walk} walk refinement did not run, using straight-line estimates`,
    );
  }
}

export const planRoutes: FastifyPluginAsync = async (app) => {
  app.get("/plan", {
    schema: planSchema,
    // Lower than the global limit: this is the expensive endpoint. See
    // `routeRateLimits.planPerMinute`.
    config: { rateLimit: { max: routeRateLimits.planPerMinute, timeWindow: "1 minute" } },
  }, async (req) => {
    const q = req.query as PlanQuery;

    const ix = app.index.current();
    if (ix === null) {
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }

    if (q.departAfter !== undefined && q.arriveBy !== undefined) {
      throw app.httpErrors.badRequest("Pass exactly one of departAfter or arriveBy");
    }

    const { lang, from, to } = badRequest(app, () => ({
      lang: parseLang(q.lang),
      from: parsePlace(q.from),
      to: parsePlace(q.to),
    }));

    const raw = q.arriveBy ?? q.departAfter;
    const at = raw === undefined ? new Date() : new Date(raw);
    if (Number.isNaN(at.getTime())) {
      throw app.httpErrors.badRequest(`Invalid time: ${raw}`);
    }

    // The feed holds about 30 days; say so rather than return an empty result
    // for a date outside it. Read per request so a feed swap needs no restart.
    const window = serviceWindow(app.calendar);
    const ymd = ymdOf(at, config.timezone);
    if (ymd < window.start || ymd > window.end) {
      throw new ApiError(
        422, "date_outside_service_window",
        `The loaded feed covers ${window.start} to ${window.end}; ${ymd} is outside it.`,
        { details: { serviceWindow: window } },
      );
    }

    const maxWalk = q.maxWalkMeters ?? walkConfig.maxMeters;
    const origin: Endpoint = {
      place: from, ...accessStops(ix, from, maxWalk, walkConfig.speedMps),
      refined: false, name: "origin", walk: "access",
    };
    const target: Endpoint = {
      place: to, ...accessStops(ix, to, maxWalk, walkConfig.speedMps),
      refined: false, name: "destination", walk: "egress",
    };

    // An unknown `stop:<id>` is a 404, before any fallback could misreport it
    // as "no stop within N m". `point` is null only in that case.
    if (from.kind === "stop" && origin.point === null) {
      throw app.httpErrors.notFound(`No stop with id ${from.stopId}`);
    }
    if (to.kind === "stop" && target.point === null) {
      throw app.httpErrors.notFound(`No stop with id ${to.stopId}`);
    }

    // Before refinement, so a malformed value costs no Valhalla call.
    const modes = q.modes === undefined ? null : badRequest(app, () => parseModes(q.modes!));

    // Order matters only for logs and Valhalla call order; kept as it was.
    await refineEndpoint(app, req.log, ix, origin, maxWalk);
    await refineEndpoint(app, req.log, ix, target, maxWalk);
    await nearestStopFallback(app, req.log, ix, origin);
    await nearestStopFallback(app, req.log, ix, target);

    // Only reachable when even the fallback found nothing: an empty index, or
    // no pedestrian path to any of the nearest stops (offshore, fenced off).
    if (origin.stops.length === 0) {
      throw new ApiError(
        422, "no_stops_near_origin",
        `No stop within ${maxWalk} m walking distance of the origin.`,
      );
    }
    if (target.stops.length === 0) {
      throw new ApiError(
        422, "no_stops_near_destination",
        `No stop within ${maxWalk} m walking distance of the destination.`,
      );
    }

    const tripFilter = (modes === null && !q.wheelchair)
      ? undefined
      : (t: number): boolean => {
          if (q.wheelchair && ix.tripWheelchair[t] !== 1) return false;
          if (modes !== null) {
            const type = app.routeTypeByIdx[ix.tripRouteIdx[t]!];
            if (type === undefined || !modes.has(type)) return false;
          }
          return true;
        };

    const days = buildDayContexts(ix, app.calendar, at, config.timezone);
    const maxRounds = q.maxTransfers + 1;

    // The headway-scaled transfer margin, built once per request. Headway
    // tables are memoised per service day and kept parallel to `days`.
    // `baseSeconds` must equal `transferMinSeconds` (both passes check), and
    // `factor === 0` is the tested off switch.
    const transfer: TransferMargin = {
      cfg: {
        baseSeconds: walkConfig.transferMinSeconds,
        factor: walkConfig.headwayFactor,
        capSeconds: walkConfig.transferMaxSeconds,
      },
      headway: days.map((day) => headwayTableFor(ix, day)),
    };

    // The live timetable for these days, or undefined when realtime is off,
    // stale or has nothing late. Shared across requests per snapshot.
    const shift = shiftsFor(ix, app.realtime, days);

    const baseQuery: SharedQuery = {
      origins: origin.stops, destinations: target.stops,
      days, transferMinSeconds: walkConfig.transferMinSeconds, tripFilter, transfer,
      shift,
    };

    const routeOf = (routeIdx: number): {
      id: string; agencyId: string | null; shortName: string | null;
      longName: string | null; type: number; color: string | null;
    } => app.routeBriefByIdx[routeIdx] ?? {
      id: "", agencyId: null, shortName: null, longName: null, type: 3, color: null,
    };

    const secondsTo = (end: Endpoint, stopIdx: number): number =>
      end.stops.find((s) => s.stopIdx === stopIdx)?.secondsToReach ?? 0;

    const ctx: SearchContext = {
      ix,
      tz: config.timezone,
      arriveBy: q.arriveBy !== undefined,
      atEpoch: Math.floor(at.getTime() / 1000),
      results: q.results,
      maxRounds,
      baseQuery,
      transfer,
      build: (
        chain: { stopIdx: number; label: Label }[], live: LiveShift,
        accessStopIdx = chain[0]!.stopIdx,
      ) => {
        const egressStopIdx = chain[chain.length - 1]!.stopIdx;
        return buildItinerary(ix, chain, {
          tr: app.translator, lang, tz: config.timezone, days, routeOf,
          transferMinSeconds: walkConfig.transferMinSeconds, shift: live,
          accessLeg: buildWalkLeg(
            ix, app.translator, lang, origin.point, accessStopIdx,
            secondsTo(origin, accessStopIdx), true, origin.refined),
          egressLeg: buildWalkLeg(
            ix, app.translator, lang, target.point, egressStopIdx,
            secondsTo(target, egressStopIdx), false, target.refined),
        });
      },
    };

    let { itineraries, reverseSourced, probeSourced } = searchBoth(ctx, shift);

    // The realtime yield: live delays may not delete a rider's only journey.
    // When the shifted timetable leaves nothing at all, plan on the schedule
    // and let `annotateRealtime` flag the connection the predictions refused.
    if (itineraries.length === 0 && shift !== undefined) {
      ({ itineraries, reverseSourced, probeSourced } = searchBoth(ctx, undefined));
    }

    // The ONE sort: by rider effort (see rank.ts), over every candidate from
    // every search, then cut to `results` before any geometry is resolved.
    // `reverseSourced` travels with each itinerary through the reorder.
    //
    // Who skips the departure window: everyone on `arriveBy`, where a later
    // departure for a pinned arrival is simply better; only probe candidates
    // on `departAfter`, whose arrival is already bounded. See
    // `rankItineraries`' `exempt`.
    const ranked = rankItineraries(
      itineraries.map((itinerary, i) => ({
        itinerary, reverse: reverseSourced[i]!, probe: probeSourced[i]!,
      })),
      (candidate) => candidate.itinerary,
      rankConfig,
      {
        exempt: q.arriveBy !== undefined
          ? () => true
          : (candidate: { probe: boolean }) => candidate.probe,
        // With the arrival pinned, a later departure is less waiting.
        priceOriginWait: q.arriveBy === undefined,
      },
    ).slice(0, q.results);
    itineraries = ranked.map((candidate) => candidate.itinerary);
    reverseSourced = ranked.map((candidate) => candidate.reverse);

    // Later buses each ride could still be taken on, on the final itineraries
    // and before geometry and realtime (which fill alternatives in too). When
    // following the itinerary's own stops runs dry, re-plan from the stop the
    // later bus reaches, at the flat buffer.
    const replanArrival = (stopIdx: number, readyEpoch: number): number | null => {
      const res = runRaptor(ix, {
        ...baseQuery,
        transfer: { cfg: { ...transfer.cfg, factor: 0 }, headway: transfer.headway },
        origins: [{ stopIdx, secondsToReach: 0 }],
        departAfterEpoch: readyEpoch,
        maxRounds,
      });
      let best: number | null = null;
      for (const round of res.rounds) {
        for (const destination of target.stops) {
          const label = round[destination.stopIdx];
          if (label === null || label === undefined) continue;
          const door = label.arrivalEpoch + destination.secondsToReach;
          if (best === null || door < best) best = door;
        }
      }
      return best;
    };
    annotateAlternatives(ix, days, itineraries, {
      tr: app.translator, lang, tz: config.timezone, routeOf,
      transferMinSeconds: walkConfig.transferMinSeconds,
      ...alternativesConfig,
      tripFilter,
      replanArrival,
    });

    // Geometry only after reoptimisation, which can swap an itinerary's legs.
    resolveLegGeometry(app.db.db, itineraries);
    await resolveWalkGeometry(app.valhalla, itineraries);
    if (app.realtime !== null) {
      annotateRealtime(app.realtime, ix, config.timezone, days, transfer, reverseSourced, itineraries);
    }
    // Always, and after realtime, so it only ever raises the flag.
    annotateTransferRisk(ix, days, transfer, reverseSourced, itineraries);

    return {
      query: {
        from: q.from, to: q.to,
        departAfter: q.departAfter ?? null,
        arriveBy: q.arriveBy ?? null,
        accessStops: origin.stops.length,
        egressStops: target.stops.length,
      },
      itineraries,
    };
  });
};
