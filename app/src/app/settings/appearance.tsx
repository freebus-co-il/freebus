import { useTranslation } from 'react-i18next';

import { usePreferences } from '@/features/preferences/preferences-context';
import { SettingsPage } from '@/features/settings/settings-page';
import { ThemePicker } from '@/features/settings/theme-picker';

/** Light, dark, or the device's. Applies instantly, this page included. */
export default function AppearanceSettingsScreen() {
  const { t } = useTranslation();
  const { themePreference, setTheme } = usePreferences();

  return (
    <SettingsPage title={t('settings.theme')}>
      <ThemePicker value={themePreference} onChange={setTheme} />
    </SettingsPage>
  );
}
