import { IconCheck, IconChevronDown, IconLock } from '@tabler/icons-react-native';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { hapticSelected } from '@/lib/haptics';

export type FilterOption<T extends string | number> = { value: T; label: string };

type Props<T extends string | number> = {
  /** Drawn inside the chip, before the label. */
  icon: ReactNode;
  /** The sheet's heading. */
  title: string;
  options: FilterOption<T>[];
  selected: T[];
  onCommit: (next: T[]) => void;
  /** Chip label while nothing is picked -- an empty selection means "all". */
  allLabel: string;
  /** Chip label for two or more; the single pick shows its own name. */
  countLabel: string;
  resetLabel: string;
  /** Set to lock the chip: it stops being pressable, shows this label instead
   *  of a summary, and says why through `lockedHint`. */
  lockedLabel?: string;
  lockedHint?: string;
};

/**
 * The Lines tab's filter chip: a pill that opens a bottom sheet of
 * checkboxes, exactly as `ModeFilterChip` does over the results map. Same
 * idiom on purpose -- one sheet pattern in the app, not two.
 *
 * Generic over the value because the tab wants two of these, one keyed by
 * operator id and one by GTFS route type, and the only difference between
 * them is the list they are handed.
 */
export function LineFilterChip<T extends string | number>({
  icon,
  title,
  options,
  selected,
  onCommit,
  allLabel,
  countLabel,
  resetLabel,
  lockedLabel,
  lockedHint,
}: Props<T>) {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const sheetEdge = useSheetEdge();
  const [open, setOpen] = useState(false);
  // What the sheet is editing, held locally and only committed on close.
  //
  // Same reasoning as `ModeFilterChip`: writing to the screen's filter state
  // on every tap re-keys the /routes query, so a list that reacts by
  // unmounting takes the open sheet with it -- and it runs one whole search
  // per checkbox besides.
  const [draft, setDraft] = useState<T[]>(selected);

  const chosen = options.find((option) => option.value === selected[0]);
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1 && chosen
        ? chosen.label
        : countLabel;

  function toggle(value: T) {
    hapticSelected();
    setDraft(draft.includes(value) ? draft.filter((other) => other !== value) : [...draft, value]);
  }

  // Seeded from the committed selection each time, so a sheet abandoned last
  // time never reopens holding stale edits.
  function openSheet() {
    setDraft(selected);
    setOpen(true);
  }

  // Every way out commits -- Done, the backdrop, and Android's back gesture.
  // Discarding on some of those and keeping on others is the kind of
  // distinction a rider has to learn by losing work once.
  function closeSheet() {
    onCommit(draft);
    setOpen(false);
  }

  // Locked: the other filter has already decided this one, so there is
  // nothing to open. Rendered as a plain view rather than a disabled
  // Pressable so there is no press target at all, with the reason in the
  // accessibility hint and a padlock where the chevron would be.
  if (lockedLabel !== undefined) {
    return (
      <ThemedView
        type="background"
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        accessibilityLabel={lockedLabel}
        accessibilityHint={lockedHint}
        style={[styles.chip, styles.chipLocked, outline]}
      >
        {icon}
        <ThemedText type="smallBold" themeColor="textSecondary">
          {lockedLabel}
        </ThemedText>
        <IconLock size={14} color={theme.textSecondary} />
      </ThemedView>
    );
  }

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={summary} onPress={openSheet}>
        <ThemedView type="background" style={[styles.chip, outline]}>
          {icon}
          <ThemedText type="smallBold">{summary}</ThemedText>
          <IconChevronDown size={16} color={theme.textSecondary} />
        </ThemedView>
      </Pressable>

      <Modal transparent animationType="slide" visible={open} onRequestClose={closeSheet}>
        <SheetBackdrop onPress={closeSheet} />
        <ThemedView type="background" style={[styles.sheet, sheetEdge]}>
          <ThemedView style={[styles.grabber, { backgroundColor: theme.borderMuted }]} />
          <ThemedText type="subtitle">{title}</ThemedText>

          <ScrollView style={styles.list}>
            {options.map((option) => {
              // An empty selection means "all", so every row reads as ticked
              // in that state -- showing a column of empty checkboxes for a
              // filter letting everything through would be a plain lie.
              const checked = draft.length === 0 || draft.includes(option.value);
              return (
                <Pressable
                  key={String(option.value)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  onPress={() => toggle(option.value)}
                  style={styles.row}
                >
                  <View
                    style={[
                      styles.checkbox,
                      { borderColor: theme.borderMuted },
                      checked && { backgroundColor: theme.text, borderColor: theme.text },
                    ]}
                  >
                    {checked && <IconCheck size={14} color={theme.background} />}
                  </View>
                  <ThemedText type="default" style={styles.rowLabel}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.actions}>
            {draft.length > 0 && (
              <Pressable
                onPress={() => setDraft([])}
                style={[styles.secondaryButton, { borderColor: theme.borderMuted }]}
              >
                <ThemedText type="smallBold">{resetLabel}</ThemedText>
              </Pressable>
            )}
            <Pressable onPress={closeSheet} style={[styles.doneButton, { backgroundColor: theme.text }]}>
              <ThemedText type="smallBold" themeColor="background">
                {t('search.done')}
              </ThemedText>
            </Pressable>
          </View>
        </ThemedView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  /** `alignSelf` is load-bearing: as a child of a row the chip otherwise
   *  stretches and shrinks with its neighbour, which squeezes the label down
   *  to a single clipped glyph. Same as `ModeFilterChip`. */
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
  },
  // Inert, and it has to look it: the same pill, drained of contrast.
  chipLocked: {
    opacity: 0.6,
  },
  sheet: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    paddingTop: Spacing.two,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    gap: Spacing.three,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: Spacing.two,
  },
  // Bounded so a feed with many operators cannot grow the sheet past the
  // screen; it scrolls inside instead.
  list: {
    maxHeight: 320,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
  rowLabel: {
    flexShrink: 1,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: Spacing.one,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  secondaryButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  doneButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
});
