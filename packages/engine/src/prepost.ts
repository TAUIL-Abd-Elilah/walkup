/**
 * Pre/post-show block near the venue (Q10): eligibility, delta rank versus the
 * house-signal twin, fan-facing rule and load balancing.
 *
 * National chains (only when `chains` is given: the hand-kept list plus the
 * other signals of `chainSignals`): eligible spots keep Qloo's order, but
 * every chain goes after the local ones before the list is cut to
 * `maxSpots`, so a chain fills only a place no local spot can, one spot per brand, and at most
 * `maxChains` (2) are kept. Load-balancing weights still follow Qloo's rank.
 *
 * Never listed: a non-venue (a mall, plaza, station: `isNonVenue`), a food
 * cart, kiosk or stand (`isFoodStand`: somewhere to buy a snack, not a room a
 * share of the crowd can sit in) and an adult-themed place (`isAdultThemed`).
 *
 * The kept spots are listed nearest the venue first (chains still after the
 * local spots; ties: Qloo's order).
 */
import type { Chip, PrePostSpot, QlooEntity, Weekday } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES, distanceOf, isBarCategory, isClosedEntity, isFoodStand, isNonVenue, resolveCategory, type CategoryOptions } from "./category";
import { chainSignals, isAdultThemed, isSameBusiness, MAX_CHAINS_PER_LIST, normalizeChainName, type ChainEntry, type ChainIndex, type ChainList } from "./chains";
import { hoursOnDay, openInEvening, type HoursOptions } from "./hours";
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

/**
 * The chip for a place's rank against the same search for the room's usual crowd, in plain words:
 * `delta` = usual-crowd rank - this bill's rank (positive: higher for this bill); null = not on the usual crowd's
 * list of `listSize` (0 or absent: that list did not come back).
 */
export function usualCrowdChipLabel(delta: number | null, listSize?: number): string {
  if (delta === null) return listSize && listSize > 0 ? `not in the room's usual crowd's top ${listSize}` : "no list for the room's usual crowd";
  if (delta === 0) return "ranks the same here as for the room's usual crowd";
  const n = Math.abs(delta);
  return `ranks ${n} ${n === 1 ? "place" : "places"} ${delta > 0 ? "higher" : "lower"} here than for the room's usual crowd`;
}

/** True for a chip written by `usualCrowdChipLabel` (or the older "tonight vs house" wording). */
export function isUsualCrowdChip(label: string): boolean {
  return /^tonight vs house\b/.test(label) || /(?:here (?:than|as) for|not in|no list for) the room's usual crowd/.test(label);
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
  /** Leave out spots whose hours that day end before the evening (a café that closes at 3 pm). Needs `weekday`. */
  eveningOnly?: boolean;
  /** Default 8. */
  maxSpots?: number;
  excludeEntityIds?: Iterable<string>;
  /** Names never listed, compared the way chain names are ("The Anthem" = "Anthem"): the venue's own name. */
  excludeNames?: readonly string[];
  hours?: HoursOptions;
  chipLabel?: string;
  /** Hand-kept chain list: chains go after the local spots (see the module comment). Absent or null: no chain rule. */
  chains?: ChainList | ChainIndex | readonly ChainEntry[] | null;
  /** Most chains kept (with `chains`). Default `MAX_CHAINS_PER_LIST` (2). */
  maxChains?: number;
  /** Other places the run saw (the partner pools), for the "same name at 3+ places" chain signal. */
  chainContext?: readonly QlooEntity[];
}

export interface PrePostReport {
  candidates: number;
  droppedClosed: number;
  droppedHoursClosed: number;
  /** Open that day, but only before the evening (with `eveningOnly`). */
  droppedNotEvening: number;
  droppedExcluded: number;
  /** Not a business: a mall, plaza, station, parking garage, park. */
  droppedNotVenue: number;
  /** A food cart, kiosk, stand or truck. */
  droppedStand: number;
  /** Adult-themed places. */
  droppedAdult: number;
  capacityApplied: boolean;
  unplaced: number;
  /** Eligible spots on the chain list. 0 without a list. */
  chains: number;
  /** Chains on the list Qloo's order alone gives that the rule moved: now off the list, or after a local spot Qloo ranked lower. */
  chainsMovedDown: number;
  /** Names of the eligible chains not on the list (a local spot took the place, or the cap), in Qloo order. */
  chainsOffList: string[];
  /** Spots that are chains. */
  chainsKept: number;
  /** Eligible chains not on the list, and how many of those only the cap kept off. */
  chainsLeftOut: number;
  chainsCapped: number;
  /** The chain cap applied (0 without the chain rule). */
  maxChains: number;
}

