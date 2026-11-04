import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/design-system';
import { homeWidget, useHomeWidgetOptions, type AnyHomeWidget } from '@/features/home-widgets';
import { SettingsPage } from '@/features/settings/settings-page';

/**
 * Any home widget's options: the widget's own `Editor`, inside the shared
 * settings page. One route for every widget, so a widget with options needs
 * no screen of its own.
 */
export default function HomeWidgetOptionsScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const widget = homeWidget(id);

  // An id nothing registers (a stale link, a widget a later build removed).
  if (!widget?.options) {
    return (
      <SettingsPage title={t('homeWidgets.title')}>
        <EmptyState icon="info" title={t('homeWidgets.unknown')} />
      </SettingsPage>
    );
  }
  return <Options widget={widget} />;
}

/** Split out so the options hook runs only for a widget that has options. */
function Options({ widget }: { widget: AnyHomeWidget }) {
  const { t } = useTranslation();
  const [value, setValue] = useHomeWidgetOptions(widget);
  const Editor = widget.options!.Editor;
  return (
    <SettingsPage title={t(widget.titleKey)}>
      <Editor value={value} onChange={setValue} />
    </SettingsPage>
  );
}
