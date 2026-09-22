import type { Lang } from "../db/i18n.js";
import type { GeocodePlace, Geocoder, LatLon, SearchOptions } from "./types.js";

/**
 * Google Places API (New) autocomplete + Place Details, and the Geocoding API
 * for reverse lookups. Metered per request, so every choice below is about
 * what a search costs (prices as of 2026-09, per 1,000, after 10,000 free
 * events a month per SKU):
 *
 *   - Autocomplete Requests      $2.83
 *   - Place Details Essentials   $5.00
 *   - Geocoding                  $5.00
 *
 * 1. SESSIONS. Every autocomplete call and the Place Details call that
 *    resolves the pick carry the same `sessionToken`. A session that ends in
 *    Place Details Essentials bills at most its first 12 autocomplete calls;
 *    without a token every call bills forever. A session the rider abandons
 *    (they picked a STOP instead, or backed out) still bills per call -- the
 *    client's debounce and minimum query length are what bound that.
 *
 * 2. POSITIONS ONLY FOR THE PICK. Autocomplete returns no coordinates, and
 *    this does not go fetch them for every suggestion: that would be up to
 *    five Place Details calls per keystroke. `search` returns `placeId`s, and
 *    `place` resolves the ONE the rider taps.
 *
 * 3. FIELD MASK `location` ONLY on Place Details. It keeps the call in the
 *    Essentials SKU; asking for `displayName` alone would bump it to Pro
 *    ($17). The label already came from autocomplete, so nothing is lost.
 *
 * 4. A DAILY CEILING (`GOOGLE_MAPS_DAILY_REQUEST_LIMIT`). The API is public
 *    and CORS-open, so a script could run up the bill. Past the ceiling every
 *    call degrades to "no results" for the rest of the UTC day. It is a
 *    per-process backstop, not a substitute for a quota on the key itself.
 *
 * The key never leaves this server -- the client only ever talks to
 * `/geocode/*`, so it can be restricted to this box's IP.
 */

const ISRAEL_BOUNDS = {
  low: { latitude: 29.4, longitude: 34.2 },
  high: { latitude: 33.4, longitude: 35.9 },
};

/** Google's maximum for a bias circle. A bias, not a restriction: a rider in
 *  Haifa searching a Tel Aviv address still finds it, just ranked below the
 *  nearby matches. */
const BIAS_RADIUS_METERS = 50_000;

const AUTOCOMPLETE_FIELD_MASK = [
  "suggestions.placePrediction.placeId",
  "suggestions.placePrediction.structuredFormat",
  "suggestions.placePrediction.distanceMeters",
].join(",");

/** The country is the last part of nearly every secondary line, and with
 *  results restricted to il/ps it says nothing. */
const COUNTRY_SUFFIXES = new Set(["Israel", "ישראל", "إسرائيل"]);

/** How often a failing Google call is logged. A bad key fails every
 *  keystroke of every rider; one line a minute is plenty to notice it. */
const WARN_INTERVAL_MS = 60_000;

/**
 * Counts billable calls per UTC day and refuses past `limit`. `0` disables
 * the ceiling.
 */
export class DailyBudget {
  private day = "";
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly onExhausted: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  take(): boolean {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.limit > 0 && this.used >= this.limit) return false;
    this.used++;
    if (this.limit > 0 && this.used === this.limit) this.onExhausted();
    return true;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function stripCountry(text: string | undefined): string | null {
  if (text === undefined) return null;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length > 0 && COUNTRY_SUFFIXES.has(parts[parts.length - 1]!)) parts.pop();
  const joined = parts.join(", ");
  return joined === "" ? null : joined;
}

function parseSuggestion(suggestion: unknown): GeocodePlace | null {
  const prediction = obj(obj(suggestion)?.["placePrediction"]);
  if (prediction === undefined) return null;
  const placeId = str(prediction["placeId"]);
  const structured = obj(prediction["structuredFormat"]);
  const label = str(obj(structured?.["mainText"])?.["text"]);
  if (placeId === undefined || label === undefined) return null;
  const secondary = stripCountry(str(obj(structured?.["secondaryText"])?.["text"]));
  const distance = prediction["distanceMeters"];
  return {
    label,
    secondaryLabel: secondary === label ? null : secondary,
    lat: null,
    lon: null,
    placeId,
    distanceMeters: typeof distance === "number" && Number.isFinite(distance) ? distance : null,
  };
}

function component(components: unknown[], type: string): string | undefined {
  for (const c of components) {
    const types = obj(c)?.["types"];
    if (Array.isArray(types) && types.includes(type)) return str(obj(c)?.["long_name"]);
  }
  return undefined;
}

/** Street + number when the result has them, else the first part of the
 *  formatted address (a named place, a road); the city as the subtitle. */
function parseGeocodingResult(result: unknown, fallback: LatLon): GeocodePlace | null {
  const r = obj(result);
  if (r === undefined) return null;
  const components = Array.isArray(r["address_components"]) ? r["address_components"] : [];
  const route = component(components, "route");
  const number = component(components, "street_number");
  const city = component(components, "locality");
  const street = route !== undefined ? (number !== undefined ? `${route} ${number}` : route) : undefined;
  const label = street ?? str(r["formatted_address"])?.split(",")[0]?.trim() ?? city;
  if (label === undefined || label === "") return null;
  const location = obj(obj(r["geometry"])?.["location"]);
  const lat = location?.["lat"];
  const lon = location?.["lng"];
  const hasPosition = typeof lat === "number" && Number.isFinite(lat)
    && typeof lon === "number" && Number.isFinite(lon);
  return {
    label,
    secondaryLabel: city !== undefined && city !== label ? city : null,
    lat: hasPosition ? lat : fallback.lat,
    lon: hasPosition ? lon : fallback.lon,
    placeId: null,
    distanceMeters: null,
  };
}

