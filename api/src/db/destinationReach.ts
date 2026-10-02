import type Database from "better-sqlite3";
import type { DestinationStop } from "./destinationArea.js";

/** Where one run sets the rider down for the destination they named. */
export interface Reach {
  /** Which stop near the destination the run actually calls at. The rider
   *  named a PLACE, not this -- see `destinationStops`. */
  stopId: string;
  stopSequence: number;
  /** How far that stop is from the place the rider named. */
  walkMeters: number;
  /**
   * SCHEDULED seconds on board, from this boarding to that call.
   *
   * A duration, deliberately, and not an instant: the caller adds it to the
   * row's own boardable instant, which may be a live prediction. Both times
   * it is derived from are seconds since their shared service day's
   * midnight, so the subtraction is immune to everything that makes clock
   * arithmetic dangerous here -- a 25:30 departure, and the autumn
   * fall-back night when the same service day carries two UTC offsets (see
   * the sort in `departuresAt`).
   */
  rideSeconds: number;
}

/**
 * One run's identity on a board: the trip AND the stop_sequence it is
 * boarded at. A loop trip calls at the same stop twice and appears on the
 * board twice, and the two visits reach the destination differently -- the
 * first may reach it, the second may already have passed it.
 */
export function reachKey(tripId: string, boardStopSequence: number): string {
  return `${tripId}\u0000${boardStopSequence}`;
}

interface Row {
  trip_id: string; board_seq: number;
  dest_stop_id: string; dest_seq: number; ride_seconds: number;
}

/**
 * Of two stops a run calls at near the destination, the one the rider would
 * actually ride to: the SHORTER WALK wins, and only a tie is settled by
 * getting off earlier.
 *
 * Riding one stop further to arrive at the door beats hopping off where the
 * route first clips the edge of the area -- a bus that grazes it at 480 m
 * and then stops 50 m from the entrance is one the rider stays on.
 */
function closer(candidate: { walkMeters: number; stopSequence: number }, incumbent: Reach): boolean {
  if (candidate.walkMeters !== incumbent.walkMeters) return candidate.walkMeters < incumbent.walkMeters;
  return candidate.stopSequence < incumbent.stopSequence;
}

/**
 * Of the runs on a departure board, which ones carry the rider to the
 * destination WITHOUT CHANGING -- where each sets them down, and how long
 * that takes.
 *
 * One query for the whole board rather than one per row: a board is a few
 * hundred rows at most, and the same self-join that proves the run calls at
 * the destination after the boarding already knows when.
 *
 * `drop_off_type = 1` means alighting is not possible there, so a run that
 * merely drives past the destination without letting anyone off does not
 * count as reaching it -- the mirror of the `pickup_type` rule that keeps a
 * trip's final stop off its own departure board.
 */
export function destinationReach(
  db: Database.Database,
  opts: {
    tripIds: readonly string[];
    /** The board's stops -- every platform it was built from. */
    boardStopIds: readonly string[];
    /** The stops around the place the rider named, with the walk from each --
     *  see `destinationStops`. */
    destStops: readonly DestinationStop[];
  },
): Map<string, Reach> {
  const out = new Map<string, Reach>();
  if (opts.tripIds.length === 0 || opts.boardStopIds.length === 0 || opts.destStops.length === 0) {
    return out;
  }

  const walkByStop = new Map(opts.destStops.map((s) => [s.stopId, s.walkMeters] as const));
  const destStopIds = [...walkByStop.keys()];
  const trips = opts.tripIds.map(() => "?").join(",");
  const boards = opts.boardStopIds.map(() => "?").join(",");
  const dests = destStopIds.map(() => "?").join(",");

  // ix_stop_times_trip_seq covers (trip_ref, stop_sequence), so both halves
  // of the self-join walk one trip's own rows.
  const rows = db.prepare(`
    SELECT t.trip_id AS trip_id,
           b.stop_sequence AS board_seq,
           ds.stop_id AS dest_stop_id,
           d.stop_sequence AS dest_seq,
           d.arrival_time - b.departure_time AS ride_seconds
    FROM trips t
    JOIN stop_times b  ON b.trip_ref  = t.trip_ref
    JOIN stops      bs ON bs.stop_ref = b.stop_ref
    JOIN stop_times d  ON d.trip_ref  = t.trip_ref
    JOIN stops      ds ON ds.stop_ref = d.stop_ref
    WHERE t.trip_id IN (${trips})
      AND bs.stop_id IN (${boards})
      AND ds.stop_id IN (${dests})
      AND d.stop_sequence > b.stop_sequence
      AND COALESCE(b.pickup_type, 0) <> 1
      AND COALESCE(d.drop_off_type, 0) <> 1
    ORDER BY b.stop_sequence, d.stop_sequence
  `).all(...opts.tripIds, ...opts.boardStopIds, ...destStopIds) as Row[];

  for (const row of rows) {
    // A feed whose times run backwards along a trip would produce a negative
    // ride and, added to the boarding instant, an arrival BEFORE the bus
    // left. Drop the row instead: no answer beats a nonsense one.
    if (row.ride_seconds < 0) continue;
    const walkMeters = walkByStop.get(row.dest_stop_id);
    if (walkMeters === undefined) continue;

    const key = reachKey(row.trip_id, row.board_seq);
    const candidate: Reach = {
      stopId: row.dest_stop_id,
      stopSequence: row.dest_seq,
      rideSeconds: row.ride_seconds,
      walkMeters,
    };
    // A run calls at several stops near the destination far more often now
    // that the destination is an area rather than a station, so which one it
    // is reported as is a real choice -- see `closer`.
    const incumbent = out.get(key);
    if (incumbent === undefined || closer(candidate, incumbent)) out.set(key, candidate);
  }
  return out;
}
