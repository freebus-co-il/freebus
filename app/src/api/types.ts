export type Place = {
  type: 'coordinate' | 'stop';
  lat: number;
  lon: number;
  stopId?: string;
  name?: string;
};

export type RealtimeInfo = {
  predictedDeparture: string | null;
  predictedArrival: string | null;
  delaySeconds: number | null;
  vehicleRef: string | null;
  confidence: string | null;
  recordedAt: string | null;
};

export type WalkLeg = {
  type: 'walk';
  from: Place;
  to: Place;
  distanceMeters: number;
  durationSeconds: number;
  geometry: string | null;
  walkEstimated: boolean;
  /** The walk's turns, each with the stretch of `geometry` it covers. Absent on
   *  a walk still drawn as a straight line, and on itineraries stored before the
   *  server sent turns. */
  steps?: WalkStep[];
};

/** The kinds of move a walk is described in -- the server's own vocabulary,
 *  so the app phrases each in the rider's language. */
export type WalkManeuver =
  | 'depart' | 'arrive' | 'straight'
  | 'slight-right' | 'right' | 'sharp-right'
  | 'slight-left' | 'left' | 'sharp-left'
  | 'uturn' | 'roundabout' | 'stairs' | 'elevator' | 'escalator'
  | 'enter-building' | 'exit-building' | 'ferry';

export type WalkStep = {
  /** The move that starts this step: turn right, then walk the step. */
  maneuver: WalkManeuver;
  /** The street the step walks along; null when unnamed. */
  street: string | null;
  lengthMeters: number;
  /** Where the step starts and ends, as indexes into the decoded geometry. */
  beginShapeIndex: number;
  endShapeIndex: number;
};

/** `GET /walk`: one walk on the street network -- a re-route from where the
 *  rider actually is. */
export type WalkRouteResponse = {
  distanceMeters: number;
  durationSeconds: number;
  geometry: string | null;
  steps: WalkStep[];
  estimated: boolean;
};

export type TransitLeg = {
  type: 'transit';
  route: {
    id: string;
    /** GTFS `agency_id` -- the operating company, and what the route is
     *  coloured by. See `lib/route-color`. */
    agencyId: string | null;
    shortName: string;
    longName: string;
    type: number;
    color: string | null;
  };
  tripId: string;
  headsign: string;
  /** The train's number on a rail trip (the feed's `trip_headsign`), null on every
   *  other mode. For rail the API sends the final station in `headsign`, so
   *  this is the secondary fact beside it, never the label. Optional: an older
   *  API does not send it, and a journey stored before it did reads back
   *  without. */
  tripNumber?: string | null;
  directionId: number;
  from: { stop: Place; departureTime: string; stopSequence: number };
  to: { stop: Place; arrivalTime: string; stopSequence: number };
  numStops: number;
  intermediateStops: Place[];
  geometry: string | null;
  geometryFallback: boolean;
  realtime: RealtimeInfo | null;
  /** The later buses this same ride can be taken on: same board and alight
   *  stop, each marked with what taking it does to the journey. Complete legs,
   *  so one can be swapped in when the rider says which bus they are on (see
   *  `features/trip/line-options`). Optional: an itinerary stored by a
   *  journey that started before the server sent these reads back without. */
  alternatives?: TransitAlternative[];
  /** On an alternative: it reaches the alight stop too late for the planned
   *  next ride. On a leg, only once the rider has switched to that alternative. */
  missesConnection?: boolean;
  /** On an alternative: how much later (negative: sooner) the rider reaches
   *  the end of the journey on it than on the ride originally planned; null
   *  when the server found no onward trip. On a leg, as `missesConnection`. */
  arrivalDelaySeconds?: number | null;
};

/** A leg offered in place of another; it never carries alternatives of its own. */
export type TransitAlternative = Omit<TransitLeg, 'alternatives'>;

export type Leg = WalkLeg | TransitLeg;

export type Itinerary = {
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  transfers: number;
  walkSeconds: number;
  walkMeters: number;
  legs: Leg[];
  transferAtRisk: boolean | null;
};

export type PlanQuery = {
  from: string;
  to: string;
  departAfter?: string;
  arriveBy?: string;
  /** Comma-separated GTFS route_type values, e.g. "2,3". Omitted entirely for
   *  no filter -- the backend treats a missing param as "any vehicle", and
   *  never receives an empty string (see `search-context`'s `modeQuery`). */
  modes?: string;
  /** Locale for backend-localized text (stop names, headsigns). */
  lang?: string;
};

export type PlanResponse = {
  query: PlanQuery & { accessStops?: unknown; egressStops?: unknown };
  itineraries: Itinerary[];
};

/** One vehicle type the loaded feed can actually plan with (`GET /modes`). */
export type TransitMode = {
  type: number;
  /** English GTFS name. A FALLBACK only -- the app's own translations win
   *  when it has a label for this type; this catches types shipped by a feed
   *  newer than the app build. */
  name: string;
  routes: number;
};

export type ModesResponse = {
  modes: TransitMode[];
};

