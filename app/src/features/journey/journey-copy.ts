import type { TFunction } from 'i18next';

import type { Itinerary, WalkLeg } from '@/api/types';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';
import { routeColor, WALK_LEG_COLOR } from '@/lib/route-color';

import { lineLabel, minutesLeft, offPlanLine, stopName, vehicleInPlay } from './journey-labels';
import type { JourneyState } from './types';

export { lineLabel, minutesLeft, stopName, vehicleInPlay } from './journey-labels';

/**
 * The two lines every in-app surface says about a journey, and the colour of
 * the thing the rider is currently on.
 *
 * `action` is the one place the surfaces legitimately differ: the docked bar
 * NAMES the way out of a divergence where its supporting line would go, while
 * the journey screen renders it as a real control (`off-plan-card`). Making
 * that a field rather than two resolvers is what stops the bar and the screen
 * drifting into saying different things about the same moment.
 */
export type JourneyCopy = {
  hero: string;
  /**
   * The same moment, with any self-ticking number taken out of it.
   *
   * For surfaces the OS animates. `waiting` and `transferring` say "480 in 4
   * min", and `arriving` says "5 min walk" -- all three carry a minute that
   * changes every sixty seconds. Handing those to a Live Activity is wrong
   * twice over: it would spend an update a minute against a budget the spec
   * sizes at six to nine for a whole journey, and the instant the app
   * suspends the sentence FREEZES beside a `Text(timerInterval:)` that keeps
   * counting, so the surface contradicts itself in two places at once.
   *
   * So the OS renders the countdown and this renders everything else -- which
   * is also what the spec asks for in its own words: waiting leads with the
   * line number, big, because the question at a stop is never "how long", it
   * is "is this one mine?".
   */
  heroStatic: string;
  supporting: string | null;
  action: string | null;
  accent: string;
};

/**
 * What the rider is doing, in one line they can read at arm's length and one
 * line of detail under it.
 *
 * Takes the itinerary as well as the state because three of the eight phases
 * are walks, and the machine carries no leg on those -- the stop a rider is
 * walking to, and how long it takes, live only in the plan.
 */
export function journeyCopy(
  state: JourneyState,
  itinerary: Itinerary,
  destinationLabel: string,
  t: TFunction,
  palette: { end: string; alert: string },
): JourneyCopy {
  const ride = vehicleInPlay(itinerary, state);
  const destination = destinationLabel.trim() || t('journey.toDestination');

  if (state.phase === 'arrived') {
    const hero = t('journey.phase.arrived');
    return { hero, heroStatic: hero, supporting: destination, action: null, accent: palette.end };
  }

  if (state.offPlan) {
    const named = offPlanLine(itinerary, state);
    const hero =
      state.offPlan === 'overshot'
        ? t('journey.offPlan.overshot', { name: ride ? stopName(ride.to.stop, t) : destination })
        : t(
            state.offPlan === 'missed-transfer'
              ? 'journey.offPlan.missedTransfer'
              : 'journey.offPlan.missedDeparture',
            { line: named ? lineLabel(named) : '' },
          );
    return { hero, heroStatic: hero, supporting: null, action: t('journey.findAnotherWay'), accent: palette.alert };
  }

  if (state.leg) {
    const leg = state.leg;
    const accent = routeColor(leg.route);

    if (state.phase === 'waiting') {
      return {
        hero: t('journey.phase.waiting', { line: lineLabel(leg), minutes: minutesLeft(state.timer) }),
        heroStatic: lineLabel(leg),
        supporting: leg.headsign.trim()
          ? t('results.towards', { name: formatHeadsign(leg.headsign) })
          : stopName(leg.from.stop, t),
        action: null,
        accent,
      };
    }

    if (state.phase === 'alight-soon') {
      const hero = t('journey.phase.alightSoon');
      return { hero, heroStatic: hero, supporting: stopName(leg.to.stop, t), action: null, accent };
    }

    // THE honesty rule, and the reason this branch exists at all.
    //
    // `stopsRemaining` is null whenever no GPS fix has placed the rider on the
    // route, and a stop count is the one number these surfaces must never
    // invent. The timetable knows when the bus is due; only a position knows
    // how many stops are left. So with no position the hero drops to the time
    // it can actually stand behind rather than deriving a count from the
    // schedule -- which would look every bit as precise and be wrong the
    // moment the bus ran late.
    if (state.stopsRemaining === null) {
      return {
        hero: t('journey.phase.ridingUntil', { time: formatClockTime(leg.to.arrivalTime) }),
        heroStatic: t('journey.phase.ridingUntil', { time: formatClockTime(leg.to.arrivalTime) }),
        supporting: stopName(leg.to.stop, t),
        action: null,
        accent,
      };
    }

    return {
      hero: t('journey.phase.riding', { count: state.stopsRemaining }),
      // A stop count changes only when a GPS fix says it did, which is exactly
      // the kind of discovered fact an update is meant to be spent on.
      heroStatic: t('journey.phase.riding', { count: state.stopsRemaining }),
      supporting: t('journey.offAt', {
        name: stopName(leg.to.stop, t),
        time: formatClockTime(leg.to.arrivalTime),
      }),
      action: null,
      accent,
    };
  }

  const current = itinerary.legs[state.legIndex];
  const walk: WalkLeg | null = current?.type === 'walk' ? current : null;
  const walkTo = walk
    ? t('journey.walkTo', { duration: formatDurationMinutes(walk.durationSeconds), name: stopName(walk.to, t) })
    : null;

  if (state.phase === 'arriving') {
    return {
      // Minutes LEFT rather than the walk's full length: on the last leg the
      // machine's timer already counts down to the end of the walk, and a
      // rider three minutes into a five-minute walk is not still five minutes
      // out.
      hero: t('journey.phase.arriving', { duration: formatDurationMinutes(minutesLeft(state.timer) * 60) }),
      heroStatic: t('journey.phase.arrivingStatic'),
      supporting: t('journey.toDestination'),
      action: null,
      accent: WALK_LEG_COLOR,
    };
  }

  // A transfer's hero is the line being caught, not the walk being walked --
  // the walk is a detail, the departure is the deadline.
  if (state.phase === 'transferring' && ride) {
    return {
      hero: t('journey.phase.transferring', { line: lineLabel(ride), minutes: minutesLeft(state.timer) }),
      heroStatic: lineLabel(ride),
      supporting: walkTo,
      action: null,
      accent: routeColor(ride.route),
    };
  }

  const hero = t('journey.phase.walkingToStop');
  return { hero, heroStatic: hero, supporting: walkTo, action: null, accent: WALK_LEG_COLOR };
}
