import type { RouteRun } from '@/api/types';

/**
 * `iso` moved by `seconds`. An unscheduled run's stop times are its template
 * trip's, shifted by its start offset; a zero offset returns the string as
 * given, so a timetable run's times are never re-serialised. Total -- an
 * unparseable `iso` is returned unchanged rather than throwing.
 */
export function shiftIso(iso: string, seconds: number): string {
  if (seconds === 0) return iso;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? iso : new Date(at + seconds * 1000).toISOString();
}

/**
 * The run the line page is showing, held by the rider's own pick -- an
 * unscheduled bus shares its template trip's `tripId` with that trip's own
 * timetable run, so runs are told apart by `runId`.
 *
 * A held run keeps showing even after it leaves the list: the listed copy
 * when one still carries its `runId` (fresh times, and its chip active),
 * else the held snapshot itself (no chip active -- none in the list carries
 * that `runId` anymore). With nothing held, the default run (the one tapped
 * on a station board) when it is listed, else the first run. A default the
 * list does not name answers `null`: the page then keeps showing the board's
 * own trip rather than jumping to an unrelated run.
 */
export function activeRun(
  runs: readonly RouteRun[], held: RouteRun | null, defaultRunId: string | null,
): RouteRun | null {
  if (held !== null) return runs.find((r) => r.runId === held.runId) ?? held;
  if (defaultRunId !== null) return runs.find((r) => r.runId === defaultRunId) ?? null;
  return runs[0] ?? null;
}
