import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { parseLang, type Lang, type Translator } from "../db/i18n.js";
import { siblingStopIds, stopExists } from "../db/stops.js";
import {
  departuresAt, nextDepartureAfter, tripStopVisit, type Departure,
} from "../db/departures.js";
import { config } from "../config.js";
import { toIso } from "../transit/calendar.js";
import type { TimetableIndex } from "../transit/index.js";
import type { TransitLeg } from "../transit/itinerary.js";
import type { RealtimeStore } from "../realtime/store.js";
import { runIdFor } from "./unscheduledRuns.js";

/**
 * The same six-field shape `TransitLeg["realtime"]` uses (see its own doc
 * comment for the full null-vs-populated contract) -- a type-only alias of
 * an already-exported type, not a duplicate declaration, so the two can
 * never again diverge the way they briefly did on delay anchoring.
 * `predictedArrival` is always null here: a departure board entry is a
 * single stop visit, not a leg with its own separate arrival, so there is
 * nothing distinct for that field to report.
 */
type DepartureRealtime = TransitLeg["realtime"];

/**
 * The public shape of one departures-board entry: `Departure` minus the
 * internal-only `arrivalTime` (see that field's own doc comment in
 * `db/departures.ts` -- it exists only to anchor the derivation below and
 * must never reach a response), plus `realtime`.
 */
type PublicDeparture = Omit<Departure, "arrivalTime"> & {
  realtime: DepartureRealtime;
  /**
   * The row's identity: `tripId` for a timetable row, see `runIdFor` for an
   * unscheduled one. What this guarantees is that DISTINCT runs never share a
   * `runId` -- it does NOT guarantee one row per `runId`. A scheduled row's
   * `runId` is simply its `tripId`, with no dedup at all: a loop trip that
   * visits one of the board's stops twice inside the window produces two
   * `Departure` rows with the identical `tripId`/`runId`, one per visit
   * (`stopSequence` tells them apart). An unscheduled run predicted at two
   * sibling stops under `includeSiblings` is the opposite case -- still one
   * physical bus, but `runIdFor`'s shared `taken` set gives its two rows
   * DIFFERENT ids (`T@veh`, then `T@veh#2`) rather than repeating one. Either
   * way, a client keying rows by `runId` alone must not assume it is unique
   * per row, nor that it is stable per physical run.
   */
  runId: string;
  /** True for a live bus running off-timetable on this trip's slot. */
  unscheduled: boolean;
};

function toPublicDeparture(d: Departure, realtime: DepartureRealtime): PublicDeparture {
  return {
    tripId: d.tripId, runId: d.tripId, unscheduled: false,
    stopId: d.stopId, stopSequence: d.stopSequence,
    departureTime: d.departureTime, headsign: d.headsign, tripNumber: d.tripNumber,
    directionId: d.directionId,
    lineCode: d.lineCode, lineDirection: d.lineDirection,
    route: d.route, realtime,
  };
}

/**
 * One departure's realtime annotation, or null when its trip has no fresh,
 * resolved data -- see `DepartureRealtime`'s own comment. Never throws: an
 * id lookup miss degrades to an absent prediction, never a fault.
 *
 * SIRI's own prediction is an ARRIVAL (`RealtimeCall.expectedArrival`), the
 * same fact `routes/plan.ts`'s `realtimeForLeg` documents for a transit
 * leg's board stop -- and the derivation here is identical: compute the
 * delay against this row's own scheduled arrival (`d.arrivalTime`), then
 * apply that same delay to the scheduled departure (`d.departureTime`).
 * This feed dwells nowhere (`arrival_time === departure_time` on all 9.8M
 * `stop_times` rows, checked 2026-08-23), so the derived value is
 * numerically identical to the raw prediction today; the derivation is
 * what keeps it correct the day a dwelling feed arrives.
 */
