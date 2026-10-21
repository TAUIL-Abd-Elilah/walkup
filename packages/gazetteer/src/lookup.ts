import type { LiftTile } from "@walkup/contracts";
import { haversineKm } from "./haversine";
import { resolveMetro, resolveMetros } from "./load";
import { stateFromGeoid, stateFromZip } from "./states";
import { isNeighbourhoodCity, isResidentialZip, knownAreaNear, MAX_AREA_ZIPS, zipPlace } from "./zips";
import type {
  Bbox,
  LoadOptions,
  MetroGazetteer,
  MetroRef,
  MultiMetroOptions,
  NameOptions,
  PlaceRecord,
  PointName,
  ZctaHit,
  ZctaRecord,
} from "./types";

export const DEFAULT_NEIGHBOURHOOD_RADIUS_KM = 2.5;

export function bboxContains(bbox: Bbox, lat: number, lon: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

function assertPoint(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError(`invalid point: ${lat}, ${lon}`);
  }
}

/** Equivalent-circle radius of a place, km. Null when the land area is unknown. */
function placeRadiusKm(p: PlaceRecord): number | null {
  return p.landKm2 != null && p.landKm2 > 0 ? Math.sqrt(p.landKm2 / Math.PI) : null;
}

function pickPlace(lat: number, lon: number, places: PlaceRecord[], strategy: NameOptions["placeStrategy"]): { place: PlaceRecord; d: number } | null {
  let nearest: { place: PlaceRecord; d: number } | null = null;
  let inside: { place: PlaceRecord; d: number; area: number } | null = null;
  let edge: { place: PlaceRecord; d: number; gap: number } | null = null;
  for (const place of places) {
    const d = haversineKm(lat, lon, place.lat, place.lon);
    if (!nearest || d < nearest.d) nearest = { place, d };
    if (strategy === "nearest") continue;
    const r = placeRadiusKm(place);
    const gap = d - (r ?? 0);
    if (r != null && d <= r) {
      const area = place.landKm2 ?? Infinity;
      if (!inside || area < inside.area || (area === inside.area && d < inside.d)) inside = { place, d, area };
    }
    if (!edge || gap < edge.gap) edge = { place, d, gap };
  }
  if (strategy === "nearest") return nearest;
  return inside ?? edge ?? nearest;
}

/**
 * Name a point: the nearest OSM neighbourhood/suburb/quarter within 2.5 km (configurable),
 * else a Census place (area-aware by default; see NameOptions). Null only when the metro
 * has neither neighbourhoods nor places.
 */
export function nameForPoint(lat: number, lon: number, metro: MetroRef, opts?: NameOptions & LoadOptions): PointName | null {
  assertPoint(lat, lon);
  const m = resolveMetro(metro, opts);
  const insideMetro = bboxContains(m.bbox, lat, lon);
  const radius = opts?.neighbourhoodRadiusKm ?? DEFAULT_NEIGHBOURHOOD_RADIUS_KM;

  let best: { name: string; ref: string; d: number } | null = null;
  for (const n of m.neighbourhoods) {
    const d = haversineKm(lat, lon, n.lat, n.lon);
    if (d <= radius && (!best || d < best.d)) best = { name: n.name, ref: n.osmId, d };
  }
  if (best) return { name: best.name, source: "neighbourhood", distanceKm: round3(best.d), ref: best.ref, insideMetro };

  const hit = pickPlace(lat, lon, m.places, opts?.placeStrategy ?? "area-aware");
  if (!hit) return null;
  return { name: hit.place.name, source: "place", distanceKm: round3(hit.d), ref: hit.place.geoid, insideMetro };
}

/**
 * The US state (USPS code, "MD") a point is in, for labels such as "Silver Spring, MD". The ZCTAs are read like
 * the places: each is a circle of its land area, the smallest circle holding the point wins, else the circle with
 * the nearest edge, and that ZCTA's ZIP prefix gives the state. When no ZCTA has a known state, the Census place
 * the area-aware rule picks gives it (its GEOID). A record's own `state` field wins when the file carries one.
 * Null when neither is known. Like the names this is "near", not "inside": right on a state line it can be wrong.
 */
