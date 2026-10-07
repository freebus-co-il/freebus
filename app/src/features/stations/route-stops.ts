import type { RunStop } from './station-line';

/** One stop of the line in focus, as the station map dots it. */
export type StopDot = {
  latitude: number;
  longitude: number;
  name: string;
  /** Already behind this station on the run: drawn faded, as the journey map
   *  fades a leg the rider is not on. */
  dimmed: boolean;
};

/** A slot in the map's fixed pool of dot markers -- see `stopDotSlots`. */
export type StopDotSlot = StopDot & { visible: boolean };

/** An unused slot: hidden, and parked far from anywhere a rider can tap. */
export const PARKED: StopDotSlot = { latitude: 0, longitude: 0, name: '', dimmed: false, visible: false };

/**
 * Every stop of the run in focus except this station itself, which already
 * has its own sign on the map. `boardingIndex` is where the station sits in
 * `stops` (`runStops`); -1 when it is not on the run, and then nothing dims.
 */
export function routeStopDots(stops: readonly RunStop[], boardingIndex: number): StopDot[] {
  return stops.flatMap((stop, index) => (index === boardingIndex
    ? []
    : [{ latitude: stop.lat, longitude: stop.lon, name: stop.name, dimmed: boardingIndex >= 0 && index < boardingIndex }]));
}

/**
 * The dots, laid into a pool of exactly `poolSize` slots.
 *
 * Fixed-size on purpose. The Android map tracks its children by position, and
 * before react-native-maps 1.28.1 it OVERWROTE a feature on any insert that
 * was not at the end -- leaving the old one on the map, stripped to Google's
 * red pin. A pool that is always mounted never inserts or removes anything:
 * changing the line in focus only moves and shows its slots.
 *
 * A run longer than the pool keeps the stops still ahead of the station
 * first, since those are the ones a rider waiting here rides to.
 */
export function stopDotSlots(dots: readonly StopDot[], poolSize: number): StopDotSlot[] {
  let shown = dots;
  if (dots.length > poolSize) {
    const ahead = dots.filter((dot) => !dot.dimmed).slice(0, poolSize);
    const room = poolSize - ahead.length;
    // The stops just behind the station, never the far start of the run.
    const behind = room > 0 ? dots.filter((dot) => dot.dimmed).slice(-room) : [];
    shown = [...behind, ...ahead];
  }
  return Array.from({ length: poolSize }, (_, index) => {
    const dot = shown[index];
    return dot === undefined ? PARKED : { ...dot, visible: true };
  });
}