export function buildPrePostSpots(entities: readonly QlooEntity[], opts: PrePostOptions): { spots: PrePostSpot[]; report: PrePostReport } {
  const maxSpots = isFiniteNumber(opts.maxSpots) ? Math.max(0, Math.floor(opts.maxSpots)) : 8;
  const defaultCap = isFiniteNumber(opts.defaultCapacity) && opts.defaultCapacity >= 0 ? opts.defaultCapacity : 60;
  const excluded = new Set(opts.excludeEntityIds ?? []);
  const excludedNames = new Set((opts.excludeNames ?? []).map((x) => normalizeChainName(x)).filter((x) => x !== ""));
  const barCats = opts.barCategories ?? DEFAULT_BAR_CATEGORIES;
  const report: PrePostReport = {
    candidates: entities.length,
    droppedClosed: 0,
    droppedHoursClosed: 0,
    droppedNotEvening: 0,
    droppedExcluded: 0,
    droppedNotVenue: 0,
    droppedStand: 0,
    droppedAdult: 0,
    capacityApplied: false,
    unplaced: 0,
    chains: 0,
    chainsMovedDown: 0,
    chainsOffList: [],
    chainsKept: 0,
    chainsLeftOut: 0,
    chainsCapped: 0,
    maxChains: 0,
  };
  const chainRule = !!opts.chains;
  const maxChains = chainRule ? (isFiniteNumber(opts.maxChains) ? Math.max(0, Math.floor(opts.maxChains)) : MAX_CHAINS_PER_LIST) : Number.POSITIVE_INFINITY;
  if (chainRule) report.maxChains = maxChains;
  const chainOf: ReadonlyMap<string, unknown> = chainRule ? chainSignals([...entities, ...(opts.chainContext ?? [])], opts.chains ?? null) : new Map();

  const n = entities.length;
  const billIds = entities.map((e) => e?.entityId ?? "");
  const deltas = deltaRanks(billIds, opts.houseTwinIds ?? null);
  // Every eligible spot in Qloo order; the cut to maxSpots comes after the chain rule.
  const eligible: { e: QlooEntity; rank: number; weight: number; chain: boolean }[] = [];
  const seen = new Set<string>();
  entities.forEach((e, i) => {
    if (!chainRule && eligible.length >= maxSpots) return;
    const id = e?.entityId;
    if (!id || seen.has(id)) return;
    if (excluded.has(id) || (excludedNames.size > 0 && excludedNames.has(normalizeChainName(e.name ?? "")))) {
      report.droppedExcluded++;
      return;
    }
    if (isNonVenue(e)) {
      report.droppedNotVenue++;
      return;
    }
    if (isFoodStand(e)) {
      report.droppedStand++;
      return;
    }
    if (isAdultThemed(e, opts.chains ?? null)) {
      report.droppedAdult++;
      return;
    }
    if (isClosedEntity(e)) {
      report.droppedClosed++;
      return;
    }
    if (opts.weekday) {
      const h = hoursOnDay(e.properties?.hours, opts.weekday, opts.hours ?? {});
      if (h.status === "closed") {
        report.droppedHoursClosed++;
        return;
      }
      if (opts.eveningOnly && h.status === "open" && openInEvening(h.text) === false) {
        report.droppedNotEvening++;
        return;
      }
    }
    seen.add(id);
    // The same business under a second Qloo entry is listed once.
    if (eligible.some((k) => isSameBusiness(k.e, e))) return;
    eligible.push({ e, rank: i + 1, weight: n > 0 ? 1 - i / n : 0, chain: chainOf.has(id) });
  });
  const locals = eligible.filter((k) => !k.chain);
  const chainsAll = eligible.filter((k) => k.chain);
  const room = Math.max(0, maxSpots - locals.length);
  // One spot per brand: two Starbucks near the room say nothing the first doesn't.
  const brands = new Set<string>();
  const oneEach = chainsAll.filter((k) => {
    const sig = chainOf.get(k.e.entityId) as { brand?: string } | undefined;
    const brand = normalizeChainName(sig?.brand ?? k.e.name);
    if (brands.has(brand)) return false;
    brands.add(brand);
    return true;
  });
  const kept = [...locals, ...oneEach.slice(0, Math.min(room, maxChains))].slice(0, maxSpots);
  if (chainRule) {
    report.chains = chainsAll.length;
    const plain = eligible.slice(0, maxSpots);
    const keptIds = new Set(kept.map((k) => k.e.entityId));
    // Moved: off the list now, or listed after a local spot Qloo ranked lower.
    const moved = plain.filter((k) => k.chain && (!keptIds.has(k.e.entityId) || kept.some((x) => !x.chain && x.rank > k.rank)));
    report.chainsMovedDown = moved.length;
    const off = chainsAll.filter((k) => !keptIds.has(k.e.entityId));
    report.chainsOffList = off.map((k) => k.e.name);
    report.chainsKept = chainsAll.length - off.length;
    report.chainsLeftOut = off.length;
    // Only the cap kept them off: there was room after the local spots.
    report.chainsCapped = Math.min(off.length, Math.max(0, room - report.chainsKept));
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
      chips.push({ label: usualCrowdChipLabel(delta), ledgerRef: opts.houseLedgerRef });
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
  // Nearest the venue first (local spots, then any chain); Qloo's order breaks ties, places with no distance go last.
  const order = new Map(kept.map((k, i) => [k.e.entityId, i]));
  spots.sort((a, b) => {
    const da = distanceOf(a.entity);
    const db = distanceOf(b.entity);
    return Number(a.chain === true) - Number(b.chain === true) || (da === db ? 0 : da < db ? -1 : 1) || (order.get(a.entity.entityId) ?? 0) - (order.get(b.entity.entityId) ?? 0);
  });
  return { spots, report };
}
