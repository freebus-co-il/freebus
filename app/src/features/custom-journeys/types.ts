import type { SelectedPlace } from '@/lib/place';

/**
 * How the rider gets from the point before to this one. `any` leaves it to
 * the planner; the others are the rider insisting (the train to Tel Aviv, not
 * the bus that happens to be quicker today).
 */
export type PointVia = 'any' | 'walk' | 'bus' | 'train';

export const POINT_VIAS: readonly PointVia[] = ['any', 'walk', 'bus', 'train'];

/** One place the rider pins on their way: home, a station, a favourite stop. */
export type JourneyPoint = {
  id: string;
  place: SelectedPlace;
  /** How the step INTO this point is made. Ignored on the first point. */
  via: PointVia;
};

/**
 * A journey the rider built and saved: the places they always pass through,
 * in order. What runs between them is decided each time it is started, from
 * the boards at the time.
 */
export type CustomJourney = {
  id: string;
  name: string;
  points: JourneyPoint[];
  createdAt: string;
};

/** What a running journey remembers about the saved one it was started from. */
export type CustomJourneyRef = {
  id: string;
  name: string;
};

export function newPointId(): string {
  return `p${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
}

export function newCustomJourneyId(): string {
  return `cj${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
}

/**
 * The way back: the same points in reverse, each step made the way it was
 * made going out. The rider then adjusts it (an extra stop outside the
 * station's other exit, say) rather than building it from nothing.
 */
export function reversedPoints(points: readonly JourneyPoint[]): JourneyPoint[] {
  const reversed = [...points].reverse();
  return reversed.map((point, index) => ({
    id: newPointId(),
    place: point.place,
    // Step i of the way back is step (n - i) of the way out, whose `via` sat
    // on the point after it, which is the point before this one here.
    via: index === 0 ? 'any' : reversed[index - 1]!.via,
  }));
}
