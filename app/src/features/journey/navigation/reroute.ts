/** Off the walk's line for this long before re-routing: long enough that one
 *  wild fix, or cutting a corner, does not throw away a good route. */
export const REROUTE_AFTER_OFF_ROUTE_SECONDS = 8;
/** At most one re-route in this long -- a rider wandering around a square must
 *  not turn into a request every few seconds. */
export const REROUTE_MIN_INTERVAL_SECONDS = 30;
/** A fix vaguer than this cannot say the rider has left the line at all. */
export const REROUTE_MAX_ACCURACY_METERS = 50;

export type RerouteInput = {
  /** When the rider was first seen off the line, continuously since; null while on it. */
  offRouteSince: string | null;
  /** When the last re-route was asked for; null before the first. */
  lastRerouteAt: string | null;
  accuracyMeters: number;
  now: Date;
};

/** Whether to ask the server for a new walk from where the rider is. */
export function shouldReroute({ offRouteSince, lastRerouteAt, accuracyMeters, now }: RerouteInput): boolean {
  if (offRouteSince === null || accuracyMeters > REROUTE_MAX_ACCURACY_METERS) return false;
  const secondsSince = (iso: string) => (now.getTime() - new Date(iso).getTime()) / 1000;
  if (secondsSince(offRouteSince) < REROUTE_AFTER_OFF_ROUTE_SECONDS) return false;
  return lastRerouteAt === null || secondsSince(lastRerouteAt) >= REROUTE_MIN_INTERVAL_SECONDS;
}
