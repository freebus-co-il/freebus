import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';

import { Button, Chip, Layout, ListRow, ListSection, Sheet, type IconName } from '@/design-system';
import { hapticSelected } from '@/lib/haptics';

export type FilterOption<T extends string | number> = { value: T; label: string };

/** The checklist's ceiling inside the sheet: a feed with many operators
 *  scrolls inside the sheet rather than growing it past the screen. A measured
 *  height (about seven rows), not a spacing step. */
const CHECKLIST_MAX_HEIGHT = 320;

type Props<T extends string | number> = {
  /** Drawn inside the chip, before the label. */
  icon: IconName;
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
 * checkmarks, exactly as `ModeFilterChip` does over the results map. Same
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

  // Every way out commits -- Done, the close button, the backdrop, and
  // Android's back gesture. Discarding on some of those and keeping on others
  // is the kind of distinction a rider has to learn by losing work once.
  function closeSheet() {
    onCommit(draft);
    setOpen(false);
  }

  // Locked: the other filter has already decided this one, so there is
  // nothing to open. `locked` disables the chip's press target outright (the
  // handler never runs), swaps the chevron for a padlock and drains the ink,
  // and the reason travels in the accessibility hint.
  if (lockedLabel !== undefined) {
    return (
      <Chip
        icon={icon}
        label={lockedLabel}
        locked
        onPress={openSheet}
        accessibilityLabel={lockedLabel}
        accessibilityHint={lockedHint}
      />
    );
  }

  return (
    <>
      {/* Filled while it narrows the list, so a rider can see from the chip
          row alone that what is below is not everything. */}
      <Chip icon={icon} label={summary} menu selected={selected.length > 0} onPress={openSheet} />

      <Sheet
        visible={open}
        onClose={closeSheet}
        title={title}
        closeLabel={t('common.close')}
        footer={
          <>
            {draft.length > 0 && (
              <Button label={resetLabel} variant="secondary" size="lg" onPress={() => setDraft([])} style={styles.action} />
            )}
            <Button label={t('common.done')} variant="prominent" size="lg" onPress={closeSheet} style={styles.action} />
          </>
        }
      >
        <ScrollView style={styles.list}>
          <ListSection style={styles.group}>
            {options.map((option) => {
              // An empty selection means "all", so every row reads as ticked
              // in that state -- showing a column of empty checks for a
              // filter letting everything through would be a plain lie.
              const checked = draft.length === 0 || draft.includes(option.value);
              return (
                <ListRow
                  key={String(option.value)}
                  title={option.label}
                  accessory="check"
                  selection="multiple"
                  selected={checked}
                  onPress={() => toggle(option.value)}
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
    maxHeight: CHECKLIST_MAX_HEIGHT,
  },
  group: {
    marginHorizontal: Layout.pageInset,
  },
  action: {
    flex: 1,
  },
});