function realtimeForDeparture(
  realtime: RealtimeStore, ix: TimetableIndex, tz: string, d: Departure,
): DepartureRealtime {
  const tripIdx = ix.tripIdToIdx.get(d.tripId);
  if (tripIdx === undefined) return null;
  const journey = realtime.journeyFor(tripIdx);
  if (journey === null) return null;

  const stopIdx = ix.stopIdToIdx.get(d.stopId);
  const predictedArrivalEpoch =
    stopIdx === undefined ? null : realtime.predictionFor(tripIdx, stopIdx);

  const scheduledArrivalEpoch = Date.parse(d.arrivalTime) / 1000;
  const scheduledDepartureEpoch = Date.parse(d.departureTime) / 1000;
  const delaySeconds =
    predictedArrivalEpoch === null ? null : predictedArrivalEpoch - scheduledArrivalEpoch;
  const predictedDepartureEpoch =
    delaySeconds === null ? null : scheduledDepartureEpoch + delaySeconds;

  return {
    predictedDeparture:
      predictedDepartureEpoch === null ? null : toIso(predictedDepartureEpoch, tz),
    predictedArrival: null,
    delaySeconds,
    vehicleRef: journey.journey.vehicleRef,
    confidence: journey.journey.confidence,
    recordedAt:
      journey.journey.recordedAt === null ? null : toIso(journey.journey.recordedAt, tz),
    source: realtime.feedSource,
  };
}

/**
 * Annotates a departure board with live SIRI predictions. Mirrors
 * `routes/plan.ts`'s `annotateRealtime`: enriches, never fails, never
 * touches `departureTime` (RAPTOR/the timetable query already produced it;
 * see that function's own comment for the full reasoning). `realtime ===
 * null` (no MOT key yet, the default) or an index not yet built both
 * degrade to every entry carrying `realtime: null`, without querying the
 * store at all -- `ix` (when present) already carries `tripIdToIdx`
 * precomputed once per index bundle, so there is no per-request lookup map
 * to build either way.
 */
function annotateDepartures(
  realtime: RealtimeStore | null, ix: TimetableIndex | null, tz: string,
  departures: readonly Departure[],
): PublicDeparture[] {
  if (realtime === null || ix === null) {
    return departures.map((d) => toPublicDeparture(d, null));
  }
  return departures.map((d) => toPublicDeparture(d, realtimeForDeparture(realtime, ix, tz, d)));
}

/**
 * How far BEFORE the requested time the board also looks for departures
 * that realtime says have not happened yet.
 *
 * The board itself is a schedule query (`db/departures.ts`: `departure_time
 * >= at`), so before this a bus running late was filtered out by its
 * SCHEDULED time and realtime never got to speak for it -- a bus two
 * minutes from the stop disappeared at exactly the moment it was still
 * catchable, and nothing in `/meta` could show it, because as far as the
 * pipeline was concerned no poll had failed and no journey had gone
 * unresolved. The row was simply never a candidate.
 *
 * Twenty minutes: long enough to cover the delays this network actually
 * produces, short enough that the extra index range scan stays small. It is
 * NOT a grace period -- nothing is shown merely for being recent; see
 * `stillToCome`.
 */
const LATE_LOOKBACK_SECONDS = 20 * 60;

/**
 * A safety valve on the lookback query, not a product limit: 20 minutes of
 * departures from one stop (or one station's merged platforms) is a few
 * dozen rows even at the busiest interchange in the country. It exists so a
 * pathological stop cannot turn one board request into an unbounded read.
 *
 * Deliberately far above `limit`'s own maximum of 100, because
 * `departuresAt` slices its limit off the EARLIEST rows -- truncating here
 * would drop the most recently due departures, which are precisely the ones
 * most likely to still be coming.
 */
const LATE_LOOKBACK_ROW_CAP = 500;

/** The instant a rider can actually board: the prediction when there is
 *  one, else the schedule. What the board is ordered by. */
function boardableEpoch(d: PublicDeparture): number {
  const predicted = d.realtime?.predictedDeparture ?? null;
  return Date.parse(predicted ?? d.departureTime) / 1000;
}

