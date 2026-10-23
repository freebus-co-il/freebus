import type { Itinerary } from '@/api/types';

/**
 * Whether a re-plan's answer may still be applied: the journey is the one it
 * was asked for, and nothing has changed its itinerary since -- not a line the
 * rider picked, not an earlier run they boarded, not an offer they accepted.
 * Splicing an answer onto an itinerary that has moved on would undo the
 * rider's own choice.
 */
export function responseApplies(
  journeyId: string,
  before: Itinerary,
  current: { id: string; itinerary: Itinerary } | null,
): boolean {
  return current !== null && current.id === journeyId && current.itinerary === before;
}

/**
 * The ride whose get-off alarm the journey should answer for the rider, now
 * that it has moved on from it -- whether or not the in-app alert fired (the
 * app may have been asleep while the OS rang). Null when there is nothing to
 * answer.
 */
export function legToAcknowledge(
  previous: number | null,
  current: number | null,
  itinerary: Itinerary,
  acknowledged: number | null,
): number | null {
  if (previous === null || current === null || current <= previous) return null;
  if (itinerary.legs[previous]?.type !== 'transit' || acknowledged === previous) return null;
  return previous;
}
