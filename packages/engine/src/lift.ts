/**
 * Lift computation: where this bill's crowd over-indexes versus the room's
 * usual crowd. Deterministic, no API call.
 *
 * For every geohash-6 tile present in both heatmaps (inner join):
 *
 *   billPct  = pct_rank(mean bill affinity)   within the joined tiles, in (0, 1]
 *   housePct = pct_rank(mean house affinity)  within the joined tiles, in (0, 1]
 *   score    = ln((billPct + a) / (housePct + a))       a = smoothing, default 0.5
 *   popPct   = pct_rank(popularity)           within the joined tiles, in (0, 1]
 *   w        = min(1, popPct / shrinkTau)      (w = 1 when shrinkTau <= 0)
 *   lift     = exp(w * score)
 *
 * Affinities are only ever compared as percentile ranks inside one response.
 * The smoothing keeps the score bounded: with a = 0.5, lift stays inside
 * [1/3, 3], so a tile the house barely ranks (0.55 against 0.08: lift 1.81)
 * no longer dwarfs one where both crowds are strong (0.98 against 0.60: 1.35).
 * The bill floor then keeps tiles where this crowd is not actually there off
 * the top list. `shrinkTau` pulls thin-signal tiles toward 1.
 *
 * Top tiles: lift >= minLift (1.3), billPct >= minBillPct (the bill floor,
 * 0.7) and, when an adult-population lookup is injected, adults >= minAdults.
 *
 * Split-half check: the bill's seeds and the house's seeds are each split into
 * two disjoint halves (`splitHalves`), lift is computed per half, and the two
 * lift maps are compared by Spearman on the tiles both halves share
 * (`splitHalfAgreement`). Above 0.5 the map holds up when half the evidence is
 * taken away; at or below it, the map is mostly noise.
 */
import type { HeatCell, LiftTile } from "@walkup/contracts";
import { aggregateToGeohash6, type AggregatedCell } from "./geohash";
import { clamp, cmpNum, cmpStr, EPS, isFiniteNumber } from "./num";
import { seedFromString } from "./rng";
import { pctRanks, spearman } from "./stats";

export type AdultLookup = (tile: { geohash: string; lat: number; lon: number }) => number | null | undefined;

export interface LiftOptions {
  /** Minimum lift for a top tile. Default 1.3. */
  minLift?: number;
  /** Popularity percentile below which a tile is shrunk toward 1. Default 0.25. */
  shrinkTau?: number;
  /** Added to both percentile ranks before the ratio. Default 0.5 (lift inside [1/3, 3]). */
  smoothing?: number;
  /** Which popularity drives the shrink. Default "min" (the thinner of the two maps). */
  popularitySource?: "min" | "mean" | "bill" | "house";
  /** Rank affinities over the joined tiles only (default) or over each full map. */
  rankOver?: "joined" | "full";
  /** Injected adult-population lookup (ACS). When absent, no population floor is applied. */
  adultPopulation?: AdultLookup;
  /** Adult-population floor for a top tile. Default 500. */
  minAdults?: number;
  /** What to do with a tile whose lookup returned null/undefined. Default "keep". */
  unknownAdults?: "keep" | "drop";
  /** Bill floor: the bill percentile a top tile needs ("this crowd is actually there"). Default 0.7; 0 turns it off. */
  minBillPct?: number;
  /** Cap on the number of top tiles returned. Default: no cap. */
  maxTiles?: number;
}

export const LIFT_DEFAULTS = {
  minLift: 1.3,
  shrinkTau: 0.25,
  smoothing: 0.5,
  billFloor: 0.7,
  minAdults: 500,
  weakThreshold: 0.9,
  minSplitHalf: 0.5,
} as const;

function combinePopularity(b: number | null, h: number | null, source: NonNullable<LiftOptions["popularitySource"]>): number {
  const fb = isFiniteNumber(b) ? b : null;
  const fh = isFiniteNumber(h) ? h : null;
  switch (source) {
    case "bill":
      return fb ?? 0;
    case "house":
      return fh ?? 0;
    case "mean":
      if (fb !== null && fh !== null) return (fb + fh) / 2;
      return fb ?? fh ?? 0;
    case "min":
    default:
      if (fb !== null && fh !== null) return Math.min(fb, fh);
      return fb ?? fh ?? 0;
  }
}