/** Enough of a line to draw a badge for it: the number to print, the operator
 *  to colour it by, and the vehicle kind to fall back to when the line has no
 *  number (every rail route in this feed has an empty short name). */
export type StopRouteBrief = {
  shortName: string;
  agencyId: string | null;
  type: number;
};

export type StopSearchResult = {
  stopId: string;
  code: string | null;
  name: string | null;
  lat: number;
  lon: number;
  locationType: number;
  parentStation: string | null;
  /** The lines calling here, ordered by number. Empty for a stop nothing
   *  serves. */
  routes: StopRouteBrief[];
  /** Trains call here. Rail lines have no number, so `routes` never shows
   *  them; absent from an API deploy older than this field. */
  rail?: boolean;
  /** Which sign the stop shows, by what calls there: `bus`, `train`,
   *  `lightRail` (Dankal), `jerusalemLightRail`, `carmelit` or `metronit`.
   *  Absent from an API deploy older than it, and a later API may add kinds --
   *  read it through `stationKindOf`, never as a closed union. */
  stationKind?: string;
};

export type StopSearchResponse = {
  stops: StopSearchResult[];
};

/** `GET /stops/:stopId`: one stop, where it is, and every route row calling
 *  there (a line appears once per direction and alternative). */
export type StopDetail = {
  stopId: string;
  code: string | null;
  name: string | null;
  lat: number;
  lon: number;
  locationType: number;
  parentStation: string | null;
  /** See `StopSearchResult.stationKind`. */
  stationKind?: string;
  routes: {
    routeId: string;
    agencyId: string | null;
    shortName: string | null;
    longName: string | null;
    type: number;
    color: string | null;
  }[];
};

export type NearbyStop = {
  stopId: string;
  code: string | null;
  name: string | null;
  lat: number;
  lon: number;
  locationType: number;
  parentStation: string | null;
  distanceMeters: number;
  /**
   * The lines calling here, ordered by number. Empty for a stop nothing
   * serves, and ABSENT entirely from an API deploy older than the Lines tab
   * -- the app ships separately from the box, so callers must treat this as
   * optional rather than trusting it into a loop.
   */
  routes?: StopRouteBrief[];
  /** Trains call here -- see `StopSearchResult.rail`. */
  rail?: boolean;
  /** See `StopSearchResult.stationKind`. */
  stationKind?: string;
};

export type NearbyStopsResponse = {
  stops: NearbyStop[];
};

/** `GET /stops/in-box`: a stop as a map pins it. No lines -- those come from
 *  `/stops/:stopId` for the one stop the rider settles on. */
export type MapStop = {
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
  rail: boolean;
  /** See `StopSearchResult.stationKind`. */
  stationKind?: string;
};

export type StopsInBoxResponse = {
  stops: MapStop[];
};

export type Departure = {
  tripId: string;
  /** The row's identity: equals `tripId` for a timetable row. An unscheduled
   *  bus shares its template trip's `tripId`, so key rows by this. */
  runId: string;
  /** A live bus running off-timetable on `tripId`'s slot. */
  unscheduled: boolean;
  stopId: string;
  stopSequence: number;
  departureTime: string;
  headsign: string;
  /** A train's number; see `TransitLeg.tripNumber`. */
  tripNumber?: string | null;
  directionId: number;
  /** The line this run belongs to, as `/line/[lineCode]` opens it. */
  lineCode: string;
  /** Which of the line's directions -- `route_desc`'s digit, the key the line
   *  page's direction toggle uses (`LineDirection.direction`). */
  lineDirection: string;
  route: {
    routeId: string;
    /** GTFS `agency_id` -- the operating company, and what the route is
     *  coloured by. See `lib/route-color`. */
    agencyId: string | null;
    shortName: string | null;
    longName: string | null;
    type: number;
    color: string | null;
  };
  realtime: RealtimeInfo | null;
};

export type StopDeparturesResponse = {
  stopId: string;
  departures: Departure[];
  /**
   * The next departure BEYOND the window that was asked about, and only when
   * `departures` is empty -- so "nothing for an hour" can be told apart from
   * "nothing ever". Null when this stop has nothing scheduled for the next
   * eight days.
   */
  nextDeparture: Departure | null;
};

/** `GET /meta`, trimmed to what the app actually reads. */
export type MetaResponse = {
  realtime: {
    /**
     * `disabled` means no SIRI credentials are configured at all -- the
     * state this deployment is in until the ministry approves our key. The
     * app must show no live-vs-scheduled affordance at all in that state
     * (see `useRealtimeAvailable`), rather than labelling every departure
     * "scheduled", which would be noise on a board where nothing can ever
     * be anything else.
     */
    health: 'disabled' | 'ok' | 'stale' | 'failing';
    ageSeconds: number | null;
  };
  timezone: string;
};

/** Where one vehicle is right now, from `GET /vehicles`. */
export type LiveVehicle = {
  tripId: string;
  lat: number;
  lon: number;
  /** When the VEHICLE reported this, not when anyone fetched it. Null when
   *  the feed omitted it -- a UI showing an age must then say nothing rather
   *  than assume "now". */
  recordedAt: string | null;
  vehicleRef: string | null;
};

