import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';

import { glyphFor, useColors } from '@/design-system';
import { JourneyAccessoryContent, useJourneyAccessoryVisible } from '@/features/journey/journey-bar';

/**
 * The tab bar is the platform's own: a floating Liquid Glass bar on iOS 26 that
 * minimises as a list scrolls, a Material 3 navigation bar on Android. The live
 * journey rides in its accessory slot on iOS 26 (see `JourneyAccessoryContent`);
 * elsewhere each tab root renders a `JourneyDock`.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const colors = useColors();
  const showJourney = useJourneyAccessoryVisible();
  const tab = (outline: Parameters<typeof glyphFor>[0], filled: Parameters<typeof glyphFor>[0]) => ({
    sf: { default: glyphFor(outline).ios, selected: glyphFor(filled).ios },
    md: glyphFor(outline).android,
  });
  return (
    <NativeTabs
      tintColor={colors.accent}
      iconColor={{ default: colors.textSecondary, selected: colors.accent }}
      labelStyle={{ default: { color: colors.textSecondary }, selected: { color: colors.accent } }}
      indicatorColor={colors.trackFill}
      rippleColor={colors.fillPressed}
      labelVisibilityMode="labeled"
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon {...tab('home', 'homeFill')} />
        <NativeTabs.Trigger.Label>{t('tabs.home')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="lines">
        <NativeTabs.Trigger.Icon {...tab('lines', 'linesFill')} />
        <NativeTabs.Trigger.Label>{t('tabs.lines')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="stations">
        <NativeTabs.Trigger.Icon {...tab('stations', 'stationsFill')} />
        <NativeTabs.Trigger.Label>{t('tabs.stations')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon {...tab('settings', 'settingsFill')} />
        <NativeTabs.Trigger.Label>{t('tabs.settings')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      {showJourney && (
        <NativeTabs.BottomAccessory>
          <JourneyAccessoryContent />
        </NativeTabs.BottomAccessory>
      )}
    </NativeTabs>
  );
}
