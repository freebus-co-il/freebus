import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as TaskManager from 'expo-task-manager';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Platform } from 'react-native';

import { useRealtimeAvailable } from '@/api/meta';
import type { Itinerary, Place } from '@/api/types';
import { usePreferences } from '@/features/preferences/preferences-context';
import { useSearch } from '@/features/search/search-context';
import { withLineChosen } from '@/features/trip/line-options';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import i18n from '@/i18n';
import type { SelectedPlace } from '@/lib/place';

import { planAlightAlerts } from './alerts';
import { boardedEarlierRun, withEarlierRunAtStart } from './earlier-run';
import { newReminderId, type PendingLeave } from './leave-reminder';
import {
  cancelLeaveReminders,
  readPendingLeave,
  scheduleLeaveReminders,
  writePendingLeave,
} from './leave-reminder-store';
import { buildJourneyRegions } from './geofences';
import { journeyCopy } from './journey-copy';
import { liveLabelFor } from './journey-labels';
import { journeyEndsAt, resolveJourneyState } from './journey-machine';
import { reachedFromRegion } from './journey-progress';
import { buildJourneyRail, type JourneyRail } from './journey-rail';
import {
  addAcknowledgeAlightListener,
  liveSurface,
  surfaceCopy,
  type JourneySurfaceCopy,
  type LiveSurfaceAlert,
} from './live-surface';
import { pip, useJourneyPipPosition, useJourneyVisible } from './pip';
import { sameFacts, surfaceFacts, type SurfaceFacts } from './surface-facts';
import { hapticSucceeded, hapticWarned } from '@/lib/haptics';

import type { ActiveJourney, AlertSettings, JourneyState, RiderPosition } from './types';
import { useJourneyLive } from './use-journey-live';

const STORAGE_KEY = 'freebus.activeJourney.v1';

/** Names the geofencing task registered below. Stable across releases: the OS
 *  keeps monitoring regions under this name while the app is terminated, so
 *  renaming it would orphan the regions of any journey already running. */
const GEOFENCE_TASK = 'freebus.journey.geofences';

/** Android puts sound and vibration on the channel, not the notification, and
 *  a channel's settings are frozen the first time it is created -- so this is
 *  the get-off alarm's channel and nothing else's. */
const ALERT_CHANNEL_ID = 'freebus.journey.alight';

/** Two long buzzes with a gap. Long enough to register through a coat pocket,
 *  and distinct from the single short tick of an ordinary notification. */
const ALERT_VIBRATION_PATTERN = [0, 400, 200, 400];

/**
 * Fast enough that a boundary the CLOCK owns -- a departure, a scheduled
 * alight when no position is available -- is noticed within a few seconds
 * rather than up to half a minute late, which for a get-off alert is the
 * difference between a warning and an apology.
 */
const JOURNEY_TICK_MS = 5_000;

/**
 * With no journey running nothing on screen reads this clock, and this
 * provider sits above the whole navigator -- so it drops to an interval that
 * costs nothing rather than re-rendering the entire app every five seconds
 * for a value no one is looking at.
 */
const IDLE_TICK_MS = 5 * 60_000;

/** How long "You're here" stays in the PiP window before it puts itself away. */
const PIP_ARRIVED_LINGER_MS = 4_000;

/**
 * The tier the spec spends battery on: precise, and only while the journey is
 * VISIBLE -- the app foregrounded, or its PiP window -- where the cost is
 * either in front of the rider or covered by the journey's own persistent
 * notification. `distanceInterval` rather than a time interval because the
 * only thing the machine does with a fix is count stops, and a stationary
 * rider at a red light has nothing new to say.
 *
 * Fully backgrounded -- no PiP, nothing on screen -- still means geofences and
 * nothing else, the tier that costs approximately zero and survives the
 * process being killed.
 *
 * PiP is the one visible case this watch does NOT cover. A PiP activity is
 * paused while on screen, and expo-location stops every watch on pause
 * whatever service is running, so inside the window the native module asks
 * the fused provider itself and feeds the same position state (see
 * `useJourneyPipPosition` and `JourneyPipLocation.kt`). The `location`-typed
 * `JourneyService` is what legitimises that to the OS, and its notification
 * to the rider.
 */
const FOREGROUND_WATCH: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  distanceInterval: 20,
};

/**
 * The get-off alert has to land while the rider is staring at the app, which
 * is exactly when they are watching for it -- and the default behaviour for a
 * notification that arrives in the foreground is to be swallowed silently.
 * At module scope because a notification can arrive before any component has
 * mounted.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    priority: Notifications.AndroidNotificationPriority.MAX,
  }),
});

/**
 * Parsed defensively, like the preferences store: a half-written or
 * older-shaped record should mean "no journey is running", never a crash on
 * launch. The one field checked is `itinerary.legs`, because every consumer
 * indexes into it and nothing else in the record can be wrong in a way the
 * machine does not already tolerate.
 */
async function readStoredJourney(): Promise<ActiveJourney | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveJourney;
    return Array.isArray(parsed?.itinerary?.legs) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStoredJourney(journey: ActiveJourney | null): Promise<void> {
  try {
    if (journey) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(journey));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // A journey that cannot be persisted still runs for as long as the process
    // lives. Failing the start over it would take away the working feature to
    // punish the loss of the cold-start resume.
  }
}

