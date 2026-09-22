import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/**
 * The line between two inline rows.
 *
 * The app has no cards: a list is rows sitting directly on the page, and
 * this is what keeps them from running together. Use it BETWEEN rows in one
 * list -- never above the first or below the last, where it would draw the
 * outline of the card that is deliberately not there, and never between
 * top-level sections, which are separated by whitespace and their heading.
 *
 * `hairlineWidth`, not 1, so it stays one physical pixel on a 3x screen
 * rather than growing into a visible rule.
 */
export function Hairline() {
  const theme = useTheme();

  return <View style={[styles.line, { backgroundColor: theme.borderMuted }]} />;
}

const styles = StyleSheet.create({
  line: {
    height: StyleSheet.hairlineWidth,
  },
});
