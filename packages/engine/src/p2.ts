/**
 * "Same room, different crowd" metrics: specificity, taste dependence,
 * stability above chance and grounding, over real nights at one venue.
 */
import { isFiniteNumber, mean } from "./num";
import { jaccard, permutationTest, topK, type PermutationTestResult } from "./stats";

/** Mean Jaccard of the top-k lists over every pair of nights. Null with fewer than 2 lists. Lower = more specific. */
export function meanPairwiseJaccard(lists: readonly (readonly string[])[], k = 8): number | null {
  if (lists.length < 2) return null;
  const tops = lists.map((l) => topK(l, k));
  const vals: number[] = [];
  for (let i = 0; i < tops.length; i++) {
    for (let j = i + 1; j < tops.length; j++) vals.push(jaccard(tops[i] as string[], tops[j] as string[]));
  }
  return mean(vals);
}

/** 1 - Jaccard of the two top-k lists (0 = identical, 1 = disjoint). */
export function listDistance(a: readonly string[], b: readonly string[], k = 8): number {
  return 1 - jaccard(topK(a, k), topK(b, k));
}

/** Expected overlap of two independent random k-subsets of a pool of size N: k^2 / N. */
export function chanceTopKOverlap(k: number, poolSize: number): number {
  if (!isFiniteNumber(k) || !isFiniteNumber(poolSize) || poolSize <= 0 || k <= 0) return 0;
  const kk = Math.min(k, poolSize);
  return (kk * kk) / poolSize;
}

export interface TasteDependenceResult extends PermutationTestResult {
  /** True when Q-vs-S distances are not significantly larger than Q-vs-Q: the sheet would be decorative. */
  decorative: boolean;
  alpha: number;
}

/**
 * Taste dependence: are distances between Q and the shuffled-bill arm S larger
 * than distances between two Q runs? One-sided permutation test on the mean.
 */
export function tasteDependence(
  qVsS: readonly number[],
  qVsQ: readonly number[],
  opts: { iterations?: number; seed?: number; alpha?: number } = {},
): TasteDependenceResult {
  const alpha = isFiniteNumber(opts.alpha) ? opts.alpha : 0.05;
  const pt: { iterations?: number; seed?: number; alternative: "greater" } = { alternative: "greater" };
  if (opts.iterations !== undefined) pt.iterations = opts.iterations;
  if (opts.seed !== undefined) pt.seed = opts.seed;
  const res = permutationTest(qVsS, qVsQ, pt);
  return { ...res, alpha, decorative: !(res.observed !== null && res.observed > 0 && res.pValue < alpha) };
}

/** Split-seed stability: mean top-k overlap (headliner-only vs full bill) against the chance level. */
export function stabilityAboveChance(
  overlaps: readonly number[],
  k: number,
  poolSize: number,
): { meanOverlap: number | null; chance: number; aboveChance: boolean } {
  const m = mean(overlaps.filter((o) => isFiniteNumber(o)));
  const chance = chanceTopKOverlap(k, poolSize);
  return { meanOverlap: m, chance, aboveChance: m !== null && m > chance };
}

export interface GroundingCheck {
  exists: boolean | null;
  openOnNight: boolean | null;
  withinRadius: boolean | null;
  rightCategory: boolean | null;
}

export interface GroundingRates {
  n: number;
  exists: number | null;
  openOnNight: number | null;
  withinRadius: number | null;
  rightCategory: number | null;
  /** Share of rows where every checked criterion passed (unchecked criteria are skipped). */
  allPass: number | null;
}

/** Percentages (0..1) per grounding criterion; null criteria are excluded from that criterion's denominator. */
export function groundingRates(rows: readonly GroundingCheck[]): GroundingRates {
  const rate = (key: keyof GroundingCheck): number | null => {
    const vals = rows.map((r) => r[key]).filter((v): v is boolean => typeof v === "boolean");
    return vals.length === 0 ? null : vals.filter(Boolean).length / vals.length;
  };
  const checkedRows = rows.filter((r) => Object.values(r).some((v) => typeof v === "boolean"));
  const allPass =
    checkedRows.length === 0 ? null : checkedRows.filter((r) => Object.values(r).every((v) => v !== false)).length / checkedRows.length;
  return {
    n: rows.length,
    exists: rate("exists"),
    openOnNight: rate("openOnNight"),
    withinRadius: rate("withinRadius"),
    rightCategory: rate("rightCategory"),
    allPass,
  };
}
