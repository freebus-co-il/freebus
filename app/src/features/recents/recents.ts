import type { SelectedPlace } from '@/lib/place';

/** Enough to scroll, not enough to become an archive nobody prunes. */
export const MAX_PER_KIND = 20;

export type RecentLine = {
  kind: 'line';
  lineCode: string;
  shortName: string | null;
  longName: string | null;
  agencyId: string | null;
  type: number;
};

/** `rail` and `stationKind` are absent on stations recorded before they
 *  existed: those show as bus stops until the rider opens them again from the
 *  Stations search or browse list, which carries the flags. */
export type RecentStation = { kind: 'station'; stopId: string; name: string; rail?: boolean; stationKind?: string };

/**
 * A place the rider actually searched for.
 *
 * The DESTINATION only, not the trip: the row hands this place back to the
 * picker exactly as a fresh search result would, so tapping it plans from
 * wherever the rider is standing NOW rather than replaying where they stood
 * the first time. That is the whole difference between a recent search and a
 * recent trip, and it is why nothing here records an origin.
 */
export type RecentSearch = { kind: 'search'; place: SelectedPlace };

function placeKey(place: SelectedPlace): string {
  return place.kind === 'stop'
    ? `stop:${place.stopId}`
    : `at:${place.lat},${place.lon}`;
}

/**
 * What makes two searches the same search: the same place, searched twice.
 *
 * Coordinates compare EXACTLY, deliberately. The old trip key rounded them
 * to ~110 m because its origin was a live GPS fix, and a stationary fix
 * drifts far enough indoors to make every search from one kitchen a new row.
 * A destination is chosen, never measured -- a stop, an address result, a
 * pin -- so there is no drift to absorb, and rounding here would instead
 * merge two addresses a rider deliberately told apart.
 */
export function recentSearchKey(search: RecentSearch): string {
  return placeKey(search.place);
}

/**
 * What to load out of storage, given whichever of the two shapes is on disk.
 *
 * `searches` is what this version writes. `trips` is what every install
 * before it wrote -- `{ origin, destination }` pairs -- and its DESTINATIONS
 * are exactly the searches that produced them, so they carry across in
 * order rather than being dropped. The list is re-deduped on the way: two
 * trips to the same place from different origins were two rows as trips and
 * are one row as searches.
 *
 * Anything that is not an array, or an entry with no usable place, is
 * skipped rather than trusted -- this parses whatever survived on a device,
 * not something we just serialised.
 */
export function migrateStoredSearches(searches: unknown, trips: unknown): RecentSearch[] {
  if (Array.isArray(searches)) {
    return searches.filter((entry): entry is RecentSearch => isPlace((entry as RecentSearch | null)?.place));
  }
  if (!Array.isArray(trips)) return [];
  const migrated: RecentSearch[] = [];
  for (const trip of trips) {
    const place = (trip as { destination?: unknown } | null)?.destination;
    if (!isPlace(place)) continue;
    const entry: RecentSearch = { kind: 'search', place };
    if (!migrated.some((seen) => recentSearchKey(seen) === recentSearchKey(entry))) migrated.push(entry);
  }
  return migrated.slice(0, MAX_PER_KIND);
}

function isPlace(value: unknown): value is SelectedPlace {
  if (typeof value !== 'object' || value === null) return false;
  const place = value as Partial<SelectedPlace>;
  if (place.kind === 'stop') return typeof place.stopId === 'string';
  return place.kind === 'coordinate' && typeof place.lat === 'number' && typeof place.lon === 'number';
}

/** Most-recent-first, deduped on `key`, capped. */
export function promote<T>(list: T[], entry: T, key: (item: T) => string, cap = MAX_PER_KIND): T[] {
  return [entry, ...list.filter((item) => key(item) !== key(entry))].slice(0, cap);
}
