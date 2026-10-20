/**
 * Deterministic partner scoring inside the top lift tiles (Q9 pools).
 *
 *   rank_score  = 1 - (qlooRank - 1) / n        (n = size of that Qloo response)
 *   tile_weight = tile.lift / maxLift            (pools with no known tile use lift 1)
 *   score       = rank_score * tile_weight * (1 - ubiquity_penalty)   (0..1)
 *
 * Ubiquity penalty (only when the pool has a house twin: the same request with
 * the room's usual crowd as the signal). A place that ranks as high for the
 * usual crowd as for this bill is generic for this room:
 *
 *   bill_pos  = 1 - (qlooRank - 1) / n
 *   house_pos = 1 - (houseRank - 1) / n_house   (no penalty when not in the house list)
 *   u         = clamp(1 - (bill_pos - house_pos) / span, 0, 1)        span = 0.5
 *   ubiquity_penalty = maxPenalty * u                                  maxPenalty = 0.5
 *
 * So a place at least half a list higher for this bill than for the house
 * keeps its score; one at least as high for the house loses half of it.
 *
 * Selection is a single greedy pass over every eligible candidate in score
 * order (ties: distance ascending, then Qloo rank, then entity id), subject to:
 * at most `maxPerCategoryPerTile` (2) per category per tile, at most
 * `maxPerTile` (8) per tile and at most `maxTotal` (25) overall. Afterwards each
 * tile whose picks are all bars gets its best eligible non-bar, added if there is
 * room, otherwise swapped for the tile's lowest-scored bar. Fewer than
 * `minTotal` (15) picks sets `belowMinimum` so the caller can widen the radius.
 *
 * National chains (only when `chains` is given: a hand-kept list, see
 * chains.ts): a candidate whose name is on the list sorts after every
 * non-chain candidate, ahead of score, in the greedy pass and in the listed
 * order. Its score is unchanged and the caps still apply, so a chain is kept
 * only for a slot no local place can fill. The report counts the chains the
 * rule moved: those on the list the same pass makes without the rule that are
 * now off the list, or listed after a local place of their area that scores
 * lower; `chainsOffList` names the ones now off the list.
 *
 * Eligibility: an entity id, not excluded (the venue), not in an excluded
 * category, not `is_closed`, and not explicitly closed on the street-team
 * weekday according to `properties.hours` (unknown hours are kept; Qloo's
 * `filter.hours` already applied).
 */
import type { Chip, LiftTile, Partner, QlooEntity, Weekday } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES, distanceOf, isBarCategory, isClosedEntity, propString, resolveCategory, type CategoryOptions } from "./category";
import { chainIndex as toChainIndex, type ChainEntry, type ChainIndex, type ChainList } from "./chains";
import { hoursOnDay, type HoursOptions } from "./hours";
import { clamp, cmpNum, cmpStr, isFiniteNumber } from "./num";

/** The pool's house-signal twin: the same request with the room's usual crowd as the signal. */
export interface PoolHouseTwin {
  /** entityId -> 1-based rank in the twin response (first appearance). */
  ranks: ReadonlyMap<string, number>;
  /** Size of the twin response. */
  size: number;
  /** Ledger id of the twin call. */
  ledgerRef: string;
}

export interface PartnerPool {
  /** Tile the pool was fetched for; null for the near-venue fallback pool. */
  tileGeohash: string | null;
  /** Ledger id of the Qloo call that produced the pool, e.g. "Q9". */
  ledgerRef: string;
  /** Entities in Qloo response order (rank 1 first). */
  entities: readonly QlooEntity[];
  /** House twin of this pool. Absent or null when no twin ran: no penalty, no `houseRank`. */
  house?: PoolHouseTwin | null;
}

export const UBIQUITY = { maxPenalty: 0.5, span: 0.5 } as const;

/**
 * Penalty in [0, maxPenalty] for a place that ranks as high for the room's
 * usual crowd as for this bill (see the module comment). `houseRank` null =
 * not in the house list: no penalty.
 */
