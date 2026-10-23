import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Icon, IconButton, ListRow, ListSection, Sheet } from '@/design-system';

/**
 * The journey's secondary actions, behind one glass button: ending the trip
 * and saying which bus the rider is really on. Neither is something a rider
 * needs on screen while they watch for their stop, and ending the trip used to
 * sit there permanently, one stray tap from throwing the journey away.
 */
export function JourneyMenu({ onEnd, onSwitchLine }: { onEnd: () => void; onSwitchLine: (() => void) | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <>
      <IconButton icon="more" variant="glass" accessibilityLabel={t('journey.menu.more')} onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} closeLabel={t('common.close')}>
        <ListSection variant="plain">
          {onSwitchLine && (
            <ListRow leading={<Icon name="bus" />} title={t('journey.switchLine.trigger')} onPress={run(onSwitchLine)} />
          )}
          <ListRow
            leading={<Icon name="close" color="danger" />}
            title={t('journey.end')}
            destructive
            onPress={run(onEnd)}
          />
        </ListSection>
      </Sheet>
    </>
  );
}