/**
 * Retires whatever leave reminder is stored, notifications and record alike.
 *
 * Reads storage rather than taking the record from state, so it works from a
 * cold start where no state exists yet -- and so `start()` can call it
 * without depending on the pending record, which would rebuild `start` (and
 * with it the alert re-arm effect that watches it) on every reminder change.
 */
async function clearStoredPendingLeave(): Promise<void> {
  const stored = await readPendingLeave();
  if (!stored) return;
  await cancelLeaveReminders(stored.id);
  await writePendingLeave(null);
}

/**
 * Colons separate every id derived from this one -- notification identifiers
 * are `<journeyId>:alight:<legIndex>:<suffix>` and are matched back by prefix
 * -- so the id itself must not contain one. Time-based rather than random
 * because two journeys cannot be started in the same millisecond by one thumb.
 */
function newJourneyId(): string {
  return `j${Date.now().toString(36)}`;
}

/** Copy for the loud moment, resolved through i18n rather than hard-coded:
 *  this is the one string in the feature a rider reads half-asleep, and it
 *  has to be in their language wherever it is rendered from. */
function alightAlert(stopName: string, settings: AlertSettings): LiveSurfaceAlert {
  return {
    title: i18n.t('journey.alert.getOffNow'),
    body: stopName,
    sound: settings.sound,
    vibrate: settings.vibrate,
  };
}

/** Cancels every still-pending alert whose identifier starts with `prefix`.
 *  Matching by prefix rather than keeping a list of ids means this works from
 *  a background launch, where nothing but storage survived. */
async function cancelAlertsMatching(prefix: string): Promise<void> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter((request) => request.identifier.startsWith(prefix))
        .map((request) => Notifications.cancelScheduledNotificationAsync(request.identifier)),
    );
  } catch {
    // Nothing to do: the platform has no scheduler here (web), or the app has
    // no notification permission, in which case there is nothing pending.
  }
}

/**
 * The geofence half of the get-off alarm's two triggers.
 *
 * Defined at module scope, and NOT inside the provider, because the whole
 * point of a geofence is that it wakes a terminated app: the OS spins up the
 * bundle with no views mounted, runs this, and shuts down again. Anything
 * this needs has to come from storage, because no React state exists yet.
 */
TaskManager.defineTask<{ eventType: Location.GeofencingEventType; region: Location.LocationRegion }>(
  GEOFENCE_TASK,
  async ({ data, error }) => {
    if (error) return;
    // Only entering means anything. Regions are armed `notifyOnEnter` only, so
    // this is belt and braces -- and halving the events halves the wakeups.
    if (data?.eventType !== Location.GeofencingEventType.Enter) return;

    const journey = await readStoredJourney();
    if (!journey) {
      // Regions outliving their journey is the one way this can fire wrongly
      // -- a crash between clearing storage and disarming, say. Disarm here
      // rather than ignore it, or the rider gets alerts for a trip they ended.
      await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(() => {});
      return;
    }

    // Each stop the rider physically reaches moves a journey on, even with the
    // app asleep and no fix coming in: the stop's region is the evidence GPS
    // would have given. Written straight to storage -- the provider is not
    // running to hold it -- and picked back up when the app is next opened.
    // Only while the app is inactive: when it is active, its own fixes are
    // already moving the journey, and writing here could race its record.
    if (AppState.currentState !== 'active') {
      const reached = reachedFromRegion(journey.itinerary, data.region.identifier ?? '');
      if (reached !== null && reached > (journey.gpsLegIndex ?? -1)) {
        await writeStoredJourney({ ...journey, gpsLegIndex: reached });
      }
    }

    const [kind, rawLegIndex] = (data.region.identifier ?? '').split(':');
    const legIndex = Number(rawLegIndex);
    const leg = journey.itinerary.legs[legIndex];

    if (kind !== 'wake' || !leg || leg.type !== 'transit') return;
    if (journey.acknowledgedAlightLegIndex === legIndex) return;

    // The app being awake means the provider below is already driving every
    // surface from a real GPS fix and owns the alert. Firing here too would
    // buy a second alarm for one event, which is how an alert stops being
    // read as information and starts being read as noise.
    if (AppState.currentState === 'active') return;

    // Whichever trigger lands first wins and cancels the other. This one is
    // the accurate one -- it fires because the rider is actually there, not
    // because the timetable said they would be -- so it retires the
    // pre-scheduled alerts for this leg rather than the other way round.
    await cancelAlertsMatching(`${journey.id}:alight:${legIndex}:`);

    await Notifications.scheduleNotificationAsync({
      identifier: `${journey.id}:alight:${legIndex}:geofence`,
      content: {
        title: i18n.t('journey.alert.getOffNow'),
        body: leg.to.stop.name ?? '',
        sound: 'default',
        vibrate: ALERT_VIBRATION_PATTERN,
        priority: Notifications.AndroidNotificationPriority.MAX,
        // Time Sensitive pierces Focus and Do Not Disturb, and is
        // self-enabled -- no Apple review. Critical Alerts would need one and
        // is not what a missed bus stop is for.
        interruptionLevel: 'timeSensitive',
      },
      trigger: null,
    });
  },
);

async function armGeofences(journey: ActiveJourney): Promise<void> {
  try {
    // Foreground first: iOS will not even offer the always-on prompt until
    // when-in-use has been granted.
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) return;
    const background = await Location.requestBackgroundPermissionsAsync();
    if (!background.granted) return;

    await Location.startGeofencingAsync(
      GEOFENCE_TASK,
      buildJourneyRegions(journey).map((region) => ({
        identifier: region.id,
        latitude: region.lat,
        longitude: region.lon,
        radius: region.radiusMeters,
        notifyOnEnter: true,
        notifyOnExit: false,
      })),
    );
  } catch {
    // Web, Expo Go, and a device with location switched off at the OS level
    // all land here. A journey with no geofences still runs on the clock and
    // on the scheduled alerts -- which is exactly why there are two triggers.
  }
}

