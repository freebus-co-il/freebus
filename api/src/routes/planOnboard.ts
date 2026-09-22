import type { FastifyPluginAsync } from "fastify";
import { parseLang, type Lang, type Translator } from "../db/i18n.js";
import { serviceWindow, ymdOf, toIso } from "../transit/calendar.js";
import {
  buildDayContexts, runRaptor, type RaptorAccess, type DayContext,
} from "../transit/raptor.js";
import {
  paretoRounds, reconstructForward, buildItinerary,
  type Itinerary, type Leg, type TransitLeg,
} from "../transit/itinerary.js";
import type { TimetableIndex } from "../transit/index.js";
import { headwayTableFor, type TransferMargin } from "../transit/headway.js";
import { rankItineraries } from "../transit/rank.js";
import { annotateAlternatives } from "../transit/alternatives.js";
import {
  walkConfig, config, rankConfig, alternativesConfig, routeRateLimits,
} from "../config.js";
import { ApiError } from "../errors.js";
import { resolveLegGeometry } from "./legGeometry.js";
import { resolveWalkGeometry } from "./walkGeometry.js";
import { refineAccessByWalking } from "./accessRefine.js";
import {
  parsePlace, parseModes, accessStops, nearestStops, NEAREST_STOP_FALLBACK_COUNT,
  buildWalkLeg, annotateRealtime, annotateTransferRisk, requiredMarginFor,
  type ParsedPlace,
} from "./plan.js";
import { dayFor } from "./journeyCheck.js";
import type { RealtimeStore } from "../realtime/store.js";

/**
 * Where `stopIdx` first appears on `tripIdx`'s own pattern, or -1.
 *
 * FIRST occurrence, deliberately, matching `routes/journeyCheck.ts`'s
 * `findBoardAlight` rule for the same question: a loop pattern can visit one
 * physical stop more than once, and a rider naming "the stop I last passed"
 * is reading a stop list top to bottom exactly as that function assumes.
 * Taking the first occurrence is also the CONSERVATIVE end of the ambiguity
 * here -- it seeds MORE of the trip (every stop after the earlier visit),
 * which can only offer the rider extra ways off, never fewer, and every one
 * of them is timed from that stop's own schedule row regardless.
 *
 * Positions are read off the PATTERN (`patternOfTrip` + `patternStops`), not
 * off the trip: every trip sharing a pattern shares its stop sequence by
 * construction (`patterns.ts`), which is what makes `tripTimeOffset[tripIdx]
 * + pos` a real row of THIS trip's own times.
 */
function positionOnPattern(ix: TimetableIndex, tripIdx: number, stopIdx: number): number {
  // `tripIdx` always came from `ix.tripIdToIdx`, which `buildIndex` sizes
  // `patternOfTrip` to cover; `patternOfTrip` always resolves into
  // `[0, nPatterns)`, and `patternStopOffset` is sized `nPatterns + 1`.
  const p = ix.patternOfTrip[tripIdx]!;
  const stopFrom = ix.patternStopOffset[p]!;
  const stopTo = ix.patternStopOffset[p + 1]!;
  for (let j = stopFrom; j < stopTo; j++) {
    if (ix.patternStops[j] === stopIdx) return j - stopFrom;
  }
  return -1;
}

/** How many stops `tripIdx`'s pattern serves. */
function patternLength(ix: TimetableIndex, tripIdx: number): number {
  // Same invariant `positionOnPattern` above states: `tripIdx` came from
  // `ix.tripIdToIdx`, `patternOfTrip` is sized `nTrips` and resolves into
  // `[0, nPatterns)`, and `patternStopOffset` is sized `nPatterns + 1`.
  const p = ix.patternOfTrip[tripIdx]!;
  return ix.patternStopOffset[p + 1]! - ix.patternStopOffset[p]!;
}

