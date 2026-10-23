import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  Icon,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  NativeHeader,
  Radius,
  Size,
  Space,
  Surface,
  TextField,
  useColors,
} from '@/design-system';
import { LOCATION_ICON_NAMES as LOCATION_ICON_GLYPHS } from '@/features/saved-locations/location-icons';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { LOCATION_ICON_NAMES, type LocationIconName } from '@/features/saved-locations/types';
import { placeFromRouteParams, placeLabel, type PlaceRouteParams } from '@/lib/place';

const DEFAULT_ICON: LocationIconName = 'star';

/**
 * The second half of the "add a saved location" flow -- `location-picker`
 * (in `field=saved-new` mode) already picked the place and handed it here as
 * route params (see `placeToRouteParams`); this screen only needs a title
 * and an icon before it becomes a real chip on the home screen.
 */
export default function SaveLocationScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const savedLocations = useSavedLocations();
  const params = useLocalSearchParams<Partial<PlaceRouteParams>>();
  const place = placeFromRouteParams(params);

  const [title, setTitle] = useState(place ? placeLabel(place) : '');
  const [icon, setIcon] = useState<LocationIconName>(DEFAULT_ICON);
  const canSave = place !== null && title.trim().length > 0;

  function save() {
    if (!place || title.trim().length === 0) return;
    savedLocations.addCustom(title.trim(), icon, place);
    router.back();
  }

  return (
    <Surface level="bgGrouped" style={styles.container}>
      <NativeHeader title={t('savedLocations.screenTitle')} />
      <SafeAreaView edges={['bottom']} style={styles.container}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {place && (
            <ListSection>
              <ListRow
                leading={
                  <LeadingIcon>
                    <Icon name="place" size="sm" weight="medium" />
                  </LeadingIcon>
                }
                title={placeLabel(place)}
                titleLines={1}
              />
            </ListSection>
          )}

          <TextField
            label={t('savedLocations.titleLabel')}
            placeholder={t('savedLocations.titlePlaceholder')}
            value={title}
            onChangeText={setTitle}
            returnKeyType="done"
          />

          <ListSection title={t('savedLocations.chooseIcon')}>
            <View style={styles.iconGrid} accessibilityRole="radiogroup">
              {LOCATION_ICON_NAMES.map((name) => {
                const selected = name === icon;
                return (
                  <Pressable
                    key={name}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setIcon(name)}
                    android_ripple={{ color: colors.fillPressed }}
                    style={({ pressed }) => [
                      styles.iconTile,
                      {
                        backgroundColor: selected
                          ? colors.accent
                          : pressed && Platform.OS === 'ios'
                            ? colors.fillPressed
                            : colors.surfaceNested,
                      },
                    ]}
                  >
                    <Icon name={LOCATION_ICON_GLYPHS[name]} size="lg" color={selected ? 'onAccent' : 'textPrimary'} />
                  </Pressable>
                );
              })}
            </View>
          </ListSection>

          <Button
            variant="prominent"
            label={t('savedLocations.save')}
            onPress={save}
            disabled={!canSave}
            fullWidth
          />
        </ScrollView>
      </SafeAreaView>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Layout.pageInset,
    paddingTop: Space.lg,
    paddingBottom: Layout.sectionGap,
    gap: Layout.sectionGap,
  },
  iconGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
    padding: Space.lg,
  },
  iconTile: {
    width: Size.control.lg,
    height: Size.control.lg,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
