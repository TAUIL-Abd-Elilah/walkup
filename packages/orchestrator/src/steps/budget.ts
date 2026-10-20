/** Budget split across the top tiles: lift x ACS adults 21+, labelled a heuristic. */
import type { LiftTile } from "@walkup/contracts";
import { budgetSplit } from "@walkup/engine";

export interface BudgetShare {
  geohash: string;
  share: number;
  label: "heuristic, not a forecast";
}

export const BUDGET_TILES = 5;
export const BUDGET_MIN_SHARE = 0.1;

export function splitBudget(top: LiftTile[]): BudgetShare[] {
  const tiles = top.slice(0, BUDGET_TILES);
  if (tiles.length === 0) return [];
  const rows = budgetSplit(tiles, (t) => t.adultPopulation ?? null, BUDGET_MIN_SHARE);
  // Rounded to 3 decimals; the last share absorbs rounding so the sum stays 1.
  const out = rows.map((r) => ({ ...r, share: Math.round(r.share * 1000) / 1000 }));
  const sum = out.reduce((s, r) => s + r.share, 0);
  const last = out[out.length - 1];
  if (last) last.share = Math.round((last.share + (1 - sum)) * 1000) / 1000;
  return out;
}
