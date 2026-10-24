import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Itinerary, Place, TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { LiveIndicator } from '@/components/live-indicator';
import { Border, Button, Chip, Icon, Opacity, Radius, Size, Space, Text, useColors } from '@/design-system';
import { laterOptions } from '@/features/trip/line-options';
import { formatClockTime } from '@/lib/format';
import { haversineMeters } from '@/lib/geo';
import { routeColor } from '@/lib/route-color';

import { minutesLeft, nextTransitAfter, stopName, vehicleInPlay } from '../journey-labels';
import type { Backbone } from '../replan/backbone';
import type { JourneyState, RiderPosition } from '../types';
import { BusSign } from './bus-sign';
import { alsoLines, stopLadder, walkVerdict } from './sheet-copy';

/** A city walk at a rider's pace, with the corners a straight line ignores. */
const WALK_METERS_PER_SECOND = 1.2;
const WALK_DETOUR = 1.3;

function minutesUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((Date.parse(iso) - nowMs) / 60_000));
}

function Kicker({ children, color }: { children: string; color?: string }) {
  return (
    <Text variant="footnote" emphasized color={color ?? 'textSecondary'} numberOfLines={1}>
      {children}
    </Text>
  );
}

/** "On a different bus?", at the end of the line that names the rider's
 *  bus. On the card rather than behind the menu: boarding whatever line came
 *  first is too common a move to hide. Text, not a button shape, so the
 *  kicker's line keeps its height. */
function SwitchLineLink({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={Space.md}
      style={({ pressed }) => pressed && { opacity: Opacity.pressed }}
    >
      <Text variant="footnote" emphasized color="accent" numberOfLines={1}>
        {t('journey.switchLine.trigger')}
      </Text>
    </Pressable>
  );
}

/** The hero line: the one answer this moment is for. */
function Hero({ children, color, live }: { children: string; color?: string; live?: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.row, styles.grow]}>
      {live && <LiveIndicator color={colors.live} size={Size.icon.sm} />}
      <Text variant="title1" emphasized numeric color={color} numberOfLines={1} adjustsFontSizeToFit style={styles.grow}>
        {children}
      </Text>
    </View>
  );
}

/** Walking to the first stop, or between rides. "Will I make it?" */
export function WalkingView({ state, itinerary, position, transfer }: {
  state: JourneyState; itinerary: Itinerary; position: RiderPosition | null; transfer: boolean;
}) {
  const { t } = useTranslation();
  const ride = vehicleInPlay(itinerary, state);
  const walk = itinerary.legs[state.legIndex];
  const target: Place | undefined = ride?.from.stop ?? (walk?.type === 'walk' ? walk.to : undefined);
  const minutes = minutesLeft(state.timer);
  const walkSeconds = position && target
    ? (haversineMeters(position, target) * WALK_DETOUR) / WALK_METERS_PER_SECOND
    : walk?.type === 'walk' ? walk.durationSeconds : 0;
  const verdict = walkVerdict(minutes * 60 - walkSeconds);
  const verdictColor = verdict === 'plenty' ? 'live' : verdict === 'hurry' ? 'warning' : 'danger';

  return (
    <View style={styles.block}>
      <Kicker>{t(transfer ? 'journey.sheet.transferTo' : 'journey.sheet.walkingTo', { name: stopName(target, t) })}</Kicker>
      {ride && (
        <View style={styles.row}>
          <LineBadge route={ride.route} />
          <Hero live={state.timeSource === 'live'}>
            {minutes > 0 ? t('journey.sheet.leavesIn', { count: minutes }) : t('journey.sheet.leavesNow')}
          </Hero>
        </View>
      )}
      <View style={styles.row}>
        <Text variant="subheadline" color="textSecondary" numeric>
          {t('journey.sheet.walkMinutes', { count: Math.max(1, Math.round(walkSeconds / 60)) })}
        </Text>
        <Text variant="subheadline" emphasized color={verdictColor}>
          {t(verdict === 'plenty' ? 'journey.sheet.verdictPlenty' : verdict === 'hurry' ? 'journey.sheet.verdictHurry' : 'journey.sheet.verdictLate')}
        </Text>
      </View>
    </View>
  );
}

