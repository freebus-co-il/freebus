import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  EmptyState,
  Icon,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  NativeHeader,
  Space,
  Surface,
} from '@/design-system';
import { useCustomJourneys } from '@/features/custom-journeys/custom-journeys-context';
import { pointsSummary } from '@/features/custom-journeys/journey-summary';
import { useStartCustomJourney } from '@/features/custom-journeys/use-start-custom-journey';

/**
 * The rider's own journeys. Each row starts its journey from the button and
 * opens the editor from the row itself.
 */
export default function CustomJourneysScreen() {
  const { t } = useTranslation();
  const { journeys, loaded } = useCustomJourneys();
  const { startJourney, startingId } = useStartCustomJourney();

  const create = () => router.push('/custom-journeys/edit');

  return (
    <Surface level="bgGrouped" style={styles.container}>
      <NativeHeader
        title={t('customJourney.listTitle')}
        actions={[{ icon: 'add', accessibilityLabel: t('customJourney.new'), onPress: create }]}
      />
      <SafeAreaView edges={['bottom']} style={styles.container}>
        {loaded && journeys.length === 0 ? (
          <EmptyState
            icon="navigate"
            title={t('customJourney.emptyTitle')}
            message={t('customJourney.emptyMessage')}
            action={{ label: t('customJourney.new'), onPress: create }}
            style={styles.empty}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            <ListSection footer={t('customJourney.listFooter')}>
              {journeys.map((journey) => (
                <ListRow
                  key={journey.id}
                  leading={
                    <LeadingIcon tone="accent">
                      <Icon name="navigate" size="sm" color="onAccent" />
                    </LeadingIcon>
                  }
                  title={journey.name}
                  subtitle={pointsSummary(journey.points)}
                  trailing={
                    <Button
                      variant="secondary"
                      size="sm"
                      label={t('customJourney.start')}
                      loading={startingId === journey.id}
                      disabled={startingId !== null && startingId !== journey.id}
                      onPress={() => startJourney(journey)}
                    />
                  }
                  accessibilityHint={t('customJourney.editHint')}
                  onPress={() => router.push({ pathname: '/custom-journeys/edit', params: { id: journey.id } })}
                />
              ))}
            </ListSection>
          </ScrollView>
        )}
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
  },
  empty: {
    flex: 1,
    paddingHorizontal: Layout.pageInset,
  },
});