/**
 * Of the departures already due, the ones realtime positively places in the
 * future. POSITIVE evidence only, and that is the whole design: with no
 * live prediction we do not know whether a bus scheduled five minutes ago
 * left on time or is stuck around the corner, and a board padded with
 * departures that have already gone is its own kind of lie. So a row is
 * resurrected only when a fresh, resolved prediction says the bus has not
 * been here yet -- never for merely being recent, and never once its own
 * prediction has passed too (which is evidence it HAS been).
 */
function stillToCome(departures: readonly PublicDeparture[], at: Date): PublicDeparture[] {
  const now = at.getTime() / 1000;
  return departures.filter((d) => {
    const predicted = d.realtime?.predictedDeparture ?? null;
    return predicted !== null && Date.parse(predicted) / 1000 > now;
  });
}

/**
 * Board rows for the unscheduled runs predicted at `stopIds` whose predicted
 * departure falls inside `[at, at + windowSeconds]`. Each row is its
 * template trip's row at that stop, with the scheduled time shifted by the
 * run's offset and a realtime block measured against that shifted time.
 */
function unscheduledDepartures(
  realtime: RealtimeStore, ix: TimetableIndex, db: Database.Database, tr: Translator,
  opts: { stopIds: readonly string[]; at: Date; windowSeconds: number; lang: Lang; tz: string },
): PublicDeparture[] {
  const from = opts.at.getTime() / 1000;
  const to = from + opts.windowSeconds;
  const taken = new Set<string>();
  const rows: PublicDeparture[] = [];
  for (const stopId of opts.stopIds) {
    const stopIdx = ix.stopIdToIdx.get(stopId);
    if (stopIdx === undefined) continue;
    for (const { run, arrival } of realtime.unscheduledAtStop(stopIdx)) {
      const tripId = ix.tripIds[run.templateTripIdx];
      if (tripId === undefined) continue;
      const visit = tripStopVisit(db, tr, tripId, stopId, opts.lang);
      if (visit === null) continue;
      const shift = run.serviceBaseEpoch + run.offsetSeconds;
      const scheduledArrival = shift + visit.arrivalSeconds;
      const scheduledDeparture = shift + visit.departureSeconds;
      const delaySeconds = Math.round(arrival - scheduledArrival);
      const predictedDeparture = scheduledDeparture + delaySeconds;
      if (predictedDeparture < from || predictedDeparture > to) continue;
      const j = run.journey;
      rows.push({
        tripId, runId: runIdFor(tripId, run, taken), unscheduled: true,
        stopId, stopSequence: visit.stopSequence,
        departureTime: toIso(scheduledDeparture, opts.tz),
        headsign: visit.headsign, tripNumber: visit.tripNumber, directionId: visit.directionId,
        lineCode: visit.lineCode, lineDirection: visit.lineDirection,
        route: visit.route,
        realtime: {
          predictedDeparture: toIso(predictedDeparture, opts.tz),
          predictedArrival: null,
          delaySeconds,
          vehicleRef: j.vehicleRef,
          confidence: j.confidence,
          recordedAt: j.recordedAt === null ? null : toIso(j.recordedAt, opts.tz),
          source: realtime.feedSource,
        },
      });
    }
  }
  return rows;
}

