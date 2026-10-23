import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Icon,
  Layout,
  LeadingIcon,
  ListRow,
  ListSection,
  PageTitle,
  SegmentedControl,
  Surface,
  type IconName,
} from '@/design-system';
import { JourneyDock, useJourneyDockInset } from '@/features/journey/journey-bar';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@/features/journey/types';
import { usePreferences, type ThemePreference } from '@/features/preferences/preferences-context';
import type { LanguagePreference } from '@/features/preferences/resolve-language';
import { hapticSelected } from '@/lib/haptics';

/** `device` first in both lists: it is the default, and the option a rider who
 *  opened this screen by accident should find already selected. */
const LANGUAGE_OPTIONS: { value: LanguagePreference; labelKey: string }[] = [
  { value: 'device', labelKey: 'settings.deviceDefault' },
  { value: 'he', labelKey: 'settings.languageHebrew' },
  { value: 'en', labelKey: 'settings.languageEnglish' },
];

// "System", not the language list's "Device default": a third of a segmented
// control has no room for the long form, and iOS names this choice "System" too.
const THEME_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: 'device', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
];

type LeadTimeValue = 'oneStop' | 'twoStops' | 'threeMinutes' | 'fiveMinutes';

/**
 * Four choices over TWO triggers, which is the thing to understand before
 * changing this table: `leadStops` and `leadSeconds` are not one setting in
 * two units. The machine counts stops whenever it has a fix and falls back to
 * the clock when it does not, so a stop choice sets `leadStops` and leaves
 * `leadSeconds` at the default -- still the fallback for a rider in a tunnel
 * -- while a minutes choice sets `leadSeconds` and drops `leadStops` to zero,
 * handing the decision to the clock the rider just chose.
 */
const LEAD_TIME_OPTIONS: {
  value: LeadTimeValue;
  labelKey: string;
  lead: Pick<AlertSettings, 'leadStops' | 'leadSeconds'>;
}[] = [
  {
    value: 'oneStop',
    labelKey: 'settings.alertLeadOneStop',
    lead: { leadStops: 1, leadSeconds: DEFAULT_ALERT_SETTINGS.leadSeconds },
  },
  {
    value: 'twoStops',
    labelKey: 'settings.alertLeadTwoStops',
    lead: { leadStops: 2, leadSeconds: DEFAULT_ALERT_SETTINGS.leadSeconds },
  },
  { value: 'threeMinutes', labelKey: 'settings.alertLeadThreeMinutes', lead: { leadStops: 0, leadSeconds: 180 } },
  { value: 'fiveMinutes', labelKey: 'settings.alertLeadFiveMinutes', lead: { leadStops: 0, leadSeconds: 300 } },
];

/** Which segment a stored pair lights up. A pair that matches nothing -- an
 *  older blob, or a hand-edited one -- shows the default rather than leaving
 *  the control blank, so the rider always sees a choice they can move off. */
function leadTimeValue(settings: AlertSettings): LeadTimeValue {
  const match = LEAD_TIME_OPTIONS.find(
    (option) =>
      option.lead.leadStops === settings.leadStops && option.lead.leadSeconds === settings.leadSeconds,
  );
  return match?.value ?? 'oneStop';
}

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
 * Two device overrides, and the tuning for the one alert the rider may be
 * asleep through.
 *
 * Choosing a language that flips the layout direction restarts the app -- see
 * `setLanguage` in the preferences context for why that is unavoidable rather
 * than a shortcut. Theme and alert changes apply instantly, the latter to a
 * journey already running as well.
 */
export default function SettingsScreen() {
  const { t } = useTranslation();
  const {
    languagePreference,
    themePreference,
    alertSettings,
    setLanguage,
    setTheme,
    setAlertSettings,
  } = usePreferences();

  const dockInset = useJourneyDockInset();
  // The end of the content scrolls clear of the tab bar (see the hook).
  const tabBarInset = useTabBarInset();

  return (
    <Surface level="bgGrouped" style={styles.container}>
      {/* Top edge only: a tab root has no native header, and the tab bar
          already clears the home indicator. */}
      <SafeAreaView style={styles.container} edges={['top']}>
        {/* The screen's first scrollable view, so the native tab bar on iOS
            finds it and applies its automatic content insets. The title
            scrolls with the content, as a large title does. */}
        <ScrollView
          contentContainerStyle={{ paddingBottom: Layout.sectionGap + dockInset + tabBarInset }}
        >
          <PageTitle>{t('tabs.settings')}</PageTitle>

          <View style={styles.sections}>
            <ListSection title={t('settings.language')}>
              {LANGUAGE_OPTIONS.map((option) => {
                const selected = languagePreference === option.value;
                return (
                  <ListRow
                    key={option.value}
                    title={t(option.labelKey)}
                    // A tick rather than a radio dot: the row is a choice
                    // already made or not, and a tick reads the same in both
                    // directions without mirroring.
                    accessory="check"
                    selected={selected}
                    // Not when the row is already the chosen one: re-picking
                    // it changes nothing, and a tap that says "done" for a
                    // no-op is a lie.
                    onPress={() => {
                      if (!selected) hapticSelected();
                      setLanguage(option.value);
                    }}
                  />
                );
              })}
            </ListSection>

            {/* The segmented control ticks on a real change only, the same
                rule the language rows above follow. */}
            <ListSection title={t('settings.theme')}>
              <View style={styles.controlRow}>
                <SegmentedControl
                  value={themePreference}
                  onChange={setTheme}
                  options={THEME_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                />
              </View>
            </ListSection>

            <ListSection title={t('settings.alerts')}>
              <View style={styles.controlRow}>
                <SegmentedControl
                  value={leadTimeValue(alertSettings)}
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
                onChange={(repeatUntilAcknowledged) =>
                  setAlertSettings({ ...alertSettings, repeatUntilAcknowledged })
                }
              />
            </ListSection>

            <ListSection title={t('settings.about')}>
              <ListRow
                leading={
                  <LeadingIcon>
                    <Icon name="info" size="md" />
                  </LeadingIcon>
                }
                title={t('settings.aboutRow')}
                accessory="chevron"
                onPress={() => router.push('/about')}
              />
            </ListSection>
          </View>
        </ScrollView>
      </SafeAreaView>

      <JourneyDock />
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sections: { paddingHorizontal: Layout.pageInset, gap: Layout.sectionGap },
  // A control that fills its row: the row's own padding, no title beside it.
  controlRow: { paddingVertical: Layout.rowPaddingV, paddingHorizontal: Layout.rowPaddingH },
});
