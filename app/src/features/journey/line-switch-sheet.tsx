import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';

import type { TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { ListRow, ListSection, Sheet, Text, type ColorRole } from '@/design-system';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { currentOption, lineOptions, lineVerdict, type LineVerdict } from '@/features/trip/line-options';
import { formatClockTime } from '@/lib/format';
import { hapticSelected } from '@/lib/haptics';

/**
 * "Which one are you on?" -- the whole of the journey screen's answer to a
 * rider who got on a different bus than the plan picked.
 *
 * This replaces a row of chips at the foot of every ride card. The chips were
 * a LIST where a QUESTION was wanted: five departures the rider had to read
 * and reject to reach the one thing that block was for. Behind a control, the
 * cost is one tap for the rider who needs it and nothing at all for everyone
 * else.
 *
 * Every run of the ride is offered, earlier ones included -- the rider may be
 * on the bus before the planned one -- and the planned run is listed and
 * ticked rather than hidden, so "I'm on the one you think" is a visible
 * answer and not an absence.
 */
export function LineSwitchSheet({
  leg, onChoose, onClose,
}: {
  /** The ride being switched; null closes the sheet. */
  leg: TransitLeg | null;
  onChoose: (tripId: string) => void;
  onClose: () => void;
}) {
  // Remember the leg this sheet last opened on, on BOTH edges of the open/close
  // cycle. The caller's `leg` prop becomes null the instant the rider picks a
  // run, but the sheet's Modal is still animating down -- so on the closing edge we
  // hold the remembered leg through the close instead of rendering null and
  // letting the rows vanish mid-animation. Symmetrically, on the OPENING edge,
  // seeding `useState(leg)` and then adjusting during render (rather than in a
  // passive `useEffect`) means the very first committed frame already has
  // content: an effect-based copy runs one tick after that first frame, which
  // opens the Modal over an empty sheet until it flushes. React's own docs
  // endorse this render-time pattern for exactly this "adjust state from a
  // prop change" case.
  const [rememberedLeg, setRememberedLeg] = useState<TransitLeg | null>(leg);
  if (leg !== null && leg !== rememberedLeg) setRememberedLeg(leg);

  const { t } = useTranslation();

  return (
    <Sheet
      visible={leg !== null}
      onClose={onClose}
      title={t('journey.switchLine.title')}
      closeLabel={t('common.close')}
    >
      {rememberedLeg && (
        <LineSwitchSheetContent leg={rememberedLeg} onChoose={onChoose} onClose={onClose} />
      )}
    </Sheet>
  );
}

function LineSwitchSheetContent({
  leg, onChoose, onClose,
}: {
  leg: TransitLeg;
  onChoose: (tripId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const options = lineOptions(leg);
  const current = currentOption(leg, options);

  const noteFor = (verdict: LineVerdict): { text: string; color: Extract<ColorRole, 'danger' | 'live'> } | null => {
    switch (verdict.kind) {
      case 'slower':
        return { text: t('trip.lineLater', { minutes: verdict.minutesLater }), color: 'danger' };
      case 'sooner':
        return { text: t('trip.lineSooner', { minutes: verdict.minutesSooner }), color: 'live' };
      case 'misses':
        return { text: t('trip.lineMisses'), color: 'danger' };
      case 'same':
        return null;
    }
  };

  // The sheet bounds its own height (and lets this shrink inside it), so a
  // busy corridor's twenty runs scroll here instead of growing the sheet past
  // the screen.
  return (
    <ScrollView style={styles.list}>
      {/* The planned run is a checked row like any other, so "I'm on the one
          you think" is a visible answer and not an absence. Plain, not
          grouped: the sheet is already the surface, and a group the same
          colour as it would only add an inset. The section draws the
          separators between rows, never under the last one. */}
      <ListSection variant="plain">
        {options.map((option) => {
          const mine = option.tripId === leg.tripId;
          const note = mine ? null : noteFor(lineVerdict(option, current));
          const time = formatClockTime(option.from.departureTime);
          // The line falls back to the mode name, same as the old chip did
          // (`features/trip/line-option-chips.tsx`, before this branch): a
          // rail route's `shortName` is empty on every one of this feed's
          // trips, and `LineBadge` draws a bare glyph for it with no label of
          // its own, so without this fallback a train row reads as nothing
          // but a time to a screen reader.
          const lineName = option.route.shortName?.trim() || t(`results.modeType.${option.route.type}`, { defaultValue: '' });
          const headsign = option.headsign?.trim() ? formatHeadsign(option.headsign) : '';
          const label = [
            t('trip.lineOption', { line: lineName, time }),
            note?.text,
            mine ? t('journey.switchLine.current') : null,
          ].filter(Boolean).join(', ');
          return (
            <ListRow
              key={option.tripId}
              accessibilityLabel={label}
              leading={<LineBadge route={option.route} />}
              // Where the run is headed, so two runs of one line read apart;
              // the badge already says which line.
              title={headsign === '' ? lineName : t('results.towards', { name: headsign })}
              titleLines={1}
              subtitle={
                note ? (
                  <Text variant="subheadline" emphasized color={note.color} numeric>
                    {note.text}
                  </Text>
                ) : mine ? (
                  t('journey.switchLine.current')
                ) : undefined
              }
              trailing={
                <Text variant="body" emphasized={mine} numeric>
                  {time}
                </Text>
              }
              accessory="check"
              selected={mine}
              onPress={() => {
                // Only when the tap actually changes anything: re-picking the
                // run already chosen is a no-op (`withLineChosen` returns
                // null), and buzzing there teaches that the tap means nothing
                // (`app/AGENTS.md`, haptics).
                if (!mine) hapticSelected();
                onChoose(option.tripId);
                onClose();
              }}
            />
          );
        })}
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 0,
  },
});
