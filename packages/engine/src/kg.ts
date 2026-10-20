/**
 * Go/no-go evaluators for the day-one probes.
 *
 * KG1 "taste moves partners": at each venue, one pool of the same places is
 * scored for two contrasting bills and once with no signal (popularity only).
 *   pass when Kendall tau(bill A, bill B) < 0.8
 *        and top-8 overlap(bill A, bill B) <= 5
 *        and top-8 overlap(bill X, popularity) <= 5 for both bills.
 *
 * KG2 "lift differs from heat and holds up": bill vs house vs a generic
 * (raw-heat) heatmap around one venue, for two bills.
 *   pass when Spearman(lift, raw heat) < 0.8 for both bills
 *        and Jaccard of the two bills' top-decile lift tiles < 0.5
 *        and, for both bills, the split-half Spearman > 0.5: lift built from
 *        one half of the bill's seeds (against one half of the house's)
 *        agrees with lift built from the other halves on their shared tiles.
 *        A bill without halves (one seed) fails unless requireSplitHalf is false.
 */
import type { HeatCell } from "@walkup/contracts";
import { computeLiftAll, LIFT_DEFAULTS, liftDiagnostics, splitHalfAgreement, type LiftOptions } from "./lift";
import { isFiniteNumber } from "./num";
import { jaccard, kendallTauRankings, topKOverlap } from "./stats";

export const KG1_THRESHOLDS = { k: 8, maxTau: 0.8, maxOverlap: 5 } as const;
export const KG2_THRESHOLDS = { maxSpearman: 0.8, maxJaccard: 0.5, topFraction: 0.1, minSplitHalf: LIFT_DEFAULTS.minSplitHalf } as const;

export interface KG1VenueInput {
  venue: string;
  /** Entity ids in rank order for bill A (scored via filter.results.entities). */
  billA: readonly string[];
  billB: readonly string[];
  /** Same pool with no signal (popularity order). */
  popularity: readonly string[];
}

export interface KG1VenueResult {
  venue: string;
  kendallTauBills: number | null;
  topOverlapBills: number;
  topOverlapAVsPop: number;
  topOverlapBVsPop: number;
  commonItems: number;
  pass: boolean;
  failures: string[];
}

export interface KG1Result {
  pass: boolean;
  venuesPassed: number;
  venues: KG1VenueResult[];
  thresholds: { k: number; maxTau: number; maxOverlap: number; requireAll: boolean };
}

export function evaluateKG1(
  venues: readonly KG1VenueInput[],
  opts: { k?: number; maxTau?: number; maxOverlap?: number; requireAll?: boolean } = {},
): KG1Result {
  const k = isFiniteNumber(opts.k) ? Math.max(1, Math.floor(opts.k)) : KG1_THRESHOLDS.k;
  const maxTau = isFiniteNumber(opts.maxTau) ? opts.maxTau : KG1_THRESHOLDS.maxTau;
  const maxOverlap = isFiniteNumber(opts.maxOverlap) ? opts.maxOverlap : KG1_THRESHOLDS.maxOverlap;
  const requireAll = opts.requireAll ?? true;
  const results = venues.map((v): KG1VenueResult => {
    const tau = kendallTauRankings(v.billA, v.billB);
    const common = new Set(v.billA.filter((id) => v.billB.includes(id))).size;
    const oBills = topKOverlap(v.billA, v.billB, k);
    const oA = topKOverlap(v.billA, v.popularity, k);
    const oB = topKOverlap(v.billB, v.popularity, k);
    const failures: string[] = [];
    if (tau === null) failures.push("Kendall tau undefined (fewer than 2 shared items or no variation)");
    else if (!(tau < maxTau)) failures.push(`Kendall tau ${tau.toFixed(3)} >= ${maxTau}`);
    if (oBills > maxOverlap) failures.push(`top-${k} overlap between bills ${oBills}/${k} > ${maxOverlap}`);
    if (oA > maxOverlap) failures.push(`top-${k} overlap bill A vs popularity ${oA}/${k} > ${maxOverlap}`);
    if (oB > maxOverlap) failures.push(`top-${k} overlap bill B vs popularity ${oB}/${k} > ${maxOverlap}`);
    if (v.billA.length < k || v.billB.length < k) failures.push(`fewer than ${k} ranked items`);
    return {
      venue: v.venue,
      kendallTauBills: tau,
      topOverlapBills: oBills,
      topOverlapAVsPop: oA,
      topOverlapBVsPop: oB,
      commonItems: common,
      pass: failures.length === 0,
      failures,
    };
  });
  const passed = results.filter((r) => r.pass).length;
  const pass = results.length > 0 && (requireAll ? passed === results.length : passed * 2 > results.length);
  return { pass, venuesPassed: passed, venues: results, thresholds: { k, maxTau, maxOverlap, requireAll } };
}

