import {
  IconArrowBackUp,
  IconArrowRoundaboutRight,
  IconArrowSharpTurnLeft,
  IconArrowSharpTurnRight,
  IconArrowUp,
  IconArrowUpLeft,
  IconArrowUpRight,
  IconCornerUpLeft,
  IconCornerUpRight,
  IconDoorEnter,
  IconDoorExit,
  IconElevator,
  IconEscalator,
  IconMapPin,
  IconShip,
  IconStairs,
  type Icon,
} from '@tabler/icons-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary, WalkManeuver } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime, formatDistanceMeters } from '@/lib/format';
import { readableTextColor, WALK_LEG_COLOR } from '@/lib/route-color';

import type { JourneyState } from '../types';
import { guidanceMeters, type WalkGuidance } from './walk-guidance';
import { walkInstruction } from './walk-instruction';

/**
 * The glyph for each move. PHYSICAL on purpose: a right turn is on the rider's
 * right in every language, so none of these come from `directional-icon` and
 * none mirror under RTL -- unlike a back arrow, which points the way the layout
 * reads.
 */
const MANEUVER_ICONS: Record<WalkManeuver, Icon> = {
  depart: IconArrowUp,
  straight: IconArrowUp,
  'slight-right': IconArrowUpRight,
  right: IconCornerUpRight,
  'sharp-right': IconArrowSharpTurnRight,
  'slight-left': IconArrowUpLeft,
  left: IconCornerUpLeft,
  'sharp-left': IconArrowSharpTurnLeft,
  uturn: IconArrowBackUp,
  roundabout: IconArrowRoundaboutRight,
  stairs: IconStairs,
  elevator: IconElevator,
  escalator: IconEscalator,
  'enter-building': IconDoorEnter,
  'exit-building': IconDoorExit,
  ferry: IconShip,
  arrive: IconMapPin,
};

const GLYPH_SIZE = 44;

export type NavigationBannerProps = {
  itinerary: Itinerary;
  state: JourneyState;
  /** The next move on the walk in play; null off a walk. */
  guidance: WalkGuidance | null;
  /** A new walk from where the rider strayed is on its way. */
  rerouting: boolean;
  /** What the rider named as their destination, for the last walk's arrival. */
  destinationLabel: string;
  now: Date;
};

function Frame({ glyph, children }: { glyph: ReactNode; children: ReactNode }) {
  const theme = useTheme();
  return (
    <ThemedView type="background" style={[styles.frame, { borderColor: theme.borderMuted }]}>
      {glyph}
      <View style={styles.texts}>{children}</View>
    </ThemedView>
  );
}

/**
 * The one line a rider on the move reads, pinned over the top of the map -- the
 * navigation half of the journey screen, where the cards below are the plan.
 *
 * - **Walking**: the next turn, big, with how far it is ("80 m · Turn right onto
 *   HaDekalim"), counting down as they walk.
 * - **Waiting**: when the bus leaves, and how many stops away it is.
 * - **Riding**: stops still to go, and where to get off.
 *
 * Nothing off plan or once arrived: those have their own card, and an
 * instruction there would be one the rider must not follow.
 */
export function NavigationBanner({ itinerary, state, guidance, rerouting, destinationLabel, now }: NavigationBannerProps) {
  const { t, i18n } = useTranslation();
  const leg = itinerary.legs[state.legIndex];
  if (!leg || state.phase === 'off-plan' || state.phase === 'arrived') return null;

  if (leg.type === 'walk') {
    if (!guidance) return null;
    const final = state.legIndex === itinerary.legs.length - 1;
    const arrivingAt = final ? destinationLabel.trim() || null : leg.to.name ?? null;
    const instruction = walkInstruction(guidance, arrivingAt, i18n.language);
    const Glyph = MANEUVER_ICONS[guidance.maneuver];
    return (
      <Frame
        glyph={
          <View style={[styles.glyph, { backgroundColor: WALK_LEG_COLOR }]}>
            <Glyph size={28} color={readableTextColor(WALK_LEG_COLOR)} />
          </View>
        }
      >
        <ThemedText type="subtitle" numberOfLines={1}>
          {formatDistanceMeters(guidanceMeters(guidance.metersToManeuver))}
        </ThemedText>
        <ThemedText type="default" numberOfLines={2}>
          {rerouting ? t('journey.nav.rerouting') : t(instruction.key, instruction.values)}
        </ThemedText>
      </Frame>
    );
  }

  const badge = (
    <View style={styles.badgeSlot}>
      <LineBadge route={leg.route} />
    </View>
  );

  if (state.phase === 'waiting' || state.phase === 'walking-to-stop' || state.phase === 'transferring') {
    const departure = new Date(leg.realtime?.predictedDeparture ?? leg.from.departureTime);
    const minutes = Math.max(0, Math.ceil((departure.getTime() - now.getTime()) / 60_000));
    return (
      <Frame glyph={badge}>
        <ThemedText type="defaultBold" numberOfLines={1}>
          {t('journey.nav.leavesIn', { minutes })}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {state.busStopsAway !== null
            ? t('journey.nav.busStopsAway', { count: state.busStopsAway })
            : t('trip.boardAt', { name: leg.from.stop.name ?? t('trip.unnamedStop') })}
        </ThemedText>
      </Frame>
    );
  }

  return (
    <Frame glyph={badge}>
      <ThemedText type="defaultBold" numberOfLines={1}>
        {state.phase === 'alight-soon'
          ? t('journey.phase.alightSoon')
          : state.stopsRemaining !== null
            ? t('journey.nav.stopsToGo', { count: state.stopsRemaining })
            : t('journey.phase.ridingUntil', { time: formatClockTime(leg.to.arrivalTime) })}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
        {t('journey.nav.getOffAt', { name: leg.to.stop.name ?? t('trip.unnamedStop') })}
      </ThemedText>
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
  },
  glyph: {
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    borderRadius: GLYPH_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSlot: {
    minWidth: GLYPH_SIZE,
    alignItems: 'center',
  },
  texts: {
    flex: 1,
    gap: Spacing.half,
  },
});
