import type { TFunction } from 'i18next';

import type { Itinerary, TransitLeg } from '@/api/types';
import { formatHeadsign } from '@/features/results/itinerary-facts';

import type { JourneyCopy } from './journey-copy';
import { liveLabelFor, lineLabel, minutesLeft, stopName, vehicleInPlay } from './journey-labels';
import type { JourneyState } from './types';

/** The window's colour says whether the rider is OK before any word is read. */
export type PipTone = 'neutral' | 'getOff' | 'offPlan';

/**
 * What the picture-in-picture window prints: a title, one big line, a footer.
 * Pure and resolved here, like the other surfaces' copy, so the window itself
 * decides nothing and the whole table in the spec is testable in Node.
 */
export type PipModel = {
  tone: PipTone;
  /** A line badge to lead the title with; null when the title stands alone. */
  badge: TransitLeg['route'] | null;
  title: string;
  /** Empty when the phase has nothing big to say. */
  hero: string;
  footer: string | null;
  /** '' when not shown. */
  liveLabel: string;
};

export type PipModelInput = {
  state: JourneyState;
  itinerary: Itinerary;
  /** The in-app copy, for the lines the window shares with it (off plan). */
  copy: JourneyCopy;
  t: TFunction;
  realtimeAvailable: boolean;
  /** `formatClockTime`, injected so this stays loadable without i18n. */
  clock: (iso: string) => string;
};

export function arrivedPipModel(t: TFunction): PipModel {
  return { tone: 'neutral', badge: null, title: t('journey.phase.arrived'), hero: '', footer: null, liveLabel: '' };
}

/** "towards X" is what tells two directions of one line apart at a stop. */
function towards(leg: TransitLeg, t: TFunction): string {
  return leg.headsign.trim() ? t('results.towards', { name: formatHeadsign(leg.headsign) }) : stopName(leg.to.stop, t);
}

export function pipModel({ state, itinerary, copy, t, realtimeAvailable, clock }: PipModelInput): PipModel {
  if (state.phase === 'arrived') return arrivedPipModel(t);

  if (state.offPlan) {
    return { tone: 'offPlan', badge: null, title: copy.hero, hero: t('journey.pip.openToReplan'), footer: null, liveLabel: '' };
  }

  const liveLabel = liveLabelFor(state, realtimeAvailable, t);
  const minutes = minutesLeft(state.timer);
  const arrive = t('journey.pip.arrive', { time: clock(state.arrivalTime) });
  const ride = vehicleInPlay(itinerary, state);
  const current = itinerary.legs[state.legIndex];
  const walkTarget = current?.type === 'walk' ? stopName(current.to, t) : null;
  const neutral = { tone: 'neutral' as const, liveLabel: '' };

  switch (state.phase) {
    case 'walking-to-stop':
      return {
        ...neutral,
        badge: null,
        title: t('journey.pip.walkTo', { name: walkTarget ?? '' }),
        hero: t('journey.pip.leavesIn', { minutes }),
        footer: ride ? `${lineLabel(ride)} ${towards(ride, t)} · ${arrive}` : arrive,
        liveLabel,
      };
    case 'transferring':
      // The walk verb is what tells a transfer apart from waiting at a
      // glance -- both lead with a line, but only one of them is a
      // destination the rider is still walking towards.
      return {
        ...neutral,
        badge: null,
        title: ride
          ? t('journey.pip.walkTo', { name: `${lineLabel(ride)} ${towards(ride, t)}` })
          : t('journey.pip.walkTo', { name: walkTarget ?? '' }),
        hero: t('journey.pip.leavesIn', { minutes }),
        footer: arrive,
        liveLabel,
      };
    case 'arriving':
      return { ...neutral, badge: null, title: t('journey.pip.walkToDestination'), hero: t('journey.pip.minutes', { minutes }), footer: arrive };
    default:
      break;
  }

  const leg = state.leg;
  if (!leg) return { ...neutral, badge: null, title: copy.hero, hero: '', footer: arrive };

  if (state.phase === 'waiting') {
    const away =
      state.busStopsAway === null
        ? null
        : state.busStopsAway === 0
          ? t('journey.bus.atBoarding')
          : t('journey.bus.toBoarding', { count: state.busStopsAway });
    return {
      ...neutral,
      badge: leg.route,
      title: towards(leg, t),
      hero: t('journey.pip.arrivesIn', { minutes }),
      footer: away ? `${away} · ${arrive}` : arrive,
      liveLabel,
    };
  }

  if (state.phase === 'alight-soon') {
    return { tone: 'getOff', badge: null, title: t('journey.alert.getOffNow'), hero: stopName(leg.to.stop, t), footer: null, liveLabel: '' };
  }

  const getOffAt = t('journey.pip.getOffAt', { name: stopName(leg.to.stop, t) });
  if (state.stopsRemaining === null) {
    return {
      ...neutral,
      badge: leg.route,
      title: towards(leg, t),
      hero: t('journey.phase.ridingUntil', { time: clock(leg.to.arrivalTime) }),
      footer: getOffAt,
    };
  }
  return {
    ...neutral,
    badge: state.nextStopName ? null : leg.route,
    title: state.nextStopName ? t('journey.pip.next', { name: state.nextStopName }) : towards(leg, t),
    hero: t('journey.phase.riding', { count: state.stopsRemaining }),
    footer: `${getOffAt} · ${clock(leg.to.arrivalTime)}`,
  };
}