async function disarmGeofences(): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch {
    // Never started, or no platform support. Either way there is nothing armed.
  }
}

async function scheduleAlightAlerts(journey: ActiveJourney, settings: AlertSettings): Promise<void> {
  try {
    const permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true },
    });
    if (!permission.granted) return;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
        name: i18n.t('journey.alert.getOffNow'),
        importance: Notifications.AndroidImportance.MAX,
        sound: settings.sound ? 'default' : null,
        vibrationPattern: ALERT_VIBRATION_PATTERN,
        enableVibrate: settings.vibrate,
        showBadge: false,
      });
    }

    const nowMs = Date.now();
    await Promise.all(
      planAlightAlerts(journey, settings)
        // "Got it" is an answer that has to survive a re-arm. This function is
        // called again whenever the rider retunes the alert mid-journey, and
        // without this the retune would resurrect the very alerts the
        // acknowledgement cancelled -- waking someone who is already awake.
        .filter((alert) => alert.legIndex !== journey.acknowledgedAlightLegIndex)
        // A journey started with its first bus already nearly at the stop has
        // alerts in the past, and a date trigger in the past fires at once --
        // which would sound the get-off alarm the instant the rider taps
        // Start, for a stop they have not left for yet.
        .filter((alert) => new Date(alert.fireAt).getTime() > nowMs)
        .map((alert) =>
          Notifications.scheduleNotificationAsync({
            identifier: alert.id,
            content: {
              title: i18n.t(alert.titleKey),
              body: alert.bodyStopName,
              sound: settings.sound ? 'default' : false,
              vibrate: settings.vibrate ? ALERT_VIBRATION_PATTERN : undefined,
              priority: Notifications.AndroidNotificationPriority.MAX,
              interruptionLevel: 'timeSensitive',
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: new Date(alert.fireAt),
              channelId: ALERT_CHANNEL_ID,
            },
          }),
        ),
    );
  } catch {
    // Same bargain as the geofences: the journey is worth running without its
    // alarm, and the surviving trigger still covers the moment that matters.
  }
}

/** Everything the OS is holding on the journey's behalf, released together.
 *  Ending has to be total -- a stray geofence or a pending alert for a trip
 *  the rider has finished is worse than never having armed one. */
async function releaseOsResources(journey: ActiveJourney | null): Promise<void> {
  await liveSurface.stop();
  await disarmGeofences();
  if (journey) await cancelAlertsMatching(`${journey.id}:`);
}

/** A stop as something the search can plan from. Prefers the stop id, which
 *  `/plan` resolves exactly, and falls back to the coordinates for a feed
 *  place that arrived without one. */
function stopAsPlace(stop: Place): SelectedPlace | null {
  const name = stop.name?.trim() || i18n.t('trip.unnamedStop');
  if (stop.stopId) return { kind: 'stop', stopId: stop.stopId, name, lat: stop.lat, lon: stop.lon };
  return { kind: 'coordinate', lat: stop.lat, lon: stop.lon, label: name };
}

/**
 * Where a re-plan starts from.
 *
 * The rider's own fix whenever there is one -- "from here" means here. With
 * no fix, the stop the machine already believes they are at: a rider who has
 * watched their bus leave is standing at its boarding stop, and one who has
 * sailed past their stop is nearest to the alighting one. Both are within a
 * few hundred metres of the truth, which for a journey search returns the
 * same options -- and a slightly-wrong origin beats a dead button on the one
 * screen that exists to offer a way out.
 */
function replanOrigin(state: JourneyState, position: RiderPosition | null): SelectedPlace | null {
  if (position) {
    return {
      kind: 'coordinate',
      lat: position.lat,
      lon: position.lon,
      label: i18n.t('search.currentLocation'),
    };
  }
  if (!state.leg) return null;
  return stopAsPlace(state.offPlan === 'overshot' ? state.leg.to.stop : state.leg.from.stop);
}

/**
 * Where the re-plan is going: unchanged, meaning unchanged from what THIS
 * journey was for.
 *
 * Rebuilt from the journey's own record rather than read off the search
 * context, because a running journey outlives the search that found it -- the
 * rider may have looked up three other places since starting it, and planning
 * to whatever is currently in the destination field would quietly send them
 * somewhere they never asked to go.
 */
function replanDestination(journey: ActiveJourney): SelectedPlace | null {
  const last = journey.itinerary.legs.at(-1);
  if (!last) return null;
  const end = last.type === 'walk' ? last.to : last.to.stop;
  const label = journey.destinationLabel.trim();
  return label ? { kind: 'coordinate', lat: end.lat, lon: end.lon, label } : stopAsPlace(end);
}