function sanitizeAdults(v: unknown): number | null {
  return isFiniteNumber(v) && v >= 0 ? v : null;
}

function lookupAdults(lookup: AdultLookup, tile: { geohash: string; lat: number; lon: number }): number | null {
  try {
    return sanitizeAdults(lookup(tile));
  } catch {
    return null;
  }
}

function smoothingOf(opts: LiftOptions): number {
  return isFiniteNumber(opts.smoothing) && opts.smoothing > 0 ? opts.smoothing : LIFT_DEFAULTS.smoothing;
}

function billFloorOf(opts: LiftOptions): number {
  return isFiniteNumber(opts.minBillPct) ? clamp(opts.minBillPct, 0, 1) : LIFT_DEFAULTS.billFloor;
}

/**
 * Bounded lift for one tile: exp(w * ln((billPct + a) / (housePct + a))).
 * `w` in [0, 1] is the popularity shrink weight (1 = no shrink).
 */
export function liftScore(billPct: number, housePct: number, opts: { smoothing?: number; weight?: number } = {}): number {
  const a = isFiniteNumber(opts.smoothing) && opts.smoothing > 0 ? opts.smoothing : LIFT_DEFAULTS.smoothing;
  const w = isFiniteNumber(opts.weight) ? clamp(opts.weight, 0, 1) : 1;
  if (!isFiniteNumber(billPct) || !isFiniteNumber(housePct)) return Number.NaN;
  return Math.exp(w * Math.log((clamp(billPct, 0, 1) + a) / (clamp(housePct, 0, 1) + a)));
}

