/**
 * Probe-local lift math (the product's version lives in the engine package;
 * this copy keeps the probe runnable on its own).
 *
 * Affinity and popularity are percentiles inside ONE heatmap response, so two
 * heatmaps are only compared through percentile ranks, never raw values.
 */

import { pctRank } from "../stats.js";
import type { CellLite } from "./extract.js";

export interface Tile {
  geohash: string;
  affinity: number;
  popularity: number;
  cells: number;
}

export interface LiftRow {
  geohash: string;
  billPct: number;
  housePct: number;
  lift: number;
  /** Raw (tile-averaged) bill affinity: the "heat" that lift is compared against. */
  billHeat: number;
  popularity: number;
}

/** Averages cells into geohash tiles of the given precision (default 6). */
export function aggregateTiles(cells: readonly CellLite[], precision = 6): Map<string, Tile> {
  const sums = new Map<string, { a: number; p: number; n: number }>();
  for (const c of cells) {
    if (c.geohash.length < precision) continue;
    const g = c.geohash.slice(0, precision);
    const s = sums.get(g) ?? { a: 0, p: 0, n: 0 };
    s.a += c.affinity;
    s.p += c.popularity;
    s.n += 1;
    sums.set(g, s);
  }
  const out = new Map<string, Tile>();
  for (const [g, s] of sums) out.set(g, { geohash: g, affinity: s.a / s.n, popularity: s.p / s.n, cells: s.n });
  return out;
}

/** Percentile rank of each tile's affinity inside its own heatmap. */
function pctByGeohash(tiles: Map<string, Tile>): Map<string, number> {
  const list = [...tiles.values()];
  const pct = pctRank(list.map((t) => t.affinity));
  const out = new Map<string, number>();
  list.forEach((t, i) => out.set(t.geohash, pct[i]!));
  return out;
}

/**
 * lift = pct_rank(bill) / pct_rank(house) on the geohash join, shrunk toward 1
 * where the tile's popularity percentile is below `shrinkBelow`.
 */
export function computeLift(
  bill: Map<string, Tile>,
  house: Map<string, Tile>,
  opts: { shrinkBelow: number },
): LiftRow[] {
  const billPct = pctByGeohash(bill);
  const housePct = pctByGeohash(house);
  const rows: LiftRow[] = [];
  for (const [g, bt] of bill) {
    const ht = house.get(g);
    const bp = billPct.get(g);
    const hp = housePct.get(g);
    if (!ht || bp === undefined || hp === undefined || hp <= 0) continue;
    const pop = (bt.popularity + ht.popularity) / 2;
    const w = opts.shrinkBelow > 0 ? Math.min(1, Math.max(0, pop / opts.shrinkBelow)) : 1;
    const raw = bp / hp;
    rows.push({ geohash: g, billPct: bp, housePct: hp, lift: 1 + (raw - 1) * w, billHeat: bt.affinity, popularity: pop });
  }
  return rows;
}

/** Geohashes of the top `fraction` of rows by lift (at least one row when any exist). */
export function topFraction(rows: readonly LiftRow[], fraction: number): Set<string> {
  if (rows.length === 0) return new Set();
  const n = Math.max(1, Math.ceil(rows.length * fraction));
  return new Set(
    [...rows]
      .sort((a, b) => b.lift - a.lift || a.geohash.localeCompare(b.geohash))
      .slice(0, n)
      .map((r) => r.geohash),
  );
}

/** Geohashes of the top n tiles by raw affinity. */
export function topTiles(tiles: Map<string, Tile>, n: number): Set<string> {
  return new Set(
    [...tiles.values()]
      .sort((a, b) => b.affinity - a.affinity || a.geohash.localeCompare(b.geohash))
      .slice(0, n)
      .map((t) => t.geohash),
  );
}