/** At the stop. "Is this my bus?" */
export function WaitingView({ state, leg, candidates, nowMs, backbone, onSwitchLine }: {
  state: JourneyState; leg: TransitLeg; candidates: readonly Itinerary[]; nowMs: number; backbone: Backbone | null;
  onSwitchLine: (() => void) | null;
}) {
  const { t } = useTranslation();
  const minutes = minutesLeft(state.timer);
  // The next run of this same line AFTER the one coming -- by live times, so a
  // late bus is not followed by a "next" that already left before it.
  const heroDeparts = Date.parse(leg.realtime?.predictedDeparture ?? leg.from.departureTime);
  const nextRun = laterOptions(leg).find((option) =>
    option.route.shortName === leg.route.shortName &&
    Date.parse(option.realtime?.predictedDeparture ?? option.from.departureTime) > heroDeparts);
  const others = alsoLines(leg, candidates, nowMs, backbone);
  const where = [
    state.busStopsAway !== null ? t('journey.sheet.busStopsAway', { count: state.busStopsAway }) : null,
    nextRun ? t('journey.sheet.nextRun', { time: formatClockTime(nextRun.realtime?.predictedDeparture ?? nextRun.from.departureTime) }) : null,
  ].filter((part): part is string => part !== null).join(' · ');

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Kicker>{t('journey.sheet.waitingFor')}</Kicker>
        </View>
        {onSwitchLine && <SwitchLineLink onPress={onSwitchLine} />}
      </View>
      <BusSign route={leg.route} headsign={leg.headsign} />
      <Hero live={state.timeSource === 'live'}>
        {minutes > 0 ? t('journey.sheet.arrivingIn', { count: minutes }) : t('journey.sheet.arrivingNow')}
      </Hero>
      {where !== '' && <Text variant="subheadline" color="textSecondary" numeric>{where}</Text>}
      {others.length > 0 && (
        <View style={styles.wrapRow}>
          <Text variant="subheadline" color="textSecondary">{t('journey.sheet.or')}</Text>
          {others.map((line) => (
            <View key={line.tripId} style={styles.row}>
              <LineBadge route={line.route} size="small" />
              <Text variant="subheadline" color="textSecondary" numeric>
                {t('journey.sheet.alsoIn', { count: minutesUntil(line.departureTime, nowMs) })}
              </Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.chips}>
        <Chip variant="info" icon="pin" label={stopName(leg.from.stop, t)} />
        <Chip variant="info" label={t('journey.sheet.rideStops', { count: leg.numStops })} />
      </View>
    </View>
  );
}

/** On board. "How many more?" */
export function RidingView({ state, leg, onSwitchLine }: {
  state: JourneyState; leg: TransitLeg; onSwitchLine: (() => void) | null;
}) {
  const { t } = useTranslation();
  const ladder = stopLadder(leg, state.stopsRemaining);
  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <LineBadge route={leg.route} size="small" />
        <View style={styles.grow}>
          <Kicker>{t('journey.sheet.rideUntil', { time: formatClockTime(leg.to.arrivalTime) })}</Kicker>
        </View>
        {onSwitchLine && <SwitchLineLink onPress={onSwitchLine} />}
      </View>
      <Hero>
        {state.stopsRemaining !== null
          ? t('journey.sheet.stopsLeft', { count: state.stopsRemaining })
          : t('journey.sheet.rideUntil', { time: formatClockTime(leg.to.arrivalTime) })}
      </Hero>
      <Text variant="subheadline" color="textSecondary">
        {t('journey.sheet.getOffAt', { name: stopName(leg.to.stop, t) })}
      </Text>
      {ladder && <Ladder ladder={ladder} color={routeColor(leg.route)} />}
    </View>
  );
}

function Ladder({ ladder, color }: { ladder: NonNullable<ReturnType<typeof stopLadder>>; color: string }) {
  const { t } = useTranslation();
  const colors = useColors();
  const rail = color;
  const rows: { key: string; node: ReactNode; strong: boolean }[] = [];
  const nextIsAlight = ladder.next.stopId === ladder.alight.stopId;
  rows.push({ key: 'next', strong: true, node: (
    <View style={styles.row}>
      <Text variant="callout" emphasized numberOfLines={1} style={styles.grow}>{stopName(ladder.next, t)}</Text>
      <Text variant="caption1" emphasized color={rail}>{t('journey.sheet.nextTag')}</Text>
    </View>
  ) });
  if (!nextIsAlight) {
    if (ladder.after) rows.push({ key: 'after', strong: false, node: <Text variant="callout" color="textSecondary" numberOfLines={1}>{stopName(ladder.after, t)}</Text> });
    if (ladder.hidden > 0) rows.push({ key: 'more', strong: false, node: <Text variant="footnote" color="textSecondary">{`⋯ ${t('journey.sheet.moreStops', { count: ladder.hidden })}`}</Text> });
    rows.push({ key: 'alight', strong: true, node: <Text variant="callout" emphasized numberOfLines={1}>{stopName(ladder.alight, t)}</Text> });
  }
  return (
    <View style={styles.ladder}>
      <View style={[styles.rail, { backgroundColor: rail }]} />
      {rows.map((row) => (
        <View key={row.key} style={styles.ladderRow}>
          {row.key === 'more'
            ? <View style={styles.dotSlot} />
            : <View style={[styles.dot, { borderColor: rail, backgroundColor: row.key === 'alight' ? rail : colors.surfaceFloating }]} />}
          <View style={styles.grow}>{row.node}</View>
        </View>
      ))}
    </View>
  );
}

/**
 * The get-off moment. The same glass sheet as every other moment -- the
 * buzz and the alarm are what make it loud; on screen it is the app's own
 * "act now" signal, the live green hero, over the stop's name.
 */
export function AlightView({ state, itinerary, leg, nowMs, canSilence, onSilence }: {
  state: JourneyState; itinerary: Itinerary; leg: TransitLeg; nowMs: number; canSilence: boolean; onSilence: () => void;
}) {
  const { t } = useTranslation();
  const next = nextTransitAfter(itinerary, state.legIndex);
  return (
    <View style={styles.block}>
      <Text variant="title1" emphasized color="live" numberOfLines={1} adjustsFontSizeToFit>
        {t('journey.sheet.alightHero')}
      </Text>
      <Text variant="title3" emphasized numberOfLines={2}>{stopName(leg.to.stop, t)}</Text>
      <View style={styles.row}>
        <Icon name="handRaised" size="sm" color="textSecondary" />
        <Text variant="subheadline" color="textSecondary">{t('journey.sheet.pressStop')}</Text>
      </View>
      {next && (
        <View style={styles.row}>
          <Text variant="subheadline" color="textSecondary">{t('journey.sheet.then')}</Text>
          <LineBadge route={next.route} size="small" />
          <Text variant="subheadline" color="textSecondary" numeric numberOfLines={1} style={styles.grow}>
            {t('journey.sheet.thenFrom', { stop: stopName(next.from.stop, t), minutes: minutesUntil(next.from.departureTime, nowMs) })}
          </Text>
        </View>
      )}
      {canSilence && <Button variant="plain" size="sm" label={t('journey.sheet.silence')} onPress={onSilence} />}
    </View>
  );
}

/** The last walk, and the end. */
export function ArrivingView({ state, destinationLabel }: { state: JourneyState; destinationLabel: string }) {
  const { t } = useTranslation();
  if (state.phase === 'arrived') return <Hero>{t('journey.sheet.arrived')}</Hero>;
  return (
    <View style={styles.block}>
      <Kicker>{t('journey.sheet.toDestination', { name: destinationLabel })}</Kicker>
      <Hero>{t('journey.sheet.walkMinutes', { count: Math.max(1, minutesLeft(state.timer)) })}</Hero>
    </View>
  );
}

/** The plan broke and a new one is on its way -- never a dead end. */
export function RecalculatingView({ stuck }: { stuck: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <Icon name="refresh" size="md" />
        <Text variant="title2" emphasized>{t('journey.sheet.recalculating')}</Text>
      </View>
      <Text variant="subheadline" color="textSecondary">
        {t(stuck ? 'journey.sheet.stuck' : 'journey.sheet.recalculatingSub')}
      </Text>
    </View>
  );
}

/** Only when the rider's own kind of trip no longer works: a different one,
 *  offered, never taken for them. */
export function OfferView({ offer, onAccept, onKeep }: { offer: Itinerary; onAccept: () => void; onKeep: () => void }) {
  const { t } = useTranslation();
  const first = offer.legs.find((leg): leg is TransitLeg => leg.type === 'transit');
  return (
    <View style={styles.block}>
      <Text variant="headline">{t('journey.sheet.offerTitle')}</Text>
      <View style={styles.row}>
        {first && <LineBadge route={first.route} />}
        <Text variant="subheadline" color="textSecondary" numeric style={styles.grow}>
          {t('journey.sheet.offerBody', { line: first?.route.shortName ?? '', time: formatClockTime(offer.arrivalTime) })}
        </Text>
      </View>
      <View style={styles.row}>
        <Button variant="prominent" size="md" label={t('journey.sheet.offerAccept')} onPress={onAccept} />
        <Button variant="plain" size="md" label={t('journey.sheet.offerKeep')} onPress={onKeep} />
      </View>
    </View>
  );
}

const DOT = 12;

const styles = StyleSheet.create({
  block: { gap: Space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  wrapRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexWrap: 'wrap' },
  grow: { flex: 1 },
  chips: { flexDirection: 'row', gap: Space.sm, flexWrap: 'wrap', marginTop: Space.xs },
  ladder: { marginTop: Space.xs, gap: Space.sm, paddingStart: Space.xs },
  rail: { position: 'absolute', start: Space.xs + DOT / 2 - 2, top: Space.sm, bottom: Space.sm, width: 4, borderRadius: Radius.xs },
  ladderRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  dotSlot: { width: DOT },
  dot: { width: DOT, height: DOT, borderRadius: Radius.full, borderWidth: Border.selected },
});
