import { useQuery } from '@tanstack/react-query';

import { apiGet } from './client';
import type { GeocodeLocationResponse, GeocodePlace, GeocodeReverseResponse, GeocodeSearchResponse } from './types';

/**
 * Shortest query worth sending to address search. Higher than stop search's
 * 2: address search may be Google-backed and billed per call, and two letters
 * ("תל", "רח") match nearly everything in the country anyway.
 */
export const ADDRESS_MIN_QUERY_LENGTH = 3;

/**
 * A billing session for Google-backed address search: every search while
 * the rider types, plus the one `resolvePlace` for what they pick, carry the
 * same token, which caps what that whole search costs. Start a new one after
 * each pick. Ignored by a Photon-backed server.
 *
 * Needs to be unique, not unguessable -- `Math.random` is fine. 32 base-36
 * characters fits Google's 36-character URL-safe limit.
 */
export function newGeocodeSession(): string {
  let token = '';
  while (token.length < 32) token += Math.random().toString(36).slice(2);
  return token.slice(0, 32);
}

/** The endpoint itself, for the one caller that is not a screen: a caught
 *  share resolves its address once, on arrival, with no component to hang a
 *  query on. Kept beside the hook so both spend the same parameters. */
export async function searchAddresses(q: string, lang: string, session?: string): Promise<GeocodePlace[]> {
  const res = await apiGet<GeocodeSearchResponse>('/geocode/search', { q: q.trim(), lang, limit: 8, session });
  return res.places;
}

export function useAddressSearch(
  q: string,
  lang: string,
  opts: { session: string; near: { lat: number; lon: number } | null },
) {
  const trimmed = q.trim();
  return useQuery({
    // `session` and `near` are deliberately NOT in the key. A new session
    // after a pick, or the GPS fix drifting a few metres, must not re-send a
    // query whose answer is already in hand -- each re-send can be billed.
    queryKey: ['addressSearch', trimmed, lang],
    queryFn: () => apiGet<GeocodeSearchResponse>('/geocode/search', {
      q: trimmed, lang, limit: 8, session: opts.session, lat: opts.near?.lat, lon: opts.near?.lon,
    }),
    enabled: trimmed.length >= ADDRESS_MIN_QUERY_LENGTH,
    // Long, so backspacing and retyping the same text is free.
    staleTime: 5 * 60_000,
  });
}

/** The position of a search result that came back with only a `placeId`.
 *  Pass the session its searches used -- that is what closes it. */
export async function resolvePlace(placeId: string, session: string): Promise<{ lat: number; lon: number } | null> {
  const res = await apiGet<GeocodeLocationResponse>('/geocode/place', { id: placeId, session });
  return res.location;
}

/**
 * A plain one-shot call, not a `useQuery` hook -- this only ever runs once,
 * on demand, when the user explicitly picks "current location" while saving
 * a location (see `location-picker.tsx`). Turns a coordinate into a real
 * address so that pick gets a real name instead of the literal string
 * "Current location" frozen in as a saved location's permanent label.
 */
export async function reverseGeocode(lat: number, lon: number, lang: string): Promise<GeocodePlace | null> {
  const res = await apiGet<GeocodeReverseResponse>('/geocode/reverse', { lat, lon, lang });
  return res.place;
}

/**
 * How finely a reverse lookup is cached, in decimal places. Five is about a
 * metre -- fine enough that the label always belongs to the spot under the
 * pin, coarse enough that a map settling back onto almost the same point is
 * answered from cache instead of asked again.
 */
const REVERSE_KEY_DECIMALS = 5;

/**
 * The reverse lookup as query options, so a screen can both WATCH it (through
 * the hook below) and AWAIT it (through `queryClient.fetchQuery`) without the
 * two disagreeing about the key -- which is what makes the map picker's
 * Choose button instant: by the time it is tapped, the answer it needs is
 * already in the cache under this key.
 *
 * `staleTime: Infinity` because the address of a fixed coordinate does not
 * change. Nothing here is metered: reverse always goes to the self-hosted
 * Photon, whatever the address-search backend is.
 */
export function reverseGeocodeQuery(at: { lat: number; lon: number }, lang: string) {
  return {
    queryKey: [
      'reverseGeocode',
      at.lat.toFixed(REVERSE_KEY_DECIMALS),
      at.lon.toFixed(REVERSE_KEY_DECIMALS),
      lang,
    ],
    queryFn: () => reverseGeocode(at.lat, at.lon, lang),
    staleTime: Infinity,
  } as const;
}

/** What is at this position, kept up to date as the position moves. */
export function useReverseGeocode(at: { lat: number; lon: number }, lang: string, enabled = true) {
  return useQuery({ ...reverseGeocodeQuery(at, lang), enabled });
}
