import { lineKey } from '@/features/stations/station-line';

/**
 * The rider's favorites: stations, lines, and one line at one stop.
 *
 * Unlike recents, nothing here is recorded by visiting: every entry is a
 * choice the rider made, so the list is never capped, never reordered by use,
 * and never pruned when the feed stops serving an id (the row says so
 * instead; the rider decides whether to drop it).
 *
 * Every entry carries a snapshot of what it is called, so the list draws
 * offline and on the first frame. `refreshFavorite` brings a snapshot up to
 * date when the rider next opens the stop or line.
 */

export type FavoriteStation = {
  kind: 'station';
  stopId: string;
  name: string;
  rail?: boolean;
  stationKind?: string;
};

export type FavoriteLine = {
  kind: 'line';
  lineCode: string;
  shortName: string | null;
  longName: string | null;
  agencyId: string | null;
  type: number;
};

/**
 * One line, one way, at one stop: the countdown a commuter actually checks.
 *
 * `lineCode` names the line in both directions, so `lineDirection` is part of
 * the identity. A railway station serves both directions of a line from one
 * stop id, and pinning "line 5 here" without the direction would mix the two.
 */
export type FavoriteStopLine = {
  kind: 'stopLine';
  stopId: string;
  stopName: string;
  lineCode: string;
  lineDirection: string;
  shortName: string | null;
  agencyId: string | null;
  type: number;
  /** Where this direction goes, as the board shows it. */
  headsign: string;
};

export type Favorite = FavoriteStation | FavoriteLine | FavoriteStopLine;

export type FavoritesState = {
  items: Favorite[];
  /** Whether the home widget was already put on the page for the rider once.
   *  It is offered on the first save only: a rider who later takes it off has
   *  answered, and saving another favorite must not put it back. */
  widgetOffered: boolean;
};

export const EMPTY_FAVORITES: FavoritesState = { items: [], widgetOffered: false };

/** What makes two favorites the same favorite. */
export function favoriteKey(favorite: Favorite): string {
  switch (favorite.kind) {
    case 'station':
      return `station:${favorite.stopId}`;
    case 'line':
      return `line:${favorite.lineCode}`;
    case 'stopLine':
      return `stopLine:${favorite.stopId}:${favorite.lineCode}:${favorite.lineDirection}`;
  }
}

export function isFavorite(items: readonly Favorite[], favorite: Favorite): boolean {
  const key = favoriteKey(favorite);
  return items.some((item) => favoriteKey(item) === key);
}

/** Saves a new favorite at the end (the rider's own order is kept), or
 *  removes one already saved. */
export function toggleFavorite(items: readonly Favorite[], favorite: Favorite): Favorite[] {
  const key = favoriteKey(favorite);
  return isFavorite(items, favorite)
    ? items.filter((item) => favoriteKey(item) !== key)
    : [...items, favorite];
}

/**
 * Replaces a saved favorite's snapshot with a fresher one, in place.
 *
 * Returns the SAME array when nothing changed (not saved, or saved with the
 * same snapshot), so a caller can skip the write: opening a favorite station
 * must not rewrite storage on every visit.
 */
export function refreshFavorite(items: Favorite[], fresh: Favorite): Favorite[] {
  const key = favoriteKey(fresh);
  const index = items.findIndex((item) => favoriteKey(item) === key);
  if (index < 0 || sameSnapshot(items[index]!, fresh)) return items;
  const next = [...items];
  next[index] = fresh;
  return next;
}

