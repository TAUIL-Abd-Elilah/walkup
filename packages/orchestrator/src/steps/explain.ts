/**
 * "Why this place" for every partner on the sheet (`Partner.explain`), from
 * what the partner step already fetched: the place's tags, its pool (size,
 * radius, categories, ledger id), its house twin, the venue point and the
 * gazetteer. No Qloo calls. The rules live in @walkup/engine `explain.ts`.
 */
import type { Partner } from "@walkup/contracts";
import { explainPartner, partnerTagCounts, type ExplainContext } from "@walkup/engine";
import { categoryUrns } from "../tags";
import type { RunContext, Seed } from "../context";
import { partnerCategories, streetDay, TILE_RADIUS_M, type PartnersResult } from "./partners";

/** Ticketmaster says adults only and the operator has not said all ages (the bar listening night and alcohol tags need both). */
export function adultsOnly(ctx: RunContext): boolean {
  return ctx.bill.legalAgeEnforced === true && ctx.operator.allAges !== true;
}

function areaAt(ctx: RunContext, p: Partner): string | undefined {
  if (p.tileName) return p.tileName;
  const loc = p.entity.location;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const name = ctx.gazetteer.annotateTile({ lat: loc.lat, lon: loc.lon }).name;
    if (name) return name;
  }
  const hood = p.entity.properties?.neighborhood;
  return typeof hood === "string" && hood.trim() !== "" ? hood.trim() : undefined;
}

/**
 * The partners with `explain` filled in, same order. `thinSignal` is the
 * sheet's thin-signal flag (it lowers every partner's confidence one step).
 */
export function explainPartners(ctx: RunContext, result: PartnersResult, seeds: readonly Seed[], opts: { thinSignal: boolean }): Partner[] {
  if (result.partners.length === 0) return result.partners;
  const entries = new Map(ctx.ledger.entries().map((e) => [e.id, e]));
  const baseTags = categoryUrns(ctx.pins, partnerCategories(ctx)).urns.length;
  const ectx: ExplainContext = {
    venue: { lat: ctx.bill.venue.lat, lon: ctx.bill.venue.lon },
    day: streetDay(ctx),
    days: ctx.operator.streetTeamDays,
    listSize: result.partners.length,
    adultsOnly: adultsOnly(ctx),
    thinSignal: opts.thinSignal,
    billTagIds: new Set(seeds.flatMap((s) => (s.entity.tags ?? []).map((t) => t.id))),
    tagCounts: partnerTagCounts(result.partners),
  };
  return result.partners.map((p) => {
    const poolRef = p.chips[0]?.ledgerRef ?? "";
    let idx = result.pools.findIndex((x) => x.ledgerRef === poolRef && x.tileGeohash === p.tileGeohash);
    if (idx < 0) idx = result.pools.findIndex((x) => x.tileGeohash === p.tileGeohash);
    const pool = idx >= 0 ? result.pools[idx] : undefined;
    const spec = idx >= 0 ? result.poolSpecs[idx] : undefined;
    const ref = pool?.ledgerRef ?? poolRef;
    const poolSize = entries.get(ref)?.resultCount ?? pool?.entities.length ?? 0;
    const area = areaAt(ctx, p);
    const explain = explainPartner(
      {
        partner: p,
        poolSize,
        poolRef: ref,
        twinRef: pool?.house?.ledgerRef ?? null,
        ...(pool?.house ? { houseListSize: entries.get(pool.house.ledgerRef)?.resultCount ?? pool.house.size } : {}),
        widenedRadiusM: spec && spec.tileGeohash !== null && spec.radiusM > TILE_RADIUS_M ? spec.radiusM : null,
        widenedCategories: spec ? spec.tags.length > baseTags : false,
        ...(area ? { areaName: area } : {}),
      },
      ectx,
    );
    return { ...p, explain };
  });
}
