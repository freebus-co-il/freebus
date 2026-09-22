import type { FastifyPluginAsync } from "fastify";
import { parseLang, type Lang, type Translator } from "../db/i18n.js";
import { config, walkConfig, routeRateLimits } from "../config.js";
import { buildDayContexts, type DayContext } from "../transit/raptor.js";
import { headwayTableFor, type TransferMargin } from "../transit/headway.js";
import type { TimetableIndex } from "../transit/index.js";
import type { TransitLeg } from "../transit/itinerary.js";
import { toIso } from "../transit/calendar.js";
import { ApiError } from "../errors.js";
import type { RealtimeStore } from "../realtime/store.js";
import { requiredMarginFor, type MarginBoardingLeg } from "./plan.js";

/**
 * The most legs a rider's remaining chain may name in one request -- the
 * brief's own bound. A generous multiple of what a real Israeli intercity
 * journey ever has (`/plan` itself caps `maxTransfers` at 6, i.e. 7 legs),
 * kept as a named constant so the 400 message and the schema-independent
 * runtime check (Fastify's querystring coercion has no length-of-array
 * keyword that fires before the handler runs for a repeated, unkeyed param
 * like `leg`) cannot drift apart.
 */
const MAX_LEGS = 12;

interface ParsedLeg {
  tripId: string;
  fromStopId: string;
  toStopId: string;
}

/**
 * `leg=<tripId>,<fromStopId>,<toStopId>`, repeated, in journey order. Only
 * ever throws `Error` (never an HTTP type) -- caught at the call site and
 * turned into a 400, the same layering `plan.ts`'s `parsePlace`/`parseModes`
 * use so parsing stays framework-agnostic and testable on its own. Not
 * exported: no caller outside this file needs it, and an unused export is
 * its own kind of drift risk.
 *
 * Each part is trimmed before the emptiness check, so `leg=T1, 1000,2000`
 * (a stray space after a comma, plausible from a hand-built URL or a client
 * that pretty-prints its query) resolves the intended stop id rather than
 * 404ing on `" 1000"` -- a literal, un-trimmed id is not a real GTFS id
 * this feed would ever issue, so there is nothing legitimate trimming could
 * silently break.
 */
function parseLeg(raw: string, index: number): ParsedLeg {
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === "")) {
    throw new Error(
      `leg ${index}: expected exactly three comma-separated ids ` +
      `(tripId,fromStopId,toStopId), got "${raw}"`,
    );
  }
  const [tripId, fromStopId, toStopId] = parts as [string, string, string];
  return { tripId, fromStopId, toStopId };
}

/** Fastify/Node's querystring parsing gives a bare string for exactly one
 *  occurrence of a repeated param, and an array for two or more -- see
 *  `node:querystring`'s own documented behaviour, which Fastify's default
 *  parser inherits. Normalised here once so every caller sees an array. */
