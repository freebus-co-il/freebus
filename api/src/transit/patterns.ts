export interface TripTimes {
  /** Stop refs in stop_sequence order. */
  stops: Int32Array;
  /** Departure seconds, parallel to `stops`. May exceed 86400. */
  departures: Int32Array;
  /** Arrival seconds, parallel to `stops`. */
  arrivals: Int32Array;
}

export interface PatternSet {
  nPatterns: number;
  /** tripIndex -> patternIndex */
  patternOfTrip: Int32Array;
  /** Flat stop refs; pattern p occupies [patternStopOffset[p], patternStopOffset[p+1]). */
  patternStops: Int32Array;
  patternStopOffset: Int32Array;
  /**
   * Flat trip indices, totally ordered at every stop (not just the first),
   * in BOTH arrays: trip k's departures AND arrivals are each pointwise <=
   * trip k+1's within a pattern. RAPTOR's binary search over this order (see
   * `raptor.ts`'s `earliestTripOnDay`) picks a trip by departure only, but
   * then reads that trip's ARRIVAL at every later stop while riding it —
   * that read is only ever correct if arrivals are ordered the same way
   * departures are, which is why both arrays must be jointly non-decreasing,
   * not just departures.
   */
  patternTrips: Int32Array;
  patternTripOffset: Int32Array;
  /**
   * Seconds from the pattern's FIRST stop to each of its stops, parallel to
   * `patternStops` (so position `i` of pattern `p` is at `patternStopOffset[p]
   * + i`). Taken from the pattern's first trip: `departures[i] -
   * departures[0]`, which is >= 0 because departures never decrease along a
   * trip.
   *
   * It exists for exactly one caller, and the reason is a real defect it
   * fixes. `headway.ts` tabulates each pattern's gaps by the hour of the
   * departure at its FIRST stop, but the boarding instant RAPTOR looks a
   * margin up with is at the stop the rider is actually boarding at. The gap
   * MAGNITUDE is position-independent -- trips never overtake -- but that
   * does not extend to which hour bucket the gap belongs to. Measured on the
   * real feed (4,266,009 active (trip, boardable position) departures),
   * 14.8% landed in a different bucket than a per-position table would give,
   * and the worst case charged 105 s where the next departure AT THAT STOP
   * was an hour away and the rule wants the full 600 s cap. Subtracting this
   * offset before the lookup maps a boarding instant back to the equivalent
   * first-stop departure, which is the instant the table is keyed on.
   *
   * Measured against what missing a boarding actually costs -- the real gap
   * to the next departure at that position -- the shift takes under-pricing
   * from 8.44% of boardings to 7.49%, with the severe (>= 300 s short) tail
   * flat at 0.19% and the same worst case, which sits at position 0 where
   * the shift is zero by definition and is the ordinary hour-bucketing
   * approximation this whole margin scheme already accepts.
   *
   * One `Int32Array` entry per pattern-stop, built ONCE per index rather than
   * per service day: the offset is a property of the timetable's shape, not
   * of which trips happen to run today. The alternative -- a headway table
   * keyed by (pattern-stop, hour) rather than (pattern, hour) -- is exact for
   * trips whose running times differ, and costs ~20 MB per service day
   * against this feed instead of ~828 KB. Not worth it: the residual
   * approximation this leaves (a pattern whose trips have materially
   * different running times shifts by its first trip's offset, not by the
   * boarded trip's) is bounded by the spread of running times within one
   * pattern and is the same class of bucketing error already accepted
   * elsewhere in this margin scheme.
   */
  patternTravelSeconds: Int32Array;
}

/**
 * Lexicographic comparison of two trips across all stops, interleaving each
 * stop's departure and arrival: compare departure at position 0, then
 * arrival at position 0, then departure at position 1, and so on, returning
 * at the first value where they differ (0 if identical throughout).
 *
 * Comparing departures alone is not enough to establish the ordering RAPTOR
 * actually depends on (see `patternTrips` above): two trips can be perfectly
 * ordered by departure at every stop while still crossing in arrival (e.g.
 * different dwell times), and `overtakes` below now treats that crossing as
 * a conflict requiring a split. Once split, the survivors within a pattern
 * are guaranteed to jointly dominate each other in both arrays, so — exactly
 * as with the departures-only version this replaces — the FIRST position at
 * which the interleaved sequences differ necessarily has the same sign as
 * the overall domination direction, making lexicographic order and
 * domination order the same thing on exactly the pairs that matter.
 */
function compareTimes(a: TripTimes, b: TripTimes): number {
  // Same stop sequence implies same length; indices are in range.
  const len = a.departures.length;
  for (let i = 0; i < len; i++) {
    const ad = a.departures[i]!;
    const bd = b.departures[i]!;
    if (ad !== bd) return ad - bd;
    const aa = a.arrivals[i]!;
    const ba = b.arrivals[i]!;
    if (aa !== ba) return aa - ba;
  }
  return 0;
}

