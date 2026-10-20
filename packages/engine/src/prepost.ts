/**
 * Pre/post-show block near the venue (Q10): eligibility, delta rank versus the
 * house-signal twin, fan-facing rule and load balancing.
 *
 * National chains (only when `chains` is given): eligible spots keep Qloo's
 * order, but every spot on the hand-kept chain list goes after the local ones
 * before the list is cut to `maxSpots`, so a chain fills only a place no local
 * spot can. Load-balancing weights still follow Qloo's rank.
 */
import type { Chip, PrePostSpot, QlooEntity, Weekday } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES, isBarCategory, isClosedEntity, resolveCategory, type CategoryOptions } from "./category";
import { chainIndex as toChainIndex, type ChainEntry, type ChainIndex, type ChainList } from "./chains";
import { hoursOnDay, type HoursOptions } from "./hours";
import { loadBalance } from "./loadBalance";
import { isFiniteNumber } from "./num";

/**
 * Delta rank per bill-list entity: houseRank - billRank (1-based). Positive means
 * the spot ranks higher for tonight's bill than for the room's usual crowd.
 * Null when the twin list does not contain the entity.
 */
export function deltaRanks(billIds: readonly string[], houseIds: readonly string[] | null | undefined): Map<string, number | null> {
  const houseRank = new Map<string, number>();
  (houseIds ?? []).forEach((id, i) => {
    if (!houseRank.has(id)) houseRank.set(id, i + 1);
  });
  const out = new Map<string, number | null>();
  billIds.forEach((id, i) => {
    if (out.has(id)) return;
    const h = houseRank.get(id);
    out.set(id, houseIds && h !== undefined ? h - (i + 1) : null);
  });
  return out;
}

/** Bars are never fan-facing unless Ticketmaster says the show enforces a legal age (21+). Unknown counts as all-ages. */
export function fanFacingAllowed(category: string, legalAgeEnforced: boolean | null, barCategories: readonly string[] = DEFAULT_BAR_CATEGORIES): boolean {
  return !(isBarCategory(category, barCategories) && legalAgeEnforced !== true);
}

export interface PrePostOptions extends CategoryOptions {
  /** Headcount to place. Null: shares follow weights only and no capacity is applied. */
  attendance: number | null;
  /** Fraction of attendance that visits any pre/post spot. Default 1. */
  outingRate?: number;
  /** Assumed capacity when the operator has not set one. Default 60. */
  defaultCapacity?: number;
  capacityOverrides?: Readonly<Record<string, number>>;
  /** From Ticketmaster ageRestrictions only. */
  legalAgeEnforced: boolean | null;
  /** Entity ids of the house-signal twin, in its rank order. */
  houseTwinIds?: readonly string[] | null;
  /** Ledger id of the Q10 bill call. */
  ledgerRef: string;
  /** Ledger id of the house-signal twin call. */
  houseLedgerRef?: string;
  /** Show weekday for the hours check. */
  weekday?: Weekday | null;
  /** Default 8. */
  maxSpots?: number;
  excludeEntityIds?: Iterable<string>;
  hours?: HoursOptions;
  chipLabel?: string;
  /** Hand-kept chain list: chains go after the local spots (see the module comment). Absent or null: no chain rule. */
  chains?: ChainList | ChainIndex | readonly ChainEntry[] | null;
}

export interface PrePostReport {
  candidates: number;
  droppedClosed: number;
  droppedHoursClosed: number;
  droppedExcluded: number;
  capacityApplied: boolean;
  unplaced: number;
  /** Eligible spots on the chain list. 0 without a list. */
  chains: number;
  /** Chains on the list Qloo's order alone gives that the rule moved: now off the list, or after a local spot Qloo ranked lower. */
  chainsMovedDown: number;
  /** Names of the moved chains that are no longer on the list (a local spot took the place). */
  chainsOffList: string[];
}

