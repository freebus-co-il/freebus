import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useRealtimeAvailable } from '@/api/meta';
import { LineBadge } from '@/components/line-badge';
import { Space, StatusDot, Text, useColors, type ColorRole } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { formatClockTime } from '@/lib/format';

import { useJourney } from './journey-context';
import { journeyCopy } from './journey-copy';
import { arrivedPipModel, pipModel, type PipTone } from './pip-model';

/** The window is a few hundred points wide whatever the rider's text size, so
 *  Dynamic Type may grow its text only a little before the lines stop fitting. */
const PIP_MAX_FONT_SCALE = 1.2;

/**
 * The journey, drawn for the picture-in-picture window.
 *
 * Covers the navigator rather than replacing it, so the screen the rider left
 * is still there, scrolled where they left it, when they tap back in. Prints a
 * `pipModel` and decides nothing -- read at arm's length, in another app, so
 * two lines and one big number, and a colour that only changes when it means
 * something.
 */
export function JourneyPip() {
  const { journey, state } = useJourney();
  const { t } = useTranslation();
  const colors = useColors();
  const realtimeAvailable = useRealtimeAvailable();
  const { timeFormat } = usePreferences();

  // After arrival the journey is already gone; the window lingers on "You're
  // here" until the provider puts it away.
  const model =
    journey && state
      ? pipModel({
          state,
          itinerary: journey.itinerary,
          copy: journeyCopy(state, journey.itinerary, journey.destinationLabel, t, { end: colors.textPrimary, alert: colors.danger }, timeFormat),
          t,
          realtimeAvailable,
          clock: formatClockTime,
          timeFormat,
        })
      : arrivedPipModel(t);

  const palette = paletteFor(model.tone);
  const live = state?.timeSource === 'live';

  return (
    <View style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: colors[palette.background] }]}>
      <View style={styles.row}>
        {model.badge && <LineBadge route={model.badge} size="small" />}
        <Text
          variant="subheadline"
          emphasized
          color={palette.text}
          numberOfLines={1}
          maxFontSizeMultiplier={PIP_MAX_FONT_SCALE}
          style={styles.fill}
        >
          {model.title}
        </Text>
      </View>

      {model.hero !== '' && (
        <View style={styles.row}>
          <Text
            variant="title1"
            numeric
            color={palette.text}
            numberOfLines={1}
            adjustsFontSizeToFit
            maxFontSizeMultiplier={PIP_MAX_FONT_SCALE}
            style={styles.fill}
          >
            {model.hero}
          </Text>
          {model.liveLabel !== '' && (
            <View style={styles.row}>
              {live && <StatusDot tone="live" />}
              <Text variant="subheadline" color={palette.secondary} maxFontSizeMultiplier={PIP_MAX_FONT_SCALE}>
                {model.liveLabel}
              </Text>
            </View>
          )}
        </View>
      )}

      {model.footer && (
        <Text
          variant="subheadline"
          color={palette.secondary}
          numeric
          numberOfLines={1}
          maxFontSizeMultiplier={PIP_MAX_FONT_SCALE}
        >
          {model.footer}
        </Text>
      )}
    </View>
  );
}

/** The whole window is the signal: it turns `getOff` (or `danger`, off plan)
 *  only when that is what it means, with `onStatus` ink on the fill. */
function paletteFor(tone: PipTone): { background: ColorRole; text: ColorRole; secondary: ColorRole } {
  if (tone === 'getOff') return { background: 'getOff', text: 'onStatus', secondary: 'onStatus' };
  if (tone === 'offPlan') return { background: 'danger', text: 'onStatus', secondary: 'onStatus' };
  return { background: 'bgPlain', text: 'textPrimary', secondary: 'textSecondary' };
}

const styles = StyleSheet.create({
  // Flat: a fill and nothing else.
  root: {
    justifyContent: 'center',
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
    gap: Space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  fill: {
    flex: 1,
  },
});
