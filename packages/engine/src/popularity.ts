/**
 * The popularity check: Qloo with the bill as the signal against Qloo with no
 * signal, same pool. For each partner area the caller runs the area's place
 * search again without `signal.interests.entities` (Qloo answers it in
 * popularity order; probe 1 / KG1, Oct 15). With k = the partners picked in
 * that area, a partner is "not among the most popular places" when
 * it is not among the first k places of that list that pass the same
 * eligibility rules as partner scoring (`eligiblePartnerIds`: not the venue,
 * not closed, open on the street-team day, not an excluded category). No caps
 * apply to the popularity list. It says nothing about ticket sales.
 *
 * All or nothing: when any area with partners has no popularity list (the call
 * failed, or nothing eligible came back), there is no number and the result
 * names the areas.
 */
import type { Partner, PopularityCheck, PopularityCheckArea, QlooEntity } from "@walkup/contracts";
import { eligiblePartnerIds, type PartnerScoringOptions } from "./partners";

/** One area's no-signal search, in Qloo's order. */
export interface PopularityTwin {
  /** The pool's tile; null for the near-venue pool. */
  tileGeohash: string | null;
  entities: readonly QlooEntity[];
  ledgerRef: string;
}

export interface PopularityCheckResult {
  check: PopularityCheck | null;
  /** Areas with partners but no usable popularity list (empty when `check` is set or there are no partners). */
  missing: { tileGeohash: string | null; why: "no search" | "nothing eligible came back" }[];
}

const key = (g: string | null) => g ?? "\u0000near-venue";

export function popularityCheck(
  partners: readonly Pick<Partner, "entity" | "tileGeohash" | "tileName">[],
  twins: readonly PopularityTwin[],
  opts: PartnerScoringOptions = {},
): PopularityCheckResult {
  if (partners.length === 0) return { check: null, missing: [] };
  const areas: { tileGeohash: string | null; tileName?: string; ids: string[] }[] = [];
  for (const p of partners) {
    let a = areas.find((x) => key(x.tileGeohash) === key(p.tileGeohash));
    if (!a) {
      a = { tileGeohash: p.tileGeohash, ids: [] };
      if (p.tileName) a.tileName = p.tileName;
      areas.push(a);
    }
    a.ids.push(p.entity.entityId);
  }
  const perArea: PopularityCheckArea[] = [];
  const missing: PopularityCheckResult["missing"] = [];
  for (const a of areas) {
    const twin = twins.find((t) => key(t.tileGeohash) === key(a.tileGeohash));
    if (!twin) {
      missing.push({ tileGeohash: a.tileGeohash, why: "no search" });
      continue;
    }
    const popular = eligiblePartnerIds(twin.entities, opts);
    if (popular.length === 0) {
      missing.push({ tileGeohash: a.tileGeohash, why: "nothing eligible came back" });
      continue;
    }
    const top = new Set(popular.slice(0, a.ids.length));
    const names = new Map(twin.entities.map((e) => [e.entityId, e.name]));
    const mine = new Set(a.ids);
    const row: PopularityCheckArea = {
      tileGeohash: a.tileGeohash,
      partners: a.ids.length,
      notInPopularTop: a.ids.filter((id) => !top.has(id)).length,
      ledgerRef: twin.ledgerRef,
      popularTop: popular.slice(0, a.ids.length).map((id, i) => ({ entityId: id, name: names.get(id) ?? "", rank: i + 1, onSheet: mine.has(id) })),
    };
    if (a.tileName) row.tileName = a.tileName;
    perArea.push(row);
  }
  if (missing.length > 0) return { check: null, missing };
  return {
    check: {
      partners: perArea.reduce((s, r) => s + r.partners, 0),
      notInPopularTop: perArea.reduce((s, r) => s + r.notInPopularTop, 0),
      perArea,
      ledgerRefs: [...new Set(perArea.map((r) => r.ledgerRef))],
    },
    missing: [],
  };
}

/**
 * The one sentence for the partners card: "8 of the 11 partners aren't among the most popular places in their
 * areas: a list by popularity alone would miss them."
 */
export function popularitySentence(c: Pick<PopularityCheck, "partners" | "notInPopularTop" | "perArea">): string {
  const where =
    c.perArea.length === 1 ? (c.perArea[0]?.tileGeohash === null ? "near the venue" : c.partners === 1 ? "in its area" : "in their area") : "in their areas";
  const most = `the most popular places ${where}`;
  const n = c.notInPopularTop;
  if (c.partners === 1) return n === 1 ? `The one partner isn't among ${most}: a list by popularity alone would miss it.` : `The one partner is also among ${most}.`;
  if (n === 0) return `All ${c.partners} partners are also among ${most}.`;
  if (n === c.partners) return `None of the ${c.partners} partners is among ${most}: a list by popularity alone would miss them all.`;
  if (n === 1) return `1 of the ${c.partners} partners isn't among ${most}: a list by popularity alone would miss it.`;
  return `${n} of the ${c.partners} partners aren't among ${most}: a list by popularity alone would miss them.`;
}
