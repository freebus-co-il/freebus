import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** The one action the sheet exists to offer. */
  confirmLabel: string;
  /** Omitted for a notice: the sheet then has its confirm row alone. */
  cancelLabel?: string;
  /** Draws the confirm row in `danger` -- for an action that tears something down. */
  destructive?: boolean;
}

type Request = ConfirmOptions & { resolve: (confirmed: boolean) => void };

/**
 * The one `ConfirmHost` mounted, taking requests.
 *
 * Module state rather than a context, because not every caller is a
 * component: the background-location disclosure is asked from inside the
 * journey provider's async start-up, which has no hook to reach for.
 */
let present: ((request: Request) => void) | null = null;

/**
 * Asks the rider, on the app's own bottom sheet rather than the system alert,
 * and resolves with their answer. Dismissing it any other way -- the scrim,
 * Android's back button -- is a no.
 *
 * With no host mounted (a test, or a call made before the root layout has
 * rendered) this is a no as well: an unanswerable question is not a yes.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (present === null) {
      resolve(false);
      return;
    }
    present({ ...options, resolve });
  });
}

/** A notice with a single row to close it -- the sheet's answer is ignored. */
export function notify(title: string, closeLabel: string): void {
  void confirm({ title, confirmLabel: closeLabel });
}

/**
 * Renders whatever `confirm` was last asked. Mount once, above the navigator,
 * so a question asked from any screen floats over all of them.
 */
export function ConfirmHost() {
  const theme = useTheme();
  const sheetEdge = useSheetEdge();
  const [request, setRequest] = useState<Request | null>(null);

  useEffect(() => {
    present = (next) => {
      // One question at a time. A newer one replaces an unanswered older one,
      // which is answered no rather than left hanging forever.
      setRequest((current) => {
        current?.resolve(false);
        return next;
      });
    };
    return () => {
      present = null;
    };
  }, []);

  function answer(confirmed: boolean) {
    request?.resolve(confirmed);
    setRequest(null);
  }

  return (
    <Modal transparent animationType="slide" visible={request !== null} onRequestClose={() => answer(false)}>
      <SheetBackdrop onPress={() => answer(false)} />
      <ThemedView type="background" style={[styles.sheet, sheetEdge]}>
        <SafeAreaView edges={['bottom']}>
          <ThemedView style={[styles.grabber, { backgroundColor: theme.borderMuted }]} />
          {request && (
            <>
              <ThemedText type="smallBold" style={styles.title}>
                {request.title}
              </ThemedText>
              {request.body !== undefined && (
                <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
                  {request.body}
                </ThemedText>
              )}
              <Pressable accessibilityRole="button" style={styles.actionRow} onPress={() => answer(true)}>
                <ThemedText type="default" themeColor={request.destructive ? 'danger' : undefined}>
                  {request.confirmLabel}
                </ThemedText>
              </Pressable>
              {request.cancelLabel !== undefined && (
                <Pressable accessibilityRole="button" style={styles.actionRow} onPress={() => answer(false)}>
                  <ThemedText type="default">{request.cancelLabel}</ThemedText>
                </Pressable>
              )}
            </>
          )}
        </SafeAreaView>
      </ThemedView>
    </Modal>
  );
}

// The saved-location actions sheet's metrics, so the app's sheets agree.
const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.two,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: Spacing.two,
  },
  title: {
    paddingBottom: Spacing.two,
  },
  body: {
    paddingBottom: Spacing.two,
  },
  actionRow: {
    paddingVertical: Spacing.three,
  },
});