export interface GoogleGeocoderOptions {
  apiKey: string;
  timeoutMs: number;
  dailyRequestLimit: number;
  warn: (message: string) => void;
  /** Overridable so tests can point at a local stub. */
  placesBaseUrl?: string;
  geocodingBaseUrl?: string;
}

export class GoogleGeocoder implements Geocoder {
  private readonly budget: DailyBudget;
  private readonly placesBaseUrl: string;
  private readonly geocodingBaseUrl: string;
  private lastWarnAt = -Infinity;

  constructor(private readonly opts: GoogleGeocoderOptions) {
    this.placesBaseUrl = opts.placesBaseUrl ?? "https://places.googleapis.com";
    this.geocodingBaseUrl = opts.geocodingBaseUrl ?? "https://maps.googleapis.com";
    this.budget = new DailyBudget(opts.dailyRequestLimit, () => opts.warn(
      `Google Maps daily request limit (${opts.dailyRequestLimit}) reached -- ` +
      "address search returns nothing until 00:00 UTC.",
    ));
  }

  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.opts.warn(message);
  }

  private async fetchJson(url: string, init: RequestInit, what: string): Promise<unknown> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    if (!res.ok) {
      // Google's error body names the actual problem ("API key not valid",
      // "Places API (New) has not been used in project ...") -- worth the log.
      const body = await res.text().catch(() => "");
      throw new Error(`Google ${what} returned ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  }

  async search(q: string, lang: Lang, limit: number, opts: SearchOptions = {}): Promise<GeocodePlace[]> {
    if (!this.budget.take()) return [];
    const body: Record<string, unknown> = {
      input: q,
      languageCode: lang,
      regionCode: "il",
      includedRegionCodes: ["il", "ps"],
    };
    if (opts.session !== undefined) body["sessionToken"] = opts.session;
    if (opts.near !== undefined) {
      const center = { latitude: opts.near.lat, longitude: opts.near.lon };
      body["locationBias"] = { circle: { center, radius: BIAS_RADIUS_METERS } };
      body["origin"] = center;
    } else {
      body["locationBias"] = { rectangle: ISRAEL_BOUNDS };
    }
    try {
      const json = await this.fetchJson(`${this.placesBaseUrl}/v1/places:autocomplete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.opts.apiKey,
          "x-goog-fieldmask": AUTOCOMPLETE_FIELD_MASK,
        },
        body: JSON.stringify(body),
      }, "autocomplete");
      const suggestions = obj(json)?.["suggestions"];
      if (!Array.isArray(suggestions)) return [];
      const out: GeocodePlace[] = [];
      for (const s of suggestions) {
        const place = parseSuggestion(s);
        if (place !== null) out.push(place);
      }
      return out.slice(0, limit);
    } catch (err) {
      this.warnThrottled((err as Error).message);
      return [];
    }
  }

  async place(placeId: string, session?: string): Promise<LatLon | null> {
    if (!this.budget.take()) return null;
    const params = session !== undefined ? `?${new URLSearchParams({ sessionToken: session })}` : "";
    try {
      const json = await this.fetchJson(
        `${this.placesBaseUrl}/v1/places/${encodeURIComponent(placeId)}${params}`,
        { headers: { "x-goog-api-key": this.opts.apiKey, "x-goog-fieldmask": "location" } },
        "place details",
      );
      const location = obj(obj(json)?.["location"]);
      const lat = location?.["latitude"];
      const lon = location?.["longitude"];
      if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
      if (typeof lon !== "number" || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch (err) {
      this.warnThrottled((err as Error).message);
      return null;
    }
  }

  async reverse(lat: number, lon: number, lang: Lang): Promise<GeocodePlace | null> {
    if (!this.budget.take()) return null;
    const params = new URLSearchParams({ latlng: `${lat},${lon}`, language: lang, key: this.opts.apiKey });
    try {
      const json = await this.fetchJson(
        `${this.geocodingBaseUrl}/maps/api/geocode/json?${params}`, {}, "reverse geocode",
      );
      const status = str(obj(json)?.["status"]);
      if (status === "ZERO_RESULTS") return null;
      if (status !== "OK") {
        // The Geocoding API reports auth and quota failures as HTTP 200 with
        // a status string, not as an HTTP error.
        const message = str(obj(json)?.["error_message"]) ?? "";
        throw new Error(`Google reverse geocode status ${status}: ${message}`);
      }
      const results = obj(json)?.["results"];
      if (!Array.isArray(results)) return null;
      for (const result of results) {
        const types = obj(result)?.["types"];
        if (Array.isArray(types) && types.includes("plus_code")) continue;
        const place = parseGeocodingResult(result, { lat, lon });
        if (place !== null) return place;
      }
      return null;
    } catch (err) {
      this.warnThrottled((err as Error).message);
      return null;
    }
  }
}
