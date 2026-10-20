/**
 * Geohash helpers: aggregate Qloo heatmap cells (precision 6-7) to geohash-6
 * tiles and compute percentile ranks within one map.
 */
import ngeohash from "ngeohash";
import type { HeatCell } from "@walkup/contracts";
import { cmpStr, isFiniteNumber } from "./num";
import { pctRanks } from "./stats";

export const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";
/** Lift tiles are geohash-6 (about 1.2 km x 0.6 km). */
export const LIFT_PRECISION = 6;

const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]+$/;

export function isValidGeohash(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 12 && GEOHASH_RE.test(s);
}

function validLatLon(lat: unknown, lon: unknown): boolean {
  return isFiniteNumber(lat) && isFiniteNumber(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/**
 * The geohash at `precision` for a cell. Uses the cell's own geohash prefix when
 * it is at least that precise; otherwise encodes the cell's lat/lon. Null when
 * neither is usable.
 */
export function toGeohashPrecision(
  cell: { geohash?: string | null; lat?: number | null; lon?: number | null },
  precision: number = LIFT_PRECISION,
): string | null {
  const gh = typeof cell.geohash === "string" ? cell.geohash.trim().toLowerCase() : "";
  if (isValidGeohash(gh) && gh.length >= precision) return gh.slice(0, precision);
  if (validLatLon(cell.lat, cell.lon)) return ngeohash.encode(cell.lat as number, cell.lon as number, precision);
  return null;
}

export function toGeohash6(cell: { geohash?: string | null; lat?: number | null; lon?: number | null }): string | null {
  return toGeohashPrecision(cell, LIFT_PRECISION);
}

export function geohashCenter(gh: string): { lat: number; lon: number } {
  const d = ngeohash.decode(gh);
  return { lat: d.latitude, lon: d.longitude };
}

/** Closed ring of [lon, lat] pairs (GeoJSON order) for drawing a tile. */
export function geohashPolygon(gh: string): [number, number][] {
  const [minLat, minLon, maxLat, maxLon] = ngeohash.decode_bbox(gh);
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
}

export interface AggregatedCell {
  geohash: string;
  /** Centroid of the member cells (falls back to the tile centre when no member has a usable lat/lon). */
  lat: number;
  lon: number;
  /** Mean affinity of the member cells. */
  affinity: number;
  /** Mean affinityRank of the member cells; null when none had one. */
  affinityRank: number | null;
  /** Mean popularity of the member cells; null when none had one. */
  popularity: number | null;
  cellCount: number;
}

/**
 * Aggregates heatmap cells to geohash-6 (or `precision`). Cells with a
 * non-finite affinity or no usable location are dropped. Output is sorted by
 * geohash so it is deterministic regardless of input order.
 */
export function aggregateToGeohash6(cells: readonly HeatCell[], precision: number = LIFT_PRECISION): AggregatedCell[] {
  interface Acc {
    affSum: number;
    n: number;
    rankSum: number;
    rankN: number;
    popSum: number;
    popN: number;
    latSum: number;
    lonSum: number;
    llN: number;
  }
  const acc = new Map<string, Acc>();
  for (const c of cells ?? []) {
    if (!c || !isFiniteNumber(c.affinity)) continue;
    const gh = toGeohashPrecision(c, precision);
    if (!gh) continue;
    let a = acc.get(gh);
    if (!a) {
      a = { affSum: 0, n: 0, rankSum: 0, rankN: 0, popSum: 0, popN: 0, latSum: 0, lonSum: 0, llN: 0 };
      acc.set(gh, a);
    }
    a.affSum += c.affinity;
    a.n += 1;
    if (isFiniteNumber(c.affinityRank)) {
      a.rankSum += c.affinityRank;
      a.rankN += 1;
    }
    if (isFiniteNumber(c.popularity)) {
      a.popSum += c.popularity;
      a.popN += 1;
    }
    if (validLatLon(c.lat, c.lon)) {
      a.latSum += c.lat;
      a.lonSum += c.lon;
      a.llN += 1;
    }
  }
  const out: AggregatedCell[] = [];
  for (const [gh, a] of acc) {
    const center = a.llN > 0 ? { lat: a.latSum / a.llN, lon: a.lonSum / a.llN } : geohashCenter(gh);
    out.push({
      geohash: gh,
      lat: center.lat,
      lon: center.lon,
      affinity: a.affSum / a.n,
      affinityRank: a.rankN > 0 ? a.rankSum / a.rankN : null,
      popularity: a.popN > 0 ? a.popSum / a.popN : null,
      cellCount: a.n,
    });
  }
  out.sort((x, y) => cmpStr(x.geohash, y.geohash));
  return out;
}

/** Percentile rank of `field` within one aggregated map, keyed by geohash. Values in (0, 1]. */
export function pctRankMap(cells: readonly AggregatedCell[], field: "affinity" | "affinityRank" | "popularity" = "affinity"): Map<string, number> {
  const vals = cells.map((c) => {
    const v = c[field];
    return isFiniteNumber(v) ? v : Number.NaN;
  });
  const pr = pctRanks(vals);
  const out = new Map<string, number>();
  cells.forEach((c, i) => {
    const p = pr[i] as number;
    if (Number.isFinite(p)) out.set(c.geohash, p);
  });
  return out;
}

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
