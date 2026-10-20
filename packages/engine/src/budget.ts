/**
 * Budget split across lift tiles. A heuristic, not a forecast:
 *
 *   weight_i = max(lift_i, 0) x adults21_i
 *   share_i  proportional to weight_i, with every tile getting at least `minShare`
 *
 * Unknown adult counts use the mean of the known ones (all unknown: lift only).
 * When n x minShare >= 1 every tile gets 1/n. Shares sum to 1.
 */
import type { LiftTile } from "@walkup/contracts";
import { isFiniteNumber } from "./num";

export const BUDGET_LABEL = "heuristic, not a forecast" as const;

export interface BudgetShare {
  geohash: string;
  share: number;
  label: typeof BUDGET_LABEL;
}

export type Adults21Lookup = (tile: LiftTile) => number | null | undefined;

export function budgetSplit(tiles: readonly LiftTile[], adults21: Adults21Lookup | null | undefined, minShare = 0.1): BudgetShare[] {
  const seen = new Set<string>();
  const uniq = tiles.filter((t) => {
    if (!t || seen.has(t.geohash)) return false;
    seen.add(t.geohash);
    return true;
  });
  const n = uniq.length;
  if (n === 0) return [];
  const floor = isFiniteNumber(minShare) ? Math.max(0, minShare) : 0;
  if (floor * n >= 1) return uniq.map((t) => ({ geohash: t.geohash, share: 1 / n, label: BUDGET_LABEL }));

  const adults = uniq.map((t) => {
    if (!adults21) return null;
    let v: unknown;
    try {
      v = adults21(t);
    } catch {
      v = null;
    }
    return isFiniteNumber(v) && v >= 0 ? v : null;
  });
  const known = adults.filter((a): a is number => a !== null);
  const fill = known.length > 0 ? known.reduce((s, a) => s + a, 0) / known.length : 1;
  const w = uniq.map((t, i) => (isFiniteNumber(t.lift) ? Math.max(0, t.lift) : 0) * (known.length > 0 ? (adults[i] ?? fill) : 1));

  const share = new Array<number>(n).fill(0);
  const fixed = new Array<boolean>(n).fill(false);
  for (let guard = 0; guard <= n; guard++) {
    const freeIdx = share.map((_, i) => i).filter((i) => !fixed[i]);
    const nFixed = n - freeIdx.length;
    const budget = 1 - nFixed * floor;
    const W = freeIdx.reduce((s, i) => s + (w[i] as number), 0);
    for (const i of freeIdx) share[i] = W > 0 ? (budget * (w[i] as number)) / W : budget / freeIdx.length;
    const under = freeIdx.filter((i) => (share[i] as number) < floor - 1e-12);
    if (under.length === 0) break;
    for (const i of under) {
      fixed[i] = true;
      share[i] = floor;
    }
  }
  return uniq.map((t, i) => ({ geohash: t.geohash, share: share[i] as number, label: BUDGET_LABEL }));
}
