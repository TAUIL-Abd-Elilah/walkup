/**
 * Rank statistics and set overlaps used by the lift diagnostics, the day-one
 * probe evaluators (KG1/KG2) and the P2 metrics. Pure and deterministic.
 */
import { EPS, mean } from "./num";
import { mulberry32, shuffleInPlace } from "./rng";

/**
 * 1-based average ranks (ties share the mean of their positions). Ascending:
 * the smallest value gets rank 1. Non-finite values must be filtered first.
 */
export function averageRanks(values: readonly number[]): number[] {
  const n = values.length;
  const idx = values.map((_, i) => i);
  idx.sort((a, b) => {
    const va = values[a] as number;
    const vb = values[b] as number;
    return va < vb ? -1 : va > vb ? 1 : a - b;
  });
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    const v = values[idx[i] as number] as number;
    while (j + 1 < n && (values[idx[j + 1] as number] as number) === v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k] as number] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Percentile rank in (0, 1]: average rank divided by n. The smallest of n
 * distinct values gets 1/n and the largest gets 1, so it is never zero and is
 * safe as a denominator. Non-finite inputs get NaN and are not counted in n.
 */
export function pctRanks(values: readonly number[]): number[] {
  const finiteIdx: number[] = [];
  const finiteVals: number[] = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) {
      finiteIdx.push(i);
      finiteVals.push(v);
    }
  });
  const out = new Array<number>(values.length).fill(Number.NaN);
  const n = finiteVals.length;
  if (n === 0) return out;
  const r = averageRanks(finiteVals);
  finiteIdx.forEach((orig, k) => {
    out[orig] = (r[k] as number) / n;
  });
  return out;
}

function finitePairs(x: readonly number[], y: readonly number[]): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const a = x[i] as number;
    const b = y[i] as number;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      xs.push(a);
      ys.push(b);
    }
  }
  return { xs, ys };
}

/** Pearson correlation over finite pairs. Null when n < 2 or either side has zero variance. */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const { xs, ys } = finitePairs(x, y);
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs) as number;
  const my = mean(ys) as number;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/** Spearman rank correlation (Pearson on average ranks, so ties are handled). */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  const { xs, ys } = finitePairs(x, y);
  if (xs.length < 2) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/** Kendall tau-b over finite pairs (tie-corrected). Null when undefined. O(n^2). */
export function kendallTau(x: readonly number[], y: readonly number[]): number | null {
  const { xs, ys } = finitePairs(x, y);
  const n = xs.length;
  if (n < 2) return null;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign((xs[i] as number) - (xs[j] as number));
      const dy = Math.sign((ys[i] as number) - (ys[j] as number));
      if (dx === 0) tiesX++;
      if (dy === 0) tiesY++;
      if (dx !== 0 && dy !== 0) {
        if (dx === dy) concordant++;
        else discordant++;
      }
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - tiesX) * (n0 - tiesY));
  if (denom === 0) return null;
  return (concordant - discordant) / denom;
}

/** Positions (0-based) of the items both rankings contain, in `a`'s order. Duplicates keep their first position. */
export function commonPositions(a: readonly string[], b: readonly string[]): { ids: string[]; posA: number[]; posB: number[] } {
  const firstB = new Map<string, number>();
  b.forEach((id, i) => {
    if (!firstB.has(id)) firstB.set(id, i);
  });
  const seen = new Set<string>();
  const ids: string[] = [];
  const posA: number[] = [];
  const posB: number[] = [];
  a.forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    const j = firstB.get(id);
    if (j === undefined) return;
    ids.push(id);
    posA.push(i);
    posB.push(j);
  });
  return { ids, posA, posB };
}

/** Kendall tau between two rank orders, over the items they share. */
export function kendallTauRankings(a: readonly string[], b: readonly string[]): number | null {
  const { posA, posB } = commonPositions(a, b);
  return kendallTau(posA, posB);
}

/** Spearman between two rank orders, over the items they share. */
export function spearmanRankings(a: readonly string[], b: readonly string[]): number | null {
  const { posA, posB } = commonPositions(a, b);
  return spearman(posA, posB);
}

/** Size of the intersection over size of the union. Two empty sets are identical, so the result is 1. */
export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** First k distinct items of a ranked list. */
export function topK<T>(list: readonly T[], k: number): T[] {
  const out: T[] = [];
  const kk = Math.max(0, Math.floor(k));
  const seen = new Set<T>();
  for (const x of list) {
    if (out.length >= kk) break;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** Count of items that appear in both top-k lists (0..k). Duplicates are counted once. */
export function topKOverlap<T>(a: readonly T[], b: readonly T[], k: number): number {
  const sb = new Set(topK(b, k));
  let n = 0;
  for (const x of topK(a, k)) if (sb.has(x)) n++;
  return n;
}

export type Alternative = "two-sided" | "greater" | "less";

export interface PermutationTestOptions {
  /** Number of random relabellings. Default 9,999. */
  iterations?: number;
  /** Seed for the resampling RNG. Default 1. */
  seed?: number;
  /** "greater" tests statistic(a, b) > 0 (with the default mean-difference statistic: mean(a) > mean(b)). */
  alternative?: Alternative;
  /** Default: mean(a) - mean(b). */
  statistic?: (a: number[], b: number[]) => number;
}

export interface PermutationTestResult {
  observed: number | null;
  pValue: number;
  iterations: number;
  alternative: Alternative;
}

export function meanDifference(a: number[], b: number[]): number {
  return (mean(a) ?? Number.NaN) - (mean(b) ?? Number.NaN);
}

/**
 * Two-sample permutation test. The p-value uses the (count + 1) / (iterations + 1)
 * correction, so it is never zero. Seeded, so results are reproducible.
 */
export function permutationTest(a: readonly number[], b: readonly number[], opts: PermutationTestOptions = {}): PermutationTestResult {
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 9999));
  const alternative = opts.alternative ?? "two-sided";
  const stat = opts.statistic ?? meanDifference;
  const fa = a.filter((v) => Number.isFinite(v));
  const fb = b.filter((v) => Number.isFinite(v));
  if (fa.length === 0 || fb.length === 0) return { observed: null, pValue: 1, iterations: 0, alternative };
  const observed = stat([...fa], [...fb]);
  if (!Number.isFinite(observed)) return { observed: null, pValue: 1, iterations: 0, alternative };
  const pooled = [...fa, ...fb];
  const rng = mulberry32(opts.seed ?? 1);
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    shuffleInPlace(pooled, rng);
    const s = stat(pooled.slice(0, fa.length), pooled.slice(fa.length));
    const hit =
      alternative === "greater"
        ? s >= observed - EPS
        : alternative === "less"
          ? s <= observed + EPS
          : Math.abs(s) >= Math.abs(observed) - EPS;
    if (hit) extreme++;
  }
  return { observed, pValue: (extreme + 1) / (iterations + 1), iterations, alternative };
}
