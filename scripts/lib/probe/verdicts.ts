/**
 * Pure gate arithmetic for the go/no-go probes. Inputs are id orders and heat
 * cells already extracted in memory; outputs are derived numbers only.
 */

import { jaccard, kendallTauFromOrders, spearman, topKOverlap } from "../stats.js";
import type { CellLite } from "./extract.js";
import { aggregateTiles, computeLift, topFraction } from "./heat.js";

// ---------------------------------------------------------------------------
// KG1: does the bill move the ranking of one fixed pool of places?
// ---------------------------------------------------------------------------

export interface Kg1Thresholds {
  topK: number;
  maxTau: number;
  maxTopKOverlap: number;
  minPool: number;
  minCoverage: number;
}

export interface Kg1VenueMetrics {
  poolSize: number;
  coverageA: number;
  coverageB: number;
  tauAB: number;
  tauN: number;
  topKAB: number;
  topKAvsPop: number;
  topKBvsPop: number;
  evaluable: boolean;
  pass: boolean;
  reason: string | null;
}

export function kg1Venue(
  poolOrder: readonly string[],
  orderA: readonly string[],
  orderB: readonly string[],
  t: Kg1Thresholds,
): Kg1VenueMetrics {
  const pool = new Set(poolOrder);
  const a = orderA.filter((id) => pool.has(id));
  const b = orderB.filter((id) => pool.has(id));
  const coverageA = pool.size > 0 ? new Set(a).size / pool.size : 0;
  const coverageB = pool.size > 0 ? new Set(b).size / pool.size : 0;
  const { tau, n } = kendallTauFromOrders(a, b);
  const topKAB = topKOverlap(a, b, t.topK);
  const topKAvsPop = topKOverlap(a, poolOrder, t.topK);
  const topKBvsPop = topKOverlap(b, poolOrder, t.topK);
  let reason: string | null = null;
  if (pool.size < t.minPool) reason = `pool has ${pool.size} places (< ${t.minPool})`;
  else if (coverageA < t.minCoverage || coverageB < t.minCoverage)
    reason = `scored calls covered ${pct(coverageA)} / ${pct(coverageB)} of the pool (filter.results.entities may be ignored)`;
  else if (!Number.isFinite(tau)) reason = "tau undefined";
  const evaluable = reason === null;
  const pass =
    evaluable &&
    tau < t.maxTau &&
    topKAB <= t.maxTopKOverlap &&
    topKAvsPop <= t.maxTopKOverlap &&
    topKBvsPop <= t.maxTopKOverlap;
  return { poolSize: pool.size, coverageA, coverageB, tauAB: tau, tauN: n, topKAB, topKAvsPop, topKBvsPop, evaluable, pass, reason };
}

export type GateStatus = "pass" | "fail" | "inconclusive";

export function kg1Gate(venues: readonly Kg1VenueMetrics[], required: number): { status: GateStatus; passed: number; evaluable: number } {
  const evaluable = venues.filter((v) => v.evaluable).length;
  const passed = venues.filter((v) => v.pass).length;
  if (passed >= required) return { status: "pass", passed, evaluable };
  // Enough rooms were measurable and too few passed: a real no-go. Otherwise we lack evidence.
  return { status: evaluable >= required ? "fail" : "inconclusive", passed, evaluable };
}

// ---------------------------------------------------------------------------
// KG2 / KG3: is lift more than raw heat?
// ---------------------------------------------------------------------------

export interface LiftMetrics {
  cells: number;
  tiles: number;
  joined: number;
  spearmanLiftVsHeat: number;
  top: Set<string>;
}

export function liftMetrics(
  bill: readonly CellLite[],
  base: readonly CellLite[],
  opts: { shrinkBelow: number; topFraction: number; minJoined?: number },
): LiftMetrics {
  const billTiles = aggregateTiles(bill);
  const baseTiles = aggregateTiles(base);
  const rows = computeLift(billTiles, baseTiles, { shrinkBelow: opts.shrinkBelow });
  const rho =
    rows.length >= (opts.minJoined ?? 20)
      ? spearman(
          rows.map((r) => r.lift),
          rows.map((r) => r.billHeat),
        )
      : NaN;
  return { cells: bill.length, tiles: billTiles.size, joined: rows.length, spearmanLiftVsHeat: rho, top: topFraction(rows, opts.topFraction) };
}

/** Spearman of two heatmaps' tile affinities on their geohash join (raw heat vs foot-traffic baseline). */
export function heatAgreement(a: readonly CellLite[], b: readonly CellLite[]): { joined: number; rho: number } {
  const ta = aggregateTiles(a);
  const tb = aggregateTiles(b);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [g, t] of ta) {
    const u = tb.get(g);
    if (!u) continue;
    xs.push(t.affinity);
    ys.push(u.affinity);
  }
  return { joined: xs.length, rho: xs.length >= 20 ? spearman(xs, ys) : NaN };
}

export function topJaccard(a: Set<string>, b: Set<string>): number {
  return jaccard(a, b);
}

// ---------------------------------------------------------------------------
// KG4: fan-bar viability
// ---------------------------------------------------------------------------

export interface Kg4Row {
  club: string;
  metro: string;
  barListed: boolean;
  resolved: boolean;
  /** 1-based rank of the bar in the club-signal list for its metro, or null when absent. */
  rank: number | null;
}

export function kg4Gate(rows: readonly Kg4Row[], minResolved: number, minInTop: number): {
  status: GateStatus;
  listed: number;
  resolved: number;
  inTop: number;
} {
  const listed = rows.filter((r) => r.barListed).length;
  const resolved = rows.filter((r) => r.resolved).length;
  const inTop = rows.filter((r) => r.rank !== null).length;
  if (resolved >= minResolved && inTop >= minInTop) return { status: "pass", listed, resolved, inTop };
  if (listed < minResolved) return { status: "inconclusive", listed, resolved, inTop };
  return { status: "fail", listed, resolved, inTop };
}

/**
 * Derby check: inside one metro, does club X's signal rank X's bar above club
 * Y's bar? Pairs where neither bar appears in X's list are skipped.
 */
export function derbyPairs(
  lists: Map<string, readonly string[]>,
  bars: Map<string, string>,
  clubs: readonly string[],
  metros: readonly string[],
): { correct: number; total: number } {
  let correct = 0;
  let total = 0;
  for (const m of metros) {
    for (const x of clubs) {
      const list = lists.get(`${x}|${m}`);
      const own = bars.get(`${x}|${m}`);
      if (!list || !own) continue;
      for (const y of clubs) {
        if (y === x) continue;
        const rival = bars.get(`${y}|${m}`);
        if (!rival || rival === own) continue;
        const ro = list.indexOf(own);
        const rr = list.indexOf(rival);
        if (ro === -1 && rr === -1) continue;
        total++;
        if (ro !== -1 && (rr === -1 || ro < rr)) correct++;
      }
    }
  }
  return { correct, total };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
