import { router, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Icon,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  PageTitle,
  Surface,
  Text,
  type IconName,
} from '@/design-system';
import { JourneyDock, useJourneyDockInset } from '@/features/journey/journey-bar';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { usePreferences } from '@/features/preferences/preferences-context';
import { LANGUAGE_OPTIONS, THEME_OPTIONS, labelKeyFor, leadTimeOption } from '@/features/settings/options';

/** One row of the index: a glyph, the page's name, and, when the page holds
 *  a single choice, that choice, so the rider can read it without going in. */
function PageRow({ icon, title, value, href }: { icon: IconName; title: string; value?: string; href: Href }) {
  return (
    <ListRow
      leading={
        <LeadingIcon>
          <Icon name={icon} size="md" />
        </LeadingIcon>
      }
      title={title}
      trailing={
        value !== undefined && (
          <Text variant="callout" color="textSecondary" numberOfLines={1}>
            {value}
          </Text>
        )
      }
      accessory="chevron"
      accessibilityLabel={value !== undefined ? `${title}, ${value}` : undefined}
      onPress={() => router.push(href)}
    />
  );
}

/**
 * An index of settings pages, not the settings themselves: each group lives
 * on its own pushed page under `app/settings/`, so a new setting is a new
 * page and a new row here rather than a longer scroll.
 */
export default function SettingsScreen() {
  const { t } = useTranslation();
  const { languagePreference, themePreference, alertSettings } = usePreferences();

  const dockInset = useJourneyDockInset();
  // The end of the content scrolls clear of the tab bar (see the hook).
  const tabBarInset = useTabBarInset();

  return (
    <Surface level="bgGrouped" style={styles.container}>
      {/* Top edge only: a tab root has no native header, and the tab bar
          already clears the home indicator. */}
      <SafeAreaView style={styles.container} edges={['top']}>
        {/* The screen's first scrollable view, so the native tab bar on iOS
            finds it and applies its automatic content insets. The title
            scrolls with the content, as a large title does. */}
        <ScrollView
          contentContainerStyle={{ paddingBottom: Layout.sectionGap + dockInset + tabBarInset }}
        >
          <PageTitle>{t('tabs.settings')}</PageTitle>

          <View style={styles.sections}>
            <ListSection>
              <PageRow
                icon="language"
                title={t('settings.language')}
                value={t(labelKeyFor(LANGUAGE_OPTIONS, languagePreference))}
                href="/settings/language"
              />
              <PageRow
                icon="appearance"
                title={t('settings.theme')}
                value={t(labelKeyFor(THEME_OPTIONS, themePreference))}
                href="/settings/appearance"
              />
            </ListSection>

            <ListSection>
              <PageRow
                icon="bell"
                title={t('settings.alerts')}
                value={t(leadTimeOption(alertSettings).labelKey)}
                href="/settings/alerts"
              />
            </ListSection>

            <ListSection>
              <PageRow icon="info" title={t('settings.aboutRow')} href="/about" />
            </ListSection>
          </View>
        </ScrollView>
      </SafeAreaView>

      <JourneyDock />
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sections: { paddingHorizontal: Layout.pageInset, gap: Layout.sectionGap },
});
