import { useTranslation } from 'react-i18next';
import type { StyleProp, ViewStyle } from 'react-native';

import { Icon, LeadingIcon, ListRow, ListSection } from '@/design-system';
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
 * A whole grouped section, title included, so the picker places it like any
 * other section of its page. Renders nothing at all until there is something
 * to show, so a rider who has never searched just sees the empty picker.
 */
export function RecentSearches({ onSelect, style }: { onSelect: (place: SelectedPlace) => void; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const { searches } = useRecents();

  const shown = searches.slice(0, SHOWN);
  if (shown.length === 0) return null;

  return (
    <ListSection title={t('recentSearches.title')} style={style}>
      {shown.map((search) => (
        <ListRow
          key={recentSearchKey(search)}
          // One history glyph for every row, a stop included. `SelectedPlace`
          // is all that is stored, and it carries no `stationKind`/`rail` --
          // so drawing a stop's sign here would mean showing the BUS flag for
          // a train station, which is worse than not claiming to know. The
          // tile itself keeps this text on the same edge as the results.
          leading={
            <LeadingIcon>
              <Icon name="history" size="sm" weight="medium" />
            </LeadingIcon>
          }
          title={placeLabel(search.place)}
          titleLines={1}
          onPress={() => onSelect(search.place)}
        />
      ))}
    </ListSection>
  );
}
