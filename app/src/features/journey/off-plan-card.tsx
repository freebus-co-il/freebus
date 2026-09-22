import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { IconArrowForward } from '@/components/directional-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { useJourney } from './journey-context';
import { journeyCopy } from './journey-copy';
import type { JourneyState } from './types';

/**
 * Detect, then offer.
 *
 * What went wrong, and one way out. Nothing else on purpose: this appears in
 * front of a rider standing on a pavement watching their bus disappear, and
 * every extra control on the screen is one more thing to read before they can
 * act. The spec's phase table gives `off-plan` a hero and a single
 * `[Find another way →]`, and that is the whole card.
 *
 * Notably absent is anything that ends or edits the running journey. The
 * action below re-issues the search and navigates; the journey underneath
 * keeps running untouched until the rider picks a replacement and starts it
 * themselves. The app noticing something has gone wrong is not the same as
 * the app deciding what to do about it.
 */
export function OffPlanCard({ state }: { state: JourneyState }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { journey, replanFromHere } = useJourney();

  // The same resolver every other surface reads, so the sentence the bar
  // shows and the sentence on this card cannot drift apart -- they are one
  // string produced once. The card is the only surface that renders `action`
  // as a control rather than as text.
  const copy = journey
    ? journeyCopy(state, journey.itinerary, journey.destinationLabel, t, { end: theme.text, alert: theme.danger })
    : null;
  if (!copy) return null;

  return (
    <ThemedView type="background" style={[styles.card, { borderColor: theme.borderMuted }]}>
      <View style={styles.reason}>
        {/* The accent the hero would have carried for this phase, in the alert
            colour rather than the route's: the route is precisely the thing
            that is no longer happening. Flat by rule (`AGENTS.md`) -- the
            surface colour and the hairline are the whole card. */}
        <View style={[styles.accent, { backgroundColor: copy.accent }]} />
        <ThemedText type="subtitle" numberOfLines={3} style={styles.reasonText}>
          {copy.hero}
        </ThemedText>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={replanFromHere}
        style={[styles.action, { backgroundColor: theme.text }]}
      >
        <ThemedText type="defaultBold" themeColor="background">
          {copy.action ?? t('journey.findAnotherWay')}
        </ThemedText>
        <IconArrowForward
          size={20}
          color={theme.background}
        />
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    borderWidth: 1,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.three,
  },
  accent: {
    width: 4,
    borderRadius: 2,
  },
  reasonText: {
    flex: 1,
  },
  // Filled, not outlined: this is the one thing the rider came to this card to
  // do, and it is the only tap target on it.
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
});
