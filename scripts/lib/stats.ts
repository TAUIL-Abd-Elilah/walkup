/**
 * Small rank statistics for the probe script. Pure functions, no dependencies.
 *
 * Convention: when a statistic is undefined (fewer than two points, zero
 * variance, empty sets) the function returns NaN. Callers treat NaN as
 * "inconclusive", never as a pass.
 */

/** Average ranks (1-based); tied values share the mean of their positions. */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.v === order[start]!.v) end++;
    const avg = (start + end) / 2 + 1;
    for (let k = start; k <= end; k++) out[order[k]!.i] = avg;
    start = end + 1;
  }
  return out;
}

/** Percentile rank in (0, 1]: average rank divided by n. Highest value gets 1. */
export function pctRank(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  return ranks(values).map((r) => r / n);
}

/** Pearson correlation. NaN when n < 2 or either side has zero variance. */
export function pearson(x: readonly number[], y: readonly number[]): number {
  assertSameLength(x, y);
  const n = x.length;
  if (n < 2) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation (Pearson on average ranks, so ties are handled). */
export function spearman(x: readonly number[], y: readonly number[]): number {
  assertSameLength(x, y);
  if (x.length < 2) return NaN;
  return pearson(ranks(x), ranks(y));
}

/** Kendall tau-b (tie-corrected). O(n^2), fine for the pool sizes the probe uses. */
export function kendallTau(x: readonly number[], y: readonly number[]): number {
  assertSameLength(x, y);
  const n = x.length;
  if (n < 2) return NaN;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[i]! - x[j]!);
      const dy = Math.sign(y[i]! - y[j]!);
      if (dx === 0) tiesX++;
      if (dy === 0) tiesY++;
      if (dx === 0 || dy === 0) continue;
      if (dx === dy) concordant++;
      else discordant++;
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - tiesX) * (n0 - tiesY));
  if (denom === 0) return NaN;
  return (concordant - discordant) / denom;
}

/**
 * Kendall tau-b between two orderings of ids (best first), computed over the
 * ids both orderings contain. Returns the tau and how many ids were compared.
 */
export function kendallTauFromOrders(a: readonly string[], b: readonly string[]): { tau: number; n: number } {
  const posB = new Map<string, number>();
  b.forEach((id, i) => {
    if (!posB.has(id)) posB.set(id, i);
  });
  const xs: number[] = [];
  const ys: number[] = [];
  const seen = new Set<string>();
  a.forEach((id, i) => {
    const j = posB.get(id);
    if (j === undefined || seen.has(id)) return;
    seen.add(id);
    xs.push(i);
    ys.push(j);
  });
  return { tau: kendallTau(xs, ys), n: xs.length };
}

/** How many of the first k ids of `a` are also among the first k ids of `b`. */
export function topKOverlap(a: readonly string[], b: readonly string[], k: number): number {
  if (k <= 0) return 0;
  const top = new Set(b.slice(0, k));
  let hits = 0;
  for (const id of new Set(a.slice(0, k))) if (top.has(id)) hits++;
  return hits;
}

/** Jaccard index |A n B| / |A u B|. NaN when both sets are empty. */
export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return NaN;
  return inter / union;
}

function assertSameLength(x: readonly number[], y: readonly number[]): void {
  if (x.length !== y.length) throw new RangeError(`length mismatch: ${x.length} vs ${y.length}`);
}
