/**
 * Tiny geohash helpers (decode to a bounding box, encode, polygon rings).
 * No dependencies so the client bundle stays small and the server and the
 * print view draw identical tiles.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Decode a geohash of any precision to its bounding box. Throws on an invalid character. */
export function decodeBbox(hash: string): Bbox {
  if (hash.length === 0) throw new Error("empty geohash");
  let even = true;
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  for (const raw of hash.toLowerCase()) {
    const idx = BASE32.indexOf(raw);
    if (idx < 0) throw new Error(`invalid geohash character "${raw}" in "${hash}"`);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (idx >> bit) & 1;
      if (even) {
        const mid = (minLon + maxLon) / 2;
        if (on) minLon = mid;
        else maxLon = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (on) minLat = mid;
        else maxLat = mid;
      }
      even = !even;
    }
  }
  return { minLat, minLon, maxLat, maxLon };
}

/** Centre of a geohash cell. */
export function decodeCenter(hash: string): { lat: number; lon: number } {
  const b = decodeBbox(hash);
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

/** Encode a point to a geohash (default precision 6, about 1.2 km x 0.6 km). */
export function encode(lat: number, lon: number, precision = 6): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("lat/lon must be finite");
  let even = true;
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  let bit = 0;
  let ch = 0;
  let out = "";
  while (out.length < precision) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      if (lon >= mid) {
        ch = (ch << 1) | 1;
        minLon = mid;
      } else {
        ch = ch << 1;
        maxLon = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        minLat = mid;
      } else {
        ch = ch << 1;
        maxLat = mid;
      }
    }
    even = !even;
    bit++;
    if (bit === 5) {
      out += BASE32.charAt(ch);
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

/** True when the string is a syntactically valid geohash. */
export function isGeohash(hash: string): boolean {
  return hash.length > 0 && [...hash.toLowerCase()].every((c) => BASE32.includes(c));
}

/** Closed GeoJSON ring ([lon, lat] pairs, counter-clockwise) for a cell. */
export function bboxRing(b: Bbox): [number, number][] {
  return [
    [b.minLon, b.minLat],
    [b.maxLon, b.minLat],
    [b.maxLon, b.maxLat],
    [b.minLon, b.maxLat],
    [b.minLon, b.minLat],
  ];
}

/** Width and height of a cell in km, measured at the cell's own latitude (a precision-6 cell in Nashville is about 1.0 by 0.6 km). */
export function cellSizeKm(hash: string): { widthKm: number; heightKm: number } {
  const b = decodeBbox(hash);
  const lat = (b.minLat + b.maxLat) / 2;
  return {
    widthKm: (b.maxLon - b.minLon) * 111.32 * Math.cos((lat * Math.PI) / 180),
    heightKm: (b.maxLat - b.minLat) * 110.57,
  };
}

/** Union bounding box of several boxes (and optional extra points). */
export function unionBbox(boxes: Bbox[], points: { lat: number; lon: number }[] = []): Bbox | null {
  if (boxes.length === 0 && points.length === 0) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const b of boxes) {
    minLat = Math.min(minLat, b.minLat);
    minLon = Math.min(minLon, b.minLon);
    maxLat = Math.max(maxLat, b.maxLat);
    maxLon = Math.max(maxLon, b.maxLon);
  }
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLat = Math.max(maxLat, p.lat);
    maxLon = Math.max(maxLon, p.lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}
