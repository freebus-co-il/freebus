// encodePolyline / decodePolyline / haversineMeters are copied verbatim from
// gtfs/src/gtfs/polyline.ts. The two packages share no module
// mechanism and introducing workspaces to share ~85 lines of pure arithmetic
// would mean restructuring a working service. If either copy changes, change
// both.

export type LatLon = readonly [lat: number, lon: number];

const DEFAULT_PRECISION = 6;

function encodeSigned(value: number, out: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1;
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>>= 5;
  }
  out.push(String.fromCharCode(v + 63));
}

export function encodePolyline(
  points: readonly LatLon[],
  precision: number = DEFAULT_PRECISION,
): string {
  const factor = 10 ** precision;
  const out: string[] = [];
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of points) {
    const qLat = Math.round(lat * factor);
    const qLon = Math.round(lon * factor);
    encodeSigned(qLat - prevLat, out);
    encodeSigned(qLon - prevLon, out);
    prevLat = qLat;
    prevLon = qLon;
  }
  return out.join("");
}

export function decodePolyline(
  encoded: string,
  precision: number = DEFAULT_PRECISION,
): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;

  while (i < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >>> 1) : result >>> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >>> 1) : result >>> 1;

    points.push([lat / factor, lon / factor]);
  }
  return points;
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const METERS_PER_DEG_LAT = 111_320;

/**
 * A latitude/longitude box guaranteed to contain every point within `meters`
 * of the centre. Used to pre-filter the R*Tree before an exact haversine pass.
 *
 * The box is a superset of the true circle, never a subset — the longitude
 * span is widened by the cosine of the latitude, and at the poles (where
 * cos -> 0) it clamps to the whole longitude range rather than dividing by
 * something arbitrarily close to zero.
 */
export function bboxAround(lat: number, lon: number, meters: number): {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
} {
  const dLat = meters / METERS_PER_DEG_LAT;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLon = Math.abs(cos) < 1e-9 ? 180 : meters / (METERS_PER_DEG_LAT * Math.abs(cos));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: Math.max(-180, lon - dLon),
    maxLon: Math.min(180, lon + dLon),
  };
}
