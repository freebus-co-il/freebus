import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ResultsEmptyStateProps = {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  /** The action is already running -- a refresh in flight. */
  busy?: boolean;
};

/**
 * What the bottom of the results screen shows when there is no trip to show:
 * never a bare map. It says why, what to change, and offers the one action that
 * moves the rider on -- search again, or pick the place the search is missing.
 */
export function ResultsEmptyState({ title, body, actionLabel, onAction, busy = false }: ResultsEmptyStateProps) {
  const theme = useTheme();
  return (
    <ThemedView type="background" style={[styles.card, { borderColor: theme.borderMuted }]}>
      <ThemedText type="defaultBold" style={styles.text}>
        {title}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.text}>
        {body}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={onAction}
        style={[styles.button, { backgroundColor: theme.text }]}
      >
        {busy ? (
          <ActivityIndicator color={theme.background} />
        ) : (
          <ThemedText type="defaultBold" themeColor="background">
            {actionLabel}
          </ThemedText>
        )}
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  // The same card the loading state sits in, so the bottom of the screen keeps
  // its place whichever state it is in.
  card: {
    alignItems: 'center',
    marginHorizontal: Spacing.three,
    padding: Spacing.four,
    gap: Spacing.two,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
  },
  text: {
    textAlign: 'center',
  },
  button: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: Spacing.two,
    borderRadius: 999,
  },
});
