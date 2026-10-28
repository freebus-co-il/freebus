/**
 * Map styling shared by every map screen. See design-system.md 3.1 (map) and 11
 * of token-map.md for where these were copied before.
 */
export const MapStyle = {
  routeWidth: 5,
  routeWidthSecondary: 4,
  dashPattern: [8, 6],
  /** A line shape behind the focused trip. */
  lineShapeOpacity: 0.3,
  /** The focused trip's own line shape, which the legs are drawn over. */
  focusedLineShapeOpacity: 0.12,
  unfocusedLegOpacity: 0.4,
  markerRingWidth: 3,
  markerRingWidthSecondary: 2,
  /** Camera padding where nothing floats over the map. */
  edgePadding: 50,
} as const;

/** Android's dark basemap (iOS draws its own dark map). Was `lib/map-style.ts`. */
export const DarkBasemap = {
  geometry: '#1C1C1E',
  labelFill: '#9A9AA0',
  labelStroke: '#000000',
  poi: '#232325',
  park: '#1F2621',
  road: '#3A3A3C',
  highway: '#48484A',
  transit: '#2C2C2E',
  water: '#000000',
} as const;
