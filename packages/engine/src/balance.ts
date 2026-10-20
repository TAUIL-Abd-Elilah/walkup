/**
 * Balance check (self-correction): is one seed of the bill dominating the
 * results? Triggers when one seed's aggregate explainability influence is above
 * 0.7 (only when explainability is informative), or when the headliner alone
 * reproduces the full bill's top 8 (overlap >= 7/8). The correction re-queries
 * without the headliner and merges by rank (`mergeRankedLists`).
 */
import type { QlooEntity } from "@walkup/contracts";
import { cmpStr, isFiniteNumber } from "./num";
import { topKOverlap } from "./stats";

export interface SeedInfluence {
  seedId: string;
  /** Share of all explainability score mass across the results (0..1). */
  share: number;
  total: number;
}

export interface InfluenceSummary {
  /** At least two seeds with non-zero mass and not all shares equal. */
  informative: boolean;
  influence: SeedInfluence[];
}

export function seedInfluence(entities: readonly QlooEntity[]): InfluenceSummary {
  const totals = new Map<string, number>();
  for (const e of entities) {
    for (const c of e?.explainability ?? []) {
      if (!c || typeof c.entityId !== "string" || !isFiniteNumber(c.score) || c.score < 0) continue;
      totals.set(c.entityId, (totals.get(c.entityId) ?? 0) + c.score);
    }
  }
  const all = [...totals.values()].reduce((s, v) => s + v, 0);
  const influence = [...totals.entries()]
    .map(([seedId, total]) => ({ seedId, total, share: all > 0 ? total / all : 0 }))
    .sort((a, b) => b.share - a.share || cmpStr(a.seedId, b.seedId));
  const nonZero = influence.filter((s) => s.total > 0);
  const informative = nonZero.length >= 2 && (influence[0] as SeedInfluence).share - (influence.at(-1) as SeedInfluence).share > 1e-9;
  return { informative, influence };
}

export interface BalanceCheckResult {
  triggered: boolean;
  dominantSeed: string | null;
  reasons: string[];
  influence: InfluenceSummary;
  splitSeedOverlap: number | null;
}

export function balanceCheck(
  entities: readonly QlooEntity[],
  opts: {
    threshold?: number;
    headlinerId?: string;
    splitSeed?: { fullBill: readonly string[]; headlinerOnly: readonly string[]; k?: number; minOverlap?: number };
  } = {},
): BalanceCheckResult {
  const threshold = isFiniteNumber(opts.threshold) ? opts.threshold : 0.7;
  const influence = seedInfluence(entities);
  const reasons: string[] = [];
  let dominantSeed: string | null = null;
  const top = influence.influence[0];
  if (influence.informative && top && top.share > threshold) {
    dominantSeed = top.seedId;
    reasons.push(`one seed carries ${(top.share * 100).toFixed(0)}% of explainability influence`);
  }
  let splitSeedOverlap: number | null = null;
  if (opts.splitSeed) {
    const k = isFiniteNumber(opts.splitSeed.k) ? opts.splitSeed.k : 8;
    const minOverlap = isFiniteNumber(opts.splitSeed.minOverlap) ? opts.splitSeed.minOverlap : 7;
    splitSeedOverlap = topKOverlap(opts.splitSeed.fullBill, opts.splitSeed.headlinerOnly, k);
    if (splitSeedOverlap >= minOverlap) {
      reasons.push(`headliner alone reproduces ${splitSeedOverlap}/${k} of the top ${k}`);
      dominantSeed ??= opts.headlinerId ?? null;
    }
  }
  return { triggered: reasons.length > 0, dominantSeed, reasons, influence, splitSeedOverlap };
}

/**
 * Weighted Borda merge of ranked id lists: an item at 0-based position i in a
 * list of length n earns weight x (1 - i / n). Ties: best single position, then id.
 */
export function mergeRankedLists(lists: readonly { ids: readonly string[]; weight: number }[]): string[] {
  const score = new Map<string, number>();
  const best = new Map<string, number>();
  for (const l of lists) {
    const w = isFiniteNumber(l.weight) && l.weight > 0 ? l.weight : 0;
    const seen = new Set<string>();
    const ids = l.ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    const n = ids.length;
    ids.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + w * (1 - i / n));
      best.set(id, Math.min(best.get(id) ?? Number.MAX_SAFE_INTEGER, i));
    });
  }
  return [...score.keys()].sort(
    (a, b) => (score.get(b) as number) - (score.get(a) as number) || (best.get(a) as number) - (best.get(b) as number) || cmpStr(a, b),
  );
}