export function ubiquityPenalty(
  qlooRank: number,
  n: number,
  houseRank: number | null,
  houseSize: number,
  opts: { maxPenalty?: number; span?: number } = {},
): number {
  const maxPenalty = isFiniteNumber(opts.maxPenalty) ? clamp(opts.maxPenalty, 0, 1) : UBIQUITY.maxPenalty;
  const span = isFiniteNumber(opts.span) && opts.span > 0 ? opts.span : UBIQUITY.span;
  if (houseRank === null || !isFiniteNumber(houseRank) || !(houseSize > 0) || !(n > 0)) return 0;
  const billPos = clamp(1 - (qlooRank - 1) / n, 0, 1);
  const housePos = clamp(1 - (houseRank - 1) / houseSize, 0, 1);
  return maxPenalty * clamp(1 - (billPos - housePos) / span, 0, 1);
}

export interface PartnerScoringOptions extends CategoryOptions {
  /** Street-team weekday for the hours double-check. Null/undefined skips it. */
  weekday?: Weekday | null;
  maxPerCategoryPerTile?: number;
  maxPerTile?: number;
  minTotal?: number;
  maxTotal?: number;
  /** Never suggested (the venue's own place id, operator exclusions). */
  excludeEntityIds?: Iterable<string>;
  /** Category keys (as `resolveCategory` returns them) that are never suggested, e.g. bars on an all-ages show. */
  excludeCategories?: Iterable<string>;
  /** Ubiquity penalty knobs. Default `UBIQUITY`. */
  ubiquity?: { maxPenalty?: number; span?: number };
  /** Label of the chip tied to the pool's ledger entry. */
  chipLabel?: string;
  /** Additional chips (e.g. "tonight vs house +3 ranks [Q10]"). */
  extraChips?: (e: QlooEntity, ctx: { tileGeohash: string | null; qlooRank: number; ledgerRef: string }) => Chip[];
  hours?: HoursOptions;
  /** "tile" (default): grouped by tile in lift order, then score. "score": global score order. */
  order?: "tile" | "score";
  /** Hand-kept chain list: chains sort after every local place (see the module comment). Absent or null: no chain rule. */
  chains?: ChainList | ChainIndex | readonly ChainEntry[] | null;
}

export const PARTNER_DEFAULTS = {
  maxPerCategoryPerTile: 2,
  maxPerTile: 8,
  minTotal: 15,
  maxTotal: 25,
  chipLabel: "over-indexes for this bill",
} as const;

export interface PartnerScoringReport {
  /** Entities seen across all pools (before any filter). */
  candidates: number;
  droppedInvalid: number;
  droppedExcluded: number;
  /** Left out because the category is excluded (operator input or the all-ages rule). */
  droppedCategory: number;
  droppedClosed: number;
  droppedHoursClosed: number;
  /** Eligible picks kept with unknown hours on the weekday. */
  hoursUnknown: number;
  /** Second and later appearances of an already selected entity. */
  duplicates: number;
  /** Eligible candidates left out by the caps. */
  notSelected: number;
  /** Picks whose score carries a ubiquity penalty above zero. */
  penalized: number;
  nonBarAdded: number;
  nonBarSwaps: number;
  /** Eligible candidates (distinct) on the chain list. 0 without a list. */
  chains: number;
  /** Chains on the list the same pass makes without the chain rule that the rule moved (off the list, or below a lower-scored local of their area). */
  chainsMovedDown: number;
  /** Names of the moved chains that are no longer on the list (a local place took the slot). */
  chainsOffList: string[];
  /** Picks on the chain list. */
  chainsKept: number;
  selected: number;
  belowMinimum: boolean;
  /** Picks per tile; the near-venue pool is keyed "near-venue". */
  perTile: Record<string, number>;
}

interface Candidate {
  entity: QlooEntity;
  id: string;
  tileGeohash: string | null;
  tileKey: string;
  ledgerRef: string;
  qlooRank: number;
  score: number;
  /** Present when the pool had a house twin. */
  houseRank?: number | null;
  ubiquityPenalty?: number;
  distance: number;
  category: string;
  isBar: boolean;
  hoursText: string | null;
  hoursKnown: boolean;
  /** On the chain list (always false without one). */
  chain: boolean;
}

const NEAR_VENUE = "near-venue";

function compareCandidates(a: Candidate, b: Candidate): number {
  return Number(a.chain) - Number(b.chain) || compareByScore(a, b);
}

