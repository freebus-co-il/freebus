/**
 * What a rider actually shared into FreeBus, before anything has been looked
 * up. Parsing is deliberately separate from resolving: this step is pure
 * string work with no network and no clock, so every format below is covered
 * by a test that runs in milliseconds.
 */
export type SharedTarget =
  /** Coordinates were in the payload itself -- nothing else needs to happen. */
  | { kind: 'coordinate'; lat: number; lon: number; label: string | null }
  /** A shortened map link, which carries no position until it is followed. */
  | { kind: 'shortLink'; url: string }
  /** Text with no position in it, to be handed to `/geocode/search`. */
  | { kind: 'query'; text: string };

/**
 * Coordinates carried in a URL query parameter, in the order they are trusted.
 *
 * Order matters where a link carries more than one: `daddr`/`destination` is
 * where the sharer was going, while `center` is merely what their map happened
 * to be showing, so the destination wins.
 */
const COORDINATE_PARAMS = ['daddr', 'destination', 'q', 'll', 'latlng', 'coordinate', 'center', 'viewpoint'];

/**
 * Shorteners that are followed over the network to find out where they point.
 *
 * An allowlist rather than "anything short": expanding a link means fetching a
 * URL that someone else chose, and the app has no reason to do that for
 * anything but a map link it can actually use.
 */
const MAP_SHORTENERS: { host: string; pathPrefix?: string }[] = [
  { host: 'maps.app.goo.gl' },
  { host: 'goo.gl', pathPrefix: '/maps' },
];

/** Latitude and longitude, and nothing else. */
const COORDINATE_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Google Maps puts a dropped pin in the path as `@lat,lon,17z` -- the zoom
 *  suffix must not be mistaken for a third component of the pair. */
const AT_PATH_PAIR = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

/**
 * The pin's own coordinates inside an expanded Google Maps link's `data=`
 * blob. Preferred over the `@lat,lon` in the path, which is only where the
 * map was centred -- the two differ by enough to land the rider across the
 * street from where the sharer actually pointed.
 */
const DATA_PIN = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;

