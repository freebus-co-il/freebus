import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useRealtimeAvailable } from '@/api/meta';
import { LineBadge } from '@/components/line-badge';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClockTime } from '@/lib/format';

import { useJourney } from './journey-context';
import { journeyCopy } from './journey-copy';
import { arrivedPipModel, pipModel, type PipTone } from './pip-model';

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
  const theme = useTheme();
  const realtimeAvailable = useRealtimeAvailable();

  // After arrival the journey is already gone; the window lingers on "You're
  // here" until the provider puts it away.
  const model =
    journey && state
      ? pipModel({
          state,
          itinerary: journey.itinerary,
          copy: journeyCopy(state, journey.itinerary, journey.destinationLabel, t, { end: theme.text, alert: theme.danger }),
          t,
          realtimeAvailable,
          clock: formatClockTime,
        })
      : arrivedPipModel(t);

  const palette = paletteFor(model.tone, theme);
  const live = state?.timeSource === 'live';

  return (
    <View style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: palette.background }]}>
      <View style={styles.row}>
        {model.badge && <LineBadge route={model.badge} size="small" />}
        <ThemedText type="smallBold" numberOfLines={1} style={[styles.fill, { color: palette.text }]}>
          {model.title}
        </ThemedText>
      </View>

      {model.hero !== '' && (
        <View style={styles.row}>
          <ThemedText type="subtitle" numberOfLines={1} adjustsFontSizeToFit style={[styles.fill, { color: palette.text }]}>
            {model.hero}
          </ThemedText>
          {model.liveLabel !== '' && (
            <View style={styles.row}>
              {live && <View style={[styles.dot, { backgroundColor: theme.success }]} />}
              <ThemedText type="small" style={{ color: palette.secondary }}>{model.liveLabel}</ThemedText>
            </View>
          )}
        </View>
      )}

      {model.footer && (
        <ThemedText type="small" numberOfLines={1} style={{ color: palette.secondary }}>
          {model.footer}
        </ThemedText>
      )}
    </View>
  );
}

function paletteFor(tone: PipTone, theme: ReturnType<typeof useTheme>) {
  if (tone === 'getOff') return { background: theme.getOff, text: theme.onAccent, secondary: theme.onAccent };
  if (tone === 'offPlan') return { background: theme.danger, text: theme.onAccent, secondary: theme.onAccent };
  return { background: theme.background, text: theme.text, secondary: theme.textSecondary };
}

const styles = StyleSheet.create({
  // Flat: a fill and nothing else, like every surface in the app.
  root: {
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  fill: {
    flex: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
