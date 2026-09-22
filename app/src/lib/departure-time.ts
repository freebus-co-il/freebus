import type { RealtimeInfo } from '@/api/types';

/**
 * When a departure is actually expected, and whether anyone has confirmed it.
 *
 * `live` is what separates a prediction from a promise. A scheduled time says
 * what the timetable intends; a live one says where the vehicle is. Rendering
 * them identically -- which every board in this app did until now -- asks a
 * rider to trust a countdown without telling them which kind it is, and the
 * two are not equally trustworthy five minutes before a bus that has not left
 * its depot.
 */
export type DepartureTime = {
  /** ISO-8601. The predicted time when there is one, the scheduled time
   *  otherwise. */
  iso: string;
  /** True only when a vehicle actually reported this. */
  live: boolean;
  /** Seconds late (negative: early) against the timetable, when known and
   *  worth mentioning. Null when there is no prediction, and deliberately
   *  null for trivial deviations -- see `DELAY_WORTH_REPORTING_SECONDS`. */
  delaySeconds: number | null;
};

/**
 * Below this, a "delay" is timetable rounding and traffic-light luck, not
 * something a rider experiences or can act on. Reporting "1 min late" on
 * every row would bury the one that is genuinely ten minutes out.
 */
export const DELAY_WORTH_REPORTING_SECONDS = 120;

/**
 * Resolves what to show for one departure.
 *
 * A prediction only counts as live when it actually carries a predicted
 * instant: `realtime` can be present with `predictedDeparture: null` when the
 * feed has located the vehicle's journey but has no call for THIS stop (see
 * the API's `realtimeForDeparture`). That is a known vehicle on an unknown
 * schedule at this stop -- still the timetable's answer, so still scheduled.
 */
export function departureTime(
  scheduledIso: string,
  realtime: RealtimeInfo | null,
): DepartureTime {
  const predicted = realtime?.predictedDeparture ?? null;
  if (predicted === null) {
    return { iso: scheduledIso, live: false, delaySeconds: null };
  }
  const delay = realtime?.delaySeconds ?? null;
  return {
    iso: predicted,
    live: true,
    delaySeconds:
      delay !== null && Math.abs(delay) >= DELAY_WORTH_REPORTING_SECONDS ? delay : null,
  };
}
