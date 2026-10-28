/**
 * The runs whose buses the line page draws when it was opened from a station
 * board: the rider's run, the run ahead of it and the run behind it, in the
 * order they reach the rider's stop.
 *
 * Its own module so the rule is testable without a map. A run the list does
 * not name is still drawn, alone -- the rider tapped it, and the bus they are
 * waiting for matters more than the neighbours the list could not place.
 */
export function runNeighbours(
  runs: readonly { tripId: string }[], tripId: string | null,
): string[] {
  if (tripId === null) return [];
  const index = runs.findIndex((run) => run.tripId === tripId);
  if (index === -1) return [tripId];
  return runs.slice(Math.max(0, index - 1), index + 2).map((run) => run.tripId);
}
