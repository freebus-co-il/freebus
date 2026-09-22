import type { Lang } from "../db/i18n.js";

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * One address-search result, whichever backend produced it.
 *
 * Exactly one of {`lat`/`lon`, `placeId`} is set. Photon hands back a
 * position with every result. Google's autocomplete deliberately does not --
 * a position costs a Place Details call, and paying for one per keystroke per
 * suggestion is the single most expensive way to use that API -- so a Google
 * result carries a `placeId` instead, and the client resolves ONLY the one the
 * rider picks, through `GET /geocode/place`. Keeping both shapes in one
 * contract is what lets `GEOCODER` flip without a client release.
 */
export interface GeocodePlace {
  /** Primary display text -- always a single non-empty string. */
  label: string;
  /** Supporting context for a two-line UI -- null when there's nothing to
   *  add beyond `label`. */
  secondaryLabel: string | null;
  lat: number | null;
  lon: number | null;
  placeId: string | null;
  /** Straight-line distance from the search's `near` point, when the backend
   *  reports one and the position itself is not in hand (Google). Lets the
   *  client keep sorting merged results by distance without coordinates. */
  distanceMeters: number | null;
}

export interface SearchOptions {
  /**
   * Google billing session token, echoed from the client. Every autocomplete
   * call and the one Place Details call that follows a pick share it, which
   * caps what a search session costs -- see `google.ts`. Ignored by Photon.
   */
  session?: string;
  /** Rank results near here. */
  near?: LatLon;
}

export interface Geocoder {
  /** Never throws -- an outage degrades to no address results. */
  search(q: string, lang: Lang, limit: number, opts?: SearchOptions): Promise<GeocodePlace[]>;
  /** Resolves a `placeId` from `search` to a position. Never throws. */
  place(placeId: string, session?: string): Promise<LatLon | null>;
  /** Never throws. */
  reverse(lat: number, lon: number, lang: Lang): Promise<GeocodePlace | null>;
}
