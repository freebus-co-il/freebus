import { useTranslation } from 'react-i18next';
import { Alert, Linking, StyleSheet, View } from 'react-native';

import { Layout, ListRow, ListSection, Text } from '@/design-system';
import { SettingsPage } from '@/features/settings/settings-page';

const CONTACT_EMAIL = 'contactfreebus@gmail.com';
const REPOSITORY_URL = 'https://github.com/freebus-co-il/freebus';

export default function FeedbackScreen() {
  const { t } = useTranslation();

  async function openLink(url: string) {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(t('feedback.linkErrorTitle'), t('feedback.linkErrorBody'));
    }
  }

  return (
    <SettingsPage title={t('feedback.title')}>
      <ListSection>
        <View style={styles.prose}>
          <Text variant="subheadline">{t('feedback.intro')}</Text>
        </View>
        <ListRow
          title={t('feedback.contact')}
          subtitle={CONTACT_EMAIL}
          accessory="externalLink"
          onPress={() => void openLink(`mailto:${CONTACT_EMAIL}`)}
        />
      </ListSection>

      <ListSection title={t('feedback.developersTitle')}>
        <View style={styles.prose}>
          <Text variant="subheadline">{t('feedback.developersBody')}</Text>
        </View>
        <ListRow
          title={t('feedback.repository')}
          accessory="externalLink"
          onPress={() => void openLink(REPOSITORY_URL)}
        />
        <ListRow
          title={t('feedback.contributing')}
          accessory="externalLink"
          onPress={() => void openLink(`${REPOSITORY_URL}/blob/main/.github/CONTRIBUTING.md`)}
        />
      </ListSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  prose: {
    paddingVertical: Layout.rowPaddingV,
    paddingHorizontal: Layout.rowPaddingH,
  },
});
