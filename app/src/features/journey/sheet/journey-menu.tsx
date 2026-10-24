import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Icon, IconButton, ListRow, ListSection, Sheet } from '@/design-system';

/**
 * The journey's secondary actions, behind one glass button. Ending the trip
 * used to sit on screen permanently, one stray tap from throwing the journey
 * away. Saying which bus the rider is really on is NOT here: it is too common
 * to hide, so the card offers it beside the line it corrects.
 */
export function JourneyMenu({ onEnd }: { onEnd: () => void }) {
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