export const departureRoutes: FastifyPluginAsync = async (app) => {
  app.get("/stops/:stopId/departures", {
    schema: {
      params: { type: "object", required: ["stopId"], properties: { stopId: { type: "string" } } },
      querystring: {
        type: "object",
        properties: {
          at: { type: "string" },
          window: { type: "integer", minimum: 1, maximum: 180, default: 60 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
          includeSiblings: { type: "boolean", default: false },
          lang: { type: "string" },
        },
      },
    },
  }, async (req) => {
    const { stopId } = req.params as { stopId: string };
    const q = req.query as {
      at?: string; window: number; limit: number; includeSiblings: boolean; lang?: string;
    };

    let lang;
    try { lang = parseLang(q.lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }

    const at = q.at === undefined ? new Date() : new Date(q.at);
    if (Number.isNaN(at.getTime())) {
      throw app.httpErrors.badRequest(`Invalid at: ${q.at}`);
    }

    // Existence is decided by the STOP ID, never by `includeSiblings` --
    // that flag only controls which platforms of an existing station get
    // merged into one board. Deciding existence from `siblingStopIds`
    // instead would make an unknown id 404 only when the flag is on
    // (an empty sibling list) and a 200 with an empty board when it is
    // off (nothing looked the stop up at all) -- one endpoint with two
    // different meanings for the same input, switched by a flag about
    // which platforms to merge.
    if (!stopExists(app.db.db, stopId)) {
      throw app.httpErrors.notFound(`No stop with id ${stopId}`);
    }
    const stopIds = q.includeSiblings ? siblingStopIds(app.db.db, stopId) : [stopId];

    const ix = app.index.current();
    const scheduled = departuresAt(app.db.db, app.translator, app.calendar, {
      stopIds, at, windowSeconds: q.window * 60,
      limit: q.limit, lang, tz: config.timezone,
    });

    // Departures already due, which only realtime can put back on the board.
    // Skipped entirely when nothing could resurrect one -- realtime
    // disabled (the default until an MOT key exists) or an index not yet
    // built -- so a deployment without live data does exactly the one query
    // it always did, and answers byte-for-byte what it answered before.
    //
    // The window ENDS one second before `at`, where the scheduled board
    // begins, so the two are disjoint by construction and a departure due
    // at exactly `at` cannot appear on the board twice.
    const overdue = app.realtime === null || ix === null
      ? []
      : departuresAt(app.db.db, app.translator, app.calendar, {
        stopIds,
        at: new Date(at.getTime() - LATE_LOOKBACK_SECONDS * 1000),
        windowSeconds: LATE_LOOKBACK_SECONDS - 1,
        limit: LATE_LOOKBACK_ROW_CAP, lang, tz: config.timezone,
      });

    // Live buses running off-timetable on a slot that already has its own
    // bus. Merged before the sort and the limit, so they compete for a
    // place like any row.
    const unscheduled = app.realtime === null || ix === null
      ? []
      : unscheduledDepartures(app.realtime, ix, app.db.db, app.translator, {
        stopIds, at, windowSeconds: q.window * 60, lang, tz: config.timezone,
      });

    const board = [
      ...annotateDepartures(app.realtime, ix, config.timezone, scheduled),
      ...stillToCome(annotateDepartures(app.realtime, ix, config.timezone, overdue), at),
      ...unscheduled,
    ]
      // On the boardable instant, not the scheduled one: a rider reads this
      // board to know what to catch next, and a bus 70 minutes late is not
      // the next thing to catch merely because its timetable slot was.
      .sort((a, b) => boardableEpoch(a) - boardableEpoch(b))
      // Applied AFTER the merge, so a resurrected departure competes for a
      // place on equal terms rather than being appended past the limit the
      // client asked for.
      .slice(0, q.limit);

    // Only when the board is empty, and only ever ONE row: the lookahead
    // walks day by day (see `nextDepartureAfter`), so it is far dearer than
    // the board query it supplements and must not run alongside a board that
    // already answered the question.
    const upcoming = board.length === 0
      ? nextDepartureAfter(app.db.db, app.translator, app.calendar, {
        stopIds, at, lang, tz: config.timezone,
      })
      : null;

    return {
      stopId,
      departures: board,
      /**
       * The next departure BEYOND the requested window, present only when
       * the board itself is empty -- so a client can tell "this stop is
       * closed right now" from "this stop is not served at all". Null when
       * nothing runs from here in the next eight days.
       */
      nextDeparture: upcoming === null
        ? null
        : annotateDepartures(app.realtime, ix, config.timezone, [upcoming])[0]!,
    };
  });
};
