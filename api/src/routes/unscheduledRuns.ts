import type { UnscheduledRun } from "../realtime/match.js";

/**
 * A stable row identity for an unscheduled run, shared by the departure
 * board and the line page so both name the same bus the same way. Its
 * template trip's id plus the vehicle (or, with no vehicle ref, the start
 * offset); suffixed `#2`, `#3`… when that still repeats within one response,
 * so a client keying rows by it never collides. `taken` is per response.
 */
export function runIdFor(tripId: string, run: UnscheduledRun, taken: Set<string>): string {
  const base = `${tripId}@${run.journey.vehicleRef ?? run.offsetSeconds}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}#${n}`;
  taken.add(id);
  return id;
}
