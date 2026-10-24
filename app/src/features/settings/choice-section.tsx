import { useTranslation } from 'react-i18next';

import { ListRow, ListSection } from '@/design-system';
import { hapticSelected } from '@/lib/haptics';

/**
 * One choice out of a few, as ticked rows: the language list, and the map and
 * time rows under the appearance tiles. A tick rather than a radio dot: the
 * row is a choice already made or not, and a tick reads the same in both
 * directions without mirroring.
 */
export function ChoiceSection<T extends string>({
  title,
  footer,
  options,
  value,
  onChange,
  subtitleFor,
}: {
  title?: string;
  footer?: string;
  options: { value: T; labelKey: string }[];
  value: T;
  onChange: (next: T) => void;
  /** A line under an option's label, for a choice that is easier shown than named. */
  subtitleFor?: (value: T) => string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ListSection title={title} footer={footer}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <ListRow
            key={option.value}
            title={t(option.labelKey)}
            subtitle={subtitleFor?.(option.value)}
            accessory="check"
            selected={selected}
            // Not when the row is already the chosen one: re-picking it
            // changes nothing, and a tap that says "done" for a no-op is a lie.
            onPress={() => {
              if (!selected) hapticSelected();
              onChange(option.value);
            }}
          />
        );
      })}
    </ListSection>
  );
}
