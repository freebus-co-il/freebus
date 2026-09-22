import type { Lang } from "../db/i18n.js";
import type { GeocodePlace, Geocoder, LatLon, SearchOptions } from "./types.js";

/**
 * Photon only understands `default` (the OSM feature's own local-language
 * name -- Hebrew, for almost everything in an Israel-only index), `en`,
 * `de` and `fr`. It has no `he`/`ar`, so both map to `default` -- the
 * fullest result Photon can give for either, since neither has a dedicated
 * name field of its own.
 */
function photonLang(lang: Lang): "default" | "en" {
  return lang === "en" ? "en" : "default";
}

/**
 * `name` beats street+housenumber for the PRIMARY label -- a named building
 * or business (a mall, a residential tower) is usually why a text query
 * matched the feature at all, and burying it behind a bare address hides
 * the very thing the user searched for (found the hard way: searching
 * "מידטאון תל אביב" matched a real feature named "מידטאון TLV מגורים" on
 * "מנחם בגין 144ד", but the old street-first rule showed only the street
 * address with no visible connection to what was typed). The address then
 * becomes the SECONDARY line instead of being discarded, which is exactly
 * the two-line "name, then address" list item every mainstream map app
 * uses -- and still degrades correctly to address-only, then city-only,
 * for a plain address point with no name at all (e.g. a bare "Shomer 13").
 *
 * `city` is folded into whichever of {name, address} is NOT primary, and
 * dropped entirely if it would just repeat the primary (e.g. a city-level
 * match whose `name` already equals its `city`, "Haifa"/"Haifa").
 */
function buildPlace(properties: Record<string, unknown>): { label: string; secondaryLabel: string | null } | null {
  const str = (key: string): string | undefined => {
    const v = properties[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const street = str("street");
  const housenumber = str("housenumber");
  const name = str("name");
  const city = str("city");

  const address = street !== undefined
    ? (housenumber !== undefined ? `${street} ${housenumber}` : street)
    : undefined;

  const label = name ?? address ?? city;
  if (label === undefined) return null;

  let secondaryLabel: string | null;
  if (label === name) {
    const parts = [address, city].filter((p): p is string => p !== undefined && p !== label);
    secondaryLabel = parts.length > 0 ? parts.join(", ") : null;
  } else if (label === address) {
    secondaryLabel = city !== undefined && city !== label ? city : null;
  } else {
    secondaryLabel = null;
  }

  return { label, secondaryLabel };
}

/**
 * GeoJSON orders coordinates [lon, lat] -- the reverse of every other pair
 * in this codebase. Getting this backwards silently produces a point
 * roughly correct in magnitude but on the wrong side of the Mediterranean,
 * which no simple range check catches after the fact -- hence checking
 * `Number.isFinite` on each explicitly, the same defensive style
 * `walking/valhalla.ts`'s `parseRouteResponse` uses.
 */
function parseFeature(feature: unknown): GeocodePlace | null {
  if (typeof feature !== "object" || feature === null) return null;
  const geometry = (feature as Record<string, unknown>)["geometry"];
  const properties = (feature as Record<string, unknown>)["properties"];
  if (typeof geometry !== "object" || geometry === null) return null;
  if (typeof properties !== "object" || properties === null) return null;
  const coordinates = (geometry as Record<string, unknown>)["coordinates"];
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lon, lat] = coordinates as unknown[];
  if (typeof lon !== "number" || !Number.isFinite(lon)) return null;
  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  const place = buildPlace(properties as Record<string, unknown>);
  if (place === null) return null;
  return { ...place, lat, lon, placeId: null, distanceMeters: null };
}

function parseFeatureCollection(json: unknown): GeocodePlace[] {
  if (typeof json !== "object" || json === null) return [];
  const features = (json as Record<string, unknown>)["features"];
  if (!Array.isArray(features)) return [];
  const out: GeocodePlace[] = [];
  for (const feature of features) {
    const parsed = parseFeature(feature);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export class PhotonClient implements Geocoder {
  constructor(private readonly opts: { url: string; timeoutMs: number }) {}

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const search = new URLSearchParams(params);
    const res = await fetch(`${this.opts.url}${path}?${search.toString()}`, {
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`Photon ${path} returned ${res.status}`);
    return await res.json();
  }

  /**
   * Never throws: a slow or dead Photon container should degrade address
   * search to "no address results" (stop search still works standalone),
   * never fail the whole request -- mirrors `ValhallaClient.route`'s
   * degrade-don't-throw contract in `walking/valhalla.ts`.
   */
  async search(q: string, lang: Lang, limit: number, opts: SearchOptions = {}): Promise<GeocodePlace[]> {
    const params: Record<string, string> = { q, lang: photonLang(lang), limit: String(limit) };
    if (opts.near !== undefined) {
      params["lat"] = String(opts.near.lat);
      params["lon"] = String(opts.near.lon);
    }
    try {
      const json = await this.get("/api", params);
      return parseFeatureCollection(json);
    } catch {
      return [];
    }
  }

  /** Photon results always carry their position, so no client ever has a
   *  `placeId` to resolve here -- except one holding a Google result from
   *  just before `GEOCODER` was flipped back, which cannot be resolved. */
  async place(): Promise<LatLon | null> {
    return null;
  }

  async reverse(lat: number, lon: number, lang: Lang): Promise<GeocodePlace | null> {
    try {
      const json = await this.get("/reverse", {
        lat: String(lat), lon: String(lon), lang: photonLang(lang),
      });
      const places = parseFeatureCollection(json);
      return places[0] ?? null;
    } catch {
      return null;
    }
  }
}
