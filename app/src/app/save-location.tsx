import { IconMapPin } from '@tabler/icons-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconBack } from '@/components/directional-icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { LOCATION_ICON_COMPONENTS } from '@/features/saved-locations/location-icons';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { LOCATION_ICON_NAMES, type LocationIconName } from '@/features/saved-locations/types';
import { useControlOutline, useTheme } from '@/hooks/use-theme';
import { placeFromRouteParams, placeLabel, type PlaceRouteParams } from '@/lib/place';
import { INPUT_ALIGN_START } from '@/i18n/direction';

const DEFAULT_ICON: LocationIconName = 'star';

/**
 * The second half of the "add a saved location" flow -- `location-picker`
 * (in `field=saved-new` mode) already picked the place and handed it here as
 * route params (see `placeToRouteParams`); this screen only needs a title
 * and an icon before it becomes a real chip on the home screen.
 */
export default function SaveLocationScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const outline = useControlOutline();
  const savedLocations = useSavedLocations();
  const params = useLocalSearchParams<Partial<PlaceRouteParams>>();
  const place = placeFromRouteParams(params);

  const [title, setTitle] = useState(place ? placeLabel(place) : '');
  const [icon, setIcon] = useState<LocationIconName>(DEFAULT_ICON);

  function save() {
    if (!place || title.trim().length === 0) return;
    savedLocations.addCustom(title.trim(), icon, place);
    router.back();
  }

  return (
    <ThemedView type="background" style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={Spacing.two} style={styles.back}>
            <IconBack size={26} color={theme.text} />
          </Pressable>
          <ThemedText type="default" style={styles.headerTitle}>
            {t('savedLocations.screenTitle')}
          </ThemedText>
        </View>

        {place && (
          <View style={styles.placeRow}>
            <View style={[styles.iconCircle, { backgroundColor: theme.background }, outline]}>
              <IconMapPin size={18} color={theme.text} />
            </View>
            <ThemedText type="default" numberOfLines={1} style={styles.placeText}>
              {placeLabel(place)}
            </ThemedText>
          </View>
        )}

        <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
          {t('savedLocations.titleLabel')}
        </ThemedText>
        <View style={[styles.inputShell, { backgroundColor: theme.background }, outline]}>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            placeholder={t('savedLocations.titlePlaceholder')}
            placeholderTextColor={theme.textSecondary}
            value={title}
            onChangeText={setTitle}
          />
        </View>

        <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
          {t('savedLocations.chooseIcon')}
        </ThemedText>
        <View style={styles.iconGrid}>
          {LOCATION_ICON_NAMES.map((name) => {
            const IconComponent = LOCATION_ICON_COMPONENTS[name];
            const selected = name === icon;
            return (
              <Pressable key={name} onPress={() => setIcon(name)}>
                <View
                  style={[
                    styles.iconOption,
                    { backgroundColor: selected ? theme.text : theme.background },
                    selected ? null : outline,
                  ]}
                >
                  <IconComponent size={22} color={selected ? theme.background : theme.text} />
                </View>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={save}
          disabled={!place || title.trim().length === 0}
          style={[
            styles.saveButton,
            { backgroundColor: theme.text, opacity: !place || title.trim().length === 0 ? 0.4 : 1 },
          ]}
        >
          <ThemedText type="smallBold" themeColor="background">
            {t('savedLocations.save')}
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    gap: Spacing.four,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  back: {
    padding: Spacing.one,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeText: {
    flex: 1,
  },
  sectionLabel: {
    marginTop: Spacing.four,
  },
  inputShell: {
    borderWidth: 1.5,
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  input: {
    fontSize: 16,
    textAlign: INPUT_ALIGN_START,
  },
  iconGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  iconOption: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    marginTop: Spacing.four,
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: 999,
  },
});
