import { useTranslation } from 'react-i18next';

import { Tag } from '@/design-system';

export type RiskBadgeProps = {
  transferAtRisk: boolean | null;
};

/** Whether a journey's transfer holds, as a status tag. `null` is "no
 *  realtime to judge by", which is a fact, not a warning -- so it is neutral. */
export function RiskBadge({ transferAtRisk }: RiskBadgeProps) {
  const { t } = useTranslation();

  if (transferAtRisk === null) return <Tag tone="neutral" label={t('results.riskUnknown')} />;
  return transferAtRisk
    ? <Tag tone="danger" label={t('results.riskAtRisk')} />
    : <Tag tone="live" label={t('results.riskOk')} />;
}