function legParamsOf(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Where `tripIdx` boards `fromIdx` and alights `toIdx` on its own pattern,
 * or which of the two ways this is malformed. A trip's boarding/alighting
 * positions are read off its PATTERN's stop sequence (`patternOfTrip` +
 * `patternStops`) -- every trip sharing a pattern shares that sequence by
 * construction (`patterns.ts`), and the trip's own per-position times live
 * in the parallel `arrivalTime`/`departureTime` arrays at `tripTimeOffset[
 * tripIdx] + pos`.
 *
 * A loop pattern can visit one physical stop more than once; the FIRST
 * occurrence of `fromIdx` is taken as boarding (mirroring a rider reading a
 * trip's stop list top to bottom and boarding at the first chance), and the
 * NEAREST occurrence of `toIdx` strictly after it as alighting. If `toIdx`
 * never appears after that boarding position but does appear before it,
 * that is the "alighting precedes boarding" case (400, a malformed chain,
 * not a missed connection) -- distinguished from "this trip never visits
 * `toIdx` at all" so the two 400 messages can each name the real problem.
 */
type BoardAlight =
  | { ok: true; boardPos: number; alightPos: number }
  | { ok: false; reason: "not_served"; stopId: "from" | "to" }
  | { ok: false; reason: "wrong_order" };

function findBoardAlight(ix: TimetableIndex, tripIdx: number, fromIdx: number, toIdx: number): BoardAlight {
  // `tripIdx` always came from `ix.tripIdToIdx`, which `buildIndex` sizes
  // `patternOfTrip` to cover for every valid trip index; `patternOfTrip`
  // always resolves to one of `[0, nPatterns)`, and `patternStopOffset` is
  // sized `nPatterns + 1`, so both offset reads below are in bounds too.
  const p = ix.patternOfTrip[tripIdx]!;
  const stopFrom = ix.patternStopOffset[p]!;
  const stopTo = ix.patternStopOffset[p + 1]!;

  let boardPos = -1;
  for (let j = stopFrom; j < stopTo; j++) {
    if (ix.patternStops[j] === fromIdx) { boardPos = j - stopFrom; break; }
  }
  if (boardPos === -1) return { ok: false, reason: "not_served", stopId: "from" };

  for (let j = stopFrom + boardPos + 1; j < stopTo; j++) {
    if (ix.patternStops[j] === toIdx) return { ok: true, boardPos, alightPos: j - stopFrom };
  }
  // Not found after boardPos -- check whether it exists BEFORE it, which is
  // the "wrong order" malformed chain rather than "not served at all".
  for (let j = stopFrom; j < stopFrom + boardPos; j++) {
    if (ix.patternStops[j] === toIdx) return { ok: false, reason: "wrong_order" };
  }
  return { ok: false, reason: "not_served", stopId: "to" };
}

/**
 * One remaining leg, fully resolved against the schedule: which service day
 * it runs on, its scheduled and (when realtime is configured) predicted
 * times, and enough of its own identity (`tripId`, `from.stopSequence`,
 * `from.departureTime`) to feed `requiredMarginFor` -- see `MarginBoardingLeg`.
 */
interface ResolvedLeg {
  tripIdx: number;
  tripId: string;
  boardPos: number;
  alightPos: number;
  fromIdx: number;
  toIdx: number;
  scheduledDepartureEpoch: number;
  scheduledArrivalEpoch: number;
  /** Predicted arrival at the ALIGHT stop, epoch seconds, or null when
   *  unknown (realtime disabled, trip unresolved, or an ambiguous loop
   *  visit) -- see this file's own realtime derivation, below. */
  predictedArrivalEpoch: number | null;
  response: {
    tripId: string;
    route: TransitLeg["route"];
    /** See `TransitLeg.headsign`. */
    headsign: string | null;
    /** See `TransitLeg.tripNumber`. */
    tripNumber: string | null;
    from: {
      stopId: string; name: string | null;
      scheduledDeparture: string; departure: string; delaySeconds: number;
      /** True only when this time came from the realtime store; `delaySeconds: 0` with `predicted: false` means no live data, not on time. */
      predicted: boolean;
    };
    to: {
      stopId: string; name: string | null;
      scheduledArrival: string; arrival: string; delaySeconds: number;
      /** True only when this time came from the realtime store; `delaySeconds: 0` with `predicted: false` means no live data, not on time. */
      predicted: boolean;
    };
    durationSeconds: number;
    numStops: number;
  };
}

/**
 * How far in the PAST a candidate boarding instant may sit, relative to
 * `at`, before `dayFor` (below) refuses to use it -- see that function's
 * own comment for what this guards against. A rider mid-journey can
 * legitimately be checking a leg they boarded up to a few hours ago (the
 * whole reason `journey/check` exists is to answer for a leg already
 * underway), so this cannot be zero or near-zero; 6 h comfortably covers
 * any plausible remaining-leg check while still catching a genuinely stale
 * day -- verified against the reproduced cross-boundary regression (a leg
 * boarding 23:30, checked at 00:00:01 the same night, 31 minutes later) and
 * every one of this file's other day-selection tests.
 */
export const MAX_BOARD_LOOKBACK_SECONDS = 6 * 3600;

/**
 * The service day to render `tripIdx`'s own raw GTFS times against, given
 * this leg's boarding offset (`boardOffsetSeconds`, the trip's raw GTFS
 * departure seconds at its board position) and the query instant `atEpoch`
 * -- or `null` when no day in `days` gives an honest answer at all.
 *
 * `days` is `buildDayContexts`' (current day, previous day) pair, current
 * first (`calendar.ts`'s `serviceInstants`), always exactly 86400 s apart.
 * A trip active on BOTH is possible and genuinely ambiguous -- e.g. a
 * Sun-Thu service checked on a Monday, where "yesterday" (Sunday) is just
 * as active as "today" -- so list order alone cannot pick the right one:
 * picking the first match by list order can be a full 24 h wrong.
 *
 * The fix is to pick whichever day's resulting boarding instant is NEAREST
 * `atEpoch` -- not first-in-list -- so a leg checked from just before or
 * after midnight resolves to the instant that query actually implies. A
 * candidate more than `MAX_BOARD_LOOKBACK_SECONDS` in the PAST is rejected
 * outright rather than merely disfavoured: with only two candidates 86400 s
 * apart, "nearest" alone already resolves every ordinary case correctly
 * (the far candidate is always >= 23 h away whenever the near one is
 * within a few hours), so this bound exists only to refuse a stale,
 * inapplicable trip -- see the lookback constant's own comment for the
 * exact regression it must not reopen.
 *
 * CAUTION: rejecting a candidate for landing before `at`'s own CALENDAR DAY
 * (midnight) instead of before `at` ITSELF discards the one case this
 * nearest-instant rule exists for -- a leg boarded 23:30, queried at
 * 00:00:01 the same night (31 min later, on the very trip the rider is
 * sitting on), would be thrown out for landing "yesterday" by calendar
 * date, leaving only tonight's 23:30 (a silent +24 h) as the only
 * survivor. Measuring the bound from `at` itself, not from midnight, is
 * what keeps that leg eligible.
 *
 * No FUTURE-side bound is needed: `today`'s own candidate never needs one
 * (an offset >= 86400 overflowing into tomorrow is exactly what GTFS
 * overflow times mean, not staleness), and `yesterday`'s candidate is
 * always CLOSER to `at` than `today`'s whenever it is the more plausible
 * pick in the first place (both being 86400 s apart), so nothing here can
 * ever prefer a candidate that is implausibly far in the future.
 *
 * `null` -- no candidate survives the lookback bound, or the trip is
 * inactive on both days to begin with -- is a real, distinct outcome the
 * caller must surface (a stale client, or a date genuinely outside the
 * loaded feed): unlike `requiredMarginFor`'s own lookup-miss fallback,
 * which degrades an ANNOTATION on an otherwise-valid response, a wrong day
 * here corrupts the PRIMARY payload -- every downstream time, delay and
 * slack computed from it -- and the rider cannot tell a plausible-looking
 * wrong answer from a right one.
 *
 * Exported for `routes/planOnboard.ts`, which asks the identical question
 * about the identical kind of input (a client-supplied trip id plus a stop on
 * it, resolved against a query instant) and must not answer it a second,
 * subtly different way. A rider aboard after midnight is not an edge case
 * there -- it is an ORDINARY case, since the endpoint exists to be called
 * from inside a vehicle that may well be running past 24:00 -- so a second
 * implementation would be a defect waiting for the exact night this one
 * already survived twice.
 */
export function dayFor(
  days: readonly DayContext[], tripIdx: number, boardOffsetSeconds: number, atEpoch: number,
): DayContext | null {
  let best: DayContext | null = null;
  let bestDiff = Infinity;
  for (const d of days) {
    if (d.activeTrip[tripIdx] !== 1) continue;
    const boardEpoch = d.baseEpoch + boardOffsetSeconds;
    if (boardEpoch < atEpoch - MAX_BOARD_LOOKBACK_SECONDS) continue; // stale, see comment above
    const diff = Math.abs(boardEpoch - atEpoch);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return best;
}

/**
 * One transit leg's realtime annotation, scoped to exactly what this
 * endpoint's response needs: the predicted arrival at BOTH ends of the leg
 * (board and alight), each expressed as a delay against that stop's own
 * scheduled time. Deliberately not imported from `routes/plan.ts`'s
 * `realtimeForLeg` -- that function derives its epochs by round-tripping
 * through a leg's already-built ISO strings (the only thing available to a
 * caller working from a RAPTOR-reconstructed `Itinerary`), where this
 * caller already has the exact scheduled epochs and the exact pattern
 * position in hand, making that round trip pure overhead. Mirrors its
 * DERIVATION exactly, the same "re-derive locally, document the mirror"
 * choice `routes/departures.ts`'s own `realtimeForDeparture` already makes
 * for the identical reason: SIRI gives one prediction per stop call, always
 * an ARRIVAL (`RealtimeCall.expectedArrival`), so a board-side "departure
 * delay" is always DERIVED -- the delay between predicted and scheduled
 * ARRIVAL at the board stop, applied on top of the scheduled departure --
 * never read directly.
 *
 * `unambiguousPredictionFor`, not `predictionFor`: this leg boards/alights
 * at one specific pattern position, and a stop visited more than once by
 * this trip's own pattern (a loop) cannot be trusted to belong to that
 * exact visit -- see `RealtimeStore.unambiguousPredictionFor`'s own doc
 * comment. Never throws: a lookup miss degrades to null predictions, never
 * a fault -- this may enrich a response, never fail one.
 */
function legRealtime(
  realtime: RealtimeStore, tripIdx: number, fromIdx: number, toIdx: number,
  scheduledDepartureEpoch: number, scheduledArrivalAtBoardEpoch: number, scheduledArrivalEpoch: number,
): { predictedDepartureEpoch: number | null; boardDelaySeconds: number | null;
     predictedArrivalEpoch: number | null; alightDelaySeconds: number | null } {
  if (realtime.journeyFor(tripIdx) === null) {
    return {
      predictedDepartureEpoch: null, boardDelaySeconds: null,
      predictedArrivalEpoch: null, alightDelaySeconds: null,
    };
  }

  const predictedArrivalAtBoardEpoch = realtime.unambiguousPredictionFor(tripIdx, fromIdx);
  const boardDelaySeconds = predictedArrivalAtBoardEpoch === null
    ? null : predictedArrivalAtBoardEpoch - scheduledArrivalAtBoardEpoch;
  const predictedDepartureEpoch = boardDelaySeconds === null
    ? null : scheduledDepartureEpoch + boardDelaySeconds;

  const predictedArrivalEpoch = realtime.unambiguousPredictionFor(tripIdx, toIdx);
  const alightDelaySeconds = predictedArrivalEpoch === null
    ? null : predictedArrivalEpoch - scheduledArrivalEpoch;

  return { predictedDepartureEpoch, boardDelaySeconds, predictedArrivalEpoch, alightDelaySeconds };
}

export const journeyCheckRoutes: FastifyPluginAsync = async (app) => {
  app.get("/journey/check", {
    schema: {
      description:
        "Answers two questions about the REMAINING steps of a journey the " +
        "frontend already holds: what time does each leg run now, and does " +
        "each connection still hold. Never re-plans -- a broken connection " +
        "is reported, not routed around. `leg` is repeated, in journey " +
        "order, one `tripId,fromStopId,toStopId` triple per remaining leg " +
        "(at least one, at most 12). `at` picks the service day (defaults " +
        "to now) so a chain running past midnight (GTFS times legitimately " +
        "exceed 86400 here) resolves against the right day rather than " +
        "being wrapped. `requiredSeconds` on a connection is the SAME " +
        "headway-scaled boarding margin `/plan` itself requires before it " +
        "will build that connection -- it covers the boarding margin only, " +
        "never the walk between two legs (the frontend already knows its " +
        "own itinerary's walk). `holds` is three-valued: `true` the " +
        "connection is fine, `false` it is broken, `null` when this cannot " +
        "be said (no realtime, or a delay we were never told about) -- " +
        "`null` must never be read as `false`. `slackSeconds` is computed " +
        "from the SAME arrival instant `holds` was decided against, so " +
        "`slackSeconds >= requiredSeconds` always agrees with `holds` -- " +
        "except that when the SCHEDULE alone already breaks a connection " +
        "(`holds: false` independent of any prediction), `slackSeconds` " +
        "reports the scheduled shortfall, not a worse one a late " +
        "prediction might separately indicate; it is always the RIGHT " +
        "sign, never the wrong one, just not necessarily the rider's own " +
        "worst-case number in that one situation. Each leg end's `predicted` " +
        "is true only when its time came from the realtime store -- a " +
        "`delaySeconds` of 0 with `predicted: false` means no live data, not on time. ",
      querystring: {
        type: "object",
        properties: {
          leg: {},
          at: { type: "string" },
          lang: { type: "string" },
        },
      },
    },
    // Per-route ceiling on top of the global 300/min limit -- this route is
    // POLLED (the app re-checks an active journey every 30 s, see
    // `JOURNEY_CHECK_POLL_MS` in `app/src/features/journey/use-journey-live.
    // ts`) and serves a rider MID-JOURNEY, so its ceiling is generous; see
    // `routeRateLimits.journeyCheckPerMinute` in `../config.js` for why 120
    // specifically. `@fastify/rate-limit` reads per-route settings from
    // `config.rateLimit` because the plugin is registered globally in
    // `server.ts`.
    config: { rateLimit: { max: routeRateLimits.journeyCheckPerMinute, timeWindow: "1 minute" } },
  }, async (req) => {
    const ix = app.index.current();
    if (ix === null) {
      // Same deliberate, retryable 503 as `/plan` and `/segments`: this
      // route is a lookup over the in-memory RAPTOR index and has nothing
      // to answer with until the first build completes.
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }

    const q = req.query as { leg?: string | string[]; at?: string; lang?: string };

    let lang: Lang;
    try { lang = parseLang(q.lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }

    const legParams = legParamsOf(q.leg);
    if (legParams.length === 0) {
      throw app.httpErrors.badRequest("At least one leg is required");
    }
    if (legParams.length > MAX_LEGS) {
      throw app.httpErrors.badRequest(`At most ${MAX_LEGS} legs are allowed, got ${legParams.length}`);
    }

    let parsedLegs: ParsedLeg[];
    try {
      parsedLegs = legParams.map((raw, i) => parseLeg(raw, i));
    } catch (err) {
      throw app.httpErrors.badRequest((err as Error).message);
    }

    const at = q.at === undefined ? new Date() : new Date(q.at);
    if (Number.isNaN(at.getTime())) {
      throw app.httpErrors.badRequest(`Invalid at: ${q.at}`);
    }
    const atEpoch = Math.floor(at.getTime() / 1000);

    const tz = config.timezone;
    const tr: Translator = app.translator;
    const days = buildDayContexts(ix, app.calendar, at, tz);

    const routeOf = (routeIdx: number): TransitLeg["route"] =>
      app.routeBriefByIdx[routeIdx]
      ?? { id: "", agencyId: null, shortName: null, longName: null, type: 3, color: null };

    const resolvedLegs: ResolvedLeg[] = parsedLegs.map((leg, i) => {
      const tripIdx = ix.tripIdToIdx.get(leg.tripId);
      if (tripIdx === undefined) throw app.httpErrors.notFound(`No trip with id ${leg.tripId}`);
      const fromIdx = ix.stopIdToIdx.get(leg.fromStopId);
      if (fromIdx === undefined) throw app.httpErrors.notFound(`No stop with id ${leg.fromStopId}`);
      const toIdx = ix.stopIdToIdx.get(leg.toStopId);
      if (toIdx === undefined) throw app.httpErrors.notFound(`No stop with id ${leg.toStopId}`);

      const ba = findBoardAlight(ix, tripIdx, fromIdx, toIdx);
      if (!ba.ok) {
        if (ba.reason === "wrong_order") {
          throw app.httpErrors.badRequest(
            `leg ${i}: on trip ${leg.tripId}, stop ${leg.toStopId} does not come after stop ${leg.fromStopId}`,
          );
        }
        const badStopId = ba.stopId === "from" ? leg.fromStopId : leg.toStopId;
        throw app.httpErrors.badRequest(`leg ${i}: trip ${leg.tripId} does not serve stop ${badStopId}`);
      }

      // `tripIdx` came from `ix.tripIdToIdx`, which `buildIndex` sizes
      // `tripTimeOffset` (length nTrips + 1) to cover for every valid trip.
      // `boardPos`/`alightPos` are positions within tripIdx's own PATTERN
      // (`findBoardAlight` scans `ix.patternStops` between that pattern's own
      // offsets), and every trip sharing a pattern shares its exact stop
      // sequence -- same length, same positions (`patterns.ts`'s
      // `buildPatterns` groups trips by identical `stops` arrays) -- so
      // `timeFrom + boardPos`/`timeFrom + alightPos` index a real row of
      // THIS trip's own `arrivalTime`/`departureTime` slice, not just of the
      // pattern's first trip.
      const timeFrom = ix.tripTimeOffset[tripIdx]!;
      const boardOffsetSeconds = ix.departureTime[timeFrom + ba.boardPos]!;

      const day = dayFor(days, tripIdx, boardOffsetSeconds, atEpoch);
      if (day === null) {
        throw new ApiError(
          422, "trip_not_active",
          `leg ${i}: trip ${leg.tripId} has no active, current service day near ${toIso(atEpoch, tz)}`,
          { details: { legIndex: i, tripId: leg.tripId } },
        );
      }

      const scheduledDepartureEpoch = day.baseEpoch + boardOffsetSeconds;
      const scheduledArrivalAtBoardEpoch = day.baseEpoch + ix.arrivalTime[timeFrom + ba.boardPos]!;
      const scheduledArrivalEpoch = day.baseEpoch + ix.arrivalTime[timeFrom + ba.alightPos]!;

      let predictedDepartureEpoch: number | null = null;
      let boardDelaySeconds: number | null = null;
      let predictedArrivalEpoch: number | null = null;
      let alightDelaySeconds: number | null = null;
      if (app.realtime !== null) {
        ({ predictedDepartureEpoch, boardDelaySeconds, predictedArrivalEpoch, alightDelaySeconds } =
          legRealtime(
            app.realtime, tripIdx, fromIdx, toIdx,
            scheduledDepartureEpoch, scheduledArrivalAtBoardEpoch, scheduledArrivalEpoch,
          ));
      }

      const scheduledDepartureIso = toIso(scheduledDepartureEpoch, tz);
      const scheduledArrivalIso = toIso(scheduledArrivalEpoch, tz);

      return {
        tripIdx, tripId: leg.tripId, boardPos: ba.boardPos, alightPos: ba.alightPos,
        fromIdx, toIdx, scheduledDepartureEpoch, scheduledArrivalEpoch, predictedArrivalEpoch,
        response: {
          tripId: leg.tripId,
          // `tripIdx` is a valid trip index (resolved via `ix.tripIdToIdx`
          // above), and `tripRouteIdx` is sized `nTrips` by `buildIndex`, so
          // this read is always in bounds -- `routeOf` itself then handles a
          // trip with no route (`-1`) via its own `?? default` fallback.
          route: routeOf(ix.tripRouteIdx[tripIdx]!),
          headsign: tr.resolve(ix.tripHeadsigns[tripIdx] ?? null, lang),
          tripNumber: ix.tripNumbers[tripIdx] ?? null,
          // `fromIdx`/`toIdx` were both checked against `ix.stopIdToIdx`
          // above (undefined already 404ed), so both index real, in-bounds
          // entries of every `ix.stop*` array, sized `nStops`.
          from: {
            stopId: ix.stopIds[fromIdx]!,
            name: tr.resolve(ix.stopNames[fromIdx] ?? null, lang),
            scheduledDeparture: scheduledDepartureIso,
            departure: predictedDepartureEpoch === null
              ? scheduledDepartureIso : toIso(predictedDepartureEpoch, tz),
            delaySeconds: boardDelaySeconds ?? 0,
            predicted: predictedDepartureEpoch !== null,
          },
          to: {
            stopId: ix.stopIds[toIdx]!,
            name: tr.resolve(ix.stopNames[toIdx] ?? null, lang),
            scheduledArrival: scheduledArrivalIso,
            arrival: predictedArrivalEpoch === null
              ? scheduledArrivalIso : toIso(predictedArrivalEpoch, tz),
            delaySeconds: alightDelaySeconds ?? 0,
            predicted: predictedArrivalEpoch !== null,
          },
          durationSeconds: scheduledArrivalEpoch - scheduledDepartureEpoch,
          numStops: ba.alightPos - ba.boardPos,
        },
      };
    });

    // A single-leg chain has no connection to price at all, and building
    // the headway machinery costs real time on this box (~45 ms measured
    // against the real feed: two `headwayTableFor` builds, one per service
    // day) -- so it is built lazily, only once a second leg makes it
    // relevant. `TransferMargin | null` rather than an empty-headway stub:
    // a stub the connections loop never runs against is one less thing to
    // reason about being well-formed.
    let transfer: TransferMargin | null = null;

    // `requiredSeconds` is computed with `reverseSourced: true` for EVERY
    // connection -- i.e. always the reverse pass's maximum-over-window rule
    // (`extraAlightingSeconds`), never the forward pass's pointwise one.
    // This endpoint has no way to know which of the two RAPTOR passes
    // originally built the itinerary this chain came from (it is stateless
    // and re-derives everything from the rider-supplied trip/stop ids
    // alone), and `requiredMarginFor`'s own doc comment establishes that
    // the reverse rule is never smaller than the forward one at the exact
    // resulting instant (the forward pointwise value is literally one of
    // the terms `extraAlightingSeconds` maximises over). Charging the
    // larger of the two whenever the true provenance is unknown is the only
    // choice that can never make a connection look SAFER than either
    // planning path would have -- the brief's own stated priority ("never
    // report holds: true where the planner would refuse it") is strictly
    // more dangerous than the reverse of it, so this endpoint always takes
    // the side that can only be too cautious, never too permissive. Measured
    // against the real feed (529,866 (pattern, position, trip) samples): the
    // two rules agree 96.82% of the time, and where they differ the mean
    // margin rises by only 4.3 s -- in the 3.18% it can differ, this choice
    // can only cost a false alarm, never a false reassurance.
    const connections = resolvedLegs.slice(0, -1).map((leg, i) => {
      // `i` ranges over the SLICED array's own indices (one shorter than
      // `resolvedLegs`), so `i + 1` is always a valid index into the
      // original `resolvedLegs` -- the connection AFTER leg `i` is always
      // between it and the very next leg.
      const next = resolvedLegs[i + 1]!;
      if (transfer === null) {
        transfer = {
          cfg: {
            baseSeconds: walkConfig.transferMinSeconds,
            factor: walkConfig.headwayFactor,
            capSeconds: walkConfig.transferMaxSeconds,
          },
          headway: days.map((day) => headwayTableFor(ix, day)),
        };
      }
      const marginNext: MarginBoardingLeg = {
        tripId: next.tripId,
        from: { stopSequence: next.boardPos, departureTime: toIso(next.scheduledDepartureEpoch, tz) },
      };
      // `leg.scheduledArrivalEpoch`/`0` (the 5th/6th arguments,
      // `prevArrivalEpoch`/`walkSeconds`) are DEAD on the
      // `reverseSourced: true` path this call always takes --
      // `requiredMarginFor`'s own branch for it never reads either,
      // computing the window entirely from `next`'s own scheduled departure
      // instead (see its doc comment). Passed through anyway, rather than a
      // placeholder like `0`, only because a placeholder here is its own
      // hazard: `requiredMarginFor`'s FORWARD branch (reachable only if
      // `reverseSourced` were ever flipped) divides by these to find a
      // headway bucket, and a wrong-but-plausible-looking `0` could
      // silently degrade that branch to `NO_HEADWAY`'s cap instead of
      // failing loudly or visibly. `requiredSeconds` itself never varies
      // with either value on the path actually taken here.
      const required = requiredMarginFor(
        ix, days, transfer, true, leg.scheduledArrivalEpoch, 0, marginNext,
      );

      // The schedule alone can already fall short of the required margin
      // (the last-service-of-day fallback, mirrored here exactly
      // as `/plan`'s own `scheduledTransferAtRisk`/`marginShortfall` check
      // it): when it does, no prediction can rescue the connection, and a
      // vehicle running early is not something this planner ever promises.
      const scheduledShort = leg.scheduledArrivalEpoch + required > next.scheduledDepartureEpoch;

      // `verdictArrivalEpoch` is whichever arrival instant `holds` was
      // actually decided against -- the schedule when `scheduledShort`
      // already settles it (or when there is no prediction to compare
      // against), the prediction otherwise. `slackSeconds`, below, is
      // computed from this SAME instant, never a different one: a client
      // computing `slackSeconds >= requiredSeconds` on its own must reach
      // the same true/false the server's own `holds` reports. An earlier
      // version of this computed `slackSeconds` from whichever epoch was
      // "most real" (predicted when known, else scheduled) independently of
      // which instant `holds` used -- the two could then disagree exactly
      // when `scheduledShort` was true on a genuinely EARLY prediction: the
      // schedule alone already breaks the connection (`holds: false`), but
      // a vehicle running ahead of schedule reports extra, not less, slack
      // against the (unused-for-the-verdict) predicted arrival -- a client
      // reading slack alone would see the connection as comfortably fine.
      let holds: boolean | null;
      let verdictArrivalEpoch: number;
      if (scheduledShort) {
        holds = false;
        verdictArrivalEpoch = leg.scheduledArrivalEpoch;
      } else if (leg.predictedArrivalEpoch === null) {
        holds = null;
        verdictArrivalEpoch = leg.scheduledArrivalEpoch;
      } else {
        verdictArrivalEpoch = leg.predictedArrivalEpoch;
        holds = verdictArrivalEpoch + required > next.scheduledDepartureEpoch ? false : true;
      }

      return {
        afterLeg: i,
        slackSeconds: next.scheduledDepartureEpoch - verdictArrivalEpoch,
        requiredSeconds: required,
        holds,
      };
    });

    let holds: boolean | null = true;
    if (connections.some((c) => c.holds === false)) holds = false;
    else if (connections.some((c) => c.holds === null)) holds = null;

    // The last leg's own `to.arrival` -- predicted when known, scheduled
    // otherwise -- exactly like every other leg's own arrival field.
    // `resolvedLegs.length === parsedLegs.length`, already checked >= 1
    // above ("At least one leg is required"), so this is never empty.
    const lastLeg = resolvedLegs[resolvedLegs.length - 1]!;

    return {
      at: toIso(atEpoch, tz),
      legs: resolvedLegs.map((l) => l.response),
      connections,
      arrivalTime: lastLeg.response.to.arrival,
      holds,
    };
  });
};
