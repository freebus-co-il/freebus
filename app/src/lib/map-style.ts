// The pure map tokens only: this module is tested under Node, outside React Native.
import { DarkBasemap } from '../design-system/tokens/map';

/** One rule of Google Maps' styling language -- the shape `react-native-maps`
 *  takes as `customMapStyle`, kept free of its types so this stays testable
 *  outside React Native. */
export type MapStyleRule = {
  featureType?: string;
  elementType?: string;
  stylers: Record<string, string | number>[];
};

/**
 * Every feature visible -- which is already the default, so this draws exactly
 * the map Google would draw unstyled. It is here because unstyled is no longer
 * an option: since an Android update on the S25, a Google map with no style,
 * or an EMPTY one, draws its routes and pins over a blank basemap. A real rule
 * is what brings the streets back (proven on-device by diagnostic build 8).
 * Do not simplify this to `[]` or `undefined`.
 */
const LIGHT: readonly MapStyleRule[] = [{ stylers: [{ visibility: 'on' }] }];

/**
 * The app's dark palette on the map: land on the card grey, water on the page
 * black, roads a step lighter, labels in the secondary text colour. A style of
 * its own rather than Google's colour scheme, which a style replaces anyway.
 */
const DARK: readonly MapStyleRule[] = [
  { elementType: 'geometry', stylers: [{ color: DarkBasemap.geometry }] },
  { elementType: 'labels.text.fill', stylers: [{ color: DarkBasemap.labelFill }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: DarkBasemap.labelStroke }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: DarkBasemap.poi }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: DarkBasemap.park }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: DarkBasemap.road }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: DarkBasemap.highway }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: DarkBasemap.transit }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: DarkBasemap.water }] },
];

/** Drains the colour out of whatever it follows: one rule, every feature. */
const GREYSCALE: MapStyleRule = { stylers: [{ saturation: -100 }] };

const STYLES = {
  light: { plain: LIGHT, monochrome: [...LIGHT, GREYSCALE] },
  dark: { plain: DARK, monochrome: [...DARK, GREYSCALE] },
} as const;

/**
 * The style every Google (Android) map is drawn with. Never empty -- see
 * `LIGHT`. `monochrome` layers the greyscale on top of the scheme, so a dark
 * map drained of colour stays dark.
 *
 * Returns the same array for the same arguments: `react-native-maps` restyles
 * the native map whenever the prop's contents are handed over again, and a
 * fresh array every render would do that on every render.
 */
export function androidMapStyle(scheme: 'light' | 'dark', monochrome: boolean): MapStyleRule[] {
  const styles = STYLES[scheme];
  return (monochrome ? styles.monochrome : styles.plain) as MapStyleRule[];
}
