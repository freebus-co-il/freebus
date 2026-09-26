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
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDistanceMeters } from '@/lib/format';
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
 *   HaDekalim"), counting down as they walk -- the one thing this banner says
 *   that a card cannot, since a turn instruction updates every few metres and
 *   belongs eyes-up at the top of the screen.
 *
 * Nothing on a transit leg, nothing off plan, and nothing once arrived: those
 * have their own card, and an instruction here would be one the rider must
 * not follow.
 */
export function NavigationBanner({ itinerary, state, guidance, rerouting, destinationLabel }: NavigationBannerProps) {
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

  // Transit legs say nothing here. The card below is the one surface that
  // owns "what is happening now" on a ride, and a banner repeating its stop
  // count over the top of it was the screen saying the most important thing
  // twice, in two places, in two different wordings.
  return null;
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
  texts: {
    flex: 1,
    gap: Spacing.half,
  },
});
