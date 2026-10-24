import { useTranslation } from 'react-i18next';
import { StyleSheet, Switch, View } from 'react-native';

import { Icon, Layout, LeadingIcon, ListRow, ListSection, SegmentedControl, type IconName } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { LEAD_TIME_OPTIONS, leadTimeOption } from '@/features/settings/options';
import { SettingsPage } from '@/features/settings/settings-page';
import { hapticSelected } from '@/lib/haptics';

/** A get-off alert toggle: what it does, by glyph and label, and the
 *  platform's own switch at its end. */
function SwitchRow({
  icon,
  label,
  value,
  onChange,
}: {
  icon: IconName;
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <ListRow
      leading={
        <LeadingIcon>
          <Icon name={icon} size="md" />
        </LeadingIcon>
      }
      title={label}
      trailing={
        // Native colours: the switch is platform chrome, and on iOS 26 it
        // draws its own Liquid Glass thumb that a custom tint would fight.
        <Switch
          accessibilityLabel={label}
          value={value}
          onValueChange={(next) => {
            hapticSelected();
            onChange(next);
          }}
        />
      }
    />
  );
}

/**
 * The tuning for the one alert the rider may be asleep through. Changes
 * apply instantly, to a journey already running as well.
 */
export default function AlertSettingsScreen() {
  const { t } = useTranslation();
  const { alertSettings, setAlertSettings } = usePreferences();

  return (
    <SettingsPage title={t('settings.alerts')}>
      {/* The segmented control ticks on a real change only, the same rule
          the language and appearance rows follow. */}
      <ListSection title={t('settings.alertLead')}>
        <View style={styles.controlRow}>
          <SegmentedControl
            value={leadTimeOption(alertSettings).value}
            onChange={(value) => {
              const option = LEAD_TIME_OPTIONS.find((candidate) => candidate.value === value);
              if (option) setAlertSettings({ ...alertSettings, ...option.lead });
            }}
            options={LEAD_TIME_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          />
        </View>
      </ListSection>

      <ListSection>
        <SwitchRow
          icon="sound"
          label={t('settings.alertSound')}
          value={alertSettings.sound}
          onChange={(sound) => setAlertSettings({ ...alertSettings, sound })}
        />
        <SwitchRow
          icon="vibrate"
          label={t('settings.alertVibrate')}
          value={alertSettings.vibrate}
          onChange={(vibrate) => setAlertSettings({ ...alertSettings, vibrate })}
        />
        <SwitchRow
          icon="repeat"
          label={t('settings.alertRepeat')}
          value={alertSettings.repeatUntilAcknowledged}
          onChange={(repeatUntilAcknowledged) => setAlertSettings({ ...alertSettings, repeatUntilAcknowledged })}
        />
      </ListSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // A control that fills its row: the row's own padding, no title beside it.
  controlRow: { paddingVertical: Layout.rowPaddingV, paddingHorizontal: Layout.rowPaddingH },
});