/**
 * `GET /vehicles?trips=...`.
 *
 * `vehicles` lists only the trips that HAVE a fresh position -- it is not a
 * per-trip result array, so callers key by `tripId` rather than by position.
 * On a keyless feed the server lists a vehicle only while its own report is
 * at most five minutes old, so a bus whose reports are lagging is simply
 * absent. `source` says which feed answered, so "this deployment has no live
 * positions at all" can be told from "this bus is not reporting".
 */
export type VehiclesResponse = {
  source: 'siri-sm' | 'open-bus-vm' | 'stride-vm' | null;
  vehicles: LiveVehicle[];
};

export type GeocodePlace = {
  label: string;
  /** Supporting context for a two-line list item (name as the bold line,
   *  this as the subtitle) -- null when there's nothing to add. */
  secondaryLabel: string | null;
  /** Exactly one of {`lat`/`lon`, `placeId`} is set. Google-backed results
   *  come without a position -- fetching one per suggestion is what costs --
   *  and the one picked is resolved through `resolvePlace`. */
  lat: number | null;
  lon: number | null;
  placeId: string | null;
  /** From the search's `near` point, when the position itself isn't in hand. */
  distanceMeters: number | null;
};

export type GeocodeSearchResponse = {
  places: GeocodePlace[];
};

export type GeocodeLocationResponse = {
  location: { lat: number; lon: number } | null;
};

export type GeocodeReverseResponse = {
  place: GeocodePlace | null;
};

export type ApiErrorBody = {
  statusCode: number;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
};

/** One stop on a trip's own timetable (`GET /trips/:tripId`). */
export type TripStopTime = {
  stop: {
    stopId: string;
    code: string | null;
    name: string | null;
    lat: number;
    lon: number;
    locationType: number;
    parentStation: string | null;
  };
  stopSequence: number;
  /** ISO-8601, rendered against the trip's own `serviceDate`. Null when the
   *  service has no remaining active date to render against. */
  arrivalTime: string | null;
  /** See `arrivalTime`. */
  departureTime: string | null;
};

/**
 * One vehicle's whole run: every stop it calls at, in order, with times.
 *
 * This is what a departure row leads to -- the answer to "where does this
 * actually go, and where do I get off", which a board of countdowns cannot
 * give on its own.
 */
export type TripDetail = {
  tripId: string;
  route: {
    routeId: string;
    agencyId: string | null;
    shortName: string | null;
    longName: string | null;
    type: number;
    color: string | null;
  };
  headsign: string | null;
  /** A train's number; see `TransitLeg.tripNumber`. */
  tripNumber?: string | null;
  directionId: number;
  wheelchairAccessible: number | null;
  /** YYYYMMDD, the date every ISO time above was rendered against. */
  serviceDate: number | null;
  stops: TripStopTime[];
};

/** A route row as the browse list needs it: a brief plus the raw `desc` the
 *  app groups lines on. See `features/lines/group-routes`. */
export type RouteListItem = {
  routeId: string;
  agencyId: string | null;
  shortName: string | null;
  longName: string | null;
  type: number;
  color: string | null;
  desc: string | null;
};

export type RoutesResponse = {
  routes: RouteListItem[];
  total: number;
};

/** One direction of a line, after the backend has collapsed alternatives. */
export type LineDirection = {
  /** `route_desc`'s direction digit -- the key. NOT GTFS `direction_id`,
   *  which maps digits 1 and 3 onto the same value. */
  direction: string;
  /** GTFS `direction_id`, for `/routes/:routeId/shape` only. */
  directionId: number;
  /** The representative route row for this direction. */
  routeId: string;
  headsign: string | null;
  stops: Place[];
};

export type LineDetail = {
  lineCode: string;
  shortName: string | null;
  longName: string | null;
  agencyId: string | null;
  type: number;
  directions: LineDirection[];
};

/** One scheduled run of a line: a chip in the run selector. */
export type RouteRun = {
  tripId: string;
  /** The run's identity: equals `tripId` for a timetable run. */
  runId: string;
  /** A live bus running off-timetable, listed on `tripId` as its template. */
  unscheduled: boolean;
  /** Seconds to add to `tripId`'s stop times for this run's own; 0 for a
   *  timetable run. */
  offsetSeconds: number;
  headsign: string | null;
  /** A train's number; see `TransitLeg.tripNumber`. */
  tripNumber?: string | null;
  departureTime: string;
  directionId: number;
};

export type RouteRunsResponse = {
  runs: RouteRun[];
};

export type RouteShapeResponse = {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  geometryFallback: boolean;
};

export type Agency = {
  agencyId: string;
  name: string | null;
  /** The route types this operator actually runs, ascending. What lets the
   *  Lines tab's two filters interlock instead of letting a rider ask for a
   *  rail operator's buses. */
  types: number[];
};

export type AgenciesResponse = {
  agencies: Agency[];
};
