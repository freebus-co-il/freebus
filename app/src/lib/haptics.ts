import * as Haptics from 'expo-haptics';

/**
 * The app's haptic vocabulary.
 *
 * Named for what JUST HAPPENED, not for the waveform, so a call site says
 * why it is buzzing and the whole app can be re-tuned from one file. Call
 * sites never import `expo-haptics` directly.
 *
 * The rule for adding one: a haptic is for a moment with no immediate
 * visual, or one the rider may not be looking at. Ordinary taps -- a chip,
 * a row, a tab -- already answer themselves on screen, and an app where
 * everything buzzes is one where nothing means anything.
 *
 * Every call is fire-and-forget and swallows its error. A haptic is never
 * the point of an interaction: a device without a Taptic Engine, a build
 * without the native module, or a rider who turned vibration off at the OS
 * level must all fall through to the action itself, silently.
 */
function fire(run: () => Promise<void>): void {
  void run().catch(() => {});
}

/** A long press registered -- said before the thing it opens has appeared. */
export function hapticGestureRecognised(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** Something came to rest: the map picker's pin, after a drag. */
export function hapticSettled(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** One of a set was chosen -- a segment, a switch, a filter's checkbox. */
export function hapticSelected(): void {
  fire(() => Haptics.selectionAsync());
}

/** Something the rider started is now running. */
export function hapticSucceeded(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/**
 * Something that wants attention: the get-off moment, or a deletion.
 *
 * `Warning` rather than `Error` -- nothing has gone wrong in either case,
 * and the two are distinguishable enough that `Error` would read as a
 * failure the rider then goes looking for.
 */
export function hapticWarned(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}
