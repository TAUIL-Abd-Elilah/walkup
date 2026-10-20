/**
 * The discovery: one finding the sheet calls out at the top, picked by a fixed
 * rule (never by the model). No discovery beats a weak one, so both rules need
 * the room's own crowd as the baseline, and the area rule needs a map that
 * passed its checks.
 *
 * 1. Area rule. Rank the squares on the lift card twice: by lift (against
 *    the room's usual crowd) and by this crowd's own heat (bill percentile,
 *    "fans alone"). Only the numbered areas (the 1-5 list the map, the area
 *    list and the partner table share) can be picked, so the sheet never
 *    points at a place the operator can't find. Take the highest-lift numbered
 *    area (lift >= minLift and bill percentile >= the bill floor) whose
 *    fans-alone rank is at least 5 places lower than its lift rank: counting
 *    fans, you would miss it. It is named by its number.
 * 2. Partner rule, when no area qualifies. Take the highest-scoring partner in
 *    a top area that is not a national chain (config/chains.json), whose type
 *    is not the most common type on the list (ties all count as most common)
 *    and that the room's usual crowd ranks at least 5 places lower, or not at
 *    all (the pool's house twin).
 * 3. Otherwise none.
 */
import type { LiftTile, Partner, SheetDiscovery } from "@walkup/contracts";
import { categoryWord } from "./explain";
import { cmpStr } from "./num";
import { joinAnd, ordinal } from "./steps";

export const DISCOVERY_RULES = {
  /** Fans-alone rank at least this many places below the lift rank. */
  minRankGap: 5,
  /** House-twin rank at least this many places below the bill's rank. */
  minHouseGap: 5,
} as const;

export const AREA_RULE = "the highest-lift numbered area that ranks at least 5 places lower when you look at this crowd on its own.";
export const PARTNER_RULE =
  "the best-scoring partner in a top area that isn't a national chain or the most common type on the list and that the room's usual crowd ranks at least 5 places lower, or not at all. Walkup tries the area rule first; no numbered area met it on this sheet.";

export interface AreaRank {
  tile: LiftTile;
  /** 1-based rank by lift (lift desc, then geohash) among every square on the card. Not the area number: numbered areas skip near neighbours. */
  liftRank: number;
  /** 1-based rank by this crowd's own heat (bill percentile desc, then lift desc, then geohash). */
  heatRank: number;
}

/** Both ranks for every distinct square on the card. */
export function rankAreas(tiles: readonly LiftTile[]): AreaRank[] {
  const uniq = new Map<string, LiftTile>();
  for (const t of tiles) if (t && typeof t.geohash === "string" && !uniq.has(t.geohash)) uniq.set(t.geohash, t);
  const list = [...uniq.values()];
  const byLift = [...list].sort((a, b) => b.lift - a.lift || cmpStr(a.geohash, b.geohash));
  const byHeat = [...list].sort((a, b) => b.billPct - a.billPct || b.lift - a.lift || cmpStr(a.geohash, b.geohash));
  const heatRank = new Map(byHeat.map((t, i) => [t.geohash, i + 1]));
  return byLift.map((t, i) => ({ tile: t, liftRank: i + 1, heatRank: heatRank.get(t.geohash) ?? i + 1 }));
}

export interface AreaDiscoveryInput {
  /** The lift card's tiles (every square on the map). */
  tiles: readonly LiftTile[];
  /** The numbered areas, in number order (area 1 first): the only areas the rule may pick. */
  numbered: readonly LiftTile[];
  baseline: "house" | "tag" | "none";
  /** False when the map failed a check (split-half at or below the bar, or lift following raw foot traffic). */
  liftTrusted: boolean;
  minLift: number;
  billFloor: number;
  /** Receipts for an area pick (the bill and house heatmaps). */
  ledgerRefs: readonly string[];
}

export function areaDiscovery(i: AreaDiscoveryInput): SheetDiscovery | null {
  if (i.baseline !== "house" || !i.liftTrusted) return null;
  const ranks = rankAreas(i.tiles);
  const byGeohash = new Map(ranks.map((r) => [r.tile.geohash, r]));
  const numbered = i.numbered.map((t, idx) => ({ t, number: idx + 1, rank: byGeohash.get(t.geohash) }));
  const pick = numbered.find(
    ({ rank }) => rank !== undefined && rank.tile.lift >= i.minLift && rank.tile.billPct >= i.billFloor && rank.heatRank - rank.liftRank >= DISCOVERY_RULES.minRankGap,
  );
  if (!pick?.rank) return null;
  const label = pick.t.name ? `Area ${pick.number}, ${pick.t.name},` : `Area ${pick.number}`;
  const gap = pick.rank.heatRank - pick.rank.liftRank;
  return {
    kind: "area",
    headline: `${label} is ${ordinal(pick.rank.heatRank)} of the ${ranks.length} squares on the map for this crowd on its own, but ${ordinal(pick.rank.liftRank)} once it's compared with the room's usual crowd.`,
    detail: "Looking at this crowd alone, you'd skip it. Next to the room's usual crowd, it stands out.",
    rule: AREA_RULE,
    why: `the highest-lift numbered area that this crowd on its own ranks ${gap} places lower`,
    geohash: pick.t.geohash,
    ledgerRefs: [...new Set(i.ledgerRefs.filter(Boolean))],
  };
}

