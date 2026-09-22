import { buildPatterns, type TripTimes } from "./patterns.js";
import type { TimetableIndex } from "./index.js";

/**
 * Builds a minimal index from explicit trips. Stops are 0..nStops-1 and
 * footpaths are supplied as [from, to, seconds] triples.
 *
 * Shared test scaffolding for both `raptor.test.ts` and
 * `raptorReverse.test.ts` — plain array plumbing, not part of the shipped
 * index-building path (that's `buildIndex` in `index.ts`).
 *
 * `opts.stopParent` defaults to "no stop has a parent station" and
 * `opts.footpathsRouted` to `false` -- the same "claims nothing" default
 * `buildIndex` itself uses for a fresh, footpath-less index. Both are
 * read by `itinerary.ts`'s transfer-leg `walkEstimated` derivation, so a
 * test exercising a chain-internal walk leg needs `ix.stopParent` to
 * exist at runtime even when it doesn't care about station grouping --
 * hence the default here, rather than leaving the field undefined and
 * relying on every caller to know to set it.
 */
export function makeTestIndex(
  nStops: number,
  trips: { stops: number[]; dep: number[]; arr: number[]; dist?: number[] }[],
  foot: [number, number, number][] = [],
  opts: { stopParent?: Int32Array; footpathsRouted?: boolean } = {},
): TimetableIndex {
  const tripTimes: TripTimes[] = trips.map((t) => ({
    stops: Int32Array.from(t.stops),
    departures: Int32Array.from(t.dep),
    arrivals: Int32Array.from(t.arr),
  }));
  const patterns = buildPatterns(tripTimes);

  const tripTimeOffset = new Int32Array(trips.length + 1);
  for (let i = 0; i < trips.length; i++) {
    tripTimeOffset[i + 1] = tripTimeOffset[i]! + trips[i]!.stops.length;
  }
  const total = tripTimeOffset[trips.length]!;
  const arrivalTime = new Int32Array(total);
  const departureTime = new Int32Array(total);
  // -1 is the index's "no shape_dist_traveled" sentinel, so a trip whose
  // caller supplied no `dist` reads as "distances unknown" -- which is what
  // every pre-existing test wants, and what makes `predictFromDistance`
  // correctly decline to place a vehicle on it.
  const stopDistance = new Int32Array(total).fill(-1);
  for (let i = 0; i < trips.length; i++) {
    arrivalTime.set(tripTimes[i]!.arrivals, tripTimeOffset[i]!);
    departureTime.set(tripTimes[i]!.departures, tripTimeOffset[i]!);
    const dist = trips[i]!.dist;
    if (dist !== undefined) stopDistance.set(Int32Array.from(dist), tripTimeOffset[i]!);
  }

  const counts = new Int32Array(nStops);
  for (let p = 0; p < patterns.nPatterns; p++) {
    for (let i = patterns.patternStopOffset[p]!; i < patterns.patternStopOffset[p + 1]!; i++) {
      counts[patterns.patternStops[i]!]!++;
    }
  }
  const stopPatternOffset = new Int32Array(nStops + 1);
  for (let s = 0; s < nStops; s++) stopPatternOffset[s + 1] = stopPatternOffset[s]! + counts[s]!;
  const stopPatterns = new Int32Array(stopPatternOffset[nStops]!);
  const stopPatternPos = new Int32Array(stopPatternOffset[nStops]!);
  const fill = stopPatternOffset.slice(0, nStops);
  for (let p = 0; p < patterns.nPatterns; p++) {
    const from = patterns.patternStopOffset[p]!;
    for (let i = from; i < patterns.patternStopOffset[p + 1]!; i++) {
      const s = patterns.patternStops[i]!;
      const at = fill[s]!;
      stopPatterns[at] = p;
      stopPatternPos[at] = i - from;
      fill[s] = at + 1;
    }
  }

  const footOffset = new Int32Array(nStops + 1);
  const sorted = [...foot].sort((a, b) => a[0] - b[0]);
  const perStop = new Map<number, [number, number][]>();
  for (const [f, t, s] of sorted) {
    const b = perStop.get(f);
    if (b === undefined) perStop.set(f, [[t, s]]); else b.push([t, s]);
  }
  const footTarget: number[] = [];
  const footSeconds: number[] = [];
  for (let s = 0; s < nStops; s++) {
    footOffset[s] = footTarget.length;
    for (const [t, secs] of perStop.get(s) ?? []) { footTarget.push(t); footSeconds.push(secs); }
  }
  footOffset[nStops] = footTarget.length;

  return {
    ...patterns,
    nStops, nTrips: trips.length,
    tripTimeOffset, arrivalTime, departureTime, stopDistance,
    stopPatterns, stopPatternPos, stopPatternOffset,
    footOffset, footTarget: Int32Array.from(footTarget), footSeconds: Int32Array.from(footSeconds),
    stopParent: opts.stopParent ?? new Int32Array(nStops).fill(-1),
    footpathsRouted: opts.footpathsRouted ?? false,
  } as unknown as TimetableIndex;
}
