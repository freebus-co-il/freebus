import type { Itinerary, TransitLeg } from '@/api/types';

/** Below this many grouped departures there is no cadence worth claiming --
 *  two departures give a single gap, which is an observation, not a pattern. */
const MIN_INSTANCES_FOR_CADENCE = 3;
/** A run of gaps whose largest exceeds this multiple of the median is not a
 *  regular service, and must not be advertised as one. */
const CADENCE_IRREGULARITY_LIMIT = 2;

/** The first ride in the journey -- the vehicle the rider has to find, board,
 *  and get the direction of right. Null for a walk-only itinerary. */
export function firstTransitLeg(itinerary: Itinerary): TransitLeg | null {
  for (const leg of itinerary.legs) {
    if (leg.type === 'transit') return leg;
  }
  return null;
}

/** Whole minutes from `now` until `iso`. Negative once it is in the past. */
export function minutesUntil(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
}

/** Past this, a countdown stops being useful and starts being arithmetic --
 *  "leave in 143 min" is a worse answer than "leave at 14:20". */
export const LEAVE_COUNTDOWN_MAX_MINUTES = 60;

/**
 * How the leave-by time should read right now.
 *
 * The four cases -- and the hour ceiling that separates a countdown from a
 * clock time -- live here rather than in a card so that every surface saying
 * "when do I move" says it on the same thresholds. Each caller still picks its
 * own strings and type scale; what must not drift is WHEN a countdown becomes
 * a clock time, and when it becomes an admission that the bus has gone.
 */
export type LeaveState =
  | { kind: 'departed' }
  | { kind: 'now' }
  | { kind: 'countdown'; minutes: number }
  | { kind: 'clockTime' };

export function leaveState(departureTime: string, now: Date): LeaveState {
  const minutes = minutesUntil(departureTime, now);
  if (minutes < 0) return { kind: 'departed' };
  if (minutes < 1) return { kind: 'now' };
  if (minutes <= LEAVE_COUNTDOWN_MAX_MINUTES) return { kind: 'countdown', minutes };
  return { kind: 'clockTime' };
}

/**
 * The typical gap between this group's departures, in minutes, or null when
 * there is no honest cadence to report.
 *
 * "Another one in ~14 minutes" is the single cheapest way to defuse the fear
 * of missing a bus in an unfamiliar place, but only when it is true. Uses the
 * MEDIAN gap rather than the mean, and refuses outright when the largest gap
 * runs past `CADENCE_IRREGULARITY_LIMIT` times it: a service that goes 5, 5,
 * 55 minutes averages to something reassuring and reads as a promise the
 * timetable does not make.
 */
export function departureFrequencyMinutes(instances: Itinerary[]): number | null {
  if (instances.length < MIN_INSTANCES_FOR_CADENCE) return null;

  const times = instances
    .map((instance) => new Date(instance.departureTime).getTime())
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i]! - times[i - 1]!) / 60_000);

  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median < 1) return null;
  if (Math.max(...gaps) > median * CADENCE_IRREGULARITY_LIMIT) return null;

  return Math.round(median);
}

/**
 * A GTFS headsign as something a rider can read.
 *
 * This feed writes headsigns as `city_place` ("חולון_פארק פרס"). The place is
 * the useful half -- it is what is printed on the front of the vehicle -- so
 * it leads, with the city trailing it the way an address reads.
 *
 * The underscore is a field separator and never part of a name, so none may
 * survive: the leading segment is the city and everything after it is the
 * place, however many separators the feed happened to put in between. Empty
 * segments are dropped rather than punctuated, so a headsign missing one half
 * reads as the half it has instead of a stray comma.
 *
 * A rail headsign arrives from the API as a plain station name already (the
 * train's final stop), with no separator, so it passes through untouched.
 */
export function formatHeadsign(headsign: string): string {
  const parts = headsign
    .split('_')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return '';
  const [city, ...place] = parts as [string, ...string[]];
  return place.length === 0 ? city : `${place.join(' ')}, ${city}`;
}

/**
 * A train's number, or null when there is none to show.
 *
 * Secondary by design: a rider at a platform matches the train by where it
 * ends, which the headsign carries, and the number only confirms it. Null for
 * every non-rail trip, for a blank value, and for an older API that does not
 * send the field at all -- each of which must render exactly as before.
 */
export function tripNumberOf(trip: { tripNumber?: string | null }): string | null {
  const number = trip.tripNumber?.trim() ?? '';
  return number === '' ? null : number;
}
