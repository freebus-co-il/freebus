import { IconRefresh } from '@tabler/icons-react-native';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hapticSelected } from '@/lib/haptics';

/**
 * Enough to clear the tab bar, which is ~49pt plus its own hairline.
 *
 * A constant rather than a measurement: this floats over the whole
 * navigator, so on a pushed screen there is no tab bar under it to measure
 * and it simply sits a little higher than it needs to.
 */
const TAB_BAR_CLEARANCE = 56;

/** Long enough to read two lines of Hebrew without hurrying, short enough
 *  that it is gone before it becomes part of the furniture. */
const VISIBLE_MS = 6000;

/**
 * Announces an update that has already been downloaded, then gets out of
 * the way.
 *
 * An ANNOUNCEMENT, not a prompt: it says the update is there and that it
 * arrives by itself next launch, which is what `expo-updates` does by
 * default. So there is nothing the rider must do, and nothing is lost if
 * they never touch it -- which matters, because the tap is not reliable
 * (see below).
 *
 * Tapping it does still restart into the update, and that is worth wiring
 * even though it could not be made to work on the simulator: it costs one
 * handler, and if it works on a real build it is the faster path. What the
 * text promises is only the part that is certain.
 *
 * Gated on `isUpdatePending`, not `isUpdateAvailable`: pending means the
 * bundle is already on the device, so "next launch" is a promise that can
 * be kept with the radio off.
 */
export function UpdateSnackbar() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { isUpdatePending } = Updates.useUpdates();
  const [hidden, setHidden] = useState(false);

  // Starts when the bar appears, not on mount: `isUpdatePending` flips some
  // time after launch, once the download finishes.
  useEffect(() => {
    if (!isUpdatePending) return;
    const timer = setTimeout(() => setHidden(true), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [isUpdatePending]);

  if (!isUpdatePending || hidden) return null;

  return (
    <Animated.View
      entering={FadeInDown}
      exiting={FadeOutDown}
      style={[styles.bar, { backgroundColor: theme.text, bottom: insets.bottom + TAB_BAR_CLEARANCE }]}
    >
      <Pressable
        onPress={() => {
          hapticSelected();
          // A failed reload leaves the rider exactly where not tapping
          // would have left them, and the update still lands next launch.
          void Updates.reloadAsync().catch(() => {});
        }}
        style={styles.action}
      >
        <IconRefresh size={18} color={theme.background} />
        <View style={styles.text}>
          <ThemedText type="smallBold" themeColor="background">
            {t('update.title')}
          </ThemedText>
          {/* Dimmed rather than a second colour: on a `text` fill there is
              no `textSecondary` that reads, and the app has no token for
              ink ON the inverse. */}
          <ThemedText type="small" themeColor="background" style={styles.detail}>
            {t('update.detail')}
          </ThemedText>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Floats OVER the content rather than taking a row in the layout: in
  // flow it pushed the whole page up by its own height for six seconds
  // and then dropped it back, which is a bigger disturbance than the
  // message is worth.
  //
  // `left`/`right`, not `start`/`end`: the inset is symmetric, so there is
  // nothing for the writing direction to mirror.
  //
  // The app's "press me" shape: a solid `text` fill with page-colour ink,
  // the same as a saved shortcut or a primary button.
  bar: {
    position: 'absolute',
    left: Spacing.four,
    right: Spacing.four,
    borderRadius: Spacing.four,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  text: {
    flex: 1,
    gap: Spacing.half,
  },
  detail: {
    opacity: 0.7,
  },
});