export function buildPrePostSpots(entities: readonly QlooEntity[], opts: PrePostOptions): { spots: PrePostSpot[]; report: PrePostReport } {
  const maxSpots = isFiniteNumber(opts.maxSpots) ? Math.max(0, Math.floor(opts.maxSpots)) : 8;
  const defaultCap = isFiniteNumber(opts.defaultCapacity) && opts.defaultCapacity >= 0 ? opts.defaultCapacity : 60;
  const excluded = new Set(opts.excludeEntityIds ?? []);
  const barCats = opts.barCategories ?? DEFAULT_BAR_CATEGORIES;
  const report: PrePostReport = {
    candidates: entities.length,
    droppedClosed: 0,
    droppedHoursClosed: 0,
    droppedExcluded: 0,
    capacityApplied: false,
    unplaced: 0,
    chains: 0,
    chainsMovedDown: 0,
    chainsOffList: [],
  };
  const chainIndex = opts.chains ? toChainIndex(opts.chains) : null;

  const n = entities.length;
  const billIds = entities.map((e) => e?.entityId ?? "");
  const deltas = deltaRanks(billIds, opts.houseTwinIds ?? null);
  // Every eligible spot in Qloo order; the cut to maxSpots comes after the chain rule.
  const eligible: { e: QlooEntity; rank: number; weight: number; chain: boolean }[] = [];
  const seen = new Set<string>();
  entities.forEach((e, i) => {
    if (!chainIndex && eligible.length >= maxSpots) return;
    const id = e?.entityId;
    if (!id || seen.has(id)) return;
    if (excluded.has(id)) {
      report.droppedExcluded++;
      return;
    }
    if (isClosedEntity(e)) {
      report.droppedClosed++;
      return;
    }
    if (opts.weekday && hoursOnDay(e.properties?.hours, opts.weekday, opts.hours ?? {}).status === "closed") {
      report.droppedHoursClosed++;
      return;
    }
    seen.add(id);
    eligible.push({ e, rank: i + 1, weight: n > 0 ? 1 - i / n : 0, chain: chainIndex ? chainIndex.match(e.name) !== null : false });
  });
  const kept = [...eligible.filter((k) => !k.chain), ...eligible.filter((k) => k.chain)].slice(0, maxSpots);
  if (chainIndex) {
    report.chains = eligible.filter((k) => k.chain).length;
    const plain = eligible.slice(0, maxSpots);
    const keptIds = new Set(kept.map((k) => k.e.entityId));
    // Moved: off the list now, or listed after a local spot Qloo ranked lower.
    const moved = plain.filter((k) => k.chain && (!keptIds.has(k.e.entityId) || kept.some((x) => !x.chain && x.rank > k.rank)));
    report.chainsMovedDown = moved.length;
    report.chainsOffList = moved.filter((k) => !keptIds.has(k.e.entityId)).map((k) => k.e.name);
  }

  const capOf = (id: string): number => {
    const o = opts.capacityOverrides?.[id];
    return isFiniteNumber(o) && o >= 0 ? o : defaultCap;
  };

  const shares = new Map<string, number>();
  if (isFiniteNumber(opts.attendance) && opts.attendance > 0) {
    const lbOpts: { outingRate?: number } = {};
    if (opts.outingRate !== undefined) lbOpts.outingRate = opts.outingRate;
    const lb = loadBalance(
      kept.map((k) => ({ entityId: k.e.entityId, weight: k.weight, assumedCapacity: capOf(k.e.entityId) })),
      opts.attendance,
      lbOpts,
    );
    for (const a of lb.allocations) shares.set(a.entityId, a.expectedShare);
    report.capacityApplied = true;
    report.unplaced = lb.unplaced;
  } else {
    const W = kept.reduce((s, k) => s + k.weight, 0);
    const rate = isFiniteNumber(opts.outingRate) ? Math.min(1, Math.max(0, opts.outingRate)) : 1;
    for (const k of kept) shares.set(k.e.entityId, W > 0 ? (rate * k.weight) / W : 0);
  }

  const spots: PrePostSpot[] = kept.map((k) => {
    const category = resolveCategory(k.e, opts);
    const delta = deltas.get(k.e.entityId) ?? null;
    const chips: Chip[] = [{ label: opts.chipLabel ?? "near the room, ranked for this bill", ledgerRef: opts.ledgerRef }];
    if (delta !== null && opts.houseLedgerRef) {
      chips.push({ label: `tonight vs house ${delta > 0 ? "+" : ""}${delta} ranks`, ledgerRef: opts.houseLedgerRef });
    }
    const spot: PrePostSpot = {
      entity: k.e,
      deltaRank: delta,
      expectedShare: shares.get(k.e.entityId) ?? 0,
      assumedCapacity: capOf(k.e.entityId),
      fanFacingAllowed: fanFacingAllowed(category, opts.legalAgeEnforced, barCats),
      category,
      chips,
    };
    if (k.chain) spot.chain = true;
    return spot;
  });
  return { spots, report };
}
