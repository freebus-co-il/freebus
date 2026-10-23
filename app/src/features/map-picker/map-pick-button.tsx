import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type StyleProp, type View, type ViewStyle } from 'react-native';

import { IconButton } from '@/design-system';

/**
 * The way into choosing a place on the map, beside the search control it is
 * an alternative to. A glass circle, so it reads as the same floating chrome
 * as the glass "Where to?" capsule next to it rather than as page content.
 *
 * Absent on web, where there is no map to choose on.
 */
export const MapPickButton = forwardRef<View, { onPress: () => void; style?: StyleProp<ViewStyle> }>(function MapPickButton(
  { onPress, style },
  ref,
) {
  const { t } = useTranslation();

  if (Platform.OS === 'web') return null;

  return (
    <IconButton
      ref={ref}
      icon="map"
      variant="glass"
      accessibilityLabel={t('mapPicker.open')}
      onPress={onPress}
      style={style}
    />
  );
});
