import { useTranslation } from 'react-i18next';

import { usePreferences } from '@/features/preferences/preferences-context';
import { ChoiceSection } from '@/features/settings/choice-section';
import { MAP_STYLE_OPTIONS, TIME_FORMAT_OPTIONS } from '@/features/settings/options';
import { SettingsPage } from '@/features/settings/settings-page';
import { ThemePicker } from '@/features/settings/theme-picker';
import { useNow } from '@/hooks/use-now';
import { formatClockTime, formatDurationMinutes } from '@/lib/format';

/** How far ahead the time-format example departure is. */
const EXAMPLE_MINUTES = 4;

/** Light, dark, or the device's; the map's scheme; and how upcoming times
 *  read. All apply instantly, this page included. */
export default function AppearanceSettingsScreen() {
  const { t } = useTranslation();
  const { themePreference, setTheme, mapStylePreference, setMapStyle, timeFormat, setTimeFormat } =
    usePreferences();
  const now = useNow();
  // A real departure a few minutes out, so each row shows what it would print.
  const example = new Date(now.getTime() + EXAMPLE_MINUTES * 60_000).toISOString();

  return (
    <SettingsPage title={t('settings.theme')}>
      <ThemePicker value={themePreference} onChange={setTheme} />

      <ChoiceSection
        title={t('settings.mapStyle')}
        options={MAP_STYLE_OPTIONS}
        value={mapStylePreference}
        onChange={setMapStyle}
      />

      <ChoiceSection
        title={t('settings.timeFormat')}
        footer={t('settings.timeFormatFooter')}
        options={TIME_FORMAT_OPTIONS}
        value={timeFormat}
        onChange={setTimeFormat}
        subtitleFor={(value) =>
          value === 'clock' ? formatClockTime(example) : formatDurationMinutes(EXAMPLE_MINUTES * 60)
        }
      />
    </SettingsPage>
  );
}
