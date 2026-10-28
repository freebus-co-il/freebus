import { Image, StyleSheet } from 'react-native';

export type StationKind = 'bus' | 'train' | 'lightRail' | 'jerusalemLightRail' | 'carmelit' | 'metronit';

const SOURCES = {
  bus: require('@/assets/images/station-icon-bus.png'),
  train: require('@/assets/images/station-icon-train.png'),
  lightRail: require('@/assets/images/station-icon-light-rail.png'),
  jerusalemLightRail: require('@/assets/images/station-icon-jerusalem-light-rail.png'),
  carmelit: require('@/assets/images/station-icon-carmelit.png'),
  metronit: require('@/assets/images/station-icon-metronit.png'),
} as const;

const KINDS = Object.keys(SOURCES) as StationKind[];

/** The sign's side in points: `assets/images/station-icon-*.png` are drawn at
 *  exactly this, @1x to @3x. */
const SIZE = 24;

/**
 * Which sign a stop shows. The API names it by what calls there; an API older
 * than that only says whether trains call, and a newer one may name a kind
 * this build has no sign for -- both fall back to the train or bus sign rather
 * than drawing nothing.
 */
export function stationKindOf(stop: { stationKind?: string | undefined; rail?: boolean | undefined }): StationKind {
  const named = KINDS.find((kind) => kind === stop.stationKind);
  if (named !== undefined) return named;
  return stop.rail ? 'train' : 'bus';
}

/**
 * A stop's sign at the head of a list row: the bus-stop flag, or the mark of
 * the station a rider looks for -- Israel Railways, the Dankal or Jerusalem
 * light rail, the Carmelit or the Metronit. The same signs the station map pins, square like
 * the signs themselves.
 */
export function StationIcon({ kind }: { kind: StationKind }) {
  return <Image source={SOURCES[kind]} style={styles.icon} />;
}

const styles = StyleSheet.create({
  icon: {
    width: SIZE,
    height: SIZE,
  },
});
