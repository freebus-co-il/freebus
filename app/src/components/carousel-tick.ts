/**
 * Whether a card arriving in a carousel should tick.
 *
 * Pulled out of `SnapCarousel` because it is the whole of the decision and
 * the two things it guards against are invisible in a screenshot -- a
 * haptic cannot be seen, and on a simulator it cannot be felt either. As a
 * pure function it is checkable.
 *
 * - `previous === null` is the carousel ARRIVING: the first viewability
 *   report fires on mount, and a buzz for a screen the rider just opened
 *   answers a gesture they never made.
 * - `!userDriven` is the app moving the carousel itself -- the journey
 *   screen scrolls it as legs complete, which already has its own haptic.
 * - An unchanged index is a report about the card already showing.
 */
export function shouldTickOnCardChange(
  previous: number | null,
  next: number,
  userDriven: boolean,
): boolean {
  return userDriven && previous !== null && next !== previous;
}
