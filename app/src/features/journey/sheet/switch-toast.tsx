import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';

import { Toast } from '@/design-system';

import type { ReplanSwitch } from '../replan/use-live-replan';

const SHOW_MS = 5_000;

/**
 * Says, once, that the journey changed course by itself -- which line it is
 * on now and what that bought -- and that the rider should stand somewhere
 * else, when they should. Nothing to approve or dismiss: it goes on its own.
 */
export function SwitchToast({ change }: { change: ReplanSwitch | null }) {
  const { t } = useTranslation();
  // The last change that has had its moment. A new change shows until its
  // own timer marks it done.
  const [doneAt, setDoneAt] = useState<number | null>(null);

  useEffect(() => {
    if (change === null) return;
    const timer = setTimeout(() => setDoneAt(change.at), SHOW_MS);
    return () => clearTimeout(timer);
  }, [change]);

  if (change === null || doneAt === change.at) return null;

  const minutes = Math.round(change.gainSeconds / 60);
  const message = change.line ? t('journey.switch.toLine', { line: change.line }) : t('journey.switch.newWay');
  const detail = change.changedStopName
    ? t('journey.switch.stopChanged', { name: change.changedStopName })
    : minutes > 0
      ? t('journey.switch.sooner', { count: minutes })
      : undefined;

  return <Toast icon="refresh" message={message} detail={detail} style={styles.toast} />;
}

const styles = StyleSheet.create({
  toast: {
    alignSelf: 'stretch',
  },
});
