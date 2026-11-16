import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import type { LegacyScrollView } from 'react-native-gesture-handler';

import { Icon, IconButton, LeadingIcon, ListRow, ListSection, Space } from '@/design-system';
import {
  addToLayout,
  homeWidgetOptionsHref,
  homeWidgets,
  removeFromLayout,
  useHomeLayout,
  resolveOptions,
  type AnyHomeWidget,
} from '@/features/home-widgets';
import { moveItem } from '@/features/home-widgets/reorder-math';
import { ReorderableRows } from '@/features/home-widgets/reorderable-rows';
import { usePreferences } from '@/features/preferences/preferences-context';
import { SettingsPage } from '@/features/settings/settings-page';

/**
 * Which widgets the home screen shows under the search bar, and in what
 * order, for whatever is registered (`features/home-widgets/widgets`). The
 * search bar and the saved-place chips are not on the list: they are how the
 * rider leaves home, so they always stay.
 *
 * Reordered by dragging: by the grip at a row's end, or by a long press
 * anywhere on it (a plain tap opens the widget's options). For a screen
 * reader the grip is adjustable: swipe up or down to move the widget.
 */
export default function HomeSettingsScreen() {
  const { t } = useTranslation();
  const { widgets, ids, setIds } = useHomeLayout();
  const { homeWidgetOptions } = usePreferences();
  const available = homeWidgets().filter((widget) => !ids.includes(widget.id));
  // The page holds still while a row is dragged, or it scrolls with the finger.
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<LegacyScrollView>(null);

  /** A widget with options says what it is set to; the others describe
   *  themselves. */
  function subtitleFor(widget: AnyHomeWidget): string {
    if (!widget.options) return t(widget.descriptionKey);
    return t(widget.options.summaryKey(resolveOptions(widget, homeWidgetOptions)));
  }

  return (
    <SettingsPage title={t('homeWidgets.title')} scrollEnabled={!dragging} scrollRef={scrollRef}>
      <ListSection
        title={t('homeWidgets.onHome')}
        footer={t('homeWidgets.onHomeFooter')}
      >
        {widgets.length === 0 ? (
          <ListRow title={t('homeWidgets.none')} />
        ) : (
          <ReorderableRows
            items={widgets}
            keyOf={(widget) => widget.id}
            onMove={(from, to) => setIds(moveItem(ids, from, to))}
            onDragChange={setDragging}
            scrollRef={scrollRef}
            handleLabel={(widget) => t('homeWidgets.reorder', { name: t(widget.titleKey) })}
            positionLabel={(index, count) => t('homeWidgets.position', { index: index + 1, count })}
            renderRow={(widget, _index, grip) => {
              const title = t(widget.titleKey);
              return (
                <ListRow
                  // A widget with choices of its own opens them from its own row.
                  onPress={widget.options ? () => router.push(homeWidgetOptionsHref(widget.id)) : undefined}
                  accessibilityHint={widget.options ? t('homeWidgets.optionsHint') : undefined}
                  leading={
                    <LeadingIcon>
                      <Icon name={widget.icon} size="md" />
                    </LeadingIcon>
                  }
                  title={title}
                  subtitle={subtitleFor(widget)}
                  trailing={
                    <View style={styles.controls}>
                      <IconButton
                        variant="plain"
                        size="sm"
                        icon="delete"
                        color="danger"
                        accessibilityLabel={t('homeWidgets.remove', { name: title })}
                        onPress={() => setIds(removeFromLayout(ids, widget.id))}
                      />
                      {widget.options && <Icon name="chevronForward" size="sm" color="textSecondary" weight="semibold" />}
                      {grip}
                    </View>
                  }
                />
              );
            }}
          />
        )}
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
                    <Icon name={widget.icon} size="md" />
                  </LeadingIcon>
                }
                title={title}
                subtitle={t(widget.descriptionKey)}
                trailing={<Icon name="add" size="md" color="accent" />}
                accessibilityLabel={t('homeWidgets.add', { name: title })}
                onPress={() => setIds(addToLayout(ids, widget.id))}
              />
            );
          })}
        </ListSection>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
});
