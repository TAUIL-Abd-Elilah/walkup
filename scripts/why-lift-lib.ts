/**
 * "Why lift" from recorded heatmaps (evals/llm-baseline/protocol.md, part 2), pure parts: no network, no files.
 *
 * For two bills in one room: how many of their top 5 raw-heat areas they share, against how many of their top 5
 * lift areas, and how closely each bill's raw heat follows the room's usual crowd (Spearman over the same tiles).
 * Raw heat is the bill's own Qloo heatmap affinity, averaged per geohash-6 tile (the engine's aggregation), on the
 * tiles lift is computed on (present in both the bill's and the usual crowd's map).
 */
import type { HeatCell, LiftTile } from "@walkup/contracts";
import { aggregateToGeohash6, cmpNum, cmpStr, haversineM, LIFT_DEFAULTS, spearman, type AggregatedCell } from "@walkup/engine";

/** Areas closer than this, or sharing a ZIP, are the same place (the sheet's rule for its numbered areas). */
export const SAME_AREA_KM = 3;
export const TOP_N = 5;

export interface JoinedTile {
  geohash: string;
  lat: number;
  lon: number;
  /** The bill's mean affinity in the tile (raw heat). */
  bill: number;
  /** The room's usual crowd's mean affinity in the tile. */
  house: number;
  /** The bill map's mean popularity in the tile (tie-break only). */
  popularity: number;
}

export interface AreaInfo {
  zctas?: string[];
  adultPopulation?: number | null;
}

/** Bill and usual-crowd maps joined on geohash-6 tiles, as lift joins them. Sorted by geohash. */
export function joinTiles(bill: readonly HeatCell[], house: readonly HeatCell[]): JoinedTile[] {
  const b = new Map<string, AggregatedCell>(aggregateToGeohash6(bill).map((c) => [c.geohash, c]));
  const h = new Map<string, AggregatedCell>(aggregateToGeohash6(house).map((c) => [c.geohash, c]));
  const out: JoinedTile[] = [];
  for (const [g, cb] of b) {
    const ch = h.get(g);
    if (!ch) continue;
    out.push({ geohash: g, lat: cb.lat, lon: cb.lon, bill: cb.affinity, house: ch.affinity, popularity: cb.popularity ?? 0 });
  }
  return out.sort((x, y) => cmpStr(x.geohash, y.geohash));
}

export function sameArea(a: { lat: number; lon: number; zctas?: string[] }, b: { lat: number; lon: number; zctas?: string[] }): boolean {
  if (haversineM(a, b) < SAME_AREA_KM * 1000) return true;
  const za = a.zctas ?? [];
  return za.length > 0 && (b.zctas ?? []).some((z) => za.includes(z));
}

/**
 * The top `n` raw-heat areas: tiles by the bill's raw heat (ties: popularity, then geohash), at least
 * `minAdults` adults when the lookup knows the number, skipping a tile that is the same place as one already
 * picked. The same rules as the sheet's numbered areas, without the lift ones.
 */
export function topRawAreas(
  tiles: readonly JoinedTile[],
  annotate: (t: { lat: number; lon: number }) => AreaInfo,
  n = TOP_N,
  minAdults: number = LIFT_DEFAULTS.minAdults,
): Array<JoinedTile & AreaInfo> {
  const sorted = [...tiles].sort((a, b) => cmpNum(b.bill, a.bill) || cmpNum(b.popularity, a.popularity) || cmpStr(a.geohash, b.geohash));
  const out: Array<JoinedTile & AreaInfo> = [];
  for (const t of sorted) {
    if (out.length >= n) break;
    const info = annotate(t);
    const adults = info.adultPopulation;
    if (typeof adults === "number" && adults < minAdults) continue;
    const tile = { ...t, ...info };
    if (out.some((o) => sameArea(o, tile))) continue;
    out.push(tile);
  }
  return out;
}

/** The sheet's numbered areas 1-5: lift 1.3 and up, highest first, one per place (apps/web/lib/sheet-utils.ts topTiles). */
export function topLiftAreas(tiles: readonly LiftTile[], n = TOP_N): LiftTile[] {
  const sorted = [...tiles]
    .filter((t) => t.lift >= LIFT_DEFAULTS.minLift)
    .sort((a, b) => b.lift - a.lift || b.billPct - a.billPct || cmpStr(a.geohash, b.geohash));
  const out: LiftTile[] = [];
  for (const t of sorted) {
    if (out.length >= n) break;
    if (out.some((o) => sameArea(o, t))) continue;
    out.push(t);
  }
  return out;
}

/** Areas of `b` that are also in `a`: the same tile, or (by place) the same place by the 3 km / ZIP rule. */
export function sharedAreas(
  a: ReadonlyArray<{ geohash: string; lat: number; lon: number; zctas?: string[] }>,
  b: ReadonlyArray<{ geohash: string; lat: number; lon: number; zctas?: string[] }>,
): { sameTile: number; samePlace: number } {
  const tiles = new Set(a.map((t) => t.geohash));
  return {
    sameTile: b.filter((t) => tiles.has(t.geohash)).length,
    samePlace: b.filter((t) => a.some((o) => sameArea(o, t))).length,
  };
}

/** Spearman between the bill's raw heat and the usual crowd's raw heat over the joined tiles. */
export function rawVsHouse(tiles: readonly JoinedTile[]): { rho: number | null; n: number } {
  return { rho: tiles.length >= 3 ? spearman(tiles.map((t) => t.bill), tiles.map((t) => t.house)) : null, n: tiles.length };
}

/** Spearman between two bills' raw heat over the tiles both bills' joined maps share. */
export function billVsBill(a: readonly JoinedTile[], b: readonly JoinedTile[]): { rho: number | null; n: number } {
  const mb = new Map(b.map((t) => [t.geohash, t.bill]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const t of a) {
    const y = mb.get(t.geohash);
    if (y === undefined) continue;
    xs.push(t.bill);
    ys.push(y);
  }
  return { rho: xs.length >= 3 ? spearman(xs, ys) : null, n: xs.length };
}

export function round(v: number | null, d = 3): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