/** The order without the chain rule. */
function compareByScore(a: Candidate, b: Candidate): number {
  return (
    cmpNum(b.score, a.score) ||
    cmpNum(a.distance, b.distance) ||
    a.qlooRank - b.qlooRank ||
    cmpStr(a.id, b.id) ||
    cmpStr(a.tileKey, b.tileKey)
  );
}

type DropReason = "invalid" | "excluded" | "closed" | "hoursClosed" | "category";

const DROP_FIELD = {
  invalid: "droppedInvalid",
  excluded: "droppedExcluded",
  closed: "droppedClosed",
  hoursClosed: "droppedHoursClosed",
  category: "droppedCategory",
} as const satisfies Record<DropReason, keyof PartnerScoringReport>;

type Eligibility = { ok: false; drop: DropReason } | { ok: true; id: string; hoursText: string | null; hoursKnown: boolean; category: string };

/** The eligibility rules of the module comment, in order: id, excluded id, closed, closed on the weekday, excluded category. */
function eligibility(entity: QlooEntity, opts: PartnerScoringOptions, excluded: ReadonlySet<string>, excludedCats: ReadonlySet<string>): Eligibility {
  const id = entity && typeof entity.entityId === "string" ? entity.entityId.trim() : "";
  if (!id) return { ok: false, drop: "invalid" };
  if (excluded.has(id)) return { ok: false, drop: "excluded" };
  if (isClosedEntity(entity)) return { ok: false, drop: "closed" };
  let hoursText: string | null = null;
  let hoursKnown = true;
  if (opts.weekday) {
    const h = hoursOnDay(entity.properties?.hours, opts.weekday, opts.hours ?? {});
    if (h.status === "closed") return { ok: false, drop: "hoursClosed" };
    hoursText = h.text;
    hoursKnown = h.status === "open";
  }
  const category = resolveCategory(entity, opts);
  if (excludedCats.has(category)) return { ok: false, drop: "category" };
  return { ok: true, id, hoursText, hoursKnown, category };
}

/**
 * Entity ids of `entities` that partner scoring would consider, in their order (first appearance): the same
 * eligibility rules and options as `scorePartnersWithReport`, no caps.
 */
export function eligiblePartnerIds(entities: readonly QlooEntity[], opts: PartnerScoringOptions = {}): string[] {
  const excluded = new Set(opts.excludeEntityIds ?? []);
  const excludedCats = new Set(opts.excludeCategories ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entities) {
    const el = eligibility(e, opts, excluded, excludedCats);
    if (el.ok && !seen.has(el.id)) {
      seen.add(el.id);
      out.push(el.id);
    }
  }
  return out;
}

function intOpt(v: number | undefined, d: number): number {
  return isFiniteNumber(v) ? Math.max(0, Math.floor(v)) : d;
}

interface Caps {
  maxPerCat: number;
  maxPerTile: number;
  maxTotal: number;
}

interface Selection {
  picked: Candidate[];
  duplicates: number;
  nonBarAdded: number;
  nonBarSwaps: number;
}

/**
 * The greedy pass over `eligible` (already sorted by `cmp`) with the caps,
 * then at least one non-bar per tile when one is available.
 */
function select(eligible: readonly Candidate[], caps: Caps, cmp: (a: Candidate, b: Candidate) => number): Selection {
  const out: Selection = { picked: [], duplicates: 0, nonBarAdded: 0, nonBarSwaps: 0 };
  const picked = out.picked;
  const pickedIds = new Set<string>();
  const perTile = new Map<string, number>();
  const perTileCat = new Map<string, number>();
  const catKey = (c: Candidate) => `${c.tileKey}\u0000${c.category}`;

  for (const c of eligible) {
    if (pickedIds.has(c.id)) {
      out.duplicates++;
      continue;
    }
    if (picked.length >= caps.maxTotal || (perTile.get(c.tileKey) ?? 0) >= caps.maxPerTile || (perTileCat.get(catKey(c)) ?? 0) >= caps.maxPerCat) {
      continue;
    }
    picked.push(c);
    pickedIds.add(c.id);
    perTile.set(c.tileKey, (perTile.get(c.tileKey) ?? 0) + 1);
    perTileCat.set(catKey(c), (perTileCat.get(catKey(c)) ?? 0) + 1);
  }

  // At least one non-bar per tile when one is available.
  const tileKeys = [...new Set(picked.map((c) => c.tileKey))].sort(cmpStr);
  for (const key of tileKeys) {
    const inTile = picked.filter((c) => c.tileKey === key);
    if (inTile.length === 0 || inTile.some((c) => !c.isBar)) continue;
    const best = eligible.find((c) => c.tileKey === key && !c.isBar && !pickedIds.has(c.id));
    if (!best) continue;
    if (inTile.length < caps.maxPerTile && picked.length < caps.maxTotal) {
      picked.push(best);
      out.nonBarAdded++;
    } else {
      const worst = [...inTile].sort(cmp).at(-1) as Candidate;
      picked.splice(picked.indexOf(worst), 1, best);
      pickedIds.delete(worst.id);
      out.nonBarSwaps++;
    }
    pickedIds.add(best.id);
  }
  return out;
}