/**
 * One RAPTOR origin per stop the rider's vehicle still reaches after
 * `fromPos`, timed at when it will ACTUALLY get there: that stop's own
 * scheduled arrival on `day`, plus `delaySeconds`.
 *
 * This is the whole endpoint. `RaptorAccess.secondsToReach` is an offset from
 * the query instant, so "I am aboard this bus" is exactly "I can be at stop X
 * in N seconds, for every X the bus still serves" -- staying aboard longer is
 * a later seed, getting off early is an earlier one, and a delay shifts every
 * seed together. No new search and no new algorithm follow from it.
 *
 * A seed the vehicle has ALREADY PASSED (`secondsToReach < 0`) is dropped:
 * the rider cannot get off at a stop behind them, and seeding one would let
 * the search offer a connection that has already departed. This is reachable
 * with an honest client -- `at` is "now" and `delaySeconds` is whatever the
 * rider can see, so a bus running later than the client believes puts its
 * next stop or two in the past -- and dropping those stops is the same answer
 * a correct `delaySeconds` would have given. Dropping ALL of them (the rider
 * telling us about a ride that is, by these numbers, already over) leaves an
 * empty origin set and therefore an empty itinerary list, which this
 * endpoint's brief already treats as a legitimate answer rather than an error.
 *
 * NOT de-duplicated by stop, unlike `accessStops`'s destination-side list: a
 * loop pattern revisiting a stop produces two seeds for it, and `runRaptor`'s
 * own round-0 loop already keeps only the earlier (`t < best[origin.stopIdx]`).
 * The ambiguity `accessStops` guards against is a DESTINATION-side one -- a
 * `paretoRounds` pick names only a `stopIdx`, so two egress entries for one
 * stop leave the caller unable to say which walk produced the arrival --
 * and it does not arise here, because an origin's own instant is recovered
 * from the reconstructed chain's head label, never by looking the stop back
 * up in this list.
 *
 * ONE CONSEQUENCE, worth stating because it is visible in a response:
 * `runRaptor` keeps the EARLIER of two seeds at the same stop, so on a loop
 * pattern that visits a stop at 08:10 and again at 08:30, a journey whose
 * onward connection leaves at 08:36 reports `alightAt` at 08:10 -- the rider
 * is told to get off twenty minutes before they need to, and
 * `durationSeconds` is inflated by the same twenty minutes. That is the
 * CONSERVATIVE direction (the journey is real and makeable; the rider simply
 * waits at the stop rather than on the bus) and it is what "earliest arrival
 * wins" means at a stop reached twice, but it is not the nicest answer. A
 * fix would have to keep both visits distinguishable all the way through
 * RAPTOR's per-stop label arrays, which is the single-best-label-per-stop
 * model this planner is built on -- far past what this endpoint should
 * change.
 */
function onboardOrigins(
  ix: TimetableIndex, tripIdx: number, fromPos: number,
  baseEpoch: number, atEpoch: number, delaySeconds: number,
): RaptorAccess[] {
  // `patternOfTrip`/`patternStopOffset`: the invariant `positionOnPattern`
  // states, which this function is always called after and never without.
  const p = ix.patternOfTrip[tripIdx]!;
  const stopFrom = ix.patternStopOffset[p]!;
  const length = ix.patternStopOffset[p + 1]! - stopFrom;
  // `tripIdx` came from `ix.tripIdToIdx`, which `buildIndex` sizes
  // `tripTimeOffset` (length `nTrips + 1`) to cover for every valid trip.
  const timeFrom = ix.tripTimeOffset[tripIdx]!;

  const origins: RaptorAccess[] = [];
  for (let pos = fromPos + 1; pos < length; pos++) {
    const stopIdx = ix.patternStops[stopFrom + pos]!;
    // The same `s < 0` guard `raptor.ts`'s own pattern scan carries, for the
    // same reason: a pattern slot whose stop did not resolve is not a stop
    // anyone can get off at.
    if (stopIdx < 0) continue;
    // Never clamped, never modulo'd: `arrivalTime` here is a raw GTFS time
    // that legitimately exceeds 86400 (this feed runs to 105787), and
    // `baseEpoch` is the service day's own origin, so the sum is the real
    // absolute instant even for a rider aboard at 25:40.
    // `pos` is a position within this trip's own pattern, and every trip
    // sharing a pattern shares its exact stop sequence (`patterns.ts`), so
    // `timeFrom + pos` indexes a real row of THIS trip's times.
    const arrivalEpoch = baseEpoch + ix.arrivalTime[timeFrom + pos]! + delaySeconds;
    const secondsToReach = arrivalEpoch - atEpoch;
    if (secondsToReach < 0) continue; // already passed -- see doc comment
    origins.push({ stopIdx, secondsToReach });
  }
  return origins;
}

/**
 * How late `tripIdx` is running according to the live feed, measured at the
 * stop the rider last passed -- or `null` when the feed cannot say (disabled,
 * stale, never matched by SIRI, or no unambiguous call at that stop).
 *
 * ONE delay for the whole vehicle, not a per-stop prediction, because that is
 * what the quantity being replaced means: `delaySeconds` is "how late is this
 * bus", and the seeds apply it uniformly to every stop ahead. The reference
 * point is `onTripFromStop` deliberately -- it is the most recent place the
 * vehicle is known to have been, so its prediction is the freshest statement
 * about where the vehicle actually is.
 *
 * `unambiguousPredictionFor`, not `predictionFor`: a stop this trip's own
 * pattern visits more than once cannot be attributed to the visit the rider
 * means -- see `RealtimeStore.unambiguousPredictionFor`. Measured against the
 * SCHEDULED ARRIVAL at that stop, because SIRI gives exactly one predicted
 * instant per stop call and it is an arrival (see `routes/plan.ts`'s
 * `realtimeForLeg` for the same derivation, at length).
 *
 * Never throws: a lookup miss degrades to `null`, and the client's own number
 * (or zero) is used instead. Live data may improve an answer, never fail one.
 */
