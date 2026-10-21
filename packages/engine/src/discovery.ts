/**
 * The discovery: one finding the sheet calls out at the top, picked by a fixed
 * rule (never by the model). No discovery beats a weak one, so both rules need
 * the room's own crowd as the baseline, and the area rule needs a map that
 * passed its checks.
 *
 * 1. "Start with this place" (partner rule), first. Walk the numbered areas in
 *    order (area 1 first). In each, take the partners in this crowd's rank
 *    order (Qloo's rank for this bill, best first), skip national chains, and
 *    pick the first that the room's usual crowd ranks at least 5 places lower
 *    in the same search, or not at all (when that search came back with
 *    places). The first area with such a place gives the pick. A promoter reads
 *    it as: the best place for this crowd in the best area, and one your usual
 *    crowd would not have pointed you to.
 * 2. Area rule, when no partner qualifies. Rank the squares on the lift card twice: by lift (against
 *    the room's usual crowd) and by this crowd's own heat (bill percentile,
 *    "fans alone"). Only the numbered areas (the 1-5 list the map, the area
 *    list and the partner table share) can be picked, so the sheet never
 *    points at a place the operator can't find. Take the highest-lift numbered
 *    area (lift >= minLift and bill percentile >= the bill floor) whose
 *    fans-alone rank is at least 5 places lower than its lift rank: counting
 *    fans, you would miss it. It is named by its number.
 * 3. Otherwise none.
 */
import type { LiftTile, Partner, SheetDiscovery } from "@walkup/contracts";
import { categoryWord } from "./explain";
import { cmpStr } from "./num";
import { ordinal } from "./steps";

export const DISCOVERY_RULES = {
  /** Fans-alone rank at least this many places below the lift rank. */
  minRankGap: 5,
  /** House-twin rank at least this many places below the bill's rank. */
  minHouseGap: 5,
} as const;

export const AREA_RULE = "the highest-lift numbered area that ranks at least 5 places lower when you look at this crowd on its own.";
export const PARTNER_RULE =
  "the highest-ranked place for this crowd in the top area that the room's usual crowd ranks at least 5 places lower in the same search, or not at all; national chains are skipped. When no place in area 1 qualifies, area 2 is tried, and so on.";

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
  /** The numbered areas, in number order (area 1 first). Absent: the areas in the order the partner list has them. */
  numbered?: readonly LiftTile[];
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

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** True when the room's usual crowd ranks the partner at least `minHouseGap` places lower, or not at all (on a list that came back). */
function standsApart(p: Partner, twinSize?: (p: Partner) => number | null): boolean {
  if (p.houseRank === undefined) return false;
  if (p.houseRank === null) return (twinSize?.(p) ?? 1) > 0;
  return p.houseRank - p.qlooRank >= DISCOVERY_RULES.minHouseGap;
}

export function partnerDiscovery(i: PartnerDiscoveryInput): SheetDiscovery | null {
  if (i.baseline !== "house" || i.partners.length === 0) return null;
  const areas: { geohash: string; name: string | undefined }[] = [];
  if (i.numbered && i.numbered.length > 0) for (const t of i.numbered) areas.push({ geohash: t.geohash, name: t.name });
  else for (const p of i.partners) if (p.tileGeohash && !areas.some((a) => a.geohash === p.tileGeohash)) areas.push({ geohash: p.tileGeohash, name: p.tileName });
  let hit: { p: Partner; number: number; areaName: string | undefined } | null = null;
  for (let a = 0; a < areas.length && !hit; a++) {
    const area = areas[a] as { geohash: string; name: string | undefined };
    const inArea = i.partners
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => p.tileGeohash === area.geohash && p.chain !== true)
      .sort((x, y) => x.p.qlooRank - y.p.qlooRank || y.p.score - x.p.score || x.idx - y.idx);
    const pick = inArea.find(({ p }) => standsApart(p, i.twinSize));
    if (pick) hit = { p: pick.p, number: a + 1, areaName: area.name ?? pick.p.tileName };
  }
  if (!hit) return null;
  const { p, number } = hit;
  const name = p.entity.name;
  const area = hit.areaName ?? p.explain?.areaName;
  const size = i.twinSize?.(p) ?? null;
  const usualRank =
    typeof p.houseRank === "number"
      ? `${ordinal(p.houseRank)} for the room's usual crowd`
      : size !== null && size > 0
        ? `not in the room's usual crowd's top ${size}`
        : "not on the room's usual crowd's list";
  const headline = `${name}, ${withArticle(categoryWord(p.category))} in area ${number}${area ? ` (${area})` : ""}: ${ordinal(p.qlooRank)} for this crowd, ${usualRank}.`;
  const km = p.explain?.distanceKm;
  const detail = [typeof km === "number" ? `${km.toFixed(1)} km from the venue.` : "", p.explain?.activation ?? ""].filter(Boolean).join(" ");
  const gap = typeof p.houseRank === "number" ? `the room's usual crowd ranks ${p.houseRank - p.qlooRank} places lower` : "the room's usual crowd doesn't rank";
  const where = number === 1 ? "area 1" : `area ${number} (no place in ${number === 2 ? "area 1" : `areas 1 to ${number - 1}`} qualified)`;
  const refs = i.ledgerRefs?.(p) ?? p.explain?.ledgerRefs ?? p.chips.map((c) => c.ledgerRef);
  return {
    kind: "partner",
    headline,
    detail: detail || `${withArticle(categoryWord(p.category)).replace(/^./, (c) => c.toUpperCase())} on the partner list.`,
    rule: PARTNER_RULE,
    why: `the highest-ranked place for this crowd in ${where} that ${gap}${typeof p.houseRank === "number" ? "" : " at all"}`,
    entityId: p.entity.entityId,
    ledgerRefs: [...new Set(refs.filter(Boolean))],
  };
}

export interface DiscoveryInput extends AreaDiscoveryInput, Omit<PartnerDiscoveryInput, "baseline" | "ledgerRefs" | "numbered"> {
  partnerRefs?: (p: Partner) => string[];
}

/** "Start with this place" (the partner rule), then the area rule, else null. */
export function pickDiscovery(i: DiscoveryInput): SheetDiscovery | null {
  return (
    partnerDiscovery({
      partners: i.partners,
      baseline: i.baseline,
      numbered: i.numbered,
      ...(i.twinSize ? { twinSize: i.twinSize } : {}),
      ...(i.partnerRefs ? { ledgerRefs: i.partnerRefs } : {}),
    }) ?? areaDiscovery(i)
  );
}