/** Heat for each half of the bill's seeds, and of the house's (omit the house halves when the house is one tag). */
export interface KG2Halves {
  billA: readonly HeatCell[];
  billB: readonly HeatCell[];
  houseA?: readonly HeatCell[];
  houseB?: readonly HeatCell[];
}

export interface KG2BillInput {
  label: string;
  heat: readonly HeatCell[];
  /** Split-half heatmaps. Absent when the bill has one seed. */
  halves?: KG2Halves | null;
}

export interface KG2BillResult {
  label: string;
  spearmanLiftVsHeat: number | null;
  /** Spearman between the two halves' lift; null when not run or undefined. */
  splitHalfSpearman: number | null;
  tiles: number;
  topTiles: string[];
  pass: boolean;
}

export interface KG2Result {
  pass: boolean;
  bills: KG2BillResult[];
  topDecileJaccard: number | null;
  failures: string[];
  thresholds: { maxSpearman: number; maxJaccard: number; topFraction: number; minSplitHalf: number };
}

/**
 * `generic` is the raw-heat baseline (e.g. a restaurant-tag heatmap). Without it
 * each bill's own heat is used as raw heat. Each bill's `halves` feed the
 * split-half check; house halves default to the full house map.
 */
export function evaluateKG2(
  input: { house: readonly HeatCell[]; generic?: readonly HeatCell[] | null; bills: readonly KG2BillInput[] },
  opts: { liftOptions?: LiftOptions; maxSpearman?: number; maxJaccard?: number; topFraction?: number; minSplitHalf?: number; requireSplitHalf?: boolean } = {},
): KG2Result {
  const maxSpearman = isFiniteNumber(opts.maxSpearman) ? opts.maxSpearman : KG2_THRESHOLDS.maxSpearman;
  const maxJaccard = isFiniteNumber(opts.maxJaccard) ? opts.maxJaccard : KG2_THRESHOLDS.maxJaccard;
  const topFraction = isFiniteNumber(opts.topFraction) ? Math.min(1, Math.max(0, opts.topFraction)) : KG2_THRESHOLDS.topFraction;
  const minSplitHalf = isFiniteNumber(opts.minSplitHalf) ? opts.minSplitHalf : KG2_THRESHOLDS.minSplitHalf;
  const requireSplitHalf = opts.requireSplitHalf ?? true;
  const liftOptions = opts.liftOptions ?? {};
  const failures: string[] = [];
  const bills = input.bills.map((b): KG2BillResult => {
    const all = computeLiftAll(b.heat, input.house, liftOptions);
    const diag = liftDiagnostics(all, input.generic ?? null, { weakThreshold: maxSpearman });
    const nTop = all.length === 0 ? 0 : Math.max(1, Math.ceil(all.length * topFraction));
    const rho = diag.spearmanLiftVsHeat;
    let pass = rho !== null && rho < maxSpearman;
    if (rho === null) failures.push(`${b.label}: Spearman undefined (${diag.n} comparable tiles)`);
    else if (!pass) failures.push(`${b.label}: Spearman(lift, raw heat) ${rho.toFixed(3)} >= ${maxSpearman}`);
    let split: number | null = null;
    if (b.halves) {
      const r = splitHalfAgreement(
        { billA: b.halves.billA, billB: b.halves.billB, houseA: b.halves.houseA ?? input.house, houseB: b.halves.houseB ?? input.house },
        { ...liftOptions, minSplitHalf },
      );
      split = r.spearman;
      if (split === null) {
        failures.push(`${b.label}: split-half Spearman undefined (${r.n} shared tiles)`);
        pass = false;
      } else if (!(split > minSplitHalf)) {
        failures.push(`${b.label}: split-half Spearman ${split.toFixed(3)} <= ${minSplitHalf}`);
        pass = false;
      }
    } else if (requireSplitHalf) {
      failures.push(`${b.label}: split-half check not run (needs two halves of seeds)`);
      pass = false;
    }
    return { label: b.label, spearmanLiftVsHeat: rho, splitHalfSpearman: split, tiles: all.length, topTiles: all.slice(0, nTop).map((t) => t.geohash), pass };
  });
  let jac: number | null = null;
  if (bills.length >= 2) {
    jac = jaccard((bills[0] as KG2BillResult).topTiles, (bills[1] as KG2BillResult).topTiles);
    if (!(jac < maxJaccard)) failures.push(`top-decile tile Jaccard ${jac.toFixed(3)} >= ${maxJaccard}`);
  } else {
    failures.push("KG2 needs two bills");
  }
  return { pass: failures.length === 0, bills, topDecileJaccard: jac, failures, thresholds: { maxSpearman, maxJaccard, topFraction, minSplitHalf } };
}