function sameSnapshot(a: Favorite, b: Favorite): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(
    (key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  );
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One stored entry, or `null` for anything this build cannot draw. */
function parseFavorite(raw: unknown): Favorite | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'station':
      if (!isString(r.stopId) || !isString(r.name)) return null;
      return {
        kind: 'station',
        stopId: r.stopId,
        name: r.name,
        ...(typeof r.rail === 'boolean' ? { rail: r.rail } : {}),
        ...(isString(r.stationKind) ? { stationKind: r.stationKind } : {}),
      };
    case 'line':
      if (!isString(r.lineCode) || !isNumber(r.type)) return null;
      return {
        kind: 'line',
        lineCode: r.lineCode,
        shortName: isNullableString(r.shortName) ? r.shortName : null,
        longName: isNullableString(r.longName) ? r.longName : null,
        agencyId: isNullableString(r.agencyId) ? r.agencyId : null,
        type: r.type,
      };
    case 'stopLine':
      if (!isString(r.stopId) || !isString(r.lineCode) || !isString(r.lineDirection) || !isNumber(r.type)) {
        return null;
      }
      return {
        kind: 'stopLine',
        stopId: r.stopId,
        stopName: isString(r.stopName) ? r.stopName : r.stopId,
        lineCode: r.lineCode,
        lineDirection: r.lineDirection,
        shortName: isNullableString(r.shortName) ? r.shortName : null,
        agencyId: isNullableString(r.agencyId) ? r.agencyId : null,
        type: r.type,
        headsign: isString(r.headsign) ? r.headsign : '',
      };
    default:
      return null;
  }
}

/**
 * Reads storage defensively. An entry this build cannot read (a kind from a
 * newer build, a half-written value) is skipped rather than failing the whole
 * list, and a repeated entry keeps its first place.
 *
 * Returns `null` when the stored value as a whole is unreadable, which the
 * provider must tell apart from an empty list: an empty list is safe to save
 * over, a corrupt file is not (see `favorites-context`).
 */
export function parseStoredFavorites(raw: string | null): FavoritesState | null {
  if (raw === null) return EMPTY_FAVORITES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { items?: unknown }).items)) {
    return null;
  }
  const seen = new Set<string>();
  const items: Favorite[] = [];
  for (const entry of (parsed as { items: unknown[] }).items) {
    const favorite = parseFavorite(entry);
    if (favorite === null) continue;
    const key = favoriteKey(favorite);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(favorite);
  }
  return { items, widgetOffered: (parsed as { widgetOffered?: unknown }).widgetOffered === true };
}

/** What is written to storage. Versioned so a later shape (sync, an account)
 *  can migrate it rather than guess. */
export function serializeFavorites(state: FavoritesState): string {
  return JSON.stringify({ version: 1, items: state.items, widgetOffered: state.widgetOffered });
}

/** A pinned line's departures on its stop's board, in board order: the same
 *  line going the same way, whichever route row or variant runs it. */
export function stopLineDepartures<D extends { lineCode: string; lineDirection: string }>(
  departures: readonly D[], favorite: Pick<FavoriteStopLine, 'lineCode' | 'lineDirection'>,
): D[] {
  return departures.filter((d) => d.lineCode === favorite.lineCode && d.lineDirection === favorite.lineDirection);
}

/**
 * The lines at one stop the rider marked, as station-board `lineKey`s: every
 * saved line, and every line pinned at THIS stop. Keyed the way the board's
 * line strip groups its badges, so a favorite is found whichever route row
 * the strip happened to draw it from.
 */
export function favoriteLineKeysAt(items: readonly Favorite[], stopId: string): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.kind === 'line' || (item.kind === 'stopLine' && item.stopId === stopId)) keys.add(lineKey(item));
  }
  return keys;
}

/**
 * Whether one departure on a stop's board is a favorite: its line is saved,
 * or it is pinned at this stop going this way. A pin is one direction, so at
 * a railway station the other direction's trains are not marked.
 */
export function isFavoriteDeparture(
  items: readonly Favorite[],
  stopId: string,
  departure: { lineCode: string; lineDirection: string },
): boolean {
  return items.some((item) => (item.kind === 'line'
    ? item.lineCode === departure.lineCode
    : item.kind === 'stopLine'
      && item.stopId === stopId
      && item.lineCode === departure.lineCode
      && item.lineDirection === departure.lineDirection));
}

/** Favorites first, each group keeping its own order: the strip's order
 *  otherwise, so the rest of the strip does not reshuffle. */
export function favoritesFirst<T>(list: readonly T[], isFav: (item: T) => boolean): T[] {
  return [...list.filter(isFav), ...list.filter((item) => !isFav(item))];
}
