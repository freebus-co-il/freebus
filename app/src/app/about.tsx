import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconBack } from '@/components/directional-icon';
import { Hairline } from '@/components/hairline';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { GOOGLE_MAPS_TEXT, OSM_COPYRIGHT_URL } from '@/lib/attribution';

const REPO_URL = 'https://github.com/freebus-co-il/freebus';
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

/** One data source: what it covers, and whose it is. */
function Source({ title, body, url }: { title: string; body: string; url?: string }) {
  const content = (
    <View style={styles.block}>
      <ThemedText type="defaultBold">{title}</ThemedText>
      <ThemedText type={url ? 'link' : 'default'}>{body}</ThemedText>
    </View>
  );
  return url
    ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)}>{content}</Pressable>
    : content;
}

/**
 * Every credit the app owes, in one place a store reviewer can find. The
 * credits beside the data (`DataCredit`) are what the licences ask for; this
 * page is the complete list behind them.
 */
export default function AboutScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const version = Constants.expoConfig?.version ?? '';

  return (
    <ThemedView type="background" style={styles.container}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.container}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={Spacing.two}
            style={styles.back}
          >
            <IconBack size={26} color={theme.text} />
          </Pressable>
          <ThemedText type="default" style={styles.headerTitle}>{t('about.title')}</ThemedText>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <ThemedText type="small" themeColor="textSecondary">{t('about.version', { version })}</ThemedText>
          <ThemedText type="default">{t('about.openSource')}</ThemedText>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(REPO_URL)}>
            <ThemedText type="link">{t('about.sourceCode')}</ThemedText>
          </Pressable>

          <Hairline />
          <ThemedText type="smallBold" themeColor="textSecondary">{t('about.dataSources')}</ThemedText>
          <Source title={t('about.motTitle')} body={t('about.motBody')} url={MOT_URL} />
          <Source title={t('about.osmTitle')} body={t('about.osmBody')} url={OSM_COPYRIGHT_URL} />
          {/* Listed whatever the server's GEOCODER is: it is switched back and
              forth, and this page cannot know which one answered. */}
          <Source title={t('about.googleTitle')} body={GOOGLE_MAPS_TEXT} />

          <Hairline />
          <ThemedText type="smallBold" themeColor="textSecondary">{t('about.disclaimerTitle')}</ThemedText>
          <ThemedText type="default">{t('about.disclaimer')}</ThemedText>

          {/* Native only: the licence list is generated into the iOS and
              Android builds, and there is no web equivalent. */}
          {Platform.OS !== 'web' && (
            <>
              <Hairline />
              <Pressable
                accessibilityRole="button"
                onPress={() => openLicenses(t('about.licenses'))}
              >
                <ThemedText type="link">{t('about.licenses')}</ThemedText>
              </Pressable>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  back: {
    padding: Spacing.one,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.three,
  },
  block: {
    gap: Spacing.one,
  },
});
