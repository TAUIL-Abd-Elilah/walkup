/** Geohash and distance helpers (no dependencies). */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(lat: number, lon: number, precision: number): string {
  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let out = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) {
        ch = (ch << 1) | 1;
        lonLo = mid;
      } else {
        ch <<= 1;
        lonHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch <<= 1;
        latHi = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      out += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

export interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

export function geohashBounds(gh: string): Bounds {
  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let even = true;
  for (const c of gh) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new RangeError(`bad geohash ${gh}`);
    for (let b = 4; b >= 0; b--) {
      const on = ((v >> b) & 1) === 1;
      if (even) {
        const mid = (lonLo + lonHi) / 2;
        if (on) lonLo = mid;
        else lonHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (on) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }
  return { south: latLo, north: latHi, west: lonLo, east: lonHi };
}

export function geohashCenter(gh: string): { lat: number; lon: number } {
  const b = geohashBounds(gh);
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

export function isGeohash(s: string): boolean {
  return /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(s);
}

/** Cell size in degrees for a precision (lat, lon). */
export function cellSize(precision: number): { dLat: number; dLon: number } {
  const bits = precision * 5;
  const lonBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { dLat: 180 / 2 ** latBits, dLon: 360 / 2 ** lonBits };
}

const R_KM = 6371.0088;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Every geohash cell of `precision` whose centre is within radiusKm of the point. */
export function cellsWithin(center: { lat: number; lon: number }, radiusKm: number, precision: number): string[] {
  const { dLat, dLon } = cellSize(precision);
  const latSpan = radiusKm / 111.32;
  const lonSpan = radiusKm / (111.32 * Math.max(0.05, Math.cos((center.lat * Math.PI) / 180)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let lat = center.lat - latSpan - dLat; lat <= center.lat + latSpan + dLat; lat += dLat) {
    for (let lon = center.lon - lonSpan - dLon; lon <= center.lon + lonSpan + dLon; lon += dLon) {
      const gh = encodeGeohash(lat, lon, precision);
      if (seen.has(gh)) continue;
      seen.add(gh);
      const c = geohashCenter(gh);
      if (haversineKm(center, c) <= radiusKm) out.push(gh);
    }
  }
  return out.sort();
}

/** Parses "POINT(lon lat)" (WKT, lon first). Null when malformed. */
export function parseWktPoint(s: string | undefined | null): { lat: number; lon: number } | null {
  if (!s) return null;
  const m = /^\s*POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)\s*$/i.exec(s);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Parses "lat,lon" (the /search form). */
export function parseLatLon(s: string | undefined | null): { lat: number; lon: number } | null {
  if (!s) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return parseWktPoint(s);
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}
