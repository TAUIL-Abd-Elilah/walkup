/**
 * Load balancer for the pre/post block. Expected traffic per spot =
 * attendance x share, never above the spot's (operator-editable, "assumed")
 * capacity.
 *
 * Algorithm (water-fill, then integer apportionment):
 *  1. people = round(attendance x outingRate); caps = floor(assumedCapacity).
 *  2. Continuous water-fill: give every open spot a share proportional to its
 *     weight; any spot whose share would exceed its cap is filled to the cap and
 *     removed, and the rest is re-split among the others. Repeat until nothing
 *     overflows or every spot is full.
 *  3. Integer counts: floor each share, then hand the remaining people one at a
 *     time to the largest fractional remainders (ties: higher weight, then
 *     entityId ascending), never above a cap.
 * Spots with weight <= 0 get nobody unless every weight is 0, in which case all
 * spots with capacity share equally. People who fit nowhere are `unplaced`.
 */
import { cmpStr, isFiniteNumber } from "./num";

export interface LoadSpot {
  entityId: string;
  /** Relative pull of the spot (e.g. a rank score). Non-finite or negative counts as 0. */
  weight: number;
  /** Operator-editable capacity, labelled "assumed". NaN/negative = 0; Infinity = no cap. */
  assumedCapacity: number;
}

export interface LoadAllocation {
  entityId: string;
  expectedCount: number;
  /** expectedCount / attendance (0..1). */
  expectedShare: number;
  capacity: number;
  saturated: boolean;
}

export interface LoadBalanceResult {
  /** One row per distinct entityId, in first-seen input order. */
  allocations: LoadAllocation[];
  attendance: number;
  /** People to place = round(attendance x outingRate). */
  people: number;
  placed: number;
  unplaced: number;
}

export interface LoadBalanceOptions {
  /** Fraction of attendance that goes to any pre/post spot. Default 1. */
  outingRate?: number;
}

export function loadBalance(spots: readonly LoadSpot[], attendance: number, opts: LoadBalanceOptions = {}): LoadBalanceResult {
  const att = isFiniteNumber(attendance) && attendance > 0 ? Math.round(attendance) : 0;
  const rate = isFiniteNumber(opts.outingRate) ? Math.min(1, Math.max(0, opts.outingRate)) : 1;
  const people = Math.round(att * rate);

  // De-duplicate by entityId (first wins) and sanitise.
  const seen = new Set<string>();
  const rows: { id: string; w: number; cap: number }[] = [];
  for (const s of spots) {
    const id = String(s?.entityId ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    const w = isFiniteNumber(s.weight) && s.weight > 0 ? s.weight : 0;
    const capRaw = s.assumedCapacity;
    const cap = capRaw === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : isFiniteNumber(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 0;
    rows.push({ id, w, cap });
  }

  const withCap = rows.filter((r) => r.cap > 0);
  const anyWeight = withCap.some((r) => r.w > 0);
  const weightOf = (r: { w: number }) => (anyWeight ? r.w : 1);

  // Continuous water-fill over spots that can take people, in entityId order for determinism.
  const x = new Map<string, number>();
  let free = withCap.filter((r) => weightOf(r) > 0).sort((a, b) => cmpStr(a.id, b.id));
  let remaining = people;
  while (free.length > 0 && remaining > 1e-12) {
    const W = free.reduce((acc, r) => acc + weightOf(r), 0);
    const full = free.filter((r) => (remaining * weightOf(r)) / W >= r.cap - 1e-12);
    if (full.length === 0) {
      for (const r of free) x.set(r.id, (remaining * weightOf(r)) / W);
      remaining = 0;
      break;
    }
    for (const r of full) {
      x.set(r.id, r.cap);
      remaining -= r.cap;
    }
    const fullIds = new Set(full.map((r) => r.id));
    free = free.filter((r) => !fullIds.has(r.id));
  }

  // Integer apportionment (largest remainder).
  const counts = new Map<string, number>();
  let assigned = 0;
  let continuousTotal = 0;
  for (const r of rows) {
    const v = x.get(r.id) ?? 0;
    continuousTotal += v;
    const f = Math.min(r.cap, Math.floor(v + 1e-9));
    counts.set(r.id, f);
    assigned += f;
  }
  let toHand = Math.min(people, Math.round(continuousTotal)) - assigned;
  if (toHand > 0) {
    const order = rows
      .filter((r) => (counts.get(r.id) ?? 0) < r.cap && (x.get(r.id) ?? 0) > 0)
      .map((r) => ({ r, frac: (x.get(r.id) ?? 0) - (counts.get(r.id) ?? 0) }))
      .sort((a, b) => b.frac - a.frac || weightOf(b.r) - weightOf(a.r) || cmpStr(a.r.id, b.r.id));
    for (const o of order) {
      if (toHand <= 0) break;
      counts.set(o.r.id, (counts.get(o.r.id) ?? 0) + 1);
      assigned += 1;
      toHand -= 1;
    }
  }

  const allocations: LoadAllocation[] = rows.map((r) => {
    const c = counts.get(r.id) ?? 0;
    return {
      entityId: r.id,
      expectedCount: c,
      expectedShare: att > 0 ? c / att : 0,
      capacity: r.cap,
      saturated: r.cap !== Number.POSITIVE_INFINITY && c >= r.cap,
    };
  });
  return { allocations, attendance: att, people, placed: assigned, unplaced: Math.max(0, people - assigned) };
}
