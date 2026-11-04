import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Icon, LeadingIcon, ListRow, ListSection, type IconName } from '@/design-system';
import { pointsSummary } from '@/features/custom-journeys/journey-summary';
import { useCustomJourneys } from '@/features/custom-journeys/custom-journeys-context';
import {
  COMMUTE_SOURCE_KINDS,
  emptyCommuteSource,
  type CommuteSource,
  type CommuteSourceKind,
} from '@/features/home-widgets/commute-source';
import { usePreferences } from '@/features/preferences/preferences-context';
import { ChoiceSection } from '@/features/settings/choice-section';
import { SettingsPage } from '@/features/settings/settings-page';
import { LOCATION_ICON_NAMES } from '@/features/saved-locations/location-icons';
import { useSavedLocations } from '@/features/saved-locations/saved-locations-context';
import { placeLabel } from '@/lib/place';
import { hapticSelected } from '@/lib/haptics';

const KIND_OPTIONS: { value: CommuteSourceKind; labelKey: string }[] = COMMUTE_SOURCE_KINDS.map((kind) => ({
  value: kind,
  labelKey: `homeWidgets.source.${kind}`,
}));

/** A ticked row that fires the selection haptic only on a real change. */
function PickRow({ icon, title, subtitle, selected, disabled, onPick }: {
  icon: IconName;
  title: string;
  subtitle?: string;
  selected: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <ListRow
      leading={
        <LeadingIcon>
          <Icon name={icon} size="md" />
        </LeadingIcon>
      }
      title={title}
      subtitle={subtitle}
      titleLines={1}
      accessory="check"
      selected={selected}
      disabled={disabled}
      onPress={() => {
        if (!selected) hapticSelected();
        onPick();
      }}
    />
  );
}

/**
 * What the commute card plans: Home and Work worked out from where the rider
 * is, any two saved places, or a saved journey and its way back. Every kind
 * still shows one trip at a time, the one that fits where the rider is
 * standing, which is what each kind's footer explains.
 */
export default function CommuteSettingsScreen() {
  const { t } = useTranslation();
  const { commuteSource: source, setCommuteSource } = usePreferences();
  const { locations } = useSavedLocations();
  const { journeys } = useCustomJourneys();
  const places = locations.filter((location) => location.place !== null);

  function setKind(kind: CommuteSourceKind) {
    if (kind !== source.kind) setCommuteSource(emptyCommuteSource(kind));
  }

  function update(next: CommuteSource) {
    setCommuteSource(next);
  }

  return (
    <SettingsPage title={t('homeWidgets.commuteTitle')}>
      <ChoiceSection
        title={t('homeWidgets.sourceTitle')}
        options={KIND_OPTIONS}
        value={source.kind}
        onChange={setKind}
        subtitleFor={(kind) => t(`homeWidgets.source.${kind}Hint`)}
      />

      {source.kind === 'places' && (
        <>
          {(['first', 'second'] as const).map((slot) => {
            const other = slot === 'first' ? source.second : source.first;
            return (
              <ListSection
                key={slot}
                title={t(slot === 'first' ? 'homeWidgets.firstPlace' : 'homeWidgets.secondPlace')}
                footer={slot === 'second' ? t('homeWidgets.placesFooter') : undefined}
              >
                {places.map((location) => (
                  <PickRow
                    key={location.id}
                    icon={LOCATION_ICON_NAMES[location.icon]}
                    title={location.label}
                    subtitle={location.place ? placeLabel(location.place) : undefined}
                    selected={source[slot] === location.id}
                    // The same place twice is no trip at all.
                    disabled={other === location.id}
                    onPick={() => update({ ...source, [slot]: location.id })}
                  />
                ))}
                {places.length < 2 && (
                  <ListRow
                    leading={<Icon name="add" color="accent" />}
                    title={t('savedLocations.add')}
                    onPress={() => router.push({ pathname: '/location-picker', params: { field: 'saved-new' } })}
                  />
                )}
              </ListSection>
            );
          })}
        </>
      )}

      {source.kind === 'journeys' && (
        <>
          <ListSection title={t('homeWidgets.journeyThere')}>
            {journeys.map((journey) => (
              <PickRow
                key={journey.id}
                icon="navigate"
                title={journey.name}
                subtitle={pointsSummary(journey.points)}
                selected={source.there === journey.id}
                // Picking the way back as the way there would leave the way
                // back pointing at itself: it goes back to reversed.
                onPick={() => update({ ...source, there: journey.id, back: source.back === journey.id ? 'reverse' : source.back })}
              />
            ))}
            <ListRow
              leading={<Icon name="add" color="accent" />}
              title={t('customJourney.newChip')}
              onPress={() => router.push('/custom-journeys/edit')}
            />
          </ListSection>

          {source.there !== null && (
            <ListSection title={t('homeWidgets.journeyBack')} footer={t('homeWidgets.journeysFooter')}>
              <PickRow
                icon="swap"
                title={t('homeWidgets.reversed')}
                subtitle={t('homeWidgets.reversedHint')}
                selected={source.back === 'reverse'}
                onPick={() => update({ ...source, back: 'reverse' })}
              />
              {journeys
                .filter((journey) => journey.id !== source.there)
                .map((journey) => (
                  <PickRow
                    key={journey.id}
                    icon="navigate"
                    title={journey.name}
                    subtitle={pointsSummary(journey.points)}
                    selected={source.back === journey.id}
                    onPick={() => update({ ...source, back: journey.id })}
                  />
                ))}
            </ListSection>
          )}
        </>
      )}
    </SettingsPage>
  );
}
