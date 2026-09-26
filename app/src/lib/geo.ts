/** Great-circle distance in meters. Mirrors api's own `geo.ts` --
 *  same formula, kept separate since this is a different package. */
export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_008.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A point on the ground: every stop, every fix, every reported bus. */
type LatLon = { lat: number; lon: number };

/**
 * Whether something at `point` has LEFT `stop`, given the stop that follows it.
 *
 * Nearest-stop answers a different question -- "which stop is this closest to"
 * -- and the two differ by a whole stop, because the nearest stop flips to the
 * one ahead at the MIDPOINT between two stops, long before the vehicle gets
 * there. Treating that stop as already called at drops any "stops remaining"
 * count by one for the whole second half of every gap, and at a one-stop alert
 * lead that is the get-off alarm sounding while the bus still has to stop
 * somewhere else first. Reported from the field as "the next stop is not my
 * stop, there are 2 more".
 *
 * So `point` has left `stop` only once it is at least as close to the stop
 * after it as that stop itself is. No route shape needed, which is what makes
 * it usable at all: `geometry` is nullable on every leg.
 *
 * `following` is required rather than optional because running out of stops
 * means genuinely different things to different callers -- the last stop is
 * "as reached as this ride gets" to a count, and "the stop still to come" to a
 * name -- and a default here would quietly pick one of them. Each caller says
 * which it means.
 *
 * `distance` is injected because the callers measure differently on purpose:
 * `journey-machine` wants the great circle, `first-relevant-stop` an
 * equirectangular approximation it documents as plenty at city scale. The RULE
 * is the thing that has to be shared, not the metric -- two copies of this
 * test, one with `<` and one with `<=`, is how a stop count and a stop name
 * drifted a stop apart while both looked right.
 */
export function hasLeftStop(
  point: LatLon,
  stop: LatLon,
  following: LatLon,
  distance: (a: LatLon, b: LatLon) => number,
): boolean {
  return distance(point, following) <= distance(stop, following);
}
