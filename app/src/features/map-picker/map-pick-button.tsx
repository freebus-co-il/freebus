import { IconMap } from '@tabler/icons-react-native';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useControlOutline, useTheme } from '@/hooks/use-theme';

/**
 * The way into choosing a place on the map, beside the search field it is an
 * alternative to. The field's own outline and corner, and stretched to the
 * field's height by the row, so the two read as one control.
 *
 * Absent on web, where there is no map to choose on.
 */
export function MapPickButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  // Above the early return: a hook cannot be called from inside the style
  // array below it, which only runs on the platforms that render at all.
  const outline = useControlOutline();

  if (Platform.OS === 'web') return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('mapPicker.open')}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.background }, outline]}
    >
      <IconMap size={20} color={theme.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.four,
  },
});
