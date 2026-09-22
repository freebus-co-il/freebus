import { IconCheck } from '@tabler/icons-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SegmentedControl } from '@/components/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SectionGap, Spacing } from '@/constants/theme';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@/features/journey/types';
import { usePreferences, type ThemePreference } from '@/features/preferences/preferences-context';
import type { LanguagePreference } from '@/features/preferences/resolve-language';
import { useTheme } from '@/hooks/use-theme';
import { hapticSelected } from '@/lib/haptics';

/** `device` first in both lists: it is the default, and the option a rider who
 *  opened this screen by accident should find already selected. */
const LANGUAGE_OPTIONS: { value: LanguagePreference; labelKey: string }[] = [
  { value: 'device', labelKey: 'settings.deviceDefault' },
  { value: 'he', labelKey: 'settings.languageHebrew' },
  { value: 'en', labelKey: 'settings.languageEnglish' },
];

const THEME_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: 'device', labelKey: 'settings.deviceDefault' },
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

function OptionRow({
  label,
  selected,
  onPress,
  last,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  last: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      // Not when the row is already the chosen one: re-picking it changes
      // nothing, and a tap that says "done" for a no-op is a lie.
      onPress={() => {
        if (!selected) hapticSelected();
        onPress();
      }}
      style={styles.row}
    >
      <ThemedText type="default">{label}</ThemedText>
      {/* A tick rather than a radio dot: the row is a choice already made or
          not, and a tick reads the same in both directions without mirroring. */}
      {selected && <IconCheck size={20} color={theme.text} />}
      {!last && <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />}
    </Pressable>
  );
}

function SwitchRow({
  label,
  value,
  onChange,
  last,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  last: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.row, styles.switchRow]}>
      <ThemedText type="default">{label}</ThemedText>
      {/* Monochrome, like the segmented control: the on state is the text
          colour, so the switch reads as part of the same flat language rather
          than importing a platform accent nothing else on the screen uses. */}
      <Switch
        value={value}
        onValueChange={(next) => {
          hapticSelected();
          onChange(next);
        }}
        trackColor={{ false: theme.borderMuted, true: theme.text }}
        thumbColor={theme.background}
        ios_backgroundColor={theme.borderMuted}
      />
      {!last && <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
        {title}
      </ThemedText>
      <View>{children}</View>
    </View>
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
  const theme = useTheme();
  const {
    languagePreference,
    themePreference,
    alertSettings,
    setLanguage,
    setTheme,
    setAlertSettings,
  } = usePreferences();

  return (
    <ThemedView type="background" style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ThemedText type="title" style={styles.heading}>
          {t('tabs.settings')}
        </ThemedText>

        <ScrollView contentContainerStyle={styles.content}>
          <Section title={t('settings.language')}>
            {LANGUAGE_OPTIONS.map((option, index) => (
              <OptionRow
                key={option.value}
                label={t(option.labelKey)}
                selected={languagePreference === option.value}
                onPress={() => setLanguage(option.value)}
                last={index === LANGUAGE_OPTIONS.length - 1}
              />
            ))}
          </Section>

          <Section title={t('settings.theme')}>
            {THEME_OPTIONS.map((option, index) => (
              <OptionRow
                key={option.value}
                label={t(option.labelKey)}
                selected={themePreference === option.value}
                onPress={() => setTheme(option.value)}
                last={index === THEME_OPTIONS.length - 1}
              />
            ))}
          </Section>

          <Section title={t('settings.alerts')}>
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
              <View style={[styles.separator, { backgroundColor: theme.borderMuted }]} />
            </View>

            <SwitchRow
              label={t('settings.alertSound')}
              value={alertSettings.sound}
              onChange={(sound) => setAlertSettings({ ...alertSettings, sound })}
              last={false}
            />
            <SwitchRow
              label={t('settings.alertVibrate')}
              value={alertSettings.vibrate}
              onChange={(vibrate) => setAlertSettings({ ...alertSettings, vibrate })}
              last={false}
            />
            <SwitchRow
              label={t('settings.alertRepeat')}
              value={alertSettings.repeatUntilAcknowledged}
              onChange={(repeatUntilAcknowledged) =>
                setAlertSettings({ ...alertSettings, repeatUntilAcknowledged })
              }
              last
            />
          </Section>
        </ScrollView>
      </SafeAreaView>

    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  heading: { paddingHorizontal: Spacing.four, paddingTop: Spacing.four, paddingBottom: Spacing.four },
  content: { paddingBottom: Spacing.five },
  section: { paddingHorizontal: Spacing.four, paddingBottom: SectionGap },
  // See `nearby-stops`: the first row's own padding is the space.
  sectionTitle: {},
  // No horizontal padding: the section already insets this column, and
  // there is no card here to supply one.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.four,
  },
  // The switch is taller than a line of text, so the row is trimmed back to
  // land at roughly the height of the tick rows above it.
  switchRow: { paddingVertical: Spacing.three },
  controlRow: { paddingVertical: Spacing.four },
  // Spans the whole row now that nothing encloses it -- an indented rule on
  // a bare page reads as the edge of a card that is not there.
  separator: {
    position: 'absolute',
    bottom: 0,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    height: StyleSheet.hairlineWidth,
  },
});
