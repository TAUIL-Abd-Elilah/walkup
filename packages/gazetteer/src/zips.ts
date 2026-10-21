/**
 * ZIP place names and kinds, and the well-known districts, from the generated table in ./zip-data
 * (data/gazetteer/zips.py). Pure lookups: no disk, no network, safe in a browser bundle
 * (`@walkup/gazetteer/zips`).
 *
 * - `zipPlace("20707")` is the place name people use for a ZIP ("Laurel") and its kind.
 * - `isResidentialZip(zip)` is false for a ZIP that is one organisation (federal offices, a hospital,
 *   an airport), a military base or a campus, or has fewer than MIN_RESIDENTIAL_ADULTS adults 21+.
 *   Such ZIPs never count toward an area's adults, its ZIP list or zips.csv. An unknown ZIP counts as
 *   residential (the table covers the built metros only).
 * - `knownAreaNear(lat, lon)` is the nearest well-known district whose radius holds the point.
 */
import { KNOWN_AREAS, LOW_ADULT_ZIPS, MIN_RESIDENTIAL_ADULTS, NEIGHBOURHOOD_CITIES, ZIP_PLACES, type KnownAreaRecord, type ZipKind } from "./zip-data";
import { haversineKm } from "./haversine";

export { MIN_RESIDENTIAL_ADULTS };
export type { KnownAreaRecord, ZipKind };

/** Most ZIPs one area counts (the nearest first), so a dense downtown area keeps a meaningful name and count. */
export const MAX_AREA_ZIPS = 4;

const LOW = new Set(LOW_ADULT_ZIPS);

export interface ZipPlace {
  zip: string;
  /** The place name people use for the ZIP ("Laurel", "Alexandria", "Washington"). */
  city: string;
  kind: ZipKind;
}

export function zipPlace(zip: string | null | undefined): ZipPlace | null {
  const z = (zip ?? "").trim();
  const hit = ZIP_PLACES[z];
  return hit ? { zip: z, city: hit[0], kind: hit[1] } : null;
}

/**
 * False for a unique (one organisation), military or campus ZIP, a ZIP the built gazetteer counts fewer than
 * MIN_RESIDENTIAL_ADULTS adults in, or, when `adults21` is given, a count under that floor. True otherwise,
 * including ZIPs the table does not know.
 */
export function isResidentialZip(zip: string | null | undefined, adults21?: number | null): boolean {
  const z = (zip ?? "").trim();
  if (!/^\d{5}$/.test(z)) return false;
  const p = zipPlace(z);
  if (p && p.kind !== "residential") return false;
  if (LOW.has(z)) return false;
  if (typeof adults21 === "number" && Number.isFinite(adults21) && adults21 < MIN_RESIDENTIAL_ADULTS) return false;
  return true;
}

/** True when `city` is a ZIP city of `metro` named by neighbourhood (Washington in "dc"). */
export function isNeighbourhoodCity(metro: string | null | undefined, city: string | null | undefined): boolean {
  if (!metro || !city) return false;
  return (NEIGHBOURHOOD_CITIES[metro] ?? []).includes(city);
}

export interface KnownAreaHit {
  name: string;
  distanceKm: number;
}

/** The nearest well-known district whose radius holds the point (only `metro`'s when given), or null. */
export function knownAreaNear(lat: number, lon: number, metro?: string | null): KnownAreaHit | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: KnownAreaHit | null = null;
  for (const a of KNOWN_AREAS as readonly KnownAreaRecord[]) {
    if (metro && a.metro !== metro) continue;
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (d <= a.radiusKm && (!best || d < best.distanceKm)) best = { name: a.name, distanceKm: Math.round(d * 1000) / 1000 };
  }
  return best;
}
