/**
 * Budget split across the top tiles: lift x ACS adults 21+, labelled a heuristic. The tiles come in area order
 * (area 1 first), and the shares never rise down that order: where a later area would get more than an earlier
 * one (more adults), the run of areas is levelled to its average (pool-adjacent violators), so the money follows
 * the order the sheet recommends. Shares still sum to 1 and keep the floor.
 */
import type { LiftTile } from "@walkup/contracts";
import { budgetSplit } from "@walkup/engine";

export interface BudgetShare {
  geohash: string;
  share: number;
  label: "heuristic, not a forecast";
}

export const BUDGET_TILES = 5;
export const BUDGET_MIN_SHARE = 0.1;

/** Non-increasing fit of `values` in order (pool-adjacent violators, equal weights); the sum is kept. */
export function nonIncreasing(values: readonly number[]): number[] {
  const blocks: { sum: number; n: number }[] = [];
  for (const v of values) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1] as { sum: number; n: number };
      const a = blocks[blocks.length - 2] as { sum: number; n: number };
      if (a.sum / a.n >= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => new Array<number>(b.n).fill(b.sum / b.n));
}

export function splitBudget(top: LiftTile[]): BudgetShare[] {
  const tiles = top.slice(0, BUDGET_TILES);
  if (tiles.length === 0) return [];
  const rows = budgetSplit(tiles, (t) => t.adultPopulation ?? null, BUDGET_MIN_SHARE);
  const level = nonIncreasing(rows.map((r) => r.share));
  // Rounded to 3 decimals; the last share absorbs rounding so the sum stays 1.
  const out = rows.map((r, i) => ({ ...r, share: Math.round((level[i] ?? r.share) * 1000) / 1000 }));
  const sum = out.reduce((s, r) => s + r.share, 0);
  const last = out[out.length - 1];
  if (last) last.share = Math.round((last.share + (1 - sum)) * 1000) / 1000;
  return out;
}