export function stateForPoint(lat: number, lon: number, metro: MetroRef, opts?: LoadOptions): string | null {
  assertPoint(lat, lon);
  const m = resolveMetro(metro, opts);
  let inside: { st: string; area: number; d: number } | null = null;
  let edge: { st: string; gap: number } | null = null;
  for (const z of m.zctas) {
    const st = z.state ?? stateFromZip(z.zcta);
    if (!st) continue;
    const d = haversineKm(lat, lon, z.lat, z.lon);
    const r = z.landKm2 != null && z.landKm2 > 0 ? Math.sqrt(z.landKm2 / Math.PI) : 0;
    if (r > 0 && d <= r && (!inside || z.landKm2! < inside.area || (z.landKm2 === inside.area && d < inside.d))) inside = { st, area: z.landKm2!, d };
    if (!edge || d - r < edge.gap) edge = { st, gap: d - r };
  }
  const fromZcta = inside?.st ?? edge?.st ?? null;
  if (fromZcta) return fromZcta;
  const hit = pickPlace(lat, lon, m.places, "area-aware");
  return hit ? (hit.place.state ?? stateFromGeoid(hit.place.geoid)) : null;
}

/** ZCTAs whose internal point lies within radiusKm, nearest first. */
export function zctasNear(lat: number, lon: number, radiusKm: number, metro: MetroRef, opts?: LoadOptions): ZctaHit[] {
  assertPoint(lat, lon);
  const m = resolveMetro(metro, opts);
  return withinRadius(lat, lon, radiusKm, m.zctas);
}

/** The ZCTA with the nearest internal point (any distance), or null when the metro has none. */
export function nearestZcta(lat: number, lon: number, metro: MetroRef, opts?: LoadOptions): ZctaHit | null {
  assertPoint(lat, lon);
  const m = resolveMetro(metro, opts);
  let best: ZctaHit | null = null;
  for (const z of m.zctas) {
    const d = haversineKm(lat, lon, z.lat, z.lon);
    if (!best || d < best.distanceKm) best = { ...z, distanceKm: d };
  }
  return best ? { ...best, distanceKm: round3(best.distanceKm) } : null;
}

function withinRadius(lat: number, lon: number, radiusKm: number, zctas: ZctaRecord[]): ZctaHit[] {
  if (!(radiusKm >= 0)) throw new RangeError(`radiusKm must be >= 0, got ${radiusKm}`);
  const hits: ZctaHit[] = [];
  for (const z of zctas) {
    const d = haversineKm(lat, lon, z.lat, z.lon);
    if (d <= radiusKm) hits.push({ ...z, distanceKm: round3(d) });
  }
  return hits.sort((a, b) => a.distanceKm - b.distanceKm || a.zcta.localeCompare(b.zcta));
}

/**
 * The metro whose box contains the point; when boxes overlap, the one whose centre is
 * nearest. Null when no loaded metro covers the point.
 */
export function metroForPoint(lat: number, lon: number, opts?: MultiMetroOptions): string | null {
  assertPoint(lat, lon);
  let best: { name: string; d: number } | null = null;
  for (const m of resolveMetros(opts)) {
    if (!bboxContains(m.bbox, lat, lon)) continue;
    const c = m.center ?? { lat: (m.bbox.south + m.bbox.north) / 2, lon: (m.bbox.west + m.bbox.east) / 2 };
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || d < best.d || (d === best.d && m.metro < best.name)) best = { name: m.metro, d };
  }
  return best?.name ?? null;
}

export interface AdultsOptions extends MultiMetroOptions {
  /** Restrict to one metro instead of every loaded metro. */
  metro?: MetroRef;
  /** When no ZCTA internal point is inside the radius, count the nearest ZCTA instead of returning 0. */
  ensureNearest?: boolean;
  /**
   * Count only residential ZIPs (`isResidentialZip`: no federal, single-organisation, military or campus ZIP and
   * none with fewer than 250 adults 21+). Default false.
   */
  residentialOnly?: boolean;
  /** Count at most this many ZCTAs, the nearest first. Default: no cap. */
  maxZctas?: number;
}

export interface AdultsDetail {
  /** Sum of ACS adults 21+ over the counted ZCTAs; null when unknown (no coverage, or ACS missing). */
  adults21: number | null;
  zctas: string[];
  /** ZCTAs counted whose adults21 was null (excluded from the sum). */
  missing: string[];
  metro: string | null;
}

function candidateMetros(opts?: AdultsOptions): MetroGazetteer[] {
  if (opts?.metro !== undefined) return [resolveMetro(opts.metro, opts)];
  return resolveMetros(opts);
}

