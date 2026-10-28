import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Itinerary, Place, TransitLeg } from '@/api/types';
import { LineBadge } from '@/components/line-badge';
import { LiveIndicator } from '@/components/live-indicator';
import { Border, Button, Icon, Opacity, Radius, Size, Space, Text, useColors } from '@/design-system';
import { usePreferences } from '@/features/preferences/preferences-context';
import { formatHeadsign } from '@/features/results/itinerary-facts';
import { formatClockTime } from '@/lib/format';
import { haversineMeters } from '@/lib/geo';
import { routeColor } from '@/lib/route-color';

import { minutesLeft, nextTransitAfter, stopName, vehicleInPlay } from '../journey-labels';
import type { StationRun } from '../station-board';
import type { JourneyState, RiderPosition } from '../types';
import { BusSign } from './bus-sign';
import { stopLadder, walkVerdict } from './sheet-copy';

/** A city walk at a rider's pace, with the corners a straight line ignores. */
const WALK_METERS_PER_SECOND = 1.2;
const WALK_DETOUR = 1.3;
/** Runs listed under the one coming first: enough to weigh "first" against
 *  "faster" and "closer", few enough to read at a glance. */
const MORE_RUNS = 3;

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
  const { timeFormat } = usePreferences();
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
            {minutes <= 0
              ? t('journey.sheet.leavesNow')
              : timeFormat === 'clock' && state.timer
                ? t('journey.sheet.leavesAt', { time: formatClockTime(state.timer.to) })
                : t('journey.sheet.leavesIn', { count: minutes })}
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

/** What a run on the board is, in a few words: where it sets the rider down
 *  and the walk from there on the last ride, the arrival before it. */
function runDetail(run: StationRun, final: boolean, t: TFunction): string {
  const parts: string[] = [];
  if (final) {
    if (run.alight.name) parts.push(t('journey.sheet.offAt', { name: run.alight.name }));
    if (run.alight.walkMeters !== null) {
      const walkMinutes = Math.max(1, Math.round((run.alight.walkMeters * WALK_DETOUR) / WALK_METERS_PER_SECOND / 60));
      parts.push(t('journey.sheet.walkMinutes', { count: walkMinutes }));
    }
    parts.push(t('journey.sheet.rideMinutes', { count: Math.max(1, Math.round(run.rideSeconds / 60)) }));
  }
  parts.push(t('journey.sheet.arriveAt', { time: formatClockTime(run.arrives) }));
  return parts.join(' · ');
}

/** "in 4 min", or the clock time, by the rider's own preference. */
function departsLabel(iso: string, nowMs: number, timeFormat: string, t: TFunction): string {
  if (timeFormat === 'clock') return t('journey.sheet.alsoAt', { time: formatClockTime(iso) });
  const minutes = minutesUntil(iso, nowMs);
  return minutes <= 0 ? t('journey.sheet.now') : t('journey.sheet.alsoIn', { count: minutes });
}

/**
 * At the station: "which one do I take?"
 *
 * The station's board cut to the runs that make this step (see
 * `station-board.ts`): the one coming first as the hero, the ones after it
 * beneath. On the last ride every line that stops near the destination is
 * there, each with where it sets the rider down, the walk from there, the ride
 * and the arrival, so "comes first but slow" can be weighed against "a few
 * minutes later but faster and closer". Nothing is chosen for the rider: the
 * journey follows whichever they get on.
 */
export function WaitingView({ state, leg, runs, final, nowMs, onSwitchLine }: {
  state: JourneyState; leg: TransitLeg; runs: readonly StationRun[]; final: boolean; nowMs: number;
  onSwitchLine: (() => void) | null;
}) {
  const { t } = useTranslation();
  const { timeFormat } = usePreferences();
  const colors = useColors();
  const minutes = minutesLeft(state.timer);
  const hero = runs.find((run) => run.tripId === leg.tripId) ?? null;
  const others = runs.filter((run) => run.tripId !== leg.tripId).slice(0, MORE_RUNS);
  const where = state.busStopsAway !== null ? t('journey.sheet.busStopsAway', { count: state.busStopsAway }) : null;

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Kicker>{t('journey.sheet.boardFrom', { name: stopName(leg.from.stop, t) })}</Kicker>
        </View>
        {onSwitchLine && <SwitchLineLink onPress={onSwitchLine} />}
      </View>
      <BusSign route={leg.route} headsign={leg.headsign} tripNumber={leg.tripNumber ?? null} />
      <Hero live={state.timeSource === 'live'}>
        {minutes <= 0
          ? t('journey.sheet.arrivingNow')
          : timeFormat === 'clock' && state.timer
            ? t('journey.sheet.arrivingAt', { time: formatClockTime(state.timer.to) })
            : t('journey.sheet.arrivingIn', { count: minutes })}
      </Hero>
      <Text variant="subheadline" color="textSecondary" numeric numberOfLines={2}>
        {[where, hero ? runDetail(hero, final, t) : null].filter(Boolean).join(' · ')}
      </Text>
      {others.length > 0 && (
        <View style={styles.runs}>
          <Kicker>{t('journey.sheet.afterIt')}</Kicker>
          {others.map((run) => (
            <View key={run.key} style={styles.runRow}>
              <LineBadge route={{ ...run.route, shortName: run.route.shortName ?? '' }} size="small" />
              <View style={styles.grow}>
                <Text variant="callout" emphasized numberOfLines={1}>
                  {run.route.shortName?.trim()
                    ? formatHeadsign(run.headsign)
                    : run.tripNumber
                      ? `${t('results.trainNumber', { number: run.tripNumber })} · ${formatHeadsign(run.headsign)}`
                      : formatHeadsign(run.headsign)}
                </Text>
                <Text variant="footnote" color="textSecondary" numeric numberOfLines={1}>
                  {runDetail(run, final, t)}
                </Text>
              </View>
              <View style={styles.row}>
                {run.live && <LiveIndicator color={colors.live} size={Size.icon.sm} />}
                <Text variant="callout" emphasized numeric>{departsLabel(run.departs, nowMs, timeFormat, t)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
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
  const { timeFormat } = usePreferences();
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
            {timeFormat === 'clock'
              ? t('journey.sheet.thenFromAt', { stop: stopName(next.from.stop, t), time: formatClockTime(next.from.departureTime) })
              : t('journey.sheet.thenFrom', { stop: stopName(next.from.stop, t), minutes: minutesUntil(next.from.departureTime, nowMs) })}
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
  runs: { gap: Space.sm, marginTop: Space.xs },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  ladder: { marginTop: Space.xs, gap: Space.sm, paddingStart: Space.xs },
  rail: { position: 'absolute', start: Space.xs + DOT / 2 - 2, top: Space.sm, bottom: Space.sm, width: 4, borderRadius: Radius.xs },
  ladderRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  dotSlot: { width: DOT },
  dot: { width: DOT, height: DOT, borderRadius: Radius.full, borderWidth: Border.selected },
});
