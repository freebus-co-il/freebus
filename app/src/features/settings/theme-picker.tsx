import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Border, Palettes, Radius, Space, Text, useColors, type Scheme } from '@/design-system';
import type { ThemePreference } from '@/features/preferences/preferences-context';
import { hapticSelected } from '@/lib/haptics';

import { THEME_OPTIONS } from './options';

const PHONE = { width: 64, height: 112 };

/**
 * A thumbnail of the home screen in one scheme: header, search capsule, a
 * group of departures and the tab bar. Drawn from the scheme's own palette,
 * not the running one, so the dark thumbnail stays dark on a light page.
 */
function PhoneMockup({ scheme }: { scheme: Scheme }) {
  const c = Palettes[scheme];
  return (
    <View style={[styles.phone, { backgroundColor: c.bgGrouped, borderColor: c.separator }]}>
      <View style={[styles.title, { backgroundColor: c.textPrimary }]} />
      <View style={[styles.capsule, { backgroundColor: c.surfaceGroup }]} />
      <View style={[styles.group, { backgroundColor: c.surfaceGroup }]}>
        {[0, 1].map((row) => (
          <View key={row} style={styles.row}>
            <View style={[styles.sign, { backgroundColor: c.busSign }]} />
            <View style={[styles.text, { backgroundColor: c.textTertiary }]} />
          </View>
        ))}
      </View>
      <View style={[styles.tabBar, { backgroundColor: c.surfaceGroup }]} />
    </View>
  );
}

/** `device` follows the phone, so its thumbnail is both: light with the dark
 *  half laid over its end side. */
function Preview({ value }: { value: ThemePreference }) {
  if (value !== 'device') return <PhoneMockup scheme={value} />;
  return (
    <View>
      <PhoneMockup scheme="light" />
      <View style={styles.half}>
        <View style={styles.halfInner}>
          <PhoneMockup scheme="dark" />
        </View>
      </View>
    </View>
  );
}

/** System, light and dark as three tiles, each showing what it picks. */
export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View accessibilityRole="radiogroup" style={styles.tiles}>
      {THEME_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={t(option.labelKey)}
            // Ticks on a real change only, like every other choice in settings.
            onPress={() => {
              if (!selected) hapticSelected();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.tile,
              {
                backgroundColor: pressed ? colors.fillPressed : colors.surfaceGroup,
                borderColor: selected ? colors.accent : 'transparent',
              },
            ]}
          >
            <Preview value={option.value} />
            <Text
              variant="subheadline"
              emphasized={selected}
              color={selected ? 'textPrimary' : 'textSecondary'}
              numberOfLines={1}
            >
              {t(option.labelKey)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: Space.sm },
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: Space.md,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
    borderRadius: Radius.lg,
    // Always drawn, transparent when unselected, so selecting never shifts the tile.
    borderWidth: Border.selected,
  },
  phone: {
    width: PHONE.width,
    height: PHONE.height,
    borderRadius: Radius.md,
    borderWidth: Border.default,
    padding: Space.xs,
    gap: Space.xs,
    overflow: 'hidden',
  },
  title: { width: '50%', height: Space.xs, borderRadius: Radius.xs, marginTop: Space.xs },
  capsule: { height: Space.sm, borderRadius: Radius.full },
  group: { borderRadius: Radius.xs, padding: Space.xs, gap: Space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  sign: { width: Space.sm, height: Space.sm, borderRadius: Radius.xs },
  text: { flex: 1, height: Space.xs, borderRadius: Radius.xs },
  tabBar: { marginTop: 'auto', height: Space.md, borderRadius: Radius.full },
  // The end half of the thumbnail, clipping a full-width dark copy aligned to it.
  half: { position: 'absolute', top: 0, bottom: 0, end: 0, width: PHONE.width / 2, overflow: 'hidden' },
  halfInner: { position: 'absolute', top: 0, end: 0, width: PHONE.width },
});
