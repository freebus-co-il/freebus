import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Layout, Motion, Toast } from '@/design-system';
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

/** Arrives on the design system's `bouncy` spring -- a thing arriving -- and
 *  leaves on a plain fade. Reanimated's layout animations already fall back
 *  to no motion under Reduce Motion. The fade is on this wrapper, never on the
 *  glass itself, which stops rendering at opacity 0 (see `Glass`). */
const ENTERING = FadeInDown.springify().duration(Motion.bouncy.duration).dampingRatio(Motion.bouncy.dampingRatio);
const EXITING = FadeOutDown.duration(Motion.fade.duration);

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
      entering={ENTERING}
      exiting={EXITING}
      style={[styles.bar, { bottom: insets.bottom + TAB_BAR_CLEARANCE }]}
    >
      <Toast
        icon="refresh"
        message={t('update.title')}
        detail={t('update.detail')}
        onPress={() => {
          hapticSelected();
          // A failed reload leaves the rider exactly where not tapping
          // would have left them, and the update still lands next launch.
          void Updates.reloadAsync().catch(() => {});
        }}
      />
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
  // Glass chrome (the design system's `Toast`), not content: it floats over
  // whatever screen is up, the way the tab bar does.
  bar: {
    position: 'absolute',
    left: Layout.pageInset,
    right: Layout.pageInset,
  },
});