function realtimeDelayFor(
  realtime: RealtimeStore, tripIdx: number, refStopIdx: number,
  scheduledArrivalAtRefEpoch: number,
): number | null {
  if (realtime.journeyFor(tripIdx) === null) return null;
  const predicted = realtime.unambiguousPredictionFor(tripIdx, refStopIdx);
  if (predicted === null) return null;
  return predicted - scheduledArrivalAtRefEpoch;
}

/**
 * Where the rider leaves the vehicle they are on, and when it gets there.
 * Parallel to the itinerary list, index for index.
 *
 * Kept as a stop INDEX and an EPOCH rather than the rendered response fields,
 * because the epoch is load-bearing twice: once as the instant the response
 * reports, and once as the arrival `firstBoardingAtRisk` prices the very next
 * boarding against. Rendering to ISO and parsing back would round-trip
 * exactly (`toIso`/`Date.parse` do), but a second representation of the same
 * instant is exactly the kind of thing that drifts.
 */
interface Alighting {
  stopIdx: number;
  arrivalEpoch: number;
}

/**
 * Does the rider's FIRST boarding -- the one off the vehicle they are
 * currently on -- fall short of the margin the configured rule requires?
 *
 * THIS ENDPOINT MUST ASK THIS ITSELF, and no shared helper can do it for it.
 * `/plan`'s `computeTransferAtRisk`/`scheduledTransferAtRisk` both walk
 * `transferPairs`, which pairs a transit LEG with the next transit LEG -- and
 * the vehicle the rider is aboard is NOT a leg of this itinerary. It is an
 * access label. So the single connection `originsOnVehicle` exists to protect
 * is invisible to every check `/plan` already runs, and an itinerary holding
 * a sub-margin first boarding comes back either silently `null` or -- once a
 * realtime store confirms the itinerary's other, visible connections -- an
 * affirmative `false`. A 120 s connection off a possibly-late bus, reported
 * as not at risk, on the endpoint whose entire premise is that this
 * connection is the risky one. That was reproduced, not theorised; see this
 * file's own retry tests.
 *
 * Two paths reach a first boarding the rule would have refused, and this
 * covers both:
 *
 *  - LAYER ONE, inside `earliestTripOnDay`: the margin yields to
 *    the flat buffer when a pattern has no later trip on this service day,
 *    rather than delete the journey;
 *  - LAYER TWO, the query-level retry below: the whole search came
 *    back empty at the configured margin and was re-run flat.
 *
 * Priced with `requiredMarginFor` -- `/plan`'s own function, at its FORWARD
 * rule, which is the rule that actually built this chain -- from the same
 * three quantities an ordinary transfer is priced from: the arrival
 * (`alightEpoch`, already delay-adjusted, since the seeds were), the walk
 * between (0 for a same-stop boarding, exactly as `raptor.ts` charges it),
 * and the boarding leg itself. So the number compared here is the same number
 * the search enforced, not a second opinion about it.
 *
 * `false` for an itinerary with no transit leg at all -- the rider's own
 * vehicle already goes to the destination, and there is no next boarding to
 * be at risk. Only ever used to RAISE `transferAtRisk`, never to lower it.
 */
function firstBoardingAtRisk(
  ix: TimetableIndex, days: readonly DayContext[], transfer: TransferMargin,
  alightEpoch: number, legs: readonly Leg[],
): boolean {
  // Walk forward past any footpath the rider takes off the vehicle before
  // boarding -- the same traversal `/plan`'s `transferPairs` does between two
  // rides, asking the same question one step earlier in the chain.
  // `walkSeconds` is the reported, buffer-STRIPPED figure `buildItinerary`
  // produces, which is precisely what `requiredMarginFor`'s forward branch
  // expects (it adds `cfg.baseSeconds` back itself).
  let walkSeconds = 0;
  for (const leg of legs) {
    if (leg.type === "walk") { walkSeconds += leg.durationSeconds; continue; }
    const required = requiredMarginFor(
      ix, days, transfer, false, alightEpoch, walkSeconds, leg);
    return alightEpoch + walkSeconds + required > Date.parse(leg.from.departureTime) / 1000;
  }
  return false;
}

