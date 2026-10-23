import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Layout, ListRow, ListSection, NativeHeader, Space, Surface, Text } from '@/design-system';
import { GOOGLE_MAPS_TEXT, OSM_COPYRIGHT_URL } from '@/lib/attribution';

const REPO_URL = 'https://github.com/freebus-co-il/freebus';
const PRIVACY_URL = 'https://freebus.co.il/privacy';
const MOT_URL = 'https://www.gov.il/he/departments/ministry_of_transport_and_road_safety';

/**
 * Opens the native open-source licence list. Required here, not imported at
 * the top: the module looks its native half up the moment it loads, and
 * expo-router loads every route at startup -- so a top-level import would
 * crash, on launch, any installed binary built before this native module
 * existed, if this code reached it as an over-the-air update.
 */
function openLicenses(title: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately lazy, see above
    const { ReactNativeLegal } = require('react-native-legal') as typeof import('react-native-legal');
    ReactNativeLegal.launchLicenseListScreen(title);
  } catch {
    // A binary without the native module: there is no list to show.
  }
}

/** One data source: what it covers, and whose it is. A source with a page of
 *  its own opens it; the credit line itself is the licence's wording, so it
 *  is never truncated. */
function Source({ title, body, url }: { title: string; body: string; url?: string }) {
  return (
    <ListRow
      title={title}
      titleLines={0}
      subtitle={
        <Text variant="footnote" color="textSecondary">
          {body}
        </Text>
      }
      accessory={url ? 'chevron' : 'none'}
      onPress={url ? () => void Linking.openURL(url) : undefined}
    />
  );
}

/** A row that opens a page outside the app. */
function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  return <ListRow title={label} accessory="chevron" onPress={onPress} />;
}

/**
 * Every credit the app owes, in one place a store reviewer can find. The
 * credits beside the data (`DataCredit`) are what the licences ask for; this
 * page is the complete list behind them.
 */
export default function AboutScreen() {
  const { t } = useTranslation();
  const version = Constants.expoConfig?.version ?? '';

  return (
    <Surface level="bgGrouped" style={styles.container}>
      <NativeHeader title={t('about.title')} />
      {/* Bottom edge only: the native header already clears the top. */}
      <SafeAreaView edges={['bottom']} style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <ListSection footer={t('about.openSource')}>
            <LinkRow label={t('about.sourceCode')} onPress={() => void Linking.openURL(REPO_URL)} />
            <LinkRow label={t('about.privacy')} onPress={() => void Linking.openURL(PRIVACY_URL)} />
            {/* Native only: the licence list is generated into the iOS and
                Android builds, and there is no web equivalent. */}
            {Platform.OS !== 'web' && (
              <LinkRow label={t('about.licenses')} onPress={() => openLicenses(t('about.licenses'))} />
            )}
          </ListSection>

          <ListSection title={t('about.dataSources')}>
            <Source title={t('about.motTitle')} body={t('about.motBody')} url={MOT_URL} />
            <Source title={t('about.osmTitle')} body={t('about.osmBody')} url={OSM_COPYRIGHT_URL} />
            {/* Listed whatever the server's GEOCODER is: it is switched back and
                forth, and this page cannot know which one answered. */}
            <Source title={t('about.googleTitle')} body={GOOGLE_MAPS_TEXT} />
          </ListSection>

          <ListSection title={t('about.disclaimerTitle')}>
            <View style={styles.textRow}>
              <Text variant="subheadline">{t('about.disclaimer')}</Text>
            </View>
          </ListSection>

          <Text variant="footnote" color="textSecondary" align="center" numeric>
            {t('about.version', { version })}
          </Text>
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
  // Prose inside a group: a row's padding, no row behaviour.
  textRow: {
    paddingVertical: Layout.rowPaddingV,
    paddingHorizontal: Layout.rowPaddingH,
  },
});