/** Lift bounds for a smoothing value: [a / (1 + a), (1 + a) / a]. */
export function liftBounds(smoothing: number = LIFT_DEFAULTS.smoothing): { min: number; max: number } {
  const a = smoothing > 0 ? smoothing : LIFT_DEFAULTS.smoothing;
  return { min: a / (1 + a), max: (1 + a) / a };
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * One plain line describing how lift was scored, for the lift card (`SheetLiftDiagnostics.method`).
 * Percentiles are written on the 0-100 scale the sheet shows, so the smoothing is too (0.5 reads as 50):
 * a reader can check "percentile 91 against 27" as (91 + 50) / (27 + 50) = 1.83.
 */
export function liftMethod(opts: LiftOptions = {}): string {
  const a = fmt(smoothingOf(opts) * 100);
  const minLift = fmt(isFiniteNumber(opts.minLift) ? opts.minLift : LIFT_DEFAULTS.minLift);
  const floor = billFloorOf(opts);
  const pct = Math.round(floor <= 1 ? floor * 100 : floor);
  return `Lift is (this crowd's percentile + ${a}) / (the usual crowd's percentile + ${a}). An area makes the top list when this crowd puts it at percentile ${pct} or higher and lift is ${minLift} or more. Areas with little data are pulled toward 1.`;
}

/** Deterministic order for lift tiles: lift desc, billPct desc, popularityPct desc, geohash asc. */
export function compareLiftTiles(a: LiftTile, b: LiftTile): number {
  return cmpNum(b.lift, a.lift) || cmpNum(b.billPct, a.billPct) || cmpNum(b.popularityPct, a.popularityPct) || cmpStr(a.geohash, b.geohash);
}

/** All joined tiles with their lift, sorted by `compareLiftTiles`. */
export function computeLiftAll(bill: readonly HeatCell[], house: readonly HeatCell[], opts: LiftOptions = {}): LiftTile[] {
  return liftFromAggregates(aggregateToGeohash6(bill), aggregateToGeohash6(house), opts);
}

export function liftFromAggregates(aggB: readonly AggregatedCell[], aggH: readonly AggregatedCell[], opts: LiftOptions = {}): LiftTile[] {
  const smoothing = smoothingOf(opts);
  const tau = isFiniteNumber(opts.shrinkTau) ? opts.shrinkTau : LIFT_DEFAULTS.shrinkTau;
  const source = opts.popularitySource ?? "min";
  const rankOver = opts.rankOver ?? "joined";

  const byB = new Map(aggB.map((c) => [c.geohash, c]));
  const byH = new Map(aggH.map((c) => [c.geohash, c]));
  const joined = [...byB.keys()].filter((g) => byH.has(g)).sort(cmpStr);
  if (joined.length === 0) return [];

  let billPct: number[];
  let housePct: number[];
  if (rankOver === "full") {
    const pb = pctRanks(aggB.map((c) => c.affinity));
    const ph = pctRanks(aggH.map((c) => c.affinity));
    const mb = new Map(aggB.map((c, i) => [c.geohash, pb[i] as number]));
    const mh = new Map(aggH.map((c, i) => [c.geohash, ph[i] as number]));
    billPct = joined.map((g) => mb.get(g) as number);
    housePct = joined.map((g) => mh.get(g) as number);
  } else {
    billPct = pctRanks(joined.map((g) => (byB.get(g) as AggregatedCell).affinity));
    housePct = pctRanks(joined.map((g) => (byH.get(g) as AggregatedCell).affinity));
  }
  const popPct = pctRanks(
    joined.map((g) => combinePopularity((byB.get(g) as AggregatedCell).popularity, (byH.get(g) as AggregatedCell).popularity, source)),
  );

  const tiles: LiftTile[] = joined.map((g, i) => {
    const b = byB.get(g) as AggregatedCell;
    const h = byH.get(g) as AggregatedCell;
    const bp = billPct[i] as number;
    const hp = housePct[i] as number;
    const pp = popPct[i] as number;
    const w = tau > 0 ? clamp(pp / tau, 0, 1) : 1;
    const n = b.cellCount + h.cellCount;
    const tile: LiftTile = {
      geohash: g,
      lat: (b.lat * b.cellCount + h.lat * h.cellCount) / n,
      lon: (b.lon * b.cellCount + h.lon * h.cellCount) / n,
      lift: liftScore(bp, hp, { smoothing, weight: w }),
      billPct: bp,
      housePct: hp,
      popularityPct: pp,
    };
    if (opts.adultPopulation) tile.adultPopulation = lookupAdults(opts.adultPopulation, { geohash: g, lat: tile.lat, lon: tile.lon });
    return tile;
  });
  tiles.sort(compareLiftTiles);
  return tiles;
}

/** Applies the top-tile criteria to tiles from `computeLiftAll`. Keeps the input order. */
export function selectTopTiles(all: readonly LiftTile[], opts: LiftOptions = {}): LiftTile[] {
  const minLift = isFiniteNumber(opts.minLift) ? opts.minLift : LIFT_DEFAULTS.minLift;
  const minAdults = isFiniteNumber(opts.minAdults) ? opts.minAdults : LIFT_DEFAULTS.minAdults;
  const minBillPct = billFloorOf(opts);
  const unknown = opts.unknownAdults ?? "keep";
  const maxTiles = isFiniteNumber(opts.maxTiles) ? Math.max(0, Math.floor(opts.maxTiles)) : Number.POSITIVE_INFINITY;
  const out: LiftTile[] = [];
  for (const t of all) {
    if (out.length >= maxTiles) break;
    if (!isFiniteNumber(t.lift) || t.lift < minLift - EPS) continue;
    if (t.billPct < minBillPct - EPS) continue;
    let adults: number | null | undefined = t.adultPopulation;
    if (adults === undefined && opts.adultPopulation) adults = lookupAdults(opts.adultPopulation, t);
    if (adults !== undefined) {
      if (adults === null) {
        if (unknown === "drop") continue;
      } else if (adults < minAdults) {
        continue;
      }
    }
    out.push(adults === undefined || t.adultPopulation !== undefined ? t : { ...t, adultPopulation: adults });
  }
  return out;
}

/** Top lift tiles (lift >= minLift, bill floor, adults above the floor), sorted by lift descending. */
export function computeLift(bill: readonly HeatCell[], house: readonly HeatCell[], opts: LiftOptions = {}): LiftTile[] {
  return selectTopTiles(computeLiftAll(bill, house, opts), opts);
}

export interface LiftDiagnostics {
  /** Spearman(lift, raw heat) over the joined tiles. Null when fewer than 3 tiles or no variance. */
  spearmanLiftVsHeat: number | null;
  /** True when Spearman > threshold: lift is roughly density, so fall back to near-venue partner ranking. */
  liftWeak: boolean;
  /** True when fewer than 3 tiles could be compared. */
  insufficient: boolean;
  n: number;
  threshold: number;
  /** "bill" = the bill's own heat; "baseline" = a separate raw-heat map (e.g. the generic restaurant heatmap). */
  heatSource: "bill" | "baseline";
  /**
   * Spearman(lift, the bill's own heat percentile) over the joined tiles: the statistic the KG2 gate
   * uses. Near 1, the map shows where this bill's crowd is rather than where it stands out from the
   * baseline (Oct 15, probe 6: a comedian's map against the restaurant baseline gave 0.98).
   */
  spearmanLiftVsBillHeat: number | null;
  /** True when spearmanLiftVsBillHeat > threshold. */
  tracksOwnHeat: boolean;
}

/**
 * Spearman(lift, raw heat). Raw heat is the bill's own affinity unless a
 * baseline heatmap (generic foot-traffic signal) is given.
 */
export function liftDiagnostics(
  tiles: readonly LiftTile[],
  rawHeat?: readonly HeatCell[] | null,
  opts: { weakThreshold?: number } = {},
): LiftDiagnostics {
  const threshold = isFiniteNumber(opts.weakThreshold) ? opts.weakThreshold : LIFT_DEFAULTS.weakThreshold;
  const lifts: number[] = [];
  const heats: number[] = [];
  let heatSource: LiftDiagnostics["heatSource"] = "bill";
  if (rawHeat && rawHeat.length > 0) {
    heatSource = "baseline";
    const agg = new Map(aggregateToGeohash6(rawHeat).map((c) => [c.geohash, c.affinity]));
    for (const t of tiles) {
      const h = agg.get(t.geohash);
      if (h !== undefined && isFiniteNumber(t.lift)) {
        lifts.push(t.lift);
        heats.push(h);
      }
    }
  } else {
    for (const t of tiles) {
      if (isFiniteNumber(t.lift) && isFiniteNumber(t.billPct)) {
        lifts.push(t.lift);
        heats.push(t.billPct);
      }
    }
  }
  const n = lifts.length;
  const rho = n >= 3 ? spearman(lifts, heats) : null;
  const own = liftVsOwnHeat(tiles);
  return {
    spearmanLiftVsHeat: rho,
    liftWeak: rho !== null && rho > threshold,
    insufficient: n < 3,
    n,
    threshold,
    heatSource,
    spearmanLiftVsBillHeat: own,
    tracksOwnHeat: own !== null && own > threshold,
  };
}

/** Spearman(lift, bill percentile) over the tiles; null with fewer than 3 tiles or no variance. */
export function liftVsOwnHeat(tiles: readonly LiftTile[]): number | null {
  const lifts: number[] = [];
  const heats: number[] = [];
  for (const t of tiles) {
    if (isFiniteNumber(t.lift) && isFiniteNumber(t.billPct)) {
      lifts.push(t.lift);
      heats.push(t.billPct);
    }
  }
  return lifts.length >= 3 ? spearman(lifts, heats) : null;
}

/**
 * Splits seeds into two disjoint halves, the same way every time: distinct
 * keys ordered by their FNV-1a hash (ties by key), then dealt alternately.
 * The first half gets the extra item when the count is odd. Fewer than two
 * distinct keys give an empty second half.
 */
export function splitHalves<T>(items: readonly T[], key: (item: T) => string): [T[], T[]] {
  const seen = new Set<string>();
  const unique: { item: T; k: string; h: number }[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push({ item, k, h: seedFromString(k) });
  }
  unique.sort((a, b) => a.h - b.h || cmpStr(a.k, b.k));
  const first: T[] = [];
  const second: T[] = [];
  unique.forEach((u, i) => (i % 2 === 0 ? first : second).push(u.item));
  return [first, second];
}

export interface SplitHalfInput {
  billA: readonly HeatCell[];
  billB: readonly HeatCell[];
  /** House heat for each half. Pass the full house map to both when the house cannot be split (one genre tag). */
  houseA: readonly HeatCell[];
  houseB: readonly HeatCell[];
  /**
   * What the two halves are compared on. "lift" (default) needs two house halves. When both halves share one
   * house map, the shared denominator correlates the two lift maps even on noise, so "partial" (the default
   * whenever houseA and houseB are the same array) compares the halves' own bill percentiles with the shared
   * house percentile partialled out.
   */
  compare?: "lift" | "partial";
}

export interface SplitHalfResult {
  /** Spearman of the two halves' lift on the tiles both share. Null with fewer than 3 shared tiles or no variance. */
  spearman: number | null;
  /** Tiles both halves share. */
  n: number;
  threshold: number;
  /** spearman > threshold; null when the statistic is undefined. */
  pass: boolean | null;
}

/** Lift per half, then Spearman between the halves on their shared tiles (a partial Spearman of bill percentiles when the house is shared). */
export function splitHalfAgreement(input: SplitHalfInput, opts: LiftOptions & { minSplitHalf?: number } = {}): SplitHalfResult {
  const threshold = isFiniteNumber(opts.minSplitHalf) ? opts.minSplitHalf : LIFT_DEFAULTS.minSplitHalf;
  const by = input.compare ?? (input.houseA === input.houseB ? "partial" : "lift");
  const a = computeLiftAll(input.billA, input.houseA, opts);
  const b = new Map(computeLiftAll(input.billB, input.houseB, opts).map((t) => [t.geohash, t]));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const t of a) {
    const other = b.get(t.geohash);
    if (!other) continue;
    const [x, y] = by === "lift" ? [t.lift, other.lift] : [t.billPct, other.billPct];
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(t.housePct)) continue;
    xs.push(x);
    ys.push(y);
    zs.push(t.housePct);
  }
  let rho: number | null = null;
  if (xs.length >= 3) {
    if (by === "lift") rho = spearman(xs, ys);
    else {
      // Partial Spearman of the two bill halves given the shared house rank.
      const rxy = spearman(xs, ys);
      const rxz = spearman(xs, zs) ?? 0;
      const ryz = spearman(ys, zs) ?? 0;
      const den = Math.sqrt(Math.max(0, (1 - rxz * rxz) * (1 - ryz * ryz)));
      rho = rxy === null || den < 1e-9 ? null : Math.max(-1, Math.min(1, (rxy - rxz * ryz) / den));
    }
  }
  return { spearman: rho, n: xs.length, threshold, pass: rho === null ? null : rho > threshold };
}

