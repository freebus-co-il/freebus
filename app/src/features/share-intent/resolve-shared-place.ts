import type { GeocodePlace } from '@/api/types';
import { namedCoordinate } from '@/lib/name-place';
import type { SelectedPlace } from '@/lib/place';

import { parseSharedText, type SharedTarget } from './parse-shared-place';

/** Everything this needs from the network, injected rather than imported so
 *  the whole pipeline is exercised by tests that never make a request. */
export type ShareLookups = {
  /** Follows a shortened map link to the position it expands to. */
  resolveLink: (url: string) => Promise<Extract<SharedTarget, { kind: 'coordinate' }> | null>;
  /** Turns shared prose into candidate addresses. */
  searchAddresses: (query: string) => Promise<GeocodePlace[]>;
  /** Positions a candidate that came back with only a `placeId`. */
  resolvePlace: (placeId: string) => Promise<{ lat: number; lon: number } | null>;
  /** Names a bare position, so a dropped pin reads as an address. */
  reverseLookup: (lat: number, lon: number) => Promise<string | null>;
};

export type ResolvedShare =
  /** Plan a trip here, now. */
  | { kind: 'place'; place: SelectedPlace }
  /** Several places could have been meant -- ask, with the text pre-filled. */
  | { kind: 'ambiguous'; query: string }
  /** Nothing in the payload points anywhere. */
  | { kind: 'unreadable' };

/**
 * Everything between "a share arrived" and "we know where the rider is going".
 *
 * The three outcomes exist because the three failures are different: a
 * position we could not name is still a trip, a name we could not narrow down
 * is a question, and a link with no place in it is neither. Only the last one
 * dead-ends, and it is the only one the rider must be told about.
 *
 * `fallbackLabel` is passed in already translated -- this module has no
 * opinion about language, and its tests stay free of the i18n setup.
 */
export async function resolveSharedPlace(
  text: string,
  lookups: ShareLookups,
  fallbackLabel: string,
): Promise<ResolvedShare> {
  const target = parseSharedText(text);
  if (!target) return { kind: 'unreadable' };

  if (target.kind === 'shortLink') {
    const followed = await lookups.resolveLink(target.url);
    if (!followed) return { kind: 'unreadable' };
    return { kind: 'place', place: await toPlace(followed, lookups, fallbackLabel) };
  }

  if (target.kind === 'coordinate') {
    return { kind: 'place', place: await toPlace(target, lookups, fallbackLabel) };
  }

  const matches = await lookups.searchAddresses(target.text).catch(() => null);
  // A lookup that failed and a lookup that found nothing are the same offer to
  // the rider: here is what you shared, in a field you can edit.
  if (!matches || matches.length !== 1) return { kind: 'ambiguous', query: target.text };

  const [only] = matches;
  const position =
    only.lat !== null && only.lon !== null
      ? { lat: only.lat, lon: only.lon }
      : only.placeId !== null
        ? await lookups.resolvePlace(only.placeId).catch(() => null)
        : null;
  // Found but not positioned is a failed lookup too: same offer as above.
  if (!position) return { kind: 'ambiguous', query: target.text };
  return { kind: 'place', place: { kind: 'coordinate', lat: position.lat, lon: position.lon, label: only.label } };
}

/** A position, named as well as it can be -- unless the share already named
 *  it, in which case the sender's own words beat anything a lookup would say
 *  about the street it stands on. */
async function toPlace(
  coordinate: Extract<SharedTarget, { kind: 'coordinate' }>,
  lookups: ShareLookups,
  fallbackLabel: string,
): Promise<SelectedPlace> {
  if (coordinate.label) {
    return { kind: 'coordinate', lat: coordinate.lat, lon: coordinate.lon, label: coordinate.label };
  }
  return namedCoordinate(coordinate, lookups.reverseLookup, fallbackLabel);
}
