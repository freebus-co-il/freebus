import type { Lang } from "../db/i18n.js";
import type { GeocodePlace, Geocoder, LatLon, SearchOptions } from "./types.js";

/**
 * One geocoder built from two, split by OPERATION rather than by deployment.
 *
 * The reason it exists: address SEARCH and coordinate-to-label REVERSE are not
 * the same problem, and they do not deserve the same backend. Search is where
 * OSM actually falls short -- it misses most businesses, which is why
 * `GEOCODER=google` exists at all (see `google.ts`). Reverse only has to name
 * the place a rider is standing, where "Dizengoff Street 50" instead of
 * "Dizengoff Center" is a fair trade for costing nothing. Google's Geocoding
 * API bills $5 per 1,000 for that naming.
 *
 * So under `GEOCODER=google` this sends `search` and `place` to Google and
 * `reverse` to Photon, and the metered backend is never reached by a lookup
 * that only needed a street name.
 *
 * `place` follows `search`, deliberately and non-obviously: a `placeId` means
 * something only to the backend that issued it (see `GeocodePlace`), so
 * resolving a Google id against Photon would be a lookup against an index that
 * has never seen one.
 *
 * There is NO fallback between the two. If Photon is down, `reverse` returns
 * null and the rider sees no label -- which is what `Geocoder` already
 * promises ("never throws") and what `location-picker.tsx` and `share.tsx`
 * already handle. Falling through to Google would quietly reintroduce the
 * per-request charge this class exists to remove, and an outage that bills is
 * worse than one that shows less.
 *
 * Unused under `GEOCODER=photon`: one backend answering everything needs no
 * wrapper, and `buildGeocoder` returns the `PhotonClient` directly.
 */
export class CompositeGeocoder implements Geocoder {
  constructor(
    /** Answers `search` and `place`. */
    private readonly forSearch: Geocoder,
    /** Answers `reverse`. */
    private readonly forReverse: Geocoder,
  ) {}

  search(q: string, lang: Lang, limit: number, opts?: SearchOptions): Promise<GeocodePlace[]> {
    return this.forSearch.search(q, lang, limit, opts);
  }

  place(placeId: string, session?: string): Promise<LatLon | null> {
    return this.forSearch.place(placeId, session);
  }

  reverse(lat: number, lon: number, lang: Lang): Promise<GeocodePlace | null> {
    return this.forReverse.reverse(lat, lon, lang);
  }
}
