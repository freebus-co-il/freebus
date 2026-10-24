import { useTranslation } from 'react-i18next';

import { ListRow, ListSection } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { LANGUAGE_OPTIONS } from '@/features/settings/options';
import { SettingsPage } from '@/features/settings/settings-page';
import { hapticSelected } from '@/lib/haptics';

/**
 * The app's language, over the device's. Choosing one that flips the layout
 * direction restarts the app: see `setLanguage` in the preferences context
 * for why that is unavoidable rather than a shortcut.
 */
export default function LanguageSettingsScreen() {
  const { t } = useTranslation();
  const { languagePreference, setLanguage } = usePreferences();

  return (
    <SettingsPage title={t('settings.language')}>
      <ListSection>
        {LANGUAGE_OPTIONS.map((option) => {
          const selected = languagePreference === option.value;
          return (
            <ListRow
              key={option.value}
              title={t(option.labelKey)}
              // A tick rather than a radio dot: the row is a choice already
              // made or not, and a tick reads the same in both directions
              // without mirroring.
              accessory="check"
              selected={selected}
              // Not when the row is already the chosen one: re-picking it
              // changes nothing, and a tap that says "done" for a no-op is a lie.
              onPress={() => {
                if (!selected) hapticSelected();
                setLanguage(option.value);
              }}
            />
          );
        })}
      </ListSection>
    </SettingsPage>
  );
}
