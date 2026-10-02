import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { GOOGLE_MAPS_TEXT, OSM_COPYRIGHT_URL, type Attribution } from '@/lib/attribution';

/** Google's own greys for its text attribution; both clear 4.5:1 on our
 *  backgrounds and on the overlay pill. */
const INK = { light: '#5E5E5E', dark: '#FFFFFF' } as const;

/**
 * The credit a licence asks for beside the data it covers -- see
 * `@/lib/attribution`. `overlay` sits on a map, so it gets a translucent pill
 * of its own; `inline` sits on the page.
 */
export function DataCredit({
  source, variant = 'inline', style,
}: { source: Attribution; variant?: 'inline' | 'overlay'; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const ink = INK[scheme];
  const pill = variant === 'overlay'
    ? [styles.pill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)' }]
    : null;

  if (source === 'google') {
    return (
      <View style={[styles.container, pill, style]} accessible accessibilityLabel={GOOGLE_MAPS_TEXT}>
        {/* Google's text form: 12-16 sp, the system sans-serif, one line. */}
        <Text numberOfLines={1} style={[styles.google, { color: ink }]}>{GOOGLE_MAPS_TEXT}</Text>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t('attribution.osmA11y')}
      onPress={() => void Linking.openURL(OSM_COPYRIGHT_URL)}
      hitSlop={8}
      style={[styles.container, pill, style]}
    >
      <Text numberOfLines={1} style={[styles.osm, { color: ink }]}>{t('attribution.osm')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Google's clear space: 10 dp on the sides and top, 5 dp below.
  container: { alignSelf: 'center', paddingHorizontal: 10, paddingTop: 10, paddingBottom: 5 },
  pill: { paddingTop: 3, paddingBottom: 3, borderRadius: 8 },
  google: { fontSize: 12 },
  osm: { fontSize: 11 },
});