/** Like adultsNear, with the ZCTAs counted and the metro used. */
export function adultsNearDetail(lat: number, lon: number, radiusKm: number, opts?: AdultsOptions): AdultsDetail {
  assertPoint(lat, lon);
  const metros = candidateMetros(opts);
  const pool = (m: MetroGazetteer) => (opts?.residentialOnly ? m.zctas.filter((z) => isResidentialZip(z.zcta, z.adults21)) : m.zctas);
  const seen = new Map<string, ZctaHit>();
  for (const m of metros) for (const z of withinRadius(lat, lon, radiusKm, pool(m))) if (!seen.has(z.zcta)) seen.set(z.zcta, z);

  const covering = metros.filter((m) => bboxContains(m.bbox, lat, lon));
  const metroName = opts?.metro !== undefined ? (metros[0]?.metro ?? null) : metroForPoint(lat, lon, { metros });

  if (seen.size === 0 && opts?.ensureNearest) {
    // Only a metro whose box holds the point lends its nearest ZCTA. Outside every box the
    // "nearest" ZCTA can be any distance away, so the count stays unknown (null).
    let best: ZctaHit | null = null;
    for (const m of covering) {
      const z = nearestZcta(lat, lon, { ...m, zctas: pool(m) });
      if (z && (!best || z.distanceKm < best.distanceKm)) best = z;
    }
    if (best) seen.set(best.zcta, best);
  }

  const sorted = [...seen.values()].sort((a, b) => a.distanceKm - b.distanceKm || a.zcta.localeCompare(b.zcta));
  const cap = opts?.maxZctas !== undefined && opts.maxZctas >= 1 ? Math.floor(opts.maxZctas) : Infinity;
  const hits = sorted.slice(0, cap);
  const known = hits.filter((z) => z.adults21 != null);
  const missing = hits.filter((z) => z.adults21 == null).map((z) => z.zcta);
  let adults21: number | null;
  if (known.length) adults21 = known.reduce((s, z) => s + (z.adults21 ?? 0), 0);
  else if (hits.length === 0 && covering.length > 0) adults21 = 0; // covered area, no ZCTA point in range
  else adults21 = null;
  return { adults21, zctas: hits.map((z) => z.zcta), missing, metro: metroName };
}

/**
 * ACS adults 21+ near a point: the sum over ZCTAs whose internal point lies within
 * radiusKm (centroid inclusion; no areal weighting). Searches every loaded metro unless
 * opts.metro is given. ZCTAs without ACS are left out of the sum. Returns null when nothing
 * known is in range (no ZCTA point in range and no metro box covers the point, or ACS is
 * missing for every ZCTA in range), and 0 for a covered point with no ZCTA point in range
 * (use a radius of a few km, or ensureNearest, for small tiles). ensureNearest only applies
 * inside a metro box.
 */
export function adultsNear(lat: number, lon: number, radiusKm: number, opts?: AdultsOptions): number | null {
  return adultsNearDetail(lat, lon, radiusKm, opts).adults21;
}

export interface AnnotateOptions extends NameOptions, MultiMetroOptions {
  /** Metro to use; default metroForPoint(tile). */
  metro?: MetroRef;
  /** Radius for ZCTAs and adults. Default 3 km. */
  radiusKm?: number;
  /** Most ZCTAs one area counts, nearest first. Default MAX_AREA_ZIPS (4). */
  maxZctas?: number;
  /**
   * "local" (default): the name people use (`areaNameForPoint`). "gazetteer": the OSM neighbourhood or Census
   * place (`nameForPoint`), as before the ZIP table.
   */
  naming?: "local" | "gazetteer";
}

/** What annotateTile fills in. */
export interface AnnotatedFields {
  name?: string;
  zctas?: string[];
  adultPopulation?: number | null;
  /** The OSM or Census name behind `name` when it differs. */
  gazetteerName?: string;
}

/** The residential ZCTA a point is in: the smallest equivalent circle holding it, else the circle with the nearest edge. */
export function zipForPoint(lat: number, lon: number, metro: MetroRef, opts?: LoadOptions): ZctaHit | null {
  assertPoint(lat, lon);
  const m = resolveMetro(metro, opts);
  let inside: { z: ZctaRecord; area: number; d: number } | null = null;
  let edge: { z: ZctaRecord; gap: number; d: number } | null = null;
  for (const z of m.zctas) {
    if (!isResidentialZip(z.zcta, z.adults21)) continue;
    const d = haversineKm(lat, lon, z.lat, z.lon);
    const r = z.landKm2 != null && z.landKm2 > 0 ? Math.sqrt(z.landKm2 / Math.PI) : 0;
    if (r > 0 && d <= r && (!inside || z.landKm2! < inside.area || (z.landKm2 === inside.area && d < inside.d))) inside = { z, area: z.landKm2!, d };
    if (!edge || d - r < edge.gap) edge = { z, gap: d - r, d };
  }
  const hit = inside ?? edge;
  return hit ? { ...hit.z, distanceKm: round3(hit.d) } : null;
}

