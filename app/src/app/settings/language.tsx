import { useTranslation } from 'react-i18next';

import { usePreferences } from '@/features/preferences/preferences-context';
import { ChoiceSection } from '@/features/settings/choice-section';
import { LANGUAGE_OPTIONS } from '@/features/settings/options';
import { SettingsPage } from '@/features/settings/settings-page';

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
      <ChoiceSection options={LANGUAGE_OPTIONS} value={languagePreference} onChange={setLanguage} />
    </SettingsPage>
  );
}
