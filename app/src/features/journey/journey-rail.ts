import type { Itinerary } from '@/api/types';
import { routeColor, WALK_LEG_COLOR } from '@/lib/route-color';

/** One leg's absolute span on the wall clock. */
export type LegWindow = { legIndex: number; startsAt: string; endsAt: string; seconds: number };

export type RailSegment = {
  legIndex: number;
  seconds: number;
  color: string;
  kind: 'walk' | 'transit';
};

/** A moment the rider must act -- drawn as a diamond on iOS, a
 *  `ProgressStyle.Point` on Android. */
export type RailPoint = { atSeconds: number };

export type JourneyRail = { totalSeconds: number; segments: RailSegment[]; points: RailPoint[] };

/**
 * Each leg's absolute span, walking a "ready at" instant forward exactly as
 * `build-trip-steps.ts` does.
 *
 * The wait before boarding is folded into the RIDE's window rather than given
 * one of its own. A rider stood at the stop is already on that leg as far as
 * every surface is concerned -- the hero they need is the line they are
 * waiting for, and a separate wait window would make the rail show a gap where
 * the rider experiences a single "I am catching the 480".
 */
export function buildLegSchedule(itinerary: Itinerary): LegWindow[] {
  const windows: LegWindow[] = [];
  let readyAt = itinerary.departureTime;

  itinerary.legs.forEach((leg, legIndex) => {
    if (leg.type === 'walk') {
      const endsAt = new Date(new Date(readyAt).getTime() + leg.durationSeconds * 1000).toISOString();
      windows.push({ legIndex, startsAt: readyAt, endsAt, seconds: leg.durationSeconds });
      readyAt = endsAt;
      return;
    }
    const endsAt = leg.to.arrivalTime;
    const seconds = (new Date(endsAt).getTime() - new Date(readyAt).getTime()) / 1000;
    windows.push({ legIndex, startsAt: readyAt, endsAt, seconds });
    readyAt = endsAt;
  });

  return windows;
}

/**
 * The journey as a bar: coloured segments, with a diamond at every moment the
 * rider changes vehicle.
 *
 * ONE model, two renderers -- SwiftUI draws it and Android's `ProgressStyle`
 * consumes it as segments and points -- so the two platforms cannot drift into
 * different pictures of the same journey.
 */
export function buildJourneyRail(itinerary: Itinerary): JourneyRail {
  const segments: RailSegment[] = buildLegSchedule(itinerary).map((window) => {
    const leg = itinerary.legs[window.legIndex];
    return leg.type === 'walk'
      ? { legIndex: window.legIndex, seconds: window.seconds, color: WALK_LEG_COLOR, kind: 'walk' as const }
      : { legIndex: window.legIndex, seconds: window.seconds, color: routeColor(leg.route), kind: 'transit' as const };
  });

  // A point marks LEAVING a vehicle for another one, so the last transit
  // segment never gets one -- that boundary is the arrival, which the rail
  // already ends with. Marking it would put a diamond on the destination flag.
  const lastTransit = segments.map((segment) => segment.kind).lastIndexOf('transit');
  const points: RailPoint[] = [];
  let elapsed = 0;
  segments.forEach((segment, index) => {
    elapsed += segment.seconds;
    if (segment.kind === 'transit' && index !== lastTransit) points.push({ atSeconds: elapsed });
  });

  return { totalSeconds: segments.reduce((sum, s) => sum + s.seconds, 0), segments, points };
}