/** The named place in a `/maps/place/Levinsky+Market/@...` link. */
const PLACE_IN_PATH = /\/maps\/place\/([^/@?#]+)/;

/** A share is usually a sentence with a link in it, not a bare link. Stops at
 *  whitespace; trailing sentence punctuation is trimmed off separately. */
const URL_IN_TEXT = /(?:https?:\/\/|geo:)\S+/i;

/** `q=32.08,34.78(Levinsky Market)` -- the geo: URI form, where the name rides
 *  in parentheses directly behind the pair. */
const PAIR_WITH_NAME = /^([^(]*)\(([^)]*)\)\s*$/;

type Coordinate = { lat: number; lon: number };

function parseCoordinatePair(value: string): Coordinate | null {
  const match = COORDINATE_PAIR.exec(value);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  // A street address is also two numbers with a comma between them. Range is
  // the only thing that separates "Herzl 100, 91" from a place on Earth.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** A parameter value that may be a bare pair or a pair with a name behind it. */
function parseCoordinateValue(value: string): { coordinate: Coordinate; label: string | null } | null {
  const named = PAIR_WITH_NAME.exec(value);
  const coordinate = parseCoordinatePair(named ? named[1] : value);
  if (!coordinate) return null;
  const label = named ? decodePlus(named[2]).trim() : '';
  return { coordinate, label: label.length > 0 ? label : null };
}

/** Percent-decoding that tolerates malformed input, since the text came from
 *  another app and a stray `%` must not throw the whole share away. */
function decodePlus(value: string): string {
  const spaced = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * Drops the sentence punctuation a link picked up from the text around it.
 *
 * A closing bracket only goes if nothing in the URL opened it: `geo:` URIs
 * carry the place name as `q=32.08,34.78(Levinsky Market)`, and trimming that
 * `)` unconditionally turns a named position into unparseable text.
 */
function trimTrailingPunctuation(url: string): string {
  let trimmed = url.replace(/[.,;:!?\]]+$/, '');
  while (trimmed.endsWith(')') && countOf(trimmed, ')') > countOf(trimmed, '(')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function countOf(value: string, character: string): number {
  let count = 0;
  for (const char of value) if (char === character) count += 1;
  return count;
}

function urlHost(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  return withoutScheme.split(/[/?#]/)[0].split('@').pop()?.split(':')[0].toLowerCase() ?? '';
}

function urlPath(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return '/';
  return withoutScheme.slice(slash).split(/[?#]/)[0];
}

/**
 * The query string's parameters, without `new URL`.
 *
 * React Native's `URL` is a thin stand-in for the real thing and does not
 * expose `searchParams` the way a browser does, so the split is done by hand
 * and only `URLSearchParams` -- which the app already relies on in
 * `api/client.ts` -- is used to decode.
 */
function queryParams(url: string): URLSearchParams {
  const withoutHash = url.split('#')[0];
  const start = withoutHash.indexOf('?');
  return new URLSearchParams(start === -1 ? '' : withoutHash.slice(start + 1));
}

/** A human-readable name for the position, from wherever the link keeps one.
 *  `q` doubles as both: coordinates on a bare map link, a place name when
 *  `ll` already holds the position. */
function labelFrom(url: string, params: URLSearchParams): string | null {
  const q = params.get('q');
  if (q && !parseCoordinateValue(q) && q.trim().length > 0) return q.trim();

  const place = PLACE_IN_PATH.exec(urlPath(url));
  if (place) {
    const name = decodePlus(place[1]).trim();
    if (name.length > 0) return name;
  }

  return null;
}

/** Whether following this link over the network is allowed at all. Exported
 *  for the resolver, which refuses to fetch anything else. */
export function isMapShortenerUrl(url: string): boolean {
  const host = urlHost(url);
  const path = urlPath(url);
  return MAP_SHORTENERS.some(
    (shortener) => shortener.host === host && (!shortener.pathPrefix || path.startsWith(shortener.pathPrefix)),
  );
}

function parseUrl(url: string): SharedTarget | null {
  if (isMapShortenerUrl(url)) return { kind: 'shortLink', url };

  const params = queryParams(url);

  for (const name of COORDINATE_PARAMS) {
    const value = params.get(name);
    if (!value) continue;
    const parsed = parseCoordinateValue(value);
    if (parsed) {
      return { kind: 'coordinate', ...parsed.coordinate, label: parsed.label ?? labelFrom(url, params) };
    }
  }

  const beforeQuery = url.split('?')[0];

  const pin = DATA_PIN.exec(beforeQuery);
  if (pin) {
    const coordinate = parseCoordinatePair(`${pin[1]},${pin[2]}`);
    if (coordinate) return { kind: 'coordinate', ...coordinate, label: labelFrom(url, params) };
  }

  const atPath = AT_PATH_PAIR.exec(beforeQuery);
  if (atPath) {
    const coordinate = parseCoordinatePair(`${atPath[1]},${atPath[2]}`);
    if (coordinate) return { kind: 'coordinate', ...coordinate, label: labelFrom(url, params) };
  }

  // `geo:32.08,34.78` -- the pair sits where a host would, before any query.
  // Reached only after the query above, because `geo:0,0?q=<real position>`
  // is the standard placeholder form and its leading pair must not win.
  if (/^geo:/i.test(url)) {
    const coordinate = parseCoordinatePair(url.slice('geo:'.length).split('?')[0]);
    if (coordinate) return { kind: 'coordinate', ...coordinate, label: labelFrom(url, params) };
  }

  return null;
}

/**
 * Turns whatever arrived from the share sheet into something the app can act
 * on. Returns `null` only when the payload holds nothing usable at all -- an
 * empty share, or a link with no position and no name in it.
 */
export function parseSharedText(text: string): SharedTarget | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const bare = parseCoordinatePair(trimmed);
  if (bare) return { kind: 'coordinate', ...bare, label: null };

  const urlMatch = URL_IN_TEXT.exec(trimmed);
  if (urlMatch) {
    // A link is the whole meaning of the share -- if it turns out to hold no
    // position, the prose around it ("see you here!") is not a place name and
    // must not be geocoded as one.
    return parseUrl(trimTrailingPunctuation(urlMatch[0]));
  }

  return { kind: 'query', text: trimmed };
}
