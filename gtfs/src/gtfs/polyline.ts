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

export function polylineLengthMeters(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1]!, points[i]!);
  }
  return total;
}
