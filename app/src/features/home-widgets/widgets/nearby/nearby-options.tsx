import { useTranslation } from 'react-i18next';

import { ChoiceSection } from '@/features/settings/choice-section';

import { NEARBY_STYLES, type NearbyStyle } from './nearby-style';

const STYLE_OPTIONS: { value: NearbyStyle; labelKey: string }[] = NEARBY_STYLES.map((style) => ({
  value: style,
  labelKey: `homeWidgets.nearbyStyle.${style}`,
}));

/** Led by the closest station on a map, or the list alone, for a rider who
 *  wants the stations without scrolling past a map to reach them. */
export function NearbyOptions({ value, onChange }: { value: NearbyStyle; onChange: (next: NearbyStyle) => void }) {
  const { t } = useTranslation();
  return (
    <ChoiceSection
      title={t('homeWidgets.nearbyStyleTitle')}
      options={STYLE_OPTIONS}
      value={value}
      onChange={onChange}
      subtitleFor={(style) => t(`homeWidgets.nearbyStyle.${style}Hint`)}
    />
  );
}
