/** Minimal geohash decoder (cell centre), used only when a heatmap cell lacks lat/lon. */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function decodeGeohash(hash: string): { lat: number; lon: number } | null {
  if (!hash) return null;
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let even = true;
  for (const ch of hash.toLowerCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const on = ((idx >> bit) & 1) === 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (on) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}
