import { router, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Icon, IconButton, LeadingIcon, ListRow, ListSection, Space } from '@/design-system';
import { HOME_WIDGET_ICONS } from '@/features/home-widgets/home-widget-icons';
import type { CommuteSource } from '@/features/home-widgets/commute-source';
import {
  addHomeWidget,
  availableHomeWidgets,
  homeWidgetDefinition,
  moveHomeWidget,
  removeHomeWidget,
  type HomeWidgetId,
} from '@/features/home-widgets/widgets';
import { usePreferences } from '@/features/preferences/preferences-context';
import { SettingsPage } from '@/features/settings/settings-page';

/**
 * Which cards the home screen shows under the search bar, and in what order.
 * The search bar and the saved-place chips are not on the list: they are how
 * the rider leaves home, so they always stay.
 *
 * Moved with up and down buttons rather than dragged: one tap per step, the
 * same in both directions and for a screen reader, and no drag library for a
 * list this short.
 */
export default function HomeSettingsScreen() {
  const { t } = useTranslation();
  const { homeWidgets, setHomeWidgets, commuteSource } = usePreferences();
  const available = availableHomeWidgets(homeWidgets);

  return (
    <SettingsPage title={t('homeWidgets.title')}>
      <ListSection
        title={t('homeWidgets.onHome')}
        footer={t('homeWidgets.onHomeFooter')}
      >
        {homeWidgets.length === 0 && <ListRow title={t('homeWidgets.none')} />}
        {homeWidgets.map((id, index) => {
          const widget = homeWidgetDefinition(id);
          const title = t(widget.titleKey);
          const options = optionsFor(id, commuteSource);
          return (
            <ListRow
              key={id}
              // A widget with choices of its own opens them from its own row;
              // the row says what it is set to, where the others describe
              // themselves.
              onPress={options ? () => router.push(options.href) : undefined}
              accessibilityHint={options ? t('homeWidgets.optionsHint') : undefined}
              leading={
                <LeadingIcon>
                  <Icon name={HOME_WIDGET_ICONS[widget.id]} size="md" />
                </LeadingIcon>
              }
              title={title}
              subtitle={options ? t(options.valueKey) : t(widget.descriptionKey)}
              trailing={
                <View style={styles.controls}>
                  <IconButton
                    variant="plain"
                    size="sm"
                    icon="chevronUp"
                    accessibilityLabel={t('homeWidgets.moveUp', { name: title })}
                    disabled={index === 0}
                    onPress={() => setHomeWidgets(moveHomeWidget(homeWidgets, id, -1))}
                  />
                  <IconButton
                    variant="plain"
                    size="sm"
                    icon="chevronDown"
                    accessibilityLabel={t('homeWidgets.moveDown', { name: title })}
                    disabled={index === homeWidgets.length - 1}
                    onPress={() => setHomeWidgets(moveHomeWidget(homeWidgets, id, 1))}
                  />
                  <IconButton
                    variant="plain"
                    size="sm"
                    icon="delete"
                    color="danger"
                    accessibilityLabel={t('homeWidgets.remove', { name: title })}
                    onPress={() => setHomeWidgets(removeHomeWidget(homeWidgets, id))}
                  />
                  {options && <Icon name="chevronForward" size="sm" color="textSecondary" weight="semibold" />}
                </View>
              }
            />
          );
        })}
      </ListSection>

      {available.length > 0 && (
        <ListSection title={t('homeWidgets.available')}>
          {available.map((widget) => {
            const title = t(widget.titleKey);
            return (
              <ListRow
                key={widget.id}
                leading={
                  <LeadingIcon>
                    <Icon name={HOME_WIDGET_ICONS[widget.id]} size="md" />
                  </LeadingIcon>
                }
                title={title}
                subtitle={t(widget.descriptionKey)}
                trailing={<Icon name="add" size="md" color="accent" />}
                accessibilityLabel={t('homeWidgets.add', { name: title })}
                onPress={() => setHomeWidgets(addHomeWidget(homeWidgets, widget.id))}
              />
            );
          })}
        </ListSection>
      )}
    </SettingsPage>
  );
}

/** Where a widget's options live, and the key naming what it is set to;
 *  null for a widget with nothing to choose. */
function optionsFor(id: HomeWidgetId, commuteSource: CommuteSource): { href: Href; valueKey: string } | null {
  if (id === 'commute') return { href: '/settings/commute', valueKey: `homeWidgets.source.${commuteSource.kind}` };
  return null;
}

const styles = StyleSheet.create({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
