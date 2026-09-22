import { IconRss } from '@tabler/icons-react-native';
import { StyleSheet, View } from 'react-native';

export type LiveIndicatorProps = {
  size?: number;
  color: string;
};

/**
 * The mark that says a time came from a vehicle rather than a timetable.
 *
 * Rotated so the signal arcs stand straight up over the dot, the convention
 * every transit app has settled on for "this is live". Deliberately a glyph
 * and not a word: it sits beside a countdown on a dense board, and a rider
 * learns it once.
 *
 * The angle is -45 and not +45 because Tabler's RSS is symmetric about its
 * bottom-left-to-top-right diagonal: turning that diagonal upright leaves a
 * glyph with a vertical mirror line, which is the whole point here. It reads
 * identically in Hebrew and in English, so it needs no `I18nManager` mirror
 * and no directional pair -- unlike the arrows in `directional-icon`, a
 * signal mark points at nothing. +45 turns the same diagonal on its side and
 * gives an arrow-ish `•))` that would then have to flip per language.
 *
 * The rotation goes on a wrapper `View`, never on the icon itself. A `style`
 * handed to a Tabler icon is spread onto the `Svg` AND onto every `Path`
 * inside it, and react-native-svg flattens a shape's style into its props --
 * so each arc gets its own `rotate(-45)` about the SVG's (0,0) corner, on top
 * of the whole glyph turning. Two of the three paths land outside the 24x24
 * viewBox and the third shows as a sliver, which reads as a stray tick mark
 * next to the countdown. Same trap as the mirrored arrows in
 * `directional-icon`: a transform aimed at one of these icons never lands
 * where it looks like it will.
 *
 * Only ever rendered where `useRealtimeAvailable()` is true -- see that
 * hook's comment for why an app with no live feed at all must show neither
 * this NOR a "scheduled" counterpart.
 */
export function LiveIndicator({ size = 12, color }: LiveIndicatorProps) {
  return (
    <View style={styles.rotated}>
      <IconRss size={size} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  rotated: {
    transform: [{ rotate: '-45deg' }],
  },
});