export function scorePartnersWithReport(
  pools: readonly PartnerPool[],
  tiles: readonly LiftTile[],
  opts: PartnerScoringOptions = {},
): { partners: Partner[]; report: PartnerScoringReport } {
  const maxPerCat = intOpt(opts.maxPerCategoryPerTile, PARTNER_DEFAULTS.maxPerCategoryPerTile);
  const maxPerTile = intOpt(opts.maxPerTile, PARTNER_DEFAULTS.maxPerTile);
  const minTotal = intOpt(opts.minTotal, PARTNER_DEFAULTS.minTotal);
  const maxTotal = intOpt(opts.maxTotal, PARTNER_DEFAULTS.maxTotal);
  const barCats = opts.barCategories ?? DEFAULT_BAR_CATEGORIES;
  const chipLabel = opts.chipLabel ?? PARTNER_DEFAULTS.chipLabel;
  const excluded = new Set(opts.excludeEntityIds ?? []);
  const excludedCats = new Set(opts.excludeCategories ?? []);
  const chainIndex = opts.chains ? toChainIndex(opts.chains) : null;

  const tileByGh = new Map<string, LiftTile>();
  for (const t of tiles) if (!tileByGh.has(t.geohash)) tileByGh.set(t.geohash, t);
  const finiteLifts = tiles.map((t) => t.lift).filter((l) => isFiniteNumber(l) && l > 0);
  const maxLift = Math.max(1, ...finiteLifts);
  const tileOrder = new Map<string, number>();
  tiles.forEach((t, i) => {
    if (!tileOrder.has(t.geohash)) tileOrder.set(t.geohash, i);
  });

  const report: PartnerScoringReport = {
    candidates: 0,
    droppedInvalid: 0,
    droppedExcluded: 0,
    droppedCategory: 0,
    droppedClosed: 0,
    droppedHoursClosed: 0,
    hoursUnknown: 0,
    duplicates: 0,
    notSelected: 0,
    penalized: 0,
    nonBarAdded: 0,
    nonBarSwaps: 0,
    chains: 0,
    chainsMovedDown: 0,
    chainsOffList: [],
    chainsKept: 0,
    selected: 0,
    belowMinimum: false,
    perTile: {},
  };

  const eligible: Candidate[] = [];
  for (const pool of pools) {
    const n = pool.entities.length;
    const tile = pool.tileGeohash ? tileByGh.get(pool.tileGeohash) : undefined;
    const lift = tile && isFiniteNumber(tile.lift) ? Math.max(0, tile.lift) : 1;
    const weight = clamp(lift / maxLift, 0, 1);
    pool.entities.forEach((entity, i) => {
      report.candidates++;
      const el = eligibility(entity, opts, excluded, excludedCats);
      if (!el.ok) {
        report[DROP_FIELD[el.drop]]++;
        return;
      }
      const { id, hoursText, hoursKnown, category } = el;
      const qlooRank = i + 1;
      const rankScore = n > 0 ? 1 - (qlooRank - 1) / n : 0;
      const cand: Candidate = {
        entity,
        id,
        tileGeohash: pool.tileGeohash,
        tileKey: pool.tileGeohash ?? NEAR_VENUE,
        ledgerRef: pool.ledgerRef,
        qlooRank,
        score: clamp(rankScore * weight, 0, 1),
        distance: distanceOf(entity),
        category,
        isBar: isBarCategory(category, barCats),
        hoursText,
        hoursKnown,
        chain: chainIndex ? chainIndex.match(entity.name) !== null : false,
      };
      if (pool.house) {
        const houseRank = pool.house.ranks.get(id) ?? null;
        const penalty = ubiquityPenalty(qlooRank, n, houseRank, pool.house.size, opts.ubiquity ?? {});
        cand.houseRank = houseRank;
        cand.ubiquityPenalty = penalty;
        cand.score = clamp(rankScore * weight * (1 - penalty), 0, 1);
      }
      eligible.push(cand);
    });
  }

  const caps: Caps = { maxPerCat, maxPerTile, maxTotal };
  eligible.sort(compareCandidates);
  const chosen = select(eligible, caps, compareCandidates);
  const picked = chosen.picked;
  report.duplicates = chosen.duplicates;
  report.nonBarAdded = chosen.nonBarAdded;
  report.nonBarSwaps = chosen.nonBarSwaps;

  // What the chain rule changed: the same pass in score order alone.
  const chainIds = new Set(eligible.filter((c) => c.chain).map((c) => c.id));
  if (chainIds.size > 0) {
    report.chains = chainIds.size;
    const plain = select([...eligible].sort(compareByScore), caps, compareByScore).picked.sort(compareByScore);
    const keptIds = new Set(picked.map((c) => c.id));
    // Moved: off the list now, or listed after a local place of its area that scores lower.
    const moved = plain.filter((c) => c.chain && (!keptIds.has(c.id) || picked.some((d) => !d.chain && d.tileKey === c.tileKey && compareByScore(c, d) < 0)));
    report.chainsMovedDown = moved.length;
    report.chainsOffList = moved.filter((c) => !keptIds.has(c.id)).map((c) => c.entity.name);
  }

  const order = opts.order ?? "tile";
  const tileRank = (c: Candidate) => (c.tileGeohash === null ? Number.MAX_SAFE_INTEGER : (tileOrder.get(c.tileGeohash) ?? Number.MAX_SAFE_INTEGER - 1));
  picked.sort((a, b) => (order === "tile" ? tileRank(a) - tileRank(b) || cmpStr(a.tileKey, b.tileKey) : 0) || compareCandidates(a, b));

  const partners: Partner[] = picked.map((c) => {
    const tile = c.tileGeohash ? tileByGh.get(c.tileGeohash) : undefined;
    const chips: Chip[] = [{ label: chipLabel, ledgerRef: c.ledgerRef }];
    if (opts.extraChips) chips.push(...opts.extraChips(c.entity, { tileGeohash: c.tileGeohash, qlooRank: c.qlooRank, ledgerRef: c.ledgerRef }));
    const p: Partner = {
      entity: c.entity,
      tileGeohash: c.tileGeohash,
      category: c.category,
      score: c.score,
      qlooRank: c.qlooRank,
      address: propString(c.entity, "address", "formatted_address"),
      phone: propString(c.entity, "phone", "phone_number", "formatted_phone_number"),
      website: propString(c.entity, "website", "url"),
      chips,
    };
    if (tile?.name) p.tileName = tile.name;
    if (opts.weekday) p.hoursOnDay = c.hoursText;
    if (c.houseRank !== undefined) p.houseRank = c.houseRank;
    if (c.ubiquityPenalty !== undefined) p.ubiquityPenalty = c.ubiquityPenalty;
    if (c.chain) p.chain = true;
    return p;
  });

  const eligibleIds = new Set(eligible.map((c) => c.id));
  report.notSelected = eligibleIds.size - picked.length;
  report.selected = picked.length;
  report.penalized = picked.filter((c) => (c.ubiquityPenalty ?? 0) > 0).length;
  report.chainsKept = picked.filter((c) => c.chain).length;
  report.hoursUnknown = opts.weekday ? picked.filter((c) => !c.hoursKnown).length : 0;
  report.belowMinimum = picked.length < minTotal;
  for (const c of picked) report.perTile[c.tileKey] = (report.perTile[c.tileKey] ?? 0) + 1;
  return { partners, report };
}

/** The 15-25 partners for the drop, with diversity constraints. See the module comment for the formula. */
export function scorePartners(pools: readonly PartnerPool[], tiles: readonly LiftTile[], opts: PartnerScoringOptions = {}): Partner[] {
  return scorePartnersWithReport(pools, tiles, opts).partners;
}