export type AreaNameSource = "known" | "neighbourhood" | "zip" | "place";

export interface AreaName {
  /** The name people use: a well-known district, else the town of the ZIP, else (in a big city) the neighbourhood. */
  name: string;
  source: AreaNameSource;
  /** The OSM neighbourhood or Census place at the point, when it differs from `name` (for "Alexandria (Del Ray)"). */
  gazetteerName?: string;
  /** The residential ZIP the point is in. */
  zip?: string;
}

/**
 * The name a promoter would use for a point, from data (no names written per sheet):
 *
 *  1. a well-known district (data/gazetteer/areas.json) whose radius holds the point: "H Street NE", "U Street / Shaw";
 *  2. else the place name of the residential ZIP the point is in (data/gazetteer/zip_places.csv): "Laurel", "Bowie",
 *     "Bethesda", "Greenbelt", "Alexandria". In a city named by neighbourhood (Washington, Nashville, Seattle) the
 *     OSM neighbourhood within 2.5 km is used instead, and the city only when there is none;
 *  3. else `nameForPoint` (OSM neighbourhood, else Census place), as before.
 */
export function areaNameForPoint(lat: number, lon: number, metro: MetroRef, opts?: NameOptions & LoadOptions): AreaName | null {
  assertPoint(lat, lon);
  const m = resolveMetro(metro, opts);
  const named = nameForPoint(lat, lon, m, opts);
  const other = (name: string) => (named && named.name !== name ? { gazetteerName: named.name } : {});
  const known = knownAreaNear(lat, lon, m.metro);
  const zip = zipForPoint(lat, lon, m);
  const zipRef = zip ? { zip: zip.zcta } : {};
  if (known) return { name: known.name, source: "known", ...other(known.name), ...zipRef };
  const place = zipPlace(zip?.zcta);
  if (place) {
    if (isNeighbourhoodCity(m.metro, place.city) && named?.source === "neighbourhood") return { name: named.name, source: "neighbourhood", ...zipRef };
    return { name: place.city, source: "zip", ...other(place.city), ...zipRef };
  }
  return named ? { name: named.name, source: named.source, ...zipRef } : null;
}

/**
 * Fill a lift tile's gazetteer fields: name (the name people use, `areaNameForPoint`; the
 * OSM/Census name rides along as `gazetteerName` when it differs), zctas and adultPopulation.
 * Only residential ZIPs count (no federal, single-organisation, military or campus ZIP), at
 * most MAX_AREA_ZIPS of them, nearest first, so a dense downtown area keeps a meaningful
 * count. Uses the nearest residential ZCTA when none is inside the radius. Leaves the
 * tile's other fields untouched; a tile
 * outside the metro's box (the one passed in opts.metro, or any loaded metro) gets
 * adultPopulation null and no name, rather than the name and count of a far-away area.
 */
export function annotateTile<T extends Pick<LiftTile, "lat" | "lon"> & Partial<LiftTile>>(tile: T, opts?: AnnotateOptions): T & AnnotatedFields {
  const radiusKm = opts?.radiusKm ?? 3;
  let metro: MetroGazetteer | null = null;
  if (opts?.metro !== undefined) metro = resolveMetro(opts.metro, opts);
  else {
    const metros = resolveMetros(opts);
    const name = metroForPoint(tile.lat, tile.lon, { metros });
    metro = metros.find((m) => m.metro === name) ?? null;
  }
  if (!metro || !bboxContains(metro.bbox, tile.lat, tile.lon)) return { ...tile, adultPopulation: null };
  const detail = adultsNearDetail(tile.lat, tile.lon, radiusKm, { metro, ensureNearest: true, residentialOnly: true, maxZctas: opts?.maxZctas ?? MAX_AREA_ZIPS });
  const out: T & AnnotatedFields = { ...tile, zctas: detail.zctas, adultPopulation: detail.adults21 };
  if (opts?.naming === "gazetteer") {
    const named = nameForPoint(tile.lat, tile.lon, metro, opts);
    if (named) out.name = named.name;
    return out;
  }
  const local = areaNameForPoint(tile.lat, tile.lon, metro, opts);
  if (local) {
    out.name = local.name;
    if (local.gazetteerName) out.gazetteerName = local.gazetteerName;
  }
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