export interface LiftMapResult {
  /** Every joined tile, sorted by lift. */
  all: LiftTile[];
  /** Tiles that pass the top-tile criteria, sorted by lift. */
  top: LiftTile[];
  diagnostics: LiftDiagnostics;
  coverage: { billCells: number; houseCells: number; billTiles: number; houseTiles: number; joinedTiles: number };
}

/** One call for the orchestrator: aggregate, join, lift, top tiles and diagnostics. */
export function computeLiftMap(
  bill: readonly HeatCell[],
  house: readonly HeatCell[],
  opts: LiftOptions & { rawHeat?: readonly HeatCell[] | null; weakThreshold?: number } = {},
): LiftMapResult {
  const aggB = aggregateToGeohash6(bill ?? []);
  const aggH = aggregateToGeohash6(house ?? []);
  const all = liftFromAggregates(aggB, aggH, opts);
  const top = selectTopTiles(all, opts);
  const diagOpts: { weakThreshold?: number } = {};
  if (opts.weakThreshold !== undefined) diagOpts.weakThreshold = opts.weakThreshold;
  return {
    all,
    top,
    diagnostics: liftDiagnostics(all, opts.rawHeat ?? null, diagOpts),
    coverage: {
      billCells: (bill ?? []).length,
      houseCells: (house ?? []).length,
      billTiles: aggB.length,
      houseTiles: aggH.length,
      joinedTiles: all.length,
    },
  };
}