/**
 * True when `a` and `b` cannot coexist in one RAPTOR pattern: neither trip
 * dominates the other at every position in BOTH arrays. Departure-only
 * domination is not sufficient — two trips can stay perfectly ordered by
 * departure throughout while crossing in arrival (different dwell times),
 * and riding a pattern whose arrivals aren't jointly ordered would read the
 * wrong trip's arrival after such a crossing. `aFirst`/`bFirst` are set from
 * either array: if `a` ever leads (in departure OR arrival) and `b` ever
 * leads elsewhere (in departure OR arrival), neither fully dominates, so
 * they conflict. Both trips are known to share a stop sequence, so their
 * time arrays are the same length.
 */
function overtakes(a: TripTimes, b: TripTimes): boolean {
  let aFirst = false;
  let bFirst = false;
  for (let i = 0; i < a.departures.length; i++) {
    // Same stop sequence implies same length; indices are in range.
    const ad = a.departures[i]!;
    const bd = b.departures[i]!;
    const aa = a.arrivals[i]!;
    const ba = b.arrivals[i]!;
    if (ad < bd || aa < ba) aFirst = true;
    if (bd < ad || ba < aa) bFirst = true;
    if (aFirst && bFirst) return true;
  }
  return false;
}

export function buildPatterns(trips: readonly TripTimes[]): PatternSet {
  // 1. Group by identical stop sequence.
  const groups = new Map<string, number[]>();
  for (let t = 0; t < trips.length; t++) {
    const key = trips[t]!.stops.join(",");
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [t]);
    else bucket.push(t);
  }

  const patternStopLists: Int32Array[] = [];
  const patternTripLists: number[][] = [];
  const patternOfTrip = new Int32Array(trips.length);

  for (const [, members] of groups) {
    // 2. Order lexicographically across all stops, interleaving departure
    //    and arrival at each (see `compareTimes`). RAPTOR's binary search
    //    over a pattern's trips depends on this ordering being consistent
    //    with pointwise domination in BOTH arrays, not merely on departure at
    //    the first stop — a first-stop-only sort ties whenever two trips
    //    share a first-stop departure and falls back to unrelated insertion
    //    order, which can silently misorder the pattern.
    members.sort((x, y) => compareTimes(trips[x]!, trips[y]!));

    // 3. Split on overtaking via greedy first-fit graph coloring: a trip joins
    //    the first sub-pattern none of whose members it overtakes, otherwise
    //    it starts a new one. Greedy first-fit always yields a proper coloring
    //    (no conflicting pair ends up sharing a color) regardless of vertex
    //    order, so every sub-pattern is guaranteed conflict-free. Combined with
    //    the lexicographic sort above, non-overtaking between two trips means
    //    the earlier-sorted one is <= the other at every stop in BOTH arrays
    //    (see `compareTimes` and `overtakes`), and that pointwise <= is
    //    transitive, so each sub-pattern's members end up totally ordered at
    //    every stop in both departure and arrival, not just pairwise
    //    compatible. Splitting triggers on any departure OR arrival
    //    crossing, so more than the original 8 departure-only pairs split in
    //    the real feed.
    const subs: number[][] = [];
    for (const t of members) {
      let placed = false;
      for (const sub of subs) {
        let conflicts = false;
        for (const other of sub) {
          if (overtakes(trips[t]!, trips[other]!)) { conflicts = true; break; }
        }
        if (!conflicts) { sub.push(t); placed = true; break; }
      }
      if (!placed) subs.push([t]);
    }

    for (const sub of subs) {
      const p = patternStopLists.length;
      // Every member shares the same stop sequence, so any member's is the
      // pattern's; `sub` is non-empty by construction.
      patternStopLists.push(trips[sub[0]!]!.stops);
      patternTripLists.push(sub);
      for (const t of sub) patternOfTrip[t] = p;
    }
  }

  // 4. Flatten into typed arrays.
  const nPatterns = patternStopLists.length;
  const patternStopOffset = new Int32Array(nPatterns + 1);
  const patternTripOffset = new Int32Array(nPatterns + 1);
  for (let p = 0; p < nPatterns; p++) {
    patternStopOffset[p + 1] = patternStopOffset[p]! + patternStopLists[p]!.length;
    patternTripOffset[p + 1] = patternTripOffset[p]! + patternTripLists[p]!.length;
  }

  const patternStops = new Int32Array(patternStopOffset[nPatterns]!);
  const patternTrips = new Int32Array(patternTripOffset[nPatterns]!);
  const patternTravelSeconds = new Int32Array(patternStopOffset[nPatterns]!);
  for (let p = 0; p < nPatterns; p++) {
    patternStops.set(patternStopLists[p]!, patternStopOffset[p]!);
    patternTrips.set(patternTripLists[p]!, patternTripOffset[p]!);

    // `patternTripLists[p]` is non-empty by construction and was sorted
    // lexicographically above, so `[0]` is the pattern's pointwise-earliest
    // trip -- a deterministic choice, and the same one on every rebuild.
    const first = trips[patternTripLists[p]![0]!]!;
    const from = patternStopOffset[p]!;
    const origin = first.departures[0]!;
    for (let i = 0; i < patternStopLists[p]!.length; i++) {
      patternTravelSeconds[from + i] = first.departures[i]! - origin;
    }
  }

  return {
    nPatterns, patternOfTrip, patternStops, patternStopOffset,
    patternTrips, patternTripOffset, patternTravelSeconds,
  };
}