export const planOnboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/plan/onboard", {
    schema: {
      // No `response` schema, for exactly the reason `/plan` states at
      // length: fast-json-stringify strips any field a declared schema does
      // not list, and this response embeds `/plan`'s own deep, union-shaped
      // `Itinerary`.
      description:
        "Re-plans a journey from the vehicle the rider is currently aboard. " +
        "`onTrip` is the trip they are riding and `onTripFromStop` the stop " +
        "they last passed; every stop that trip serves AFTER it becomes a " +
        "candidate alighting point, timed at when the vehicle will actually " +
        "get there. The response is `/plan`'s own itinerary shape, plus " +
        "`alightAt` per itinerary -- the stop where the rider leaves their " +
        "current vehicle and when it arrives there, which is what " +
        "distinguishes 'get off at the next stop' from 'stay aboard four " +
        "more stops'. `delaySeconds` is how late the vehicle is running, " +
        "signed, and is used when the realtime feed has nothing for this " +
        "trip; when it does, the feed wins and `delaySource` says so " +
        "(`realtime` | `client` | `schedule`). `at` defaults to now and " +
        "picks the service day, so a rider aboard past midnight (GTFS times " +
        "legitimately exceed 86400 here) resolves against the day their " +
        "trip actually belongs to. `arriveBy` is not supported: a journey " +
        "cannot be re-planned backwards out of a vehicle already moving. An " +
        "empty `itineraries` list is a legitimate answer, not an error. " +
        "Unlike `/plan`, the FIRST boarding here is charged the full " +
        "transfer margin -- the rider has an incoming vehicle that can be " +
        "late, and it is the one they are sitting on. `departureTime` on an " +
        "itinerary is the instant the rider steps off that vehicle, not a " +
        "door departure and not the next boarding.",
      querystring: {
        type: "object",
        required: ["onTrip", "onTripFromStop", "to"],
        properties: {
          onTrip: { type: "string" },
          onTripFromStop: { type: "string" },
          to: { type: "string" },
          at: { type: "string" },
          // Deliberately NO `default`: "the client said zero" and "the client
          // said nothing" are different answers for `delaySource`, and a
          // schema default erases the difference before the handler runs.
          // Bounds are generous rather than meaningful -- six hours late is
          // already past `dayFor`'s own lookback, and two hours early is
          // further ahead of schedule than any vehicle runs -- and exist only
          // so a garbled value fails loudly instead of seeding nonsense.
          delaySeconds: { type: "integer", minimum: -7200, maximum: 21600 },
          maxWalkMeters: { type: "integer", minimum: 1, maximum: 2500 },
          maxTransfers: { type: "integer", minimum: 0, maximum: 6, default: 4 },
          results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          modes: { type: "string" },
          wheelchair: { type: "boolean", default: false },
          lang: { type: "string" },
          // Accepted by the schema only so the handler can refuse it with a
          // message that explains why, rather than having it silently ignored
          // as an unknown query parameter.
          arriveBy: { type: "string" },
        },
      },
    },
    // Per-route ceiling on top of the global 300/min limit -- this route is
    // EVENT-DRIVEN (a re-plan from the vehicle the rider is aboard, not
    // polled) but the same cost shape as `/plan` (a RAPTOR search per
    // request), so it gets the same budget; it also serves a rider
    // MID-JOURNEY, so that budget is generous. See
    // `routeRateLimits.planOnboardPerMinute` in `../config.js` for why 60
    // specifically. `@fastify/rate-limit` reads per-route settings from
    // `config.rateLimit` because the plugin is registered globally in
    // `server.ts`.
    config: { rateLimit: { max: routeRateLimits.planOnboardPerMinute, timeWindow: "1 minute" } },
  }, async (req) => {
    const q = req.query as {
      onTrip: string; onTripFromStop: string; to: string; at?: string;
      delaySeconds?: number; maxWalkMeters?: number; maxTransfers: number;
      results: number; modes?: string; wheelchair: boolean; lang?: string;
      arriveBy?: string;
    };

    const ix = app.index.current();
    if (ix === null) {
      // The same deliberate, retryable 503 `/plan`, `/segments` and
      // `/journey/check` all return: this route is a search over the
      // in-memory index and has nothing to answer with until it exists.
      throw new ApiError(
        503, "index_not_ready",
        "The timetable index has not finished building yet; retry shortly.",
        { details: { state: app.index.state() }, headers: { "retry-after": "5" } },
      );
    }

    if (q.arriveBy !== undefined) {
      throw app.httpErrors.badRequest(
        "arriveBy is not supported by /plan/onboard: a journey cannot be " +
        "re-planned backwards out of a vehicle the rider is already on. " +
        "Use /plan with arriveBy, or pass `at` here.",
      );
    }

    let lang: Lang;
    let to: ParsedPlace;
    try {
      lang = parseLang(q.lang);
      to = parsePlace(q.to);
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

    // Read fresh from `app.calendar` on every request, exactly as `/plan`
    // does, so this stays correct across a feed refresh without a redeploy.
    const window = serviceWindow(app.calendar);
    const ymd = ymdOf(at, tz);
    if (ymd < window.start || ymd > window.end) {
      throw new ApiError(
        422, "date_outside_service_window",
        `The loaded feed covers ${window.start} to ${window.end}; ${ymd} is outside it.`,
        { details: { serviceWindow: window } },
      );
    }

    // Unknown ids are 404s -- the `No <thing> with id ${id}` convention every
    // other route uses. A stop that exists but is not on this trip, or is on
    // it with nowhere left to alight, is a 400: the ids are real, the
    // COMBINATION is not.
    const tripIdx = ix.tripIdToIdx.get(q.onTrip);
    if (tripIdx === undefined) throw app.httpErrors.notFound(`No trip with id ${q.onTrip}`);
    const fromIdx = ix.stopIdToIdx.get(q.onTripFromStop);
    if (fromIdx === undefined) {
      throw app.httpErrors.notFound(`No stop with id ${q.onTripFromStop}`);
    }

    const fromPos = positionOnPattern(ix, tripIdx, fromIdx);
    if (fromPos === -1) {
      throw app.httpErrors.badRequest(
        `Trip ${q.onTrip} does not serve stop ${q.onTripFromStop}`,
      );
    }
    if (fromPos === patternLength(ix, tripIdx) - 1) {
      throw app.httpErrors.badRequest(
        `Stop ${q.onTripFromStop} is the last stop of trip ${q.onTrip}; ` +
        "there is nowhere left to alight.",
      );
    }

    const days = buildDayContexts(ix, app.calendar, at, tz);
    // `dayFor`, imported from `/journey/check` rather than rewritten: it
    // answers this exact question (which service day a client-supplied trip
    // belongs to, given a query instant) and got it wrong twice before
    // getting it right -- first by selecting on service activity alone, then
    // by measuring the candidate boarding instant from midnight rather than
    // from `at` itself. A rider aboard after midnight is an ORDINARY case for
    // this endpoint, so a second implementation here would be a defect
    // waiting for the exact night that one already survived.
    //
    // Anchored on the DEPARTURE from `onTripFromStop` -- the stop the rider
    // says they last passed, so the instant the query is implicitly about.
    // `tripIdx` resolved through `ix.tripIdToIdx` above, which
    // `tripTimeOffset` (length `nTrips + 1`) covers; `fromPos` is a real
    // position on this trip's pattern (`positionOnPattern` returned it, and
    // the -1 case already 400ed), so `timeFrom + fromPos` is a real row of
    // this trip's own times.
    const timeFrom = ix.tripTimeOffset[tripIdx]!;
    const boardOffsetSeconds = ix.departureTime[timeFrom + fromPos]!;
    const day = dayFor(days, tripIdx, boardOffsetSeconds, atEpoch);
    if (day === null) {
      throw new ApiError(
        422, "trip_not_active",
        `Trip ${q.onTrip} has no active, current service day near ${toIso(atEpoch, tz)}`,
        { details: { tripId: q.onTrip } },
      );
    }

    // Whose number is the vehicle running on. The feed wins when it has
    // something to say about THIS trip; the client's own observation is what
    // makes this endpoint useful before a SIRI key exists; and "schedule" is
    // the honest label for having neither.
    const clientDelay = q.delaySeconds;
    const liveDelay = app.realtime === null
      ? null
      : realtimeDelayFor(
        app.realtime, tripIdx, fromIdx,
        day.baseEpoch + ix.arrivalTime[timeFrom + fromPos]!,
      );
    const delaySeconds = liveDelay ?? clientDelay ?? 0;
    const delaySource: "realtime" | "client" | "schedule" =
      liveDelay !== null ? "realtime" : clientDelay !== undefined ? "client" : "schedule";

    const origins = onboardOrigins(ix, tripIdx, fromPos, day.baseEpoch, atEpoch, delaySeconds);

    // The destination endpoint, resolved with `/plan`'s own helpers rather
    // than a second copy of them: the straight-line prefilter
    // (`accessStops`), the Valhalla refinement (`refineAccessByWalking`) and
    // the uncapped nearest-stop fallback (`nearestStops`), in that order,
    // with the same 404/422 outcomes. Only the destination side exists here
    // -- the origin is a vehicle, not a place.
    const maxWalk = q.maxWalkMeters ?? walkConfig.maxMeters;
    const target = accessStops(ix, to, maxWalk, walkConfig.speedMps);
    if (to.kind === "stop" && target.point === null) {
      throw app.httpErrors.notFound(`No stop with id ${to.stopId}`);
    }

    // Parsed before refinement for the reason `/plan` documents: a malformed
    // `modes` value is a pure client mistake that should 400 before paying
    // for a Valhalla round-trip, not after.
    let modes: Set<number> | null;
    try {
      modes = q.modes === undefined ? null : parseModes(q.modes);
    } catch (err) {
      throw app.httpErrors.badRequest((err as Error).message);
    }

    let targetRefined = false;
    if (to.kind === "coord" && target.point !== null) {
      const refined = await refineAccessByWalking(
        app.valhalla, target.point, target.stops, { ix, maxWalkMeters: maxWalk });
      target.stops = refined.stops;
      targetRefined = refined.refined;
      if (!targetRefined) {
        req.log.warn(
          { endpoint: "destination", candidates: target.stops.length },
          "egress walk refinement did not run; using straight-line estimates",
        );
      }
    }
    if (to.kind === "coord" && target.point !== null && target.stops.length === 0) {
      const nearest = nearestStops(
        ix, target.point, NEAREST_STOP_FALLBACK_COUNT, walkConfig.speedMps);
      const refined = await refineAccessByWalking(
        app.valhalla, target.point, nearest, { ix, maxWalkMeters: Infinity });
      target.stops = refined.stops;
      targetRefined = refined.refined;
      if (!targetRefined) {
        req.log.warn(
          { endpoint: "destination", candidates: target.stops.length },
          "nearest-stop fallback engaged; egress walk refinement did not run, using straight-line estimates",
        );
      }
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

    const maxRounds = q.maxTransfers + 1;

    // Built exactly as `/plan` builds it, from the same config values and the
    // same memoised per-service-day tables. `factor === 0`
    // (`TRANSFER_HEADWAY_FACTOR=0`) short-circuits inside
    // `requiredTransferSeconds` and restores the flat pre-headway rule here
    // too -- including for `originsOnVehicle`, which adds no margin of its
    // own, only the right to be charged the one the rule already computes.
    const transfer: TransferMargin = {
      cfg: {
        baseSeconds: walkConfig.transferMinSeconds,
        factor: walkConfig.headwayFactor,
        capSeconds: walkConfig.transferMaxSeconds,
      },
      headway: days.map((d) => headwayTableFor(ix, d)),
    };

    const baseQuery = {
      origins, destinations: target.stops, days,
      transferMinSeconds: walkConfig.transferMinSeconds, tripFilter, transfer,
      departAfterEpoch: atEpoch,
      maxRounds,
      // THE flag. Without it these seeds are ordinary access labels and
      // inherit the first-boarding exemption -- waiving the transfer
      // margin on precisely the connection this endpoint exists to protect,
      // since the rider's incoming vehicle is not hypothetical here, it is
      // the reason they are asking.
      originsOnVehicle: true,
    };

    const routeOf = (routeIdx: number): TransitLeg["route"] =>
      app.routeBriefByIdx[routeIdx]
      ?? { id: "", agencyId: null, shortName: null, longName: null, type: 3, color: null };

    /**
     * One complete search, at ONE transfer margin. `margin` is threaded
     * rather than closed over for the same reason `/plan`'s own `search` does
     * it: the retry below must not be able to re-run at the margin
     * that just came back empty.
     *
     * NO REOPTIMISATION, unlike `/plan`'s `departAfter` branch. That step
     * re-anchors an itinerary on its first boarding and then runs the REVERSE
     * pass to find a later departure reaching the same arrival -- both
     * meaningless here. The rider's departure is not theirs to choose: it is
     * the instant a vehicle they are already on puts them down, which is what
     * `chain[0]`'s own label records and what `buildItinerary` therefore
     * reports. Running the reverse pass would also mean annotating against
     * its maximum-over-window margin rule (`requiredMarginFor`'s
     * `reverseSourced`) for chains the forward pass actually built, so every
     * itinerary here is forward-sourced and says so.
     */
    const search = (margin: TransferMargin): {
      itineraries: Itinerary[]; alighting: Alighting[];
    } => {
      const res = runRaptor(ix, { ...baseQuery, transfer: margin });

      const itineraries: Itinerary[] = [];
      const alighting: Alighting[] = [];
      for (const pick of paretoRounds(res.rounds, target.stops).slice(0, q.results)) {
        const chain = reconstructForward(ix, res.rounds, pick.round, pick.stopIdx);
        if (chain === null) continue;

        // `reconstructForward` walks `predecessor` back to the access label
        // and reverses, so `chain[0]` is ALWAYS that label -- here, one of
        // `onboardOrigins`' seeds, whose `arrivalEpoch` is the vehicle's own
        // delay-adjusted arrival at that stop. That is both where the rider
        // gets off and when, with no lookup back into the seed list needed
        // (and none possible on a loop pattern, which is why this reads the
        // label rather than searching `origins` by `stopIdx`). A chain the
        // rider walks off from starts at the seed too: the walk is
        // `chain[1]`, so `alightAt` still names the stop they left the
        // vehicle at, not the stop they walked to.
        // Both ends exist: `reconstructForward` returns `null` rather than an
        // empty chain (its loop pushes before it can ever return a chain),
        // and the `null` case was already skipped above.
        const head = chain[0]!;
        const egressStopIdx = chain[chain.length - 1]!.stopIdx;
        const egressSeconds =
          target.stops.find((t) => t.stopIdx === egressStopIdx)?.secondsToReach ?? 0;

        itineraries.push(buildItinerary(ix, chain, {
          tr, lang, tz, days, routeOf,
          transferMinSeconds: walkConfig.transferMinSeconds,
          // No access leg, ever: the rider did not walk to their origin, they
          // were carried to it. `buildItinerary` anchors `departureTime` on
          // `chain[0]`'s own instant when none is supplied, which is exactly
          // the alighting instant.
          egressLeg: buildWalkLeg(
            ix, tr, lang, target.point, egressStopIdx, egressSeconds, false, targetRefined),
        }));
        alighting.push({ stopIdx: head.stopIdx, arrivalEpoch: head.label.arrivalEpoch });
      }
      return { itineraries, alighting };
    };

    // The second layer of the retry, exactly as `/plan` applies it and for
    // the same reason: if the margin-respecting search returns NOTHING,
    // re-run at the flat rule rather than leave a rider with no journey at
    // all. It matters more here than anywhere -- someone aboard a late bus
    // at 22:15 asking what to do next is the worst possible audience for an
    // empty list. Strictly conservative (the retry returns what the
    // pre-headway planner would have) and gated on the feature being on, so
    // `TRANSFER_HEADWAY_FACTOR=0` stays byte-exact.
    //
    // The itineraries it finds are annotated below against the CONFIGURED
    // margin, so a connection the real rule wanted more slack for comes back
    // flagged `transferAtRisk` rather than silently offered. THAT REQUIRES
    // ALL THREE annotation passes below, not just `/plan`'s two: `/plan`'s
    // passes walk transit-leg-to-transit-leg pairs, and the rider's own
    // vehicle is not a leg of this itinerary, so the first boarding -- the
    // ONLY connection this endpoint's whole margin treatment exists to
    // protect -- is invisible to both. `firstBoardingAtRisk` is what closes
    // it; see its own doc comment.
    let { itineraries, alighting } = search(transfer);
    if (itineraries.length === 0 && transfer.cfg.factor !== 0) {
      ({ itineraries, alighting } = search({
        cfg: { ...transfer.cfg, factor: 0 },
        headway: transfer.headway,
      }));
    }

    // Same effort ordering as `/plan`. `paretoRounds` orders BY ROUND only
    // and this endpoint had no final sort at all, so a slower journey could
    // print above a faster one purely because it came from an earlier round.
    //
    // `applyFilters: false` is a deliberate departure from `/plan`'s "same
    // ranking, same filters" default. A rider here is already ON a vehicle:
    // these chains have no access leg (see the
    // `buildItinerary` call above), so `[alighting seed] -> walk -> destination`
    // is a zero-transit-leg itinerary that means "get off at this stop and
    // walk the rest" -- the single most useful answer this endpoint gives
    // someone standing on a bus. `/plan`'s walk-only filter exists to catch a
    // round-0 leak that cannot occur here, and applying it would delete that
    // answer. The walk-share cap is off for the same reason: with no access
    // leg the share is measured against a partial journey and means something
    // different from what the cap was calibrated on.
    //
    // The departure window is KEPT here, and it means a third thing
    // on this endpoint, which is worth stating rather than leaving implicit.
    // These itineraries have no access leg, so their `departureTime` is the
    // ALIGHTING instant -- the moment the rider steps off the vehicle they are
    // already on -- and the window therefore reads "an answer that keeps you
    // aboard more than `PLAN_DEPARTURE_WINDOW_SECONDS` past the earliest
    // possible alighting can never be promoted above one that doesn't". That
    // is a defensible rule for a rider who wants off sooner rather than later,
    // and it is bounded by construction (the seed trip's own remaining stops),
    // so it cannot exhibit the unbounded-displacement problem the window was
    // written for. Related and equally deliberate: the ride BEFORE alighting
    // is priced at zero, because `durationSeconds` is measured from that same
    // re-anchored alighting instant -- staying on the bus longer costs nothing
    // in `journeyCost`, only in the window above. Neither is `/plan`'s meaning;
    // change one and the other needs re-reading.
    //
    // `alighting` is index-for-index with `itineraries` and is read back when
    // the response is assembled below, so it is ranked as part of the same
    // wrapper rather than left behind -- reordering one without the other
    // would tell a rider to get off at another itinerary's stop.
    const ranked = rankItineraries(
      itineraries.map((itinerary, i) => ({ itinerary, alight: alighting[i]! })),
      (candidate) => candidate.itinerary,
      rankConfig,
      { applyFilters: false },
    );
    itineraries = ranked.map((candidate) => candidate.itinerary);
    alighting = ranked.map((candidate) => candidate.alight);

    // Every itinerary here was built by the FORWARD pass -- there is no
    // reoptimisation to swap one onto a reverse-reconstructed chain (see
    // `search`) -- so the forward margin rule is the one to annotate against.
    const reverseSourced = itineraries.map(() => false);

    // The later buses each ride could still be taken on -- the same step, at
    // the same point, as `/plan`, so an onboard leg and a `/plan` leg match.
    // Where following the itinerary's own stops onwards runs dry, a fresh plan
    // from the stop the later bus drops the rider at -- the same search as
    // this request, at the flat buffer alternatives are measured with.
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
      tr, lang, tz, routeOf,
      transferMinSeconds: walkConfig.transferMinSeconds,
      ...alternativesConfig,
      tripFilter,
      replanArrival,
    });
    resolveLegGeometry(app.db.db, itineraries);
    await resolveWalkGeometry(app.valhalla, itineraries);
    if (app.realtime !== null) {
      annotateRealtime(app.realtime, ix, tz, days, transfer, reverseSourced, itineraries);
    }
    annotateTransferRisk(ix, days, transfer, reverseSourced, itineraries);
    // LAST, and only ever raising: the two passes above can each write a
    // `false` (a realtime store confirming every VISIBLE connection), and the
    // one connection neither of them can see is the rider's own first
    // boarding -- see `firstBoardingAtRisk`. Running this before them would
    // let that `false` overwrite a `true` this check had already earned,
    // which is the exact shape of the defect it exists to close. Always, not
    // only on the retry path: layer ONE can yield inside the
    // search itself, with no empty result to notice.
    itineraries.forEach((itin, i) => {
      if (itin.transferAtRisk === true) return;
      // `alighting` is built index-for-index alongside `itineraries` inside
      // `search`, and the retry replaces both together, so this is always
      // defined; the guard is a defensive floor, and skipping the check is
      // the only honest thing to do without an alighting instant to price
      // against.
      const a = alighting[i];
      if (a === undefined) return;
      if (firstBoardingAtRisk(ix, days, transfer, a.arrivalEpoch, itin.legs)) {
        itin.transferAtRisk = true;
      }
    });

    return {
      query: {
        onTrip: q.onTrip,
        onTripFromStop: q.onTripFromStop,
        to: q.to,
        at: toIso(atEpoch, tz),
        // The delay actually APPLIED to the seeds, whatever its source --
        // which is the client's number only when `delaySource` says `client`.
        delaySeconds,
        // SEEDS, not distinct stops: a loop pattern that visits one stop
        // twice after `onTripFromStop` contributes two, since each visit is
        // a separate chance to get off at a separate time. Mirrors `/plan`'s
        // own `accessStops`/`egressStops`, which likewise count candidate
        // entries rather than physical places.
        alightStops: origins.length,
        egressStops: target.stops.length,
      },
      delaySource,
      // `alighting` is built index-for-index alongside `itineraries` inside
      // `search`, both are replaced together by the retry, and both are
      // reordered together by `rankItineraries` above, so the two can never
      // be out of step; the `?? null` is a defensive floor only.
      itineraries: itineraries.map((itin, i) => {
        const a = alighting[i];
        return {
          ...itin,
          alightAt: a === undefined ? null : {
            // `a.stopIdx` came out of `ix.patternStops` inside
            // `onboardOrigins` and survived a round trip through RAPTOR's own
            // per-stop arrays, so it indexes real entries of every `ix.stop*`
            // array, all sized `nStops`.
            stopId: ix.stopIds[a.stopIdx]!,
            name: tr.resolve(ix.stopNames[a.stopIdx] ?? null, lang),
            arrivalTime: toIso(a.arrivalEpoch, tz),
          },
        };
      }),
    };
  });
};
