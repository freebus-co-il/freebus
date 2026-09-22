import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useControlOutline } from '@/hooks/use-theme';

/** The one search field in the app, in both of its states: the prompt on the
 *  home screen that opens the picker, and the live input on the picker
 *  itself. Shared rather than styled twice on purpose -- tapping the first
 *  pushes the second, so any drift between them (a border here, a different
 *  radius there) shows up as the field visibly changing shape mid-transition.
 *
 *  White like the page it sits on, marked out by its outline alone -- the
 *  same outline every chip and filter wears, so the field reads as one more
 *  control rather than a shape of its own. Callers supply the contents -- a
 *  leading `IconSearch`, then a label or a `TextInput` -- and the row lays
 *  them out. */
export function FieldShell({ children }: { children: ReactNode }) {
  const outline = useControlOutline();

  return (
    <ThemedView type="background" style={[styles.shell, outline]}>
      {children}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.four,
  },
});
