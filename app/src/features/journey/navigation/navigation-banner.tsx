import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Itinerary, WalkManeuver } from '@/api/types';
import { Glass, Icon, Radius, Size, Space, Text, useColors, type IconName } from '@/design-system';
import { formatDistanceMeters } from '@/lib/format';

import type { JourneyState } from '../types';
import { guidanceMeters, type WalkGuidance } from './walk-guidance';
import { walkInstruction } from './walk-instruction';

/**
 * The glyph for each move. PHYSICAL on purpose: a right turn is on the rider's
 * right in every language, so none of these are the design system's
 * directional names (`chevronForward`, `arrowBack`...) and none mirror under
 * RTL -- unlike a back arrow, which points the way the layout reads.
 */
const MANEUVER_ICONS: Record<WalkManeuver, IconName> = {
  depart: 'straight',
  straight: 'straight',
  'slight-right': 'slightRight',
  right: 'turnRight',
  'sharp-right': 'sharpRight',
  'slight-left': 'slightLeft',
  left: 'turnLeft',
  'sharp-left': 'sharpLeft',
  uturn: 'uTurn',
  roundabout: 'roundabout',
  stairs: 'stairs',
  elevator: 'elevator',
  escalator: 'escalator',
  'enter-building': 'enter',
  'exit-building': 'exit',
  ferry: 'ferry',
  arrive: 'pin',
};

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

/** Glass, not a card: the banner is chrome floating over the map (it says
 *  what to do, it is not part of the plan), so it is the functional layer. */
function Frame({ glyph, children }: { glyph: ReactNode; children: ReactNode }) {
  return (
    <Glass shape="rounded" style={styles.frame}>
      {glyph}
      <View style={styles.texts}>{children}</View>
    </Glass>
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
  const colors = useColors();
  const leg = itinerary.legs[state.legIndex];
  if (!leg || state.phase === 'off-plan' || state.phase === 'arrived') return null;

  if (leg.type === 'walk') {
    if (!guidance) return null;
    const final = state.legIndex === itinerary.legs.length - 1;
    const arrivingAt = final ? destinationLabel.trim() || null : leg.to.name ?? null;
    const instruction = walkInstruction(guidance, arrivingAt, i18n.language);
    return (
      <Frame
        glyph={
          <View style={[styles.glyph, { backgroundColor: colors.walk }]}>
            <Icon name={MANEUVER_ICONS[guidance.maneuver]} size="lg" color="onStatus" weight="semibold" />
          </View>
        }
      >
        <Text variant="title2" numeric numberOfLines={1}>
          {formatDistanceMeters(guidanceMeters(guidance.metersToManeuver))}
        </Text>
        <Text variant="title3" numberOfLines={2}>
          {rerouting ? t('journey.nav.rerouting') : t(instruction.key, instruction.values)}
        </Text>
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
    gap: Space.md,
    padding: Space.md,
  },
  // Concentric with the panel: its `Radius.xl` less the `Space.md` padding.
  glyph: {
    width: Size.control.md,
    height: Size.control.md,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: {
    flex: 1,
    gap: Space.xxs,
  },
});
