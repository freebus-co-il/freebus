/**
 * How the app says when something upcoming happens: `countdown` ("in 4 min")
 * or `clock` ("15:24"). The rider picks it in Settings > Appearance.
 *
 * It covers moments only: when a bus leaves or arrives, when to leave. A
 * DURATION (a 6 min walk, a 40 min ride), a time already past ("2 min ago")
 * and a difference ("+3 min") stay in minutes either way, because a clock
 * time cannot say any of them.
 *
 * Components read it from `usePreferences().timeFormat`, so they re-render
 * when it changes. The copy below is for code outside React (a notification
 * scheduled for later), and is kept current by the preferences provider.
 */
export type TimeFormat = 'countdown' | 'clock';

let current: TimeFormat = 'countdown';

export function setCurrentTimeFormat(format: TimeFormat): void {
  current = format;
}

export function currentTimeFormat(): TimeFormat {
  return current;
}
