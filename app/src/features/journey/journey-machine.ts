import type { Place, TransitLeg } from '@/api/types';
import { FADE_AFTER_SECONDS } from '@/features/results/vehicle-markers';
import { haversineMeters } from '@/lib/geo';

import { distanceToPathMeters, legPath, OFF_PATH_METERS, ON_PATH_METERS, trackLegIndex } from './journey-progress';
import { buildLegSchedule } from './journey-rail';
import type { ActiveJourney, AlertSettings, JourneyState, LiveBus, LiveJourneyInput, LiveLeg, OffPlanReason, RiderPosition } from './types';
import { DEFAULT_ALERT_SETTINGS } from './types';

/** Close enough to a stop to be standing at it rather than moving past it. */
export const BOARDING_RADIUS_METERS = 100;

/**
 * How long after a scheduled departure a rider still at the stop is merely
 * waiting on a late bus rather than watching it leave without them. Without a
 * realtime feed there is no way to tell the two apart, so this is a judgement:
 * long enough that ordinary lateness never cries wolf, short enough to still
 * leave time to re-plan.
 */
export const MISSED_DEPARTURE_GRACE_SECONDS = 120;

/** Far enough past the alight stop that the rider is unambiguously on a
 *  vehicle still moving away from it, not standing on its far pavement. */
export const OVERSHOT_RADIUS_METERS = 800;

/** How long a fetched prediction still counts once polling has stopped (the
 *  screen went off, the app was hidden). Past this the countdown returns to
 *  the timetable rather than trust a bus nobody is watching any more. */
export const LIVE_HOLD_SECONDS = 120;

/** About half the gap between two bus stops: past this, nearest-stop counting
 *  from the rider's own fix cannot be trusted to name the right stop. */
export const WEAK_FIX_ACCURACY_METERS = 150;

/** A fix older than this is where the rider WAS -- in a tunnel, or with the
 *  watch starved of updates. */
export const WEAK_FIX_AGE_SECONDS = 60;

/** How long past its arrival a journey GPS is following keeps running when
 *  the rider never reaches the destination -- they finished somewhere else,
 *  or put the phone away. Generous, because ending too early is the failure
 *  GPS tracking exists to fix: a slow walker losing the journey mid-street. */
export const ARRIVAL_BACKSTOP_SECONDS = 30 * 60;

/** The instant a journey ends by the clock: at its arrival while it runs on
 *  the timetable, at the backstop once GPS is following it. */