export interface PartnerDiscoveryInput {
  partners: readonly Partner[];
  baseline: "house" | "tag" | "none";
  /** Size of the house twin's list a partner was compared with, for "isn't in the top N". */
  twinSize?: (p: Partner) => number | null;
  /** Receipts for a partner pick; default its explain refs, else its chips' refs. */
  ledgerRefs?: (p: Partner) => string[];
}

/** Categories tied for the most partners on the list. */
export function mostCommonCategories(partners: readonly Pick<Partner, "category">[]): string[] {
  const counts = new Map<string, number>();
  for (const p of partners) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  return [...counts.entries()].filter(([, n]) => n === max && max > 0).map(([c]) => c).sort(cmpStr);
}

/** "a bar or record store", "a bar, cafe or record store". */
function joinOr(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

export function partnerDiscovery(i: PartnerDiscoveryInput): SheetDiscovery | null {
  if (i.baseline !== "house" || i.partners.length === 0) return null;
  const common = new Set(mostCommonCategories(i.partners));
  const ordered = i.partners.map((p, idx) => ({ p, idx })).sort((a, b) => b.p.score - a.p.score || a.idx - b.idx);
  const hit = ordered.find(({ p }) => {
    if (p.tileGeohash === null || p.chain === true || common.has(p.category)) return false;
    if (p.houseRank === undefined) return false;
    // "Not at all" counts only when the usual crowd's list actually came back with places in it.
    if (p.houseRank === null) return (i.twinSize?.(p) ?? 1) > 0;
    return p.houseRank - p.qlooRank >= DISCOVERY_RULES.minHouseGap;
  });
  if (!hit) return null;
  const p = hit.p;
  const name = p.entity.name;
  let headline: string;
  if (typeof p.houseRank === "number") headline = `${name} ranks ${ordinal(p.qlooRank)} for this crowd and ${ordinal(p.houseRank)} for the room's usual crowd.`;
  else {
    const size = i.twinSize?.(p) ?? null;
    headline =
      size !== null && size > 0
        ? `${name} ranks ${ordinal(p.qlooRank)} for this crowd and isn't in the room's usual crowd's top ${size}.`
        : `${name} ranks ${ordinal(p.qlooRank)} for this crowd and doesn't come up for the room's usual crowd.`;
  }
  const area = p.explain?.areaName ?? p.tileName;
  const km = p.explain?.distanceKm;
  // An area named with its own distance ("Nashville-Davidson, 17 km west") needs no second one.
  const named = !!area && /\d km \w+$/.test(area);
  const where = `${area ? ` in ${area}` : ""}${typeof km === "number" && !named ? `, ${km.toFixed(1)} km from the venue` : ""}`;
  const commonWords = [...common].map((c) => categoryWord(c, true)).sort(cmpStr);
  const top = i.partners.filter((x) => x.category === [...common][0]).length;
  const lead = joinAnd(commonWords);
  const counts =
    common.size > 1
      ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)} are the most common types on the list (${top} of ${i.partners.length} each)`
      : `${lead.charAt(0).toUpperCase()}${lead.slice(1)} are the most common type on the list (${top} of ${i.partners.length})`;
  const detail = [`${counts}; this one is ${withArticle(categoryWord(p.category))}${where}.`, p.explain?.activation ?? ""].filter(Boolean).join(" ");
  const refs = i.ledgerRefs?.(p) ?? p.explain?.ledgerRefs ?? p.chips.map((c) => c.ledgerRef);
  const notTypes = joinOr([...common].map((c) => categoryWord(c)).sort(cmpStr));
  const usual =
    typeof p.houseRank === "number" ? `the room's usual crowd ranks it ${p.houseRank - p.qlooRank} places lower` : "the room's usual crowd doesn't rank it at all";
  return {
    kind: "partner",
    headline,
    detail,
    rule: PARTNER_RULE,
    why: `the best fit that isn't ${withArticle(notTypes)}, and ${usual}`,
    entityId: p.entity.entityId,
    ledgerRefs: [...new Set(refs.filter(Boolean))],
  };
}

export interface DiscoveryInput extends AreaDiscoveryInput, Omit<PartnerDiscoveryInput, "baseline" | "ledgerRefs"> {
  partnerRefs?: (p: Partner) => string[];
}

/** The area rule, then the partner rule, else null. */
export function pickDiscovery(i: DiscoveryInput): SheetDiscovery | null {
  return (
    areaDiscovery(i) ??
    partnerDiscovery({
      partners: i.partners,
      baseline: i.baseline,
      ...(i.twinSize ? { twinSize: i.twinSize } : {}),
      ...(i.partnerRefs ? { ledgerRefs: i.partnerRefs } : {}),
    })
  );
}
