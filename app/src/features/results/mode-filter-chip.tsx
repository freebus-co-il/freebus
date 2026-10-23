import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';

import { useTransitModes } from '@/api/modes';
import type { TransitMode } from '@/api/types';
import { Button, Chip, Layout, ListRow, ListSection, Sheet } from '@/design-system';
import { useSearch } from '@/features/search/search-context';
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
  // tick, so picking three vehicle types fired three of them and churned
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

  // Every way out of the sheet commits -- Done, the close button, the scrim,
  // and Android's back gesture (all of which `Sheet` routes to `onClose`). Discarding on some of those and keeping on others is the
  // kind of distinction a rider has to learn by losing work once.
  function closeSheet() {
    setSelectedModes(draft);
    setOpen(false);
  }

  return (
    <>
      <Chip label={summary} icon="bus" menu glass onPress={openSheet} accessibilityLabel={summary} />

      <Sheet
        visible={open}
        onClose={closeSheet}
        title={t('results.modeFilterTitle')}
        closeLabel={t('common.close')}
        footer={
          <>
            {draft.length > 0 && (
              <Button
                label={t('results.modeFilterReset')}
                onPress={() => setDraft([])}
                variant="secondary"
                size="lg"
                style={styles.footerButton}
              />
            )}
            <Button label={t('search.done')} onPress={closeSheet} variant="prominent" size="lg" style={styles.footerButton} />
          </>
        }
      >
        {/* Bounded by the sheet (which never grows past most of the screen),
            so a feed with many vehicle types scrolls rather than pushing the
            footer off the bottom. */}
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          <ListSection>
            {modes.map((mode) => {
              // An empty selection means "all", so every row reads as ticked in
              // that state -- showing six empty checkmarks for a filter that is
              // letting everything through would be a plain lie.
              const checked = draft.length === 0 || draft.includes(mode.type);
              return (
                <ListRow
                  key={mode.type}
                  title={label(mode)}
                  accessory="check"
                  selection="multiple"
                  selected={checked}
                  onPress={() => toggle(mode.type)}
                />
              );
            })}
          </ListSection>
        </ScrollView>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: Layout.pageInset,
  },
  // Reset and Done share the footer row evenly.
  footerButton: {
    flex: 1,
  },
});
