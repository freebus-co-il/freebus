/**
 * The `/plan` route schema.
 *
 * Deliberately no `response` schema: fast-json-stringify strips any field not
 * listed, and the deep `WalkLeg | TransitLeg` union would be silently
 * truncated. The other data routes make the same choice.
 */
export const planSchema = {
  description:
    "Plans a journey between `from` and `to` (each `lat,lon` or " +
    "`stop:<id>`), given exactly one of `departAfter`/`arriveBy`. " +
    "`departureTime`/`arrivalTime` on each itinerary are door-to-door: " +
    "anchored on the whole chain including any walking access/egress " +
    "leg, not on the first/last transit leg -- a WalkLeg carries no " +
    "timestamp of its own, so they will differ from " +
    "`legs[0].from.departureTime` whenever the itinerary starts or " +
    "ends with a walk. `departureTime` is the LATEST FEASIBLE DOOR " +
    "DEPARTURE that still reaches the reported `arrivalTime` in " +
    "exactly as many transfers, in both modes: with `arriveBy` because " +
    "the reverse search maximises departure directly, and with " +
    "`departAfter` because the forward search's own chain is " +
    "re-anchored on its first boarding and then re-optimised the same " +
    "way (that second refinement runs for the first few itineraries " +
    "only, for latency; the re-anchoring runs for every one, so no " +
    "itinerary ever reports the query instant). " +
    "WHEN LIVE DATA IS AVAILABLE THE SEARCH RUNS ON IT: a trip with a " +
    "realtime delay is planned at its PREDICTED times, so a bus whose " +
    "scheduled departure has already passed but which is running late " +
    "can still be boarded, and a connection the live data refuses is " +
    "not offered. Every transit leg therefore carries BOTH " +
    "`from.departureTime`/`to.arrivalTime` (what the planner used, and " +
    "what a rider should act on -- predicted when this trip was " +
    "delayed) and `from.scheduledDepartureTime`/" +
    "`to.scheduledArrivalTime` (always the published timetable, always " +
    "present, equal to the former when nothing was delayed). " +
    "`realtime.delaySeconds` is measured against the SCHEDULED pair. " +
    "If live delays would leave a query with NO journey at all, the " +
    "planner yields back to the timetable and returns the scheduled " +
    "journey flagged through `transferAtRisk` rather than an empty " +
    "result -- the same rule applies to the last service of the day. " +
    "`arrivalTime` is the real door arrival in both modes, and " +
    "for `departAfter` it is always the EARLIEST reachable arrival -- " +
    "re-optimisation only ever moves `departureTime` later, never " +
    "`arrivalTime`. A transit leg's `geometry` is a precision-6 " +
    "encoded polyline sliced from the operator's own shape between " +
    "the leg's board and alight stops; `geometryFallback: true` means " +
    "the line is a straight line through the leg's stops instead, " +
    "because the trip carries no shape, its shape row is missing, or " +
    "the shape could not be cut to this leg. IN PRACTICE EVERY RAIL " +
    "LEG IS A STRAIGHT LINE: all 1,085 route_type 2 trips in this " +
    "feed -- 100% of them -- carry no shape_id. `geometryFallback` is " +
    "a TRANSIT-LEG FIELD ONLY; it is absent (undefined) on walk legs. " +
    "A walk leg's `geometry` is routed through Valhalla per request " +
    "after the itinerary is built, and becomes a real precision-6 " +
    "encoded polyline whenever that call succeeds; it stays " +
    "`geometry: null` (with a haversine x1.35 `distanceMeters` " +
    "estimate) only when that call failed, timed out, or did not " +
    "parse. A walk leg's `walkEstimated` is unrelated: it describes " +
    "`durationSeconds`'s provenance, not `geometry`'s, and is set " +
    "independently -- see this service's README.",
  querystring: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      departAfter: { type: "string" },
      arriveBy: { type: "string" },
      maxWalkMeters: { type: "integer", minimum: 1, maximum: 2500 },
      maxTransfers: { type: "integer", minimum: 0, maximum: 6, default: 4 },
      results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      modes: { type: "string" },
      wheelchair: { type: "boolean", default: false },
      lang: { type: "string" },
    },
  },
};
