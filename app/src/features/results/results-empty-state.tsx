import { StyleSheet } from 'react-native';

import { Button, Card, EmptyState, Layout, Space, type IconName } from '@/design-system';

export type ResultsEmptyStateProps = {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  /** What the state is about: a missing place, an error, no service. */
  icon?: IconName;
  /** The action is already running -- a refresh in flight. */
  busy?: boolean;
};

/**
 * What the bottom of the results screen shows when there is no trip to show:
 * never a bare map. It says why, what to change, and offers the one action that
 * moves the rider on -- search again, or pick the place the search is missing.
 *
 * The action is its own `Button` rather than `EmptyState`'s, because it has to
 * show a refresh already in flight (spinner, disabled) without changing width.
 */
export function ResultsEmptyState({ title, body, actionLabel, onAction, icon = 'info', busy = false }: ResultsEmptyStateProps) {
  return (
    // The same floating card the loading state sits in, so the bottom of the
    // screen keeps its place whichever state it is in.
    <Card variant="floating" style={styles.card}>
      <EmptyState icon={icon} title={title} message={body} style={styles.empty} />
      <Button label={actionLabel} onPress={onAction} loading={busy} variant="prominent" size="md" fullWidth />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: Layout.pageInset,
  },
  // A page's empty state is centred in a whole screen of air; over a map it
  // has to stay a compact block, so most of that padding goes.
  empty: {
    paddingHorizontal: Space.none,
    paddingVertical: Space.sm,
  },
});
