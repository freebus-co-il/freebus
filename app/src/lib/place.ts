export type SelectedPlace =
  // `lat`/`lon` are OPTIONAL on a stop, not because a stop lacks a position,
  // but because `SelectedPlace` is persisted to AsyncStorage: a stop saved
  // before these were carried through has no coordinates in storage, and must
  // still parse. Such a place simply cannot be pinned until it is re-picked.
  | { kind: 'stop'; stopId: string; name: string; lat?: number; lon?: number }
  | { kind: 'coordinate'; lat: number; lon: number; label: string };

export function placeToQueryValue(place: SelectedPlace): string {
  return place.kind === 'stop' ? `stop:${place.stopId}` : `${place.lat},${place.lon}`;
}

/** Where to draw this place on a map, or null when it is a stop saved before
 *  coordinates were carried through (see `SelectedPlace`). */
export function placeCoordinates(place: SelectedPlace): { lat: number; lon: number } | null {
  if (place.kind === 'coordinate') return { lat: place.lat, lon: place.lon };
  return place.lat !== undefined && place.lon !== undefined ? { lat: place.lat, lon: place.lon } : null;
}

export function placeLabel(place: SelectedPlace): string {
  return place.kind === 'stop' ? place.name : place.label;
}

/** Round-trips a `SelectedPlace` through expo-router params (all-string) --
 *  used to hand a just-picked place from `location-picker` forward to
 *  `save-location`, which still needs the full object (not just the `/plan`
 *  query-value `placeToQueryValue` produces) to store as a saved location. */
// Flat (not a discriminated union) so `Partial<...>` below actually admits
// every field regardless of `kind` -- a union's `keyof` only sees the tag
// field the two variants share, not each variant's own distinct fields.
export type PlaceRouteParams = {
  kind: 'stop' | 'coordinate';
  stopId?: string;
  name?: string;
  lat?: string;
  lon?: string;
  label?: string;
};

export function placeToRouteParams(place: SelectedPlace): PlaceRouteParams {
  return place.kind === 'stop'
    ? {
        kind: 'stop',
        stopId: place.stopId,
        name: place.name,
        ...(place.lat !== undefined && place.lon !== undefined
          ? { lat: String(place.lat), lon: String(place.lon) }
          : {}),
      }
    : { kind: 'coordinate', lat: String(place.lat), lon: String(place.lon), label: place.label };
}

export function placeFromRouteParams(params: Partial<PlaceRouteParams>): SelectedPlace | null {
  if (params.kind === 'stop' && params.stopId && params.name) {
    const lat = Number(params.lat);
    const lon = Number(params.lon);
    const coordinates =
      params.lat && params.lon && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {};
    return { kind: 'stop', stopId: params.stopId, name: params.name, ...coordinates };
  }
  if (params.kind === 'coordinate' && params.lat && params.lon && params.label) {
    const lat = Number(params.lat);
    const lon = Number(params.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { kind: 'coordinate', lat, lon, label: params.label };
    }
  }
  return null;
}
