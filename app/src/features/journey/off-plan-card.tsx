import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';

import { Banner, Border, useColors } from '@/design-system';

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
  const colors = useColors();
  const { journey, replanFromHere } = useJourney();

  // The same resolver every other surface reads, so the sentence the bar
  // shows and the sentence on this card cannot drift apart -- they are one
  // string produced once. The card is the only surface that renders `action`
  // as a control rather than as text.
  const copy = journey
    ? journeyCopy(state, journey.itinerary, journey.destinationLabel, t, { end: colors.textPrimary, alert: colors.danger })
    : null;
  if (!copy) return null;

  // A warning banner: the warning glyph carries what the old alert-coloured
  // accent bar did -- deliberately not the route's colour, since the route is
  // precisely the thing that is no longer happening. Its one button is the
  // banner's `prominent` action: the one thing the rider came to this card to
  // do, and the only tap target on it.
  return (
    <Banner
      tone="warning"
      icon="warning"
      title={copy.hero}
      action={{ label: copy.action ?? t('journey.findAnotherWay'), onPress: replanFromHere }}
      style={[styles.card, { borderColor: colors.separator }]}
    />
  );
}

const styles = StyleSheet.create({
  // Fills the carousel's stretched row like the leg cards, and takes the same
  // hairline edge as a floating `Card`: it sits over live map tiles, not on a
  // grouped page.
  card: {
    flex: 1,
    borderWidth: Border.hairline,
  },
});
