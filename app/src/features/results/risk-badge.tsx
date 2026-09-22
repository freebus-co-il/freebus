import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export type RiskBadgeProps = {
  transferAtRisk: boolean | null;
};

export function RiskBadge({ transferAtRisk }: RiskBadgeProps) {
  const { t } = useTranslation();

  if (transferAtRisk === null) {
    return (
      <ThemedView type="surface" style={styles.badge}>
        <ThemedText type="small" themeColor="textSecondary">
          {t('results.riskUnknown')}
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView type="surface" style={styles.badge}>
      <ThemedText type="smallBold" themeColor={transferAtRisk ? 'danger' : 'success'}>
        {transferAtRisk ? t('results.riskAtRisk') : t('results.riskOk')}
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.two,
  },
});
