import type { Itinerary, Place, TransitAlternative, TransitLeg } from '@/api/types';
import { equallyGoodLines } from '@/features/trip/line-options';

import { respectsBackbone, sameStation, stationOf, type Backbone } from '../replan/backbone';

/** Slack below this is "hurry": a red light or a slow lift eats two minutes. */
const PLENTY_SECONDS = 120;
/** How many other lines the stop view names beside the hero. */
const ALSO_LINES = 2;

export type WalkVerdict = 'plenty' | 'hurry' | 'late';

export function walkVerdict(slackSeconds: number): WalkVerdict {
  if (slackSeconds >= PLENTY_SECONDS) return 'plenty';
  return slackSeconds >= 0 ? 'hurry' : 'late';
}

export type AlsoLine = Pick<TransitAlternative, 'route' | 'tripId' | 'headsign'> & { departureTime: string };

function departs(leg: Pick<TransitLeg, 'from' | 'realtime'>): string {
  return leg.realtime?.predictedDeparture ?? leg.from.departureTime;
}

/**
 * The other lines that work from the stop the rider is standing at, soonest
 * first: the ride's own equally good alternatives, plus the first ride of
 * any fresh way that boards at this same station. One per line, none already
 * gone, never the hero's own line.
 */
export function alsoLines(
  leg: TransitLeg,
  candidates: readonly Itinerary[],
  nowMs: number,
  backbone: Backbone | null = null,
): AlsoLine[] {
  const here = stationOf(leg.from.stop);
  const pool: AlsoLine[] = equallyGoodLines(leg).map((alt) => ({ ...alt, departureTime: departs(alt) }));
  for (const candidate of candidates) {
    // A line that drops the rider's own kind of trip is not "one that works".
    if (backbone !== null && !respectsBackbone(candidate, backbone)) continue;
    const first = candidate.legs.find((l): l is TransitLeg => l.type === 'transit');
    if (first && sameStation(stationOf(first.from.stop), here)) pool.push({ ...first, departureTime: departs(first) });
  }
  const seen = new Set([leg.route.shortName]);
  return pool
    .filter((line) => Date.parse(line.departureTime) >= nowMs)
    .sort((a, b) => Date.parse(a.departureTime) - Date.parse(b.departureTime))
    .filter((line) => {
      if (seen.has(line.route.shortName)) return false;
      seen.add(line.route.shortName);
      return true;
    })
    .slice(0, ALSO_LINES);
}

export type StopLadder = { next: Place; after: Place | null; hidden: number; alight: Place };

/**
 * The stops still ahead on a ride, as the sheet lists them: the next one
 * (the name the bus's own screen shows), the one after, how many more, and
 * the stop to get off at. Null without a stop count -- the sheet never
 * invents one.
 */
export function stopLadder(leg: TransitLeg, stopsRemaining: number | null): StopLadder | null {
  if (stopsRemaining === null || stopsRemaining < 1) return null;
  const ahead = [...leg.intermediateStops, leg.to.stop].slice(-stopsRemaining);
  const next = ahead[0]!;
  const alight = leg.to.stop;
  const middle = ahead.slice(1, -1);
  return { next, after: middle[0] ?? null, hidden: Math.max(0, middle.length - 1), alight };
}
