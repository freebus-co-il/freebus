import type { JourneyPoint } from '@/features/custom-journeys/types';
import { haversineMeters } from '@/lib/geo';
import { placeCoordinates, type SelectedPlace } from '@/lib/place';

/**
 * What the commute card plans. Every kind offers ONE trip at a time, chosen
 * by where the rider is standing, so the card always answers "the way I am
 * about to go" rather than asking which way.
 *
 * - `smart`: Home and Work, the card as it first shipped: to work when at
 *   home, home from anywhere else.
 * - `places`: any two saved places, back and forth.
 * - `journeys`: a saved custom journey and its way back, which is either the
 *   same journey reversed or another journey the rider picked.
 *
 * Places and journeys are stored by id, so renaming or moving one in its own
 * editor carries through; an id that no longer resolves just leaves the card
 * asking to be set up again.
 */
export type CommuteSource =
  | { kind: 'smart' }
  | { kind: 'places'; first: string | null; second: string | null }
  | { kind: 'journeys'; there: string | null; back: CommuteBack };

/** `reverse` walks the outbound journey's points backwards; anything else is
 *  the id of the journey to take home. */
export type CommuteBack = 'reverse' | string;

export type CommuteSourceKind = CommuteSource['kind'];

export const COMMUTE_SOURCE_KINDS: readonly CommuteSourceKind[] = ['smart', 'places', 'journeys'];

export const DEFAULT_COMMUTE_SOURCE: CommuteSource = { kind: 'smart' };

/** Switching kind starts that kind empty, rather than carrying ids that mean
 *  nothing to it. */
export function emptyCommuteSource(kind: CommuteSourceKind): CommuteSource {
  if (kind === 'places') return { kind, first: null, second: null };
  if (kind === 'journeys') return { kind, there: null, back: 'reverse' };
  return { kind: 'smart' };
}

const idOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Read defensively like every other preference: anything unrecognised is
 *  the original Home and Work card. */
export function parseCommuteSource(raw: unknown): CommuteSource {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (stored.kind === 'places') {
    return { kind: 'places', first: idOrNull(stored.first), second: idOrNull(stored.second) };
  }
  if (stored.kind === 'journeys') {
    return { kind: 'journeys', there: idOrNull(stored.there), back: idOrNull(stored.back) ?? 'reverse' };
  }
  return { kind: 'smart' };
}

type Position = { lat: number; lon: number };

function distanceTo(here: Position, place: SelectedPlace): number {
  const at = placeCoordinates(place);
  return at ? haversineMeters(here, at) : Number.POSITIVE_INFINITY;
}

/**
 * Of two places, the one to plan TO: the one the rider is further from. The
 * nearer of the two is where they are, or nearly; standing between them, the
 * trip goes to the one further off, which is the one there is a trip to.
 * A place with no coordinates counts as far, so it is planned to rather than
 * from. Index 0 for `a`, 1 for `b`.
 */
export function placeDestinationIndex(here: Position, a: SelectedPlace, b: SelectedPlace): 0 | 1 {
  return distanceTo(here, a) >= distanceTo(here, b) ? 0 : 1;
}

/**
 * Of a journey and its way back, the one to preview: the one whose first
 * point is closer to the rider, because that is the one they can start from
 * here. Without a fix, the outbound one. Ties go to the earlier candidate.
 */
export function closestStartIndex(here: Position | null, candidates: readonly (readonly JourneyPoint[])[]): number {
  if (here === null || candidates.length === 0) return 0;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  candidates.forEach((points, index) => {
    const first = points[0];
    const distance = first ? distanceTo(here, first.place) : Number.POSITIVE_INFINITY;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}
