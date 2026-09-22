import { IconMapPin } from '@tabler/icons-react-native';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Hairline } from '@/components/hairline';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import type { SelectedPlace } from '@/lib/place';
import { placeLabel } from '@/lib/place';

import { useRecents } from './recents-context';
import { recentSearchKey } from './recents';

/** The rider asked for three. Enough to cover a commute both ways plus the
 *  one other place anybody goes regularly; past that it stops being quick
 *  access and becomes a list to read. */
const SHOWN = 3;

/**
 * The last few places the rider searched for, as one-tap shortcuts.
 *
 * Lives on the SEARCH screen, under an empty search box -- not on the home
 * screen. A list of places already searched is what you want the moment you
 * go looking for one, and nowhere else: on home it would be a third standing
 * section competing with the suggestion and the stop list, pushing both down
 * to earn a row that is only ever relevant once the rider has decided to
 * search. Here it fills the screen that is otherwise blank until they type.
 *
 * A row is a PLACE, not a trip, and `onSelect` is the picker's own
 * `commitPlace` -- the same function a tapped search result goes through.
 * That is what lets these rows appear in every mode the picker has: as a
 * destination, as an origin, or as the address being pinned to a saved
 * location, a place the rider looked up before is a reasonable answer, and
 * none of them has to special-case a row that is just a place. It also
 * means tapping one plans from where the rider is standing NOW; it
 * deliberately does not replay the origin of the original search.
 *
 * Renders nothing at all until there is something to show, so a rider who
 * has never searched just sees the empty picker.
 */
export function RecentSearches({ onSelect }: { onSelect: (place: SelectedPlace) => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const { searches } = useRecents();

  const shown = searches.slice(0, SHOWN);
  if (shown.length === 0) return null;

  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {t('recentSearches.title')}
      </ThemedText>
      <View>
        {shown.map((search, index) => (
          <Fragment key={recentSearchKey(search)}>
            {index > 0 && <Hairline />}
            <Pressable onPress={() => onSelect(search.place)} style={styles.row}>
              {/* One pin for every row, a stop included. `SelectedPlace` is
                  all that is stored, and it carries no `stationKind`/`rail`
                  -- so drawing a stop's sign here would mean showing the
                  BUS flag for a train station, which is worse than not
                  claiming to know. The slot itself stays, keeping this text
                  on the same edge as the search results below it. */}
              <View style={[styles.iconCircle, { backgroundColor: theme.background }, outline]}>
                <IconMapPin size={18} color={theme.text} />
              </View>
              <ThemedText type="default" numberOfLines={1} style={styles.label}>
                {placeLabel(search.place)}
              </ThemedText>
            </Pressable>
          </Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No gap under a list heading: the first row's own vertical padding is
  // the space. A gap on top of that padding reads as a bigger break than
  // the one between the rows themselves, which says the heading is not
  // attached to the list it names.
  section: {
    gap: 0,
  },
  // Matches the picker's own result rows: these sit directly above that list.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
  },
});
