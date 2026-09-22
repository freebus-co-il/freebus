import { IconBus, IconCheck, IconChevronDown } from '@tabler/icons-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTransitModes } from '@/api/modes';
import type { TransitMode } from '@/api/types';
import { SheetBackdrop, useSheetEdge } from '@/components/sheet-backdrop';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useSearch } from '@/features/search/search-context';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { hapticSelected } from '@/lib/haptics';

/**
 * A floating chip over the map, matching `TripTimePicker`, that opens a
 * multi-select sheet of the vehicle types this feed can actually plan with.
 *
 * Renders NOTHING while `/modes` is loading or after it has failed: a broken
 * lookup must never stand between a rider and a trip plan, and a chip that
 * opens an empty sheet is worse than no chip at all.
 */
export function ModeFilterChip() {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const sheetEdge = useSheetEdge();
  const { selectedModes, setSelectedModes } = useSearch();
  const { data } = useTransitModes();
  const [open, setOpen] = useState(false);
  // What the sheet is editing, held locally and only committed on close.
  //
  // Two reasons, and the first is structural: writing straight to the search
  // context on every tap re-keys the /plan query, and anything that unmounts
  // this component while that is in flight takes the open sheet down with it.
  // A local draft touches no shared state at all, so a tick cannot close the
  // sheet however the rest of the screen reacts.
  //
  // The second is plain waste: committing per tap ran one whole search per
  // checkbox, so picking three vehicle types fired three of them and churned
  // the map and carousel underneath the sheet between each.
  const [draft, setDraft] = useState<number[]>(selectedModes);

  const modes = data?.modes ?? [];
  if (modes.length === 0) return null;

  // The app's own label wins; the backend's English GTFS name is the fallback
  // for a type shipped by a feed newer than this build. i18next's
  // `defaultValue` IS that fallback -- there is no second lookup path.
  const label = (mode: TransitMode) => t(`results.modeType.${mode.type}`, { defaultValue: mode.name });

  const selectedMode = modes.find((mode) => mode.type === selectedModes[0]);
  const summary =
    selectedModes.length === 0
      ? t('results.modeFilterAll')
      : selectedModes.length === 1 && selectedMode
        ? label(selectedMode)
        : t('results.modeFilterCount', { count: selectedModes.length });

  function toggle(type: number) {
    hapticSelected();
    setDraft(draft.includes(type) ? draft.filter((value) => value !== type) : [...draft, type]);
  }

  // Seeded from the committed selection each time, so a sheet abandoned last
  // time never reopens holding stale edits.
  function openSheet() {
    setDraft(selectedModes);
    setOpen(true);
  }

  // Every way out of the sheet commits -- Done, the backdrop, and Android's
  // back gesture. Discarding on some of those and keeping on others is the
  // kind of distinction a rider has to learn by losing work once.
  function closeSheet() {
    setSelectedModes(draft);
    setOpen(false);
  }

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={summary} onPress={openSheet}>
        <ThemedView type="background" style={[styles.chip, outline]}>
          <IconBus size={18} color={theme.text} />
          <ThemedText type="smallBold">{summary}</ThemedText>
          <IconChevronDown size={16} color={theme.textSecondary} />
        </ThemedView>
      </Pressable>

      <Modal transparent animationType="slide" visible={open} onRequestClose={closeSheet}>
        <SheetBackdrop onPress={closeSheet} />
        <ThemedView type="background" style={[styles.sheet, sheetEdge]}>
          <ThemedView style={[styles.grabber, { backgroundColor: theme.borderMuted }]} />
          <ThemedText type="subtitle">{t('results.modeFilterTitle')}</ThemedText>

          <ScrollView style={styles.list}>
            {modes.map((mode) => {
              // An empty selection means "all", so every row reads as ticked in
              // that state -- showing six empty checkboxes for a filter that is
              // letting everything through would be a plain lie.
              const checked = draft.length === 0 || draft.includes(mode.type);
              return (
                <Pressable
                  key={mode.type}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  onPress={() => toggle(mode.type)}
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
                    {label(mode)}
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
                <ThemedText type="smallBold">{t('results.modeFilterReset')}</ThemedText>
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
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 999,
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
  // Bounded so a feed with many vehicle types cannot grow the sheet past the
  // screen; six rows sit well inside this.
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
