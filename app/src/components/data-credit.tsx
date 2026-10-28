import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Glass, Space, Text, useScheme } from '@/design-system';
import { GOOGLE_MAPS_TEXT, OSM_COPYRIGHT_URL, type Attribution } from '@/lib/attribution';

/** Google's own greys for its text attribution; both clear 4.5:1 on our pages
 *  and on the overlay pill. Licence-mandated, so not theme roles. */
const INK = { light: '#5E5E5E', dark: '#FFFFFF' } as const;

/**
 * The credit a licence asks for beside the data it covers -- see
 * `@/lib/attribution`. `overlay` sits on a map in a small glass pill; `inline`
 * sits on the page.
 */
export function DataCredit({
  source, variant = 'inline', style,
}: { source: Attribution; variant?: 'inline' | 'overlay'; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const ink = INK[useScheme()];
  const label =
    source === 'google' ? (
      // Google's text form: 12-16 sp, the system sans-serif, one line.
      <Text variant="caption1" color={ink} numberOfLines={1}>{GOOGLE_MAPS_TEXT}</Text>
    ) : (
      <Text variant="caption2" color={ink} numberOfLines={1}>{t('attribution.osm')}</Text>
    );
  const body = variant === 'overlay' ? <Glass variant="clear" style={styles.pill}>{label}</Glass> : <View style={styles.inline}>{label}</View>;

  if (source === 'google') {
    return (
      <View style={[styles.container, style]} accessible accessibilityLabel={GOOGLE_MAPS_TEXT}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t('attribution.osmA11y')}
      onPress={() => void Linking.openURL(OSM_COPYRIGHT_URL)}
      hitSlop={Space.sm}
      style={[styles.container, style]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'center' },
  // Google's clear space: 10 dp on the sides and top, 5 dp below.
  inline: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 5 },
  pill: { paddingHorizontal: Space.sm, paddingVertical: Space.xxs },
});