export function journeyEndsAt(arrivalTime: string, tracked: boolean): string {
  return tracked ? new Date(ms(arrivalTime) + ARRIVAL_BACKSTOP_SECONDS * 1000).toISOString() : arrivalTime;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

export function isWeakFix(position: RiderPosition | null, nowMs: number): boolean {
  if (!position) return true;
  if (position.accuracyMeters > WEAK_FIX_ACCURACY_METERS) return true;
  return nowMs - ms(position.at) > WEAK_FIX_AGE_SECONDS * 1000;
}

function usableLiveLeg(live: LiveJourneyInput | null, legIndex: number, nowMs: number): LiveLeg | null {
  const found = live?.legs.find((candidate) => candidate.legIndex === legIndex);
  if (!found) return null;
  return nowMs - ms(found.fetchedAt) <= LIVE_HOLD_SECONDS * 1000 ? found : null;
}

function freshBus(live: LiveJourneyInput | null, legIndex: number, nowMs: number): LiveBus | null {
  const bus = live?.bus;
  if (!bus || bus.legIndex !== legIndex || bus.recordedAt === null) return null;
  // Never negative: a report stamped a little ahead of the phone's clock is "now".
  const ageMs = Math.max(0, nowMs - ms(bus.recordedAt));
  return ageMs <= FADE_AFTER_SECONDS * 1000 ? bus : null;
}

/** `holds === false` only, and only while the answer is fresh: null means the
 *  server cannot say, which is not the same as broken. */
function connectionBroken(live: LiveJourneyInput | null, afterLegIndex: number, nowMs: number): boolean {
  return live?.connections.some(
    (connection) =>
      connection.afterLegIndex === afterLegIndex &&
      connection.holds === false &&
      nowMs - ms(connection.fetchedAt) <= LIVE_HOLD_SECONDS * 1000,
  ) ?? false;
}

function liveArrivalTime(itinerary: ActiveJourney['itinerary'], live: LiveJourneyInput | null, nowMs: number): string {
  for (let legIndex = itinerary.legs.length - 1; legIndex >= 0; legIndex -= 1) {
    const leg = itinerary.legs[legIndex];
    if (!leg || leg.type !== 'transit') continue;
    const predicted = usableLiveLeg(live, legIndex, nowMs)?.predictedArrival;
    if (!predicted) return itinerary.arrivalTime;
    const delayMs = ms(predicted) - ms(leg.to.arrivalTime);
    return new Date(ms(itinerary.arrivalTime) + delayMs).toISOString();
  }
  return itinerary.arrivalTime;
}

/** The fields every state carries unless its branch knows better. */
function quietFields(arrivalTime: string): Pick<JourneyState, 'timeSource' | 'busStopsAway' | 'stopsSource' | 'nextStopName' | 'arrivalTime'> {
  return { timeSource: 'scheduled', busStopsAway: null, stopsSource: null, nextStopName: null, arrivalTime };
}

/** The ride's stops in order: boarding, the ones between, alighting. */
function orderedStops(leg: TransitLeg): Place[] {
  return [leg.from.stop, ...leg.intermediateStops, leg.to.stop];
}

/**
 * Stops left before alighting, from the rider's own position.
 *
 * Nearest-stop rather than anything cleverer: the alternative needs a shape to
 * project onto, and `geometry` is nullable on every leg. Nearest-stop only
 * has to be right to within half the gap between two stops, which on a bus
 * route it comfortably is.
 */
function stopsRemainingFrom(leg: TransitLeg, position: RiderPosition): number {
  const stops = orderedStops(leg);
  let nearest = 0;
  let best = Infinity;
  stops.forEach((stop, index) => {
    const distance = haversineMeters(position, stop);
    if (distance < best) {
      best = distance;
      nearest = index;
    }
  });
  return stops.length - 1 - nearest;
}

/**
 * The stop the vehicle reaches next. The nearest stop, unless the point is
 * already past it -- closer to the stop after it than the nearest stop itself
 * is -- in which case the one after. No shape needed, same as the count.
 *
 * Null once the point is past the alight stop: nearest to the last stop, and
 * farther from the stop before it than the last stop itself is. There is no
 * "next" on this ride any more, and naming the alight stop there would tell a
 * rider already carried beyond it that it is still ahead.
 */
function nextStopFrom(leg: TransitLeg, point: { lat: number; lon: number }): string | null {
  const stops = orderedStops(leg);
  let nearest = 0;
  let best = Infinity;
  stops.forEach((stop, index) => {
    const distance = haversineMeters(point, stop);
    if (distance < best) {
      best = distance;
      nearest = index;
    }
  });
  const last = stops.length - 1;
  const previous = stops[last - 1];
  if (nearest === last && previous !== undefined && haversineMeters(point, previous) > haversineMeters(previous, stops[last]!)) {
    return null;
  }
  const following = stops[nearest + 1];
  const passed = following !== undefined && haversineMeters(point, following) < haversineMeters(stops[nearest]!, following);
  return stops[passed ? nearest + 1 : nearest]?.name?.trim() || null;
}

/**
 * Split out from `detectOffPlan` because it is the one divergence rule that
 * still applies once the schedule has moved on past the ride: a rider carried
 * beyond their stop is somewhere the plan says they cannot be, whatever the
 * timetable thinks they should be doing by now.
 */
function detectOvershot(
  leg: TransitLeg,
  position: RiderPosition | null,
  nowMs: number,
): OffPlanReason | null {
  if (!position) return null;

  const pastDue = nowMs > ms(leg.to.arrivalTime);
  if (pastDue && haversineMeters(position, leg.to.stop) > OVERSHOT_RADIUS_METERS) {
    return 'overshot';
  }

  return null;
}

/** Live version of the rule above. `departure` is the predicted departure
 *  when usable, so the grace counts from the bus that is actually coming, not
 *  a timetable it has already beaten. A fresh bus position settles what the
 *  clock can only guess at: still on its way, nothing is missed however late
 *  it runs; already past the stop with the rider standing at it, missed now,
 *  without waiting out the grace -- but only on a fix fresh enough to be sure
 *  they are still there. */
function detectOffPlan(
  leg: TransitLeg,
  position: RiderPosition | null,
  nowMs: number,
  departure: string,
  bus: LiveBus | null,
  /** False under GPS tracking, where a rider still on the ride has by
   *  definition not reached its alight stop -- the overshoot is caught on the
   *  walk after it instead, once they are actually off the route. */
  allowOvershot: boolean,
): OffPlanReason | null {
  // Every divergence rule needs a position. Without one the app cannot tell a
  // missed bus from a late one, and guessing would put a false alarm in front
  // of a rider who is fine -- the one thing that would make them stop trusting
  // the alerts that matter.
  if (!position) return null;
  const atBoarding = haversineMeters(position, leg.from.stop) <= BOARDING_RADIUS_METERS;

  if (bus?.progress) {
    if (bus.progress.kind === 'toBoarding') return null;
    // "Missed at once" skips the grace, so it has to be sure of both halves:
    // the fix must postdate the report that put the bus past the stop (an
    // older one only says where the rider was BEFORE the bus came), and it
    // must be tight enough to place them at the stop at all -- a fix whose
    // error circle is wider than the boarding radius cannot tell the pavement
    // from the bus pulling away.
    const fixAfterReport = bus.recordedAt !== null && ms(position.at) >= ms(bus.recordedAt);
    const fixPlacesRider = position.accuracyMeters <= BOARDING_RADIUS_METERS;
    if (atBoarding && !isWeakFix(position, nowMs) && fixAfterReport && fixPlacesRider) return 'missed-departure';
    return allowOvershot ? detectOvershot(leg, position, nowMs) : null;
  }

  // Deliberately NOT gated on whether the clock says the rider has boarded.
  // The clock always says they boarded the instant the timetable says so,
  // which is exactly the case this rule exists to catch: the bus went, and
  // they are still standing on the pavement.
  const overdue = nowMs - ms(departure) > MISSED_DEPARTURE_GRACE_SECONDS * 1000;
  if (overdue && atBoarding) return 'missed-departure';

  // A bus that has not left yet cannot have carried anyone past their stop.
  // Without this a ride kept in play by a late prediction would read as an
  // overshoot the moment its SCHEDULED arrival passed, with the rider still
  // standing where they board.
  if (nowMs < ms(departure)) return null;

  return allowOvershot ? detectOvershot(leg, position, nowMs) : null;
}

/** The last ride before this leg, which is the one a rider on a walk leg has
 *  just been carried by -- or should have been. */
function precedingTransit(
  legs: ActiveJourney['itinerary']['legs'],
  beforeIndex: number,
): { legIndex: number; leg: TransitLeg } | null {
  for (let legIndex = beforeIndex - 1; legIndex >= 0; legIndex -= 1) {
    const leg = legs[legIndex];
    if (leg.type === 'transit') return { legIndex, leg };
  }
  return null;
}

/**
 * The ride the timetable has moved on from but live data says nobody has
 * boarded yet: its bus is fresh and still short of the stop, or its predicted
 * departure is still ahead. Only the latest ride before a walk qualifies --
 * that is the one the schedule just handed over from.
 */
function unboardedEarlierRide(
  legs: ActiveJourney['itinerary']['legs'],
  activeIndex: number,
  live: LiveJourneyInput | null,
  nowMs: number,
): { legIndex: number; leg: TransitLeg } | null {
  if (!live || legs[activeIndex]?.type === 'transit') return null;
  const ridden = precedingTransit(legs, activeIndex);
  if (!ridden) return null;
  if (freshBus(live, ridden.legIndex, nowMs)?.progress?.kind === 'toBoarding') return ridden;
  const predicted = usableLiveLeg(live, ridden.legIndex, nowMs)?.predictedDeparture;
  return predicted && ms(predicted) > nowMs ? ridden : null;
}

/**
 * What the rider is doing, as a pure function of the plan, the clock and a
 * position.
 *
 * Pure on purpose: every surface -- the in-app bar, the Dynamic Island, the
 * Android chip -- renders this and decides nothing itself, so all three agree
 * by construction, and the whole state machine is testable with a fake clock
 * and no simulator in the loop.
 */
export function resolveJourneyState(
  journey: ActiveJourney,
  position: RiderPosition | null,
  now: Date,
  settings: AlertSettings = DEFAULT_ALERT_SETTINGS,
  live: LiveJourneyInput | null = null,
): JourneyState {
  const { itinerary } = journey;
  const nowMs = now.getTime();
  const windows = buildLegSchedule(itinerary);
  const startMs = ms(itinerary.departureTime);
  const endMs = ms(itinerary.arrivalTime);
  const arrivalTime = liveArrivalTime(itinerary, live, nowMs);

  const progress = endMs === startMs ? 1 : Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));

  // The leg the TIMETABLE puts the rider on: the last window already begun,
  // falling back to the first, which covers a journey opened before its own
  // departure time.
  const scheduled = [...windows].reverse().find((window) => nowMs >= ms(window.startsAt)) ?? windows[0];
  const scheduledIndex = scheduled?.legIndex ?? 0;
  // The windows are the timetable's. A late bus still on its way -- or a
  // prediction that has it leaving later -- keeps its ride in play past the
  // window the schedule gave it; otherwise the next walk would take over and
  // raise an overshoot at a rider still standing where they board.
  const heldRide = unboardedEarlierRide(itinerary.legs, scheduledIndex, live, nowMs);

  // The leg GPS puts the rider on, once a fix good enough to act on has ever
  // placed them. From then on the journey moves when the RIDER does -- a slow
  // walk stays a walk past its scheduled minutes, a late bus stays a ride --
  // and the timetable decides only for a journey no fix has reached.
  const fix = position && !isWeakFix(position, nowMs) ? position : null;
  const tracked = trackLegIndex(itinerary, journey.gpsLegIndex ?? null, fix, heldRide?.legIndex ?? scheduledIndex);

  const quiet = { ...quietFields(arrivalTime), trackedLegIndex: tracked, ridingEarly: false };

  // A journey GPS is following ends when the rider reaches the destination --
  // or, if they never do, well past the arrival (`ARRIVAL_BACKSTOP_SECONDS`).
  // One running on the timetable ends at the arrival, shifted by the last
  // ride's live delay while that prediction is usable: ending at the scheduled
  // instant would close the journey -- and the PiP window -- on a rider still
  // a few minutes out.
  const arrived = tracked === null
    ? nowMs >= ms(arrivalTime)
    : tracked >= itinerary.legs.length || nowMs >= ms(journeyEndsAt(arrivalTime, true));
  if (arrived) {
    return {
      ...quiet,
      phase: 'arrived',
      legIndex: itinerary.legs.length - 1,
      leg: null,
      stopsRemaining: null,
      timer: null,
      offPlan: null,
      progress: 1,
    };
  }

  /** A transit leg in play: waiting for it, riding it, or off plan on it. */
  function transitState(legIndex: number, leg: TransitLeg): JourneyState {
    const liveLeg = usableLiveLeg(live, legIndex, nowMs);
    const departure = liveLeg?.predictedDeparture ?? leg.from.departureTime;
    const bus = freshBus(live, legIndex, nowMs);

    // The rider is being carried along this ride's route, away from its
    // boarding stop, while the bus the plan picked has not even left: they set
    // out early and caught the run before it (see `earlier-run.ts`). Every
    // verdict about the planned bus is then a verdict about a bus they are not
    // on -- including the server's "you'll miss the connection", which is true
    // of that bus and false of the one under them.
    const ridingEarly = tracked === legIndex
      && position !== null
      && !isWeakFix(position, nowMs)
      && nowMs < ms(departure)
      && haversineMeters(position, leg.from.stop) > BOARDING_RADIUS_METERS
      && distanceToPathMeters(position, legPath(leg)) <= ON_PATH_METERS;

    const offPlan: OffPlanReason | null =
      detectOffPlan(leg, position, nowMs, departure, bus, tracked === null) ??
      (!ridingEarly && connectionBroken(live, legIndex, nowMs) ? 'missed-transfer' : null);
    if (offPlan) {
      return { ...quiet, phase: 'off-plan', legIndex, leg, stopsRemaining: null, timer: null, offPlan, progress };
    }

    // Where the bus is beats what the clock says: a bus still short of the stop
    // has not been boarded, and one past it has, whatever the timetable thinks.
    const boarded = ridingEarly
      || (bus?.progress ? bus.progress.kind === 'toAlighting' : nowMs >= ms(departure));

    if (!boarded) {
      return {
        ...quiet,
        phase: 'waiting',
        legIndex,
        leg,
        stopsRemaining: null,
        timer: { from: now.toISOString(), to: departure, countsDown: true },
        timeSource: liveLeg?.predictedDeparture ? 'live' : 'scheduled',
        busStopsAway: bus?.progress?.kind === 'toBoarding' ? bus.progress.stops : null,
        offPlan: null,
        progress,
      };
    }

    // The bus stands in for the rider only when the rider's own fix is weak
    // and the bus's report is fresh. Otherwise nothing changes from before:
    // any fix at all still counts, and no fix still falls back to the clock.
    // The assumption, made explicit: with a weak fix the rider is on the bus
    // the plan put them on -- the same one the timetable fallback already makes.
    const busCounts = bus?.progress?.kind === 'toAlighting' && isWeakFix(position, nowMs) ? bus : null;
    let stopsRemaining: number | null = null;
    let stopsSource: JourneyState['stopsSource'] = null;
    let nextStopName: string | null = null;
    if (busCounts && busCounts.progress?.kind === 'toAlighting') {
      stopsRemaining = busCounts.progress.stops;
      stopsSource = 'bus';
      nextStopName = nextStopFrom(leg, busCounts);
    } else if (position) {
      stopsRemaining = stopsRemainingFrom(leg, position);
      stopsSource = 'rider';
      nextStopName = nextStopFrom(leg, position);
    }

    // Stops when the rider asked for stops AND a fix can count them; the clock
    // otherwise -- which covers both "no fix has placed them on the route" and
    // "they asked to be warned in minutes", the latter being what `leadStops: 0`
    // means (see the settings screen's LEAD_TIME_OPTIONS).
    //
    // Reading `leadStops` alone here would be a silent trap: a rider who picks
    // "5 min" WITH a working fix would get the notification five minutes out and
    // watch the app itself say nothing until the doors opened, because
    // `stopsRemaining <= 0` is only ever true at the stop. The two triggers must
    // agree about when the moment is.
    //
    // What is never done either way is inventing a stop count from the
    // timetable: only a position knows how many stops are left, and a fabricated
    // count would look every bit as precise and be wrong the moment the bus ran
    // late.
    const countStops = settings.leadStops > 0 && stopsRemaining !== null;
    const dueToAlight = countStops
      ? stopsRemaining! <= settings.leadStops
      : ms(leg.to.arrivalTime) - nowMs <= settings.leadSeconds * 1000;
    const alreadyAcknowledged = journey.acknowledgedAlightLegIndex === legIndex;

    return {
      ...quiet,
      phase: dueToAlight && !alreadyAcknowledged ? 'alight-soon' : 'riding',
      legIndex,
      leg,
      ridingEarly,
      stopsRemaining,
      timer: { from: now.toISOString(), to: leg.to.arrivalTime, countsDown: true },
      stopsSource,
      nextStopName,
      offPlan: null,
      progress,
    };
  }

  /** A walk in play: to the first stop, between rides, or to the destination. */
  function walkState(legIndex: number): JourneyState {
    const final = legIndex === itinerary.legs.length - 1;
    // The schedule advances to this walk the moment the previous ride was DUE
    // to end, so a rider still aboard a vehicle that sailed past their stop
    // would otherwise be congratulated on a pleasant stroll. Until they are
    // actually near where they got off, the ride is still the leg that owns
    // them. Under GPS the rider reached this walk by standing at that stop, so
    // only a fix that has left the walk's own route behind can mean they were
    // carried on -- a long walk away from the stop is just the walk.
    const ridden = precedingTransit(itinerary.legs, legIndex);
    const mayHaveOvershot = tracked === null
      || (fix !== null && distanceToPathMeters(fix, legPath(itinerary.legs[legIndex])) > OFF_PATH_METERS);
    const overshot = ridden && mayHaveOvershot ? detectOvershot(ridden.leg, position, nowMs) : null;
    if (ridden && overshot) {
      return {
        ...quiet,
        phase: 'off-plan',
        legIndex: ridden.legIndex,
        leg: ridden.leg,
        stopsRemaining: null,
        timer: null,
        offPlan: overshot,
        progress,
      };
    }

    // A connection the server says is already lost is a missed transfer while
    // walking to it, just as while riding towards it.
    if (ridden && connectionBroken(live, ridden.legIndex, nowMs)) {
      return {
        ...quiet,
        phase: 'off-plan',
        legIndex,
        leg: null,
        stopsRemaining: null,
        timer: null,
        offPlan: 'missed-transfer',
        progress,
      };
    }

    // A walk's timer counts down to the DEPARTURE it is racing, not to the end
    // of the walk. Arriving at the stop is not the deadline; the bus is. The
    // final walk has no departure to race, so it runs to the arrival -- the
    // live-shifted one, the same instant that ends the journey.
    const nextIndex = itinerary.legs.findIndex((next, index) => index > legIndex && next.type === 'transit');
    const nextTransit = nextIndex >= 0 ? itinerary.legs[nextIndex] : undefined;
    const predicted = nextIndex >= 0 ? usableLiveLeg(live, nextIndex, nowMs)?.predictedDeparture ?? null : null;
    const deadline =
      nextTransit && nextTransit.type === 'transit'
        ? predicted ?? nextTransit.from.departureTime
        : final
          ? quiet.arrivalTime
          : windows[legIndex]?.endsAt ?? quiet.arrivalTime;
    return {
      ...quiet,
      phase: final ? 'arriving' : legIndex === 0 ? 'walking-to-stop' : 'transferring',
      legIndex,
      leg: null,
      stopsRemaining: null,
      timer: { from: now.toISOString(), to: deadline, countsDown: true },
      timeSource: predicted ? 'live' : 'scheduled',
      offPlan: null,
      progress,
    };
  }

  if (tracked !== null) {
    const trackedLeg = itinerary.legs[tracked];
    return trackedLeg.type === 'walk' ? walkState(tracked) : transitState(tracked, trackedLeg);
  }

  if (heldRide) return transitState(heldRide.legIndex, heldRide.leg);
  const leg = itinerary.legs[scheduledIndex];
  return leg.type === 'walk' ? walkState(scheduledIndex) : transitState(scheduledIndex, leg);
}