function useJourneyState() {
  const [journey, setJourney] = useState<ActiveJourney | null>(null);
  const [hydrated, setHydrated] = useState(false);
  /** A journey the rider asked to be reminded about. Nothing is running for
   *  it -- see `leave-reminder`. */
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const [position, setPosition] = useState<RiderPosition | null>(null);

  // The re-plan below drives the ordinary search rather than a private query
  // of its own, so the results screen it lands on is the same screen the rider
  // already knows -- same sorting, same filters, same Start button. That is
  // also what makes the replacement journey arrive through `start()` like any
  // other. Safe to depend on because `JourneyProvider` sits inside
  // `SearchProvider` (see `_layout.tsx`).
  const { setOriginOverride, setDestination, setTimeMode, setCustomTime } = useSearch();

  // The rider's own alert settings, read once here and threaded through every
  // call site below rather than re-read at each -- so the machine, the live
  // surface and the scheduler can never disagree about how early to shout.
  // Safe to depend on because `JourneyProvider` sits inside
  // `PreferencesProvider` (see `_layout.tsx`).
  const { alertSettings: settings } = usePreferences();

  // The live surface is handed finished sentences rather than left to invent
  // its own, so the words the Lock Screen says are resolved HERE -- the one
  // place `react-i18next` and the theme both exist. A renderer that derived
  // its own copy would need its own copy of the `journey.*` keys, in every
  // locale, drifting from these.
  const { t } = useTranslation();
  const theme = useTheme();
  const palette = useMemo(() => ({ end: theme.text, alert: theme.danger }), [theme.text, theme.danger]);

  const now = useNow(journey ? JOURNEY_TICK_MS : IDLE_TICK_MS);

  const visible = useJourneyVisible();
  const realtimeAvailable = useRealtimeAvailable();

  // Resolved twice on purpose: the state without live input decides what to
  // ask the server about, and the answer then resolves the state the surfaces
  // draw. Both are pure and cheap; a tick costs two passes over a few legs.
  const base = useMemo(
    () => (journey ? resolveJourneyState(journey, position, now, settings) : null),
    [journey, position, now, settings],
  );
  const live = useJourneyLive(journey, base, visible, now);
  const state = useMemo(
    () => (journey ? resolveJourneyState(journey, position, now, settings, live) : null),
    [journey, position, now, settings, live],
  );
  const rail = useMemo<JourneyRail | null>(
    () => (journey ? buildJourneyRail(journey.itinerary) : null),
    [journey],
  );

  /** Resolves a state into the lines a surface prints. A callback rather than
   *  a bare `useMemo` because `start()` and the arrival timer both resolve a
   *  state of their own, off-render, and their copy must come from the same
   *  place as the ticking one's. */
  const copyFor = useCallback(
    (of: ActiveJourney, resolved: JourneyState): JourneySurfaceCopy =>
      // `surfaceCopy`, not the raw copy: it swaps in the hero with no ticking
      // minute in it. Pushing the in-app hero here would spend an update every
      // sixty seconds of a wait, and strand a frozen "in 4 min" beside a live
      // countdown as soon as the app suspends.
      surfaceCopy(
        journeyCopy(resolved, of.itinerary, of.destinationLabel, t, palette),
        t,
        liveLabelFor(resolved, realtimeAvailable, t),
      ),
    [t, palette, realtimeAvailable],
  );

  const copy = useMemo(
    () => (journey && state ? copyFor(journey, state) : null),
    [journey, state, copyFor],
  );

  /**
   * The last facts actually pushed to the live surface -- the reason this is a
   * ref and not state is that changing it must never itself cause a render.
   */
  const pushedFacts = useRef<SurfaceFacts | null>(null);
  /** Legs whose get-off alert has already sounded through the live surface.
   *  A phase can be re-entered -- a GPS fix that briefly counts an extra stop
   *  drops back to `riding` and returns -- and the second alarm for the same
   *  stop teaches the rider to ignore the first. */
  const alertedLegs = useRef(new Set<number>());
  /** Which journey the pre-scheduled alerts were armed for, and on which
   *  settings. A ref rather than state because it records what the OS is
   *  already holding -- nothing renders from it, and writing it must not
   *  itself trigger the effect that reads it. */
  const armedWith = useRef<{ journeyId: string; settings: AlertSettings } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Both records, before `hydrated` goes true: the reminder gate waits on
    // that flag before starting a tapped journey, and a tap that arrived
    // before this resolved would find no record and do nothing.
    Promise.all([readStoredJourney(), readPendingLeave()]).then(([stored, pending]) => {
      if (cancelled) return;
      setJourney(stored);
      setPendingLeave(pending);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Gated on `hydrated` for the same reason the preferences store is: without
  // it the initial `null` would erase a running journey from disk before the
  // read that was about to restore it had finished.
  useEffect(() => {
    if (!hydrated) return;
    void writeStoredJourney(journey);
  }, [journey, hydrated]);

  const journeyId = journey?.id ?? null;

  /** The latest live input, for the arrival timer and `recordFix` below to
   *  resolve with. A ref because `live` is a new object every tick, and keying
   *  either on it would tear them down and rebuild them every five seconds. */
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /**
   * Takes a fix from wherever one comes from -- the foreground watch, the PiP
   * window -- and moves a GPS-tracked journey on with it, writing the leg the
   * fix places the rider on back into the record. It has to be in the record:
   * a cold start must resume from it, and a journey that forgot it would slide
   * back onto the timetable the first time a fix went stale. Only ever forward,
   * matching the machine.
   *
   * In the fix's own callback rather than an effect watching `state`, so the
   * record moves once per fix instead of re-rendering the whole provider a
   * second time to catch up with the first.
   */
  const recordFix = useCallback((fix: RiderPosition) => {
    setPosition(fix);
    setJourney((current) => {
      if (!current) return current;
      const reached = resolveJourneyState(current, fix, new Date(), settingsRef.current, liveRef.current).trackedLegIndex;
      return reached !== null && (current.gpsLegIndex ?? -1) < reached ? { ...current, gpsLegIndex: reached } : current;
    });
  }, []);

  const trackedLegIndex = state?.trackedLegIndex ?? null;

  // Stops reached while the app was asleep were recorded straight into storage
  // by the geofence task. Taken on waking, furthest first, so the journey
  // opens on the leg the rider is actually on rather than the one they left.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active') return;
      void readStoredJourney().then((stored) => {
        const reached = stored?.gpsLegIndex;
        if (!stored || reached == null) return;
        setJourney((current) =>
          current && current.id === stored.id && (current.gpsLegIndex ?? -1) < reached
            ? { ...current, gpsLegIndex: reached }
            : current,
        );
      });
    });
    return () => subscription.remove();
  }, []);

  /**
   * How retuning the alert reaches a journey that is already running.
   *
   * The pre-scheduled notifications are the trigger that fires with no code
   * running, which is exactly what makes them stale the moment the rider moves
   * the lead time: they were written into the OS at start time. So they are
   * torn down and re-armed here.
   *
   * The `armedWith` guard is what keeps that cheap. This effect re-runs on
   * every change to the journey record -- acknowledging an alert rewrites it
   * -- but only touches the scheduler when the journey or its settings have
   * actually changed, so `start()`, which records what it armed, leaves
   * nothing for this to do. The cancel has to come first because a shorter
   * lead or a switched-off repeat schedules FEWER alerts than before, and
   * re-scheduling alone would only overwrite the ones that still exist.
   */
  useEffect(() => {
    if (!journey) return;
    const armed = armedWith.current;
    if (armed && armed.journeyId === journey.id && armed.settings === settings) return;

    armedWith.current = { journeyId: journey.id, settings };
    void (async () => {
      await cancelAlertsMatching(`${journey.id}:alight:`);
      await scheduleAlightAlerts(journey, settings);
    })();
  }, [journey, settings]);

  /**
   * Tier one of the spec's location table: high accuracy, and only while the
   * journey is VISIBLE -- the app foregrounded, or its PiP window.
   * Invisible tears the watch down entirely and hands the journey over to the
   * geofences, which cost approximately nothing and work with the process
   * dead.
   *
   * Keyed on the journey's id and visibility rather than the record, so
   * acknowledging an alert -- which rewrites the record -- does not restart
   * the GPS.
   */
  useEffect(() => {
    if (!journeyId || !visible) return;

    let subscription: Location.LocationSubscription | null = null;
    let stopped = false;

    void (async () => {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (!permission.granted || stopped) return;
        const next = await Location.watchPositionAsync(FOREGROUND_WATCH, (fix) => {
          recordFix({
            lat: fix.coords.latitude,
            lon: fix.coords.longitude,
            // A fix with no stated accuracy is treated as the worst one the
            // machine will still act on rather than as a perfect one.
            accuracyMeters: fix.coords.accuracy ?? Number.POSITIVE_INFINITY,
            at: new Date(fix.timestamp).toISOString(),
          });
        });
        if (stopped) next.remove();
        else subscription = next;
      } catch {
        // No position simply means the machine falls back to the timetable,
        // which every phase already has an answer for.
      }
    })();

    return () => {
      stopped = true;
      subscription?.remove();
    };
  }, [journeyId, visible, recordFix]);

  // The PiP half of the tier above. The subscription is kept for the
  // provider's life because the native side only emits while the window is
  // up and a journey is running, and never without permission -- so this is
  // silent everywhere else, and in the window it is the only fix there is.
  useJourneyPipPosition(recordFix);

  /**
   * THE constraint the whole design rests on.
   *
   * `state` is a fresh object every tick, so the effect below calls this every
   * tick -- and almost every time it must do nothing. ActivityKit meters
   * `update()` calls, and a 40-minute journey ticked at five seconds would
   * spend ~480 of them to say the same thing 470 times over; the countdown and
   * the progress rail are date ranges the OS animates by itself from the last
   * update it was given. So an update is spent ONLY on a fact GPS discovered:
   * the phase, the leg, the stop count, or a divergence. That is what keeps a
   * whole journey inside a handful of updates, off the battery, and off the
   * server.
   *
   * Every caller goes through here rather than touching `liveSurface.update`
   * directly, so there is exactly one place the budget can be blown.
   */
  const pushSurface = useCallback(
    (next: JourneyState, nextCopy: JourneySurfaceCopy) => {
      const facts = surfaceFacts(next, nextCopy);
      if (sameFacts(pushedFacts.current, facts)) return;

      // Read before the write, because the alert decision is about the
      // TRANSITION into `alight-soon`, not about being in it.
      const previouslyAlerting = pushedFacts.current?.phase === 'alight-soon';
      pushedFacts.current = facts;

      const shouldAlert =
        facts.phase === 'alight-soon' && !previouslyAlerting && !alertedLegs.current.has(facts.legIndex);
      if (shouldAlert) alertedLegs.current.add(facts.legIndex);

      // The one alert that has to land in the hand. Everything loud about
      // this moment is a NOTIFICATION, which a foregrounded app is the worst
      // case for: the rider is holding the phone, watching the screen go
      // orange, and feeling nothing. This is the only haptic in the app
      // gated on `settings.vibrate`, because unlike the rest it is not
      // interface feedback -- it is the alarm, and that switch is the
      // rider's answer about the alarm.
      if (shouldAlert && settings.vibrate) hapticWarned();

      // Deliberately does NOT cancel this leg's scheduled notifications the way
      // the geofence path does. Without a native module `liveSurface` is a
      // no-op, so on those builds the scheduled alert is the ONLY loud thing
      // that will happen -- cancelling it here would trade a duplicate alarm
      // for no alarm at all. The rider's acknowledgement is what retires it.
      void liveSurface.update(
        next,
        nextCopy,
        shouldAlert && next.leg ? alightAlert(next.leg.to.stop.name ?? '', settings) : undefined,
      );
    },
    [settings],
  );

  useEffect(() => {
    if (state && copy) pushSurface(state, copy);
  }, [state, copy, pushSurface]);

  /**
   * The PiP window is offered for exactly as long as there is a journey still
   * worth watching, and carries "Got it" only at the moment it answers.
   */
  const pipArmed = journey !== null && state !== null && state.phase !== 'arrived';
  const pipAcknowledge = state?.phase === 'alight-soon';
  useEffect(() => {
    void pip.set(pipArmed, pipAcknowledge);
  }, [pipArmed, pipAcknowledge]);

  const end = useCallback(async () => {
    const ending = journey;
    setJourney(null);
    pushedFacts.current = null;
    alertedLegs.current = new Set();
    armedWith.current = null;
    // Written through rather than left to the save effect: the geofence task
    // reads storage, and a region firing between here and React's next commit
    // would find a journey that has already ended.
    await writeStoredJourney(null);
    await releaseOsResources(ending);
  }, [journey]);

  const arrivalTime = state?.arrivalTime ?? null;

  /**
   * Arriving ends the journey rather than parking it.
   *
   * Scheduled at the arrival INSTANT rather than noticed on a tick, because
   * that instant is the one thing about the end of a journey the plan knows
   * exactly -- polling for it would find it up to a tick late and, on a cold
   * start into an already-finished journey, not at all until the first tick
   * landed. The final state is pushed before the teardown so the rider sees
   * "You're here" rather than finding the surfaces simply gone; position is
   * not passed because the machine returns `arrived` from the clock alone.
   *
   * The instant is the RESOLVED arrival, not the itinerary's: shifted by the
   * last ride's live delay while that prediction is usable, so a late bus does
   * not end the journey -- and close the PiP window -- a few minutes before
   * the rider gets there. It re-arms whenever that time moves, and reverts to
   * the timetable when the prediction lapses, which is the honest fallback.
   */
  /** The journey this provider has already ended, so the GPS arrival below and
   *  the timer here cannot both tear the same one down. */
  const finishedJourneyId = useRef<string | null>(null);
  const tracked = trackedLegIndex !== null;

  useEffect(() => {
    if (!journey || !arrivalTime) return;
    // A journey GPS is following ends when the rider gets there (the effect
    // below); this timer is then only the backstop for one who never does.
    const arrivesIn = new Date(journeyEndsAt(arrivalTime, tracked)).getTime() - Date.now();
    const timer = setTimeout(() => {
      const final = resolveJourneyState(journey, null, new Date(), settings, liveRef.current);
      // The arrival moved between arming and firing; the render that moved it
      // re-arms this effect for the new instant.
      if (final.phase !== 'arrived' || finishedJourneyId.current === journey.id) return;
      finishedJourneyId.current = journey.id;
      pushSurface(final, copyFor(journey, final));
      void end();
      // Left long enough to read, then put away. Module scope rather than a
      // cleanup-owned timer: `end()` unmounts the journey this effect belongs
      // to, so there is nothing here to tie a cleanup to. Deliberately not
      // cancelled if a new journey starts inside the linger window either --
      // `pip.leave()` itself is the guard: it is a no-op while a journey is
      // armed, so this stale call cannot close a window the new journey just
      // opened. See the `armed` guard in `pip.ts`.
      setTimeout(() => void pip.leave(), PIP_ARRIVED_LINGER_MS);
    }, Math.max(0, arrivesIn));
    return () => clearTimeout(timer);
  }, [journey, arrivalTime, tracked, end, pushSurface, settings, copyFor]);

  // Reaching the destination ends a journey GPS is following there and then --
  // not at a clock time the rider may have beaten, or may still be walking
  // past. The same finish as the timer above: "You're here", then put away.
  const arrivedHere = state?.phase === 'arrived' && tracked;
  useEffect(() => {
    if (!arrivedHere || !journey || !state || finishedJourneyId.current === journey.id) return;
    finishedJourneyId.current = journey.id;
    pushSurface(state, copyFor(journey, state));
    void end();
    setTimeout(() => void pip.leave(), PIP_ARRIVED_LINGER_MS);
  }, [arrivedHere, journey, state, pushSurface, copyFor, end]);

  const start = useCallback(
    async (itinerary: Itinerary, signature: string, departure: string, destinationLabel: string) => {
      // One journey at a time, per the spec. The old one is released BEFORE
      // the new one arms anything, or its geofences and pending alerts would
      // outlive it and shout about a stop the rider is no longer heading to.
      await releaseOsResources(journey);

      // Start means NOW. A rider who set out before the plan told them to gets
      // the run they can actually catch on the same route, not the bus a
      // search from half an hour ago picked -- which they would otherwise
      // stand and watch arrive after the one they were already on (see
      // `withEarlierRunAtStart`).
      const plan = withEarlierRunAtStart(itinerary, Date.now());

      const draft: ActiveJourney = {
        id: newJourneyId(),
        itinerary: plan,
        signature,
        departure: plan.departureTime,
        startedAt: new Date().toISOString(),
        destinationLabel,
        acknowledgedAlightLegIndex: null,
      };
      const opening = resolveJourneyState(draft, position, new Date(), settings);
      // Placed by the fix the rider started with, if there is one: a rider
      // standing still at their stop sends no new fix for `recordFix` to
      // record, and would otherwise fall back to the timetable the moment
      // this one went stale.
      const next: ActiveJourney = { ...draft, gpsLegIndex: opening.trackedLegIndex };

      setJourney(next);
      // Not `settings.vibrate`-gated: that switch is about the get-off
      // alarm, and this is the ordinary confirmation that a thing the rider
      // pressed is now running. Fired after the commit, so it answers for a
      // journey that exists rather than for an attempt.
      hapticSucceeded();
      // Claimed synchronously, before anything is awaited: the re-arm effect
      // above runs as soon as this commit lands, which can be inside the very
      // next await, and it has to recognise the schedule below as its own
      // rather than tear down and rebuild what `start` is still arming.
      armedWith.current = { journeyId: next.id, settings };
      await writeStoredJourney(next);

      // Any reminder is spent now: the rider is inside a journey, and a
      // "time to leave" buzzing later would be about a trip already under way
      // -- or, if they started a different one, about the wrong trip entirely.
      await clearStoredPendingLeave();
      setPendingLeave(null);

      const openingCopy = copyFor(next, opening);
      // Seeded so the first tick after this does not immediately re-push what
      // `start` has just handed the surface.
      pushedFacts.current = surfaceFacts(opening, openingCopy);
      alertedLegs.current = new Set();

      await liveSurface.start(next, opening, buildJourneyRail(itinerary), openingCopy);
      await armGeofences(next);
      await scheduleAlightAlerts(next, settings);
    },
    [journey, position, settings, copyFor],
  );

  /**
   * DETECT, THEN OFFER -- and this is the "offer" half, so read what it does
   * NOT do first: it does not touch the running journey.
   *
   * The record, its geofences, its scheduled alerts and its live surfaces are
   * all left exactly as they were. All this does is point the search at the
   * rider's current position and the journey's original destination, and show
   * them the results; the journey is replaced only when they pick an itinerary
   * and press Start, which goes through `start()` like any other journey.
   *
   * That separation is the whole point of the divergence feature. The app can
   * only ever GUESS that something has gone wrong -- there is no realtime
   * feed, so "the bus left without you" is inferred from a position and a
   * timetable, and it can be wrong. A journey that rewrote itself on that
   * guess would overrule the rider at the exact moment they most need to be
   * the one deciding, and would leave someone who was actually fine holding a
   * plan they never chose.
   */
  const replanFromHere = useCallback(() => {
    if (!journey || !state) return;

    const from = replanOrigin(state, position);
    const to = replanDestination(journey);
    // Nothing to plan from or to. Silent rather than an error dialogue: the
    // rider is already looking at one piece of bad news and the journey they
    // still have is untouched.
    if (!from || !to) return;

    setOriginOverride(from);
    setDestination(to);
    // Back to live "now". Any time the rider chose belonged to the search that
    // produced the journey they are standing in the wreckage of, and an
    // `arriveBy` or a `departAfter` from an hour ago would offer them trips
    // that have already gone.
    setTimeMode('departAfter');
    setCustomTime(null);

    // Pushed rather than replacing: backing out of the alternatives has to
    // land the rider back on the journey they still have.
    router.push('/results');
  }, [journey, state, position, setOriginOverride, setDestination, setTimeMode, setCustomTime]);

  const acknowledgeAlight = useCallback(async () => {
    if (!journey || !state) return;
    const legIndex = state.legIndex;

    const next = { ...journey, acknowledgedAlightLegIndex: legIndex };
    setJourney(next);
    // Written through for the geofence task's benefit, which is the one reader
    // that cannot see React state and is also the one that would otherwise
    // wake the rider again after they have already said they are up.
    await writeStoredJourney(next);

    // Only THIS leg's alerts. A journey with a second ride still needs its own
    // get-off alarm, and "Got it" was an answer to one stop, not to the trip.
    await cancelAlertsMatching(`${journey.id}:alight:${legIndex}:`);
  }, [journey, state]);

  /**
   * The rider saying which bus they are actually on.
   *
   * A ride can be taken on any of its line options (see
   * `features/trip/line-options`), and the planner only guessed one. The
   * others board and alight at the same stops, so swapping the leg keeps the
   * rest of the journey intact while its stops, route, times and live checks
   * follow the bus the rider is really on.
   *
   * What the OS holds was armed for the old bus: the get-off alarms fire at its
   * arrival, and the stop regions sit on its path. Both are rebuilt here, for
   * the same reason a retuned alert is (see the `armedWith` effect above).
   */
  const chooseLine = useCallback(
    async (legIndex: number, tripId: string) => {
      if (!journey) return;
      const itinerary = withLineChosen(journey.itinerary, legIndex, tripId);
      if (!itinerary) return;
      const next: ActiveJourney = { ...journey, itinerary };

      setJourney(next);
      armedWith.current = { journeyId: next.id, settings };
      await writeStoredJourney(next);

      await cancelAlertsMatching(`${next.id}:alight:`);
      await scheduleAlightAlerts(next, settings);
      await armGeofences(next);
    },
    [journey, settings],
  );

  /**
   * Following the bus the rider is actually on.
   *
   * `ridingEarly` is the machine saying GPS has them travelling this ride's
   * route while the bus the plan picked has not left yet: they set out early
   * and caught the run before it. Swapping the leg onto that run is the same
   * move the rider could make by hand from the line chips, and it does the
   * same things -- the journey's times and its arrival follow the bus under
   * them, the get-off alarm and the geofences are re-armed for it, and every
   * live question from then on asks about it rather than about the bus still
   * somewhere behind.
   *
   * The guard is a ref, not state: the tick that produces `ridingEarly` fires
   * every five seconds and `chooseLine` is async, so without it the same swap
   * would be attempted over and over while the first one was still running.
   */
  const switchingToTripId = useRef<string | null>(null);
  useEffect(() => {
    const leg = state?.leg;
    if (!journey || !state?.ridingEarly || !leg) return;

    const run = boardedEarlierRun(leg, Date.now());
    if (run === null || run.tripId === leg.tripId || switchingToTripId.current === run.tripId) return;

    switchingToTripId.current = run.tripId;
    void chooseLine(state.legIndex, run.tripId).finally(() => {
      switchingToTripId.current = null;
    });
  }, [journey, state, chooseLine]);

  /**
   * The other half of "Got it".
   *
   * Both native modules already silence themselves before they emit -- that is
   * what makes acknowledging work with the app suspended -- so this is only
   * how the app catches up. Without it the rider presses the button, the noise
   * stops, and the machine still believes it is in `alight-soon`: the journey
   * screen keeps shouting, this leg's pre-scheduled alerts are never
   * cancelled, and the repeat fires thirty seconds later at someone who is
   * already standing at the door.
   *
   * Subscribed once for the provider's life and reached through a ref rather
   * than re-subscribed on every change to `acknowledgeAlight`: that callback
   * closes over `state`, which is a fresh object on every five-second tick,
   * so keying the effect on it would tear down and re-register a native
   * listener twelve times a minute for the whole journey. Null-safe because
   * on web and in Expo Go there is no module to emit anything.
   */
  const acknowledgeRef = useRef(acknowledgeAlight);
  useEffect(() => {
    acknowledgeRef.current = acknowledgeAlight;
  }, [acknowledgeAlight]);

  useEffect(() => {
    const subscription = addAcknowledgeAlightListener(() => {
      void acknowledgeRef.current();
    });
    return () => subscription?.remove();
  }, []);

  /**
   * "Remind me to leave", for a journey whose departure is still an hour off.
   *
   * Deliberately NOT a journey: nothing is armed, no geofence is registered
   * and no get-off alarm is scheduled, because the rider is at home. What is
   * stored is the itinerary itself, which is what lets the tap an hour later
   * start the trip they chose rather than whatever a fresh search returns.
   *
   * False means the reminder was NOT set -- the rider refused notifications,
   * or the platform has no scheduler. Nothing is stored in that case: a
   * promise of a buzz that cannot come is worse than no reminder.
   */
  const setLeaveReminder = useCallback(
    async (itinerary: Itinerary, signature: string, departure: string, destinationLabel: string) => {
      const next: PendingLeave = {
        id: newReminderId(),
        itinerary,
        signature,
        departure,
        destinationLabel,
        setAt: new Date().toISOString(),
      };

      const armed = await scheduleLeaveReminders(next);
      if (!armed) return false;

      // One reminder at a time, like one journey -- and only once the new one
      // is actually armed, so a refused permission leaves the old one intact.
      if (pendingLeave) await cancelLeaveReminders(pendingLeave.id);
      setPendingLeave(next);
      await writePendingLeave(next);
      return true;
    },
    [pendingLeave],
  );

  const cancelLeaveReminder = useCallback(async () => {
    if (!pendingLeave) return;
    await cancelLeaveReminders(pendingLeave.id);
    setPendingLeave(null);
    await writePendingLeave(null);
  }, [pendingLeave]);

  /**
   * Starts the journey a tapped reminder names, and only that one.
   *
   * The id comes from the notification the rider tapped; a record that does
   * not match it is not started, which is what stops a stale notification from
   * launching the wrong trip. Read from storage rather than state because a
   * cold start launched by the tap may still be hydrating.
   *
   * False means there was nothing to start -- the reminder was cancelled, or
   * its journey has already been started by hand.
   */
  const startPending = useCallback(
    async (pendingId: string) => {
      const stored = pendingLeave?.id === pendingId ? pendingLeave : await readPendingLeave();
      if (!stored || stored.id !== pendingId) return false;

      await cancelLeaveReminders(stored.id);
      setPendingLeave(null);
      await writePendingLeave(null);
      await start(stored.itinerary, stored.signature, stored.departure, stored.destinationLabel);
      return true;
    },
    [pendingLeave, start],
  );

  return {
    journey, state, rail, position, live, hydrated, start, acknowledgeAlight, chooseLine, replanFromHere, end,
    pendingLeave, setLeaveReminder, cancelLeaveReminder, startPending,
  };
}

type JourneyContextValue = ReturnType<typeof useJourneyState>;

const JourneyContext = createContext<JourneyContextValue | null>(null);

export function JourneyProvider({ children }: { children: ReactNode }) {
  const value = useJourneyState();
  return <JourneyContext.Provider value={value}>{children}</JourneyContext.Provider>;
}

export function useJourney() {
  const ctx = useContext(JourneyContext);
  if (!ctx) throw new Error('useJourney must be used within a JourneyProvider');
  return ctx;
}
