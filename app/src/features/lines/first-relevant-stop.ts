export type RelevantStopInput = {
  /** The run's stops in travel order, each with its scheduled time (ISO-8601)
   *  when the surface has one. */
  stops: readonly { lat: number; lon: number; time: string | null }[];
  /** The rider's own stop, or -1 when the page was not opened from one. */
  boardingIndex: number;
  /** The selected run's live position, when the bus is reporting one. */
  bus: { lat: number; lon: number } | null;
  now: Date;
};

/** How close a live bus has to be to a stop to count as at it: the stop across
 *  the road, or a terminal's arrival platform beside its departure one, is
 *  well inside this; the next stop down the road is not. */
const NEAR_STOP_METERS = 150;
const EARTH_RADIUS_METERS = 6_371_000;

/** Equirectangular distance in metres -- plenty at city scale. */
function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRadians = Math.PI / 180;
  const dx = (a.lon - b.lon) * toRadians * Math.cos(b.lat * toRadians);
  const dy = (a.lat - b.lat) * toRadians;
  return Math.sqrt(dx * dx + dy * dy) * EARTH_RADIUS_METERS;
}

/** The last stop the timetable says the run has already reached; -1 when
 *  nothing has been passed, or the stops carry no times. */
function timetableStopIndex(stops: RelevantStopInput['stops'], now: Date): number {
  let passed = -1;
  stops.forEach((stop, index) => {
    if (stop.time === null) return;
    const at = new Date(stop.time).getTime();
    if (!Number.isNaN(at) && at <= now.getTime()) passed = index;
  });
  return passed;
}

/**
 * Where the bus is along its stops. -1 when nothing has been passed.
 *
 * Without a live position, the timetable alone. With one, the stops within
 * `NEAR_STOP_METERS` of the bus -- and of those, the one whose place in the
 * run is closest to where the timetable puts the bus. Distance alone ignores
 * route order: on an out-and-back or U-shaped route a bus at stop 5 can be
 * nearest stop 40 across the road, and at a loop's terminal GPS noise can pick
 * the last stop and fold away the whole run. With no timetable to go on, the
 * earliest nearby stop wins -- folding too little is the safer mistake. With
 * no stop that close, the single nearest stop is still the best guess.
 */
export function busStopIndex(input: RelevantStopInput): number {
  const { stops, bus, now } = input;
  const passed = timetableStopIndex(stops, now);
  if (bus === null) return passed;
  let nearest = 0;
  let nearby = -1;
  stops.forEach((stop, index) => {
    const distance = distanceMeters(stop, bus);
    if (distance < distanceMeters(stops[nearest]!, bus)) nearest = index;
    // Measured against `passed` even when it is -1, which makes the earliest
    // nearby stop the closest; a tie keeps the earlier stop.
    if (distance <= NEAR_STOP_METERS && (nearby === -1 || Math.abs(index - passed) < Math.abs(nearby - passed))) {
      nearby = index;
    }
  });
  return nearby === -1 ? nearest : nearby;
}

/**
 * The stop a line or run page's stop list should start at. Everything before
 * it is behind the bus, or before the rider's own stop, and is folded behind
 * a "N previous stops" row the rider can expand.
 *
 * Whichever is further along wins: a rider at their stop does not care where
 * the bus came from, and once the bus is past their stop the stops it has
 * already left are history too.
 */
export function firstRelevantStopIndex(input: RelevantStopInput): number {
  if (input.stops.length === 0) return 0;
  const index = Math.max(input.boardingIndex, busStopIndex(input), 0);
  return Math.min(index, input.stops.length - 1);
}

/**
 * Re-dates a trip's own stop times onto the run they were picked from.
 *
 * The trip endpoint can answer a run's stop times against an earlier service
 * date than the run itself departs on -- GTFS trips repeat across days, and
 * the endpoint resolves whichever calendar instance it finds first, not
 * necessarily the one the rider tapped. Left uncorrected, every time reads as
 * already passed, and `firstRelevantStopIndex` folds away a run that has not
 * even started.
 *
 * The fix needs no server change: shift every time by the gap between the
 * run's own departure and the trip's own time at that same anchor stop, and
 * every stop lands back on the run's actual day. Pure and total -- a missing
 * or unparseable anchor leaves the times exactly as given, rather than
 * guessing a delta from bad data.
 */
export function alignStopTimesToRun(
  times: readonly (string | null)[],
  tripAnchorTime: string | null,
  runDeparture: string | null,
): (string | null)[] {
  if (tripAnchorTime === null || runDeparture === null) return [...times];
  const anchor = new Date(tripAnchorTime).getTime();
  const departure = new Date(runDeparture).getTime();
  if (Number.isNaN(anchor) || Number.isNaN(departure)) return [...times];
  const delta = departure - anchor;
  return times.map((time) => {
    if (time === null) return null;
    const at = new Date(time).getTime();
    return Number.isNaN(at) ? time : new Date(at + delta).toISOString();
  });
}
