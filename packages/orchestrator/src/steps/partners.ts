/**
 * Q9: partner pools per top lift tile (stacked place constraints with
 * explainability), the coded fallbacks (3,500 m, then a wider category set),
 * the near-venue pool when lift is weak, the house twin of each pool (the
 * same request with the room's usual crowd as the signal, for the ubiquity
 * penalty and the "tonight vs house" chip), the probe-gated balance check,
 * and deterministic scoring with the diversity caps.
 */
import type { Chip, LiftTile, Partner, QlooEntity, StreetSheetCards, Weekday } from "@walkup/contracts";
import {
  balanceCheck,
  DEFAULT_BAR_CATEGORIES,
  mergeRankedLists,
  scorePartnersWithReport,
  type PartnerPool,
  type PartnerScoringReport,
  type PoolHouseTwin,
} from "@walkup/engine";
import { errorStatus } from "@walkup/qloo";
import { categoryTagMap, categoryUrns, DEFAULT_PARTNER_CATEGORIES, WIDEN_CATEGORIES } from "../tags";
import { cite, clean, droppedFrom, droppedReason, envelope, failure, node, plural, signal, venuePoint, type DroppedCheck, type HouseSet, type RunContext, type Seed } from "../context";
import { houseFor } from "./heat";

export const TILE_RADIUS_M = 2000;
export const TILE_RADIUS_WIDE_M = 3500;
export const MIN_POOL = 8;
export const PARTNER_TILES = 3;
export const PRICE_MAX = 3;
/** Node label of a pool's house twin (one per pool, at most PARTNER_TILES per run). */
export const HOUSE_TWIN_NODE = "Q9 house twin";
/** Chip prefix for the rank difference between the bill's list and the house twin's. */
export const HOUSE_TWIN_CHIP = "tonight vs house";
export const HOUSE_TWIN_LIMIT =
  "The usual-crowd rank comes from the same Qloo search run for the room's usual crowd. A place that ranks as high for them loses up to half its score.";

type PartnersCard = StreetSheetCards["partners"];

export interface PartnersResult {
  card: PartnersCard;
  partners: Partner[];
  report: PartnerScoringReport | null;
  pools: PartnerPool[];
  /** Pool request shape per tile, reused by arms S and P. */
  poolSpecs: PoolSpec[];
  categories: string[];
}

export interface PoolSpec {
  tileGeohash: string | null;
  point: { lat: number; lon: number };
  radiusM: number;
  tags: string[];
}

export function streetDay(ctx: RunContext): Weekday {
  return ctx.operator.streetTeamDays[0] ?? ctx.bill.weekday;
}

export function excludeTagsFor(ctx: RunContext): string[] {
  const nightClub = ctx.pins.categories.night_club;
  // The operator's all-ages flag only adds restrictions; Ticketmaster's 21+ never relaxes it.
  const adultsOnly = ctx.bill.legalAgeEnforced === true && ctx.operator.allAges !== true;
  return !adultsOnly && nightClub ? [nightClub] : [];
}

/** Category keys never suggested: the operator's exclusions, plus every bar category when the operator says all ages. */
export function excludedCategoriesFor(ctx: RunContext): string[] {
  const out = new Set((ctx.operator.excludeCategories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  if (ctx.operator.allAges === true) for (const c of DEFAULT_BAR_CATEGORIES) out.add(c);
  return [...out].sort();
}

/** The chip label for a partner's house rank. */
export function houseTwinChipLabel(houseRank: number | null, qlooRank: number, listSize: number): string {
  if (houseRank === null) return listSize > 0 ? `${HOUSE_TWIN_CHIP}: not in the house top ${listSize}` : `${HOUSE_TWIN_CHIP}: no house list`;
  const delta = houseRank - qlooRank;
  return `${HOUSE_TWIN_CHIP} ${delta > 0 ? "+" : ""}${delta} ranks`;
}

/** The house signal the twin uses: the same one as the Q10 twin (house entity ids, else the genre tag). */
function houseTwinSignal(house: HouseSet | null): { entities: string[]; tags: string[] } | null {
  if (!house) return null;
  if (house.baseline === "house" && house.ids.length > 0) return { entities: [...new Set(house.ids)], tags: [] };
  if (house.tag) return { entities: [], tags: [house.tag] };
  return null;
}

export function partnerCategories(ctx: RunContext): string[] {
  return [...(ctx.categories ?? DEFAULT_PARTNER_CATEGORIES)];
}

async function fetchPool(
  ctx: RunContext,
  seeds: Seed[],
  spec: PoolSpec,
  label: string,
  excludeIds: string[],
  signalOverride?: ReturnType<typeof signal>,
): Promise<{ entities: QlooEntity[]; ledgerRef: string; dropped: DroppedCheck }> {
  node(ctx, label, label.startsWith("Q9") ? "bill" : "arm");
  const sent = signalOverride ?? signal(ctx, seeds);
  const r = await ctx.qloo.placeInsights({
    signalEntities: sent,
    point: spec.point,
    radiusM: spec.radiusM,
    tags: spec.tags,
    operator: "union",
    hours: streetDay(ctx),
    priceMax: PRICE_MAX,
    excludeTags: excludeTagsFor(ctx),
    excludeEntities: excludeIds,
    explainability: true,
    take: 50,
  });
  return { entities: r.value, ledgerRef: r.ledgerRef, dropped: droppedFrom(r.meta, sent) };
}

/**
 * The house twin of one pool: the same tile point, radius, category tags,
 * street-team hours, price and exclusions, with the house signal instead of
 * the bill's (no explainability). Bill-level: its point is the bill's tile.
 */
async function fetchHouseTwin(
  ctx: RunContext,
  spec: PoolSpec,
  where: string,
  excludeIds: string[],
  houseSignal: { entities: string[]; tags: string[] },
): Promise<PoolHouseTwin> {
  node(ctx, `${HOUSE_TWIN_NODE}, ${where}`, "bill");
  const r = await ctx.qloo.placeInsights({
    signalEntities: houseSignal.entities,
    point: spec.point,
    radiusM: spec.radiusM,
    tags: spec.tags,
    operator: "union",
    hours: streetDay(ctx),
    priceMax: PRICE_MAX,
    excludeTags: excludeTagsFor(ctx),
    excludeEntities: excludeIds,
    take: 50,
    ...(houseSignal.tags.length > 0 ? { extra: { "signal.interests.tags": houseSignal.tags } } : {}),
  });
  const ranks = new Map<string, number>();
  r.value.forEach((e, i) => {
    if (e.entityId && !ranks.has(e.entityId)) ranks.set(e.entityId, i + 1);
  });
  return { ranks, size: r.value.length, ledgerRef: r.ledgerRef };
}

function seedNames(seeds: Seed[]): Map<string, string> {
  return new Map(seeds.map((s) => [s.entity.entityId, s.kind === "act" ? s.act : s.entity.name]));
}

/**
 * `house` is the run's house set (the twin's signal); it defaults to the one
 * the heat step used for this run.
 */
export async function runPartners(
  ctx: RunContext,
  seeds: Seed[],
  top: LiftTile[],
  liftWeak: boolean,
  venueEntityId: string | null,
  house: HouseSet | null = houseFor(ctx),
): Promise<PartnersResult> {
  const keys = partnerCategories(ctx);
  const cats = categoryUrns(ctx.pins, keys);
  const empty: Partner[] = [];
  const base: PartnersResult = { card: envelope("empty", "No partners.", empty, []), partners: [], report: null, pools: [], poolSpecs: [], categories: cats.used };
  const excludeIds = venueEntityId ? [venueEntityId] : [];
  const reasons: string[] = [];
  if (cats.skipped.length > 0) {
    reasons.push(`Skipped ${plural(cats.skipped.length, "type", "types")} of place that have no Qloo tag set up yet (${cats.skipped.join(", ")}).`);
  }
  const tiles = liftWeak ? [] : top.slice(0, PARTNER_TILES);
  const specs: PoolSpec[] = tiles.map((t) => ({ tileGeohash: t.geohash, point: { lat: t.lat, lon: t.lon }, radiusM: TILE_RADIUS_M, tags: cats.urns }));
  // Fewer usable tiles than pools: the rest of the list comes from near the room.
  if (tiles.length < PARTNER_TILES) specs.push({ tileGeohash: null, point: venuePoint(ctx), radiusM: TILE_RADIUS_WIDE_M, tags: cats.urns });
  if (tiles.length === 0) reasons.push("No area stood out, so partners are picked near the venue.");
  else if (tiles.length < PARTNER_TILES) reasons.push(`Only ${plural(tiles.length, "area")} stood out, so the rest of the list is near the venue.`);

  const pools: PartnerPool[] = [];
  const provenance: string[] = [];
  const houseSignal = houseTwinSignal(house);
  const twinFailures: string[] = [];
  let widenedRadius = 0;
  let widenedCats = 0;
  // Worst not_found share across the pools (Qloo ranks without an id it has no taste data for).
  let worstDrop: DroppedCheck = { dropped: [], share: "none" };
  const noteDrop = (d: DroppedCheck) => {
    if (d.share === "all" || (d.share === "some" && worstDrop.share === "none")) worstDrop = d;
  };
  try {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i] as PoolSpec;
      const where = spec.tileGeohash ? `tile ${i + 1}` : "near venue";
      let got = await fetchPool(ctx, seeds, spec, `Q9 partners, ${where}`, excludeIds);
      provenance.push(got.ledgerRef);
      noteDrop(got.dropped);
      if (got.entities.length < MIN_POOL && spec.radiusM < TILE_RADIUS_WIDE_M) {
        spec.radiusM = TILE_RADIUS_WIDE_M;
        widenedRadius++;
        got = await fetchPool(ctx, seeds, spec, `Q9 partners, ${where} (3,500 m)`, excludeIds);
        provenance.push(got.ledgerRef);
        noteDrop(got.dropped);
      }
      if (got.entities.length < MIN_POOL) {
        const more = categoryUrns(ctx.pins, [...keys, ...WIDEN_CATEGORIES]);
        if (more.urns.length > spec.tags.length) {
          spec.tags = more.urns;
          widenedCats++;
          got = await fetchPool(ctx, seeds, spec, `Q9 partners, ${where} (more categories)`, excludeIds);
          provenance.push(got.ledgerRef);
          noteDrop(got.dropped);
        }
      }
      cite(ctx, got.entities, got.ledgerRef);
      const poolOut: PartnerPool = { tileGeohash: spec.tileGeohash, ledgerRef: got.ledgerRef, entities: got.entities };
      // House twin: typed fallback is "no twin for this pool" (no penalty, no chip), never a failed card.
      if (houseSignal && got.entities.length > 0) {
        try {
          const twin = await fetchHouseTwin(ctx, spec, where, excludeIds, houseSignal);
          provenance.push(twin.ledgerRef);
          // An empty twin is no evidence that a place is missing for the usual crowd: no rank, no chip.
          if (twin.size > 0) poolOut.house = twin;
          else twinFailures.push(`${where.replace(/^tile /, "area ")} (no places came back)`);
        } catch (err) {
          const ref = (err as { ledgerRef?: string }).ledgerRef;
          if (ref) provenance.push(ref);
          twinFailures.push(`${where.replace(/^tile /, "area ")} (${errorStatus(err).reason})`);
        }
      }
      pools.push(poolOut);
    }
  } catch (err) {
    base.card = failure(err, empty, "Partners");
    return base;
  }
  if (worstDrop.share === "all") {
    // No usable signal: the pools are general popularity, never shown as a ranking for this bill.
    base.card = envelope("error", "No partners.", empty, provenance, droppedReason(worstDrop, "Q9") ?? undefined);
    return base;
  }
  if (worstDrop.share === "some") reasons.push(droppedReason(worstDrop, "Q9") as string);

  // Step 5, balance check (probe-gated): one seed dominating explainability.
  let rebalanced = false;
  if (ctx.probes.explainabilityInformative && seeds.length > 1 && pools[0]) {
    const headliner = seeds.find((s) => s.kind !== "proxy") ?? seeds[0];
    const check = balanceCheck(pools.flatMap((p) => p.entities), { ...(headliner ? { headlinerId: headliner.entity.entityId } : {}) });
    const others = seeds.filter((s) => s.entity.entityId !== check.dominantSeed);
    if (check.triggered && others.length > 0 && specs[0]) {
      const firstWhere = specs[0].tileGeohash ? "tile 1" : "near venue";
      const got = await fetchPool(ctx, others, specs[0], `Q9 partners, ${firstWhere} (rebalanced)`, excludeIds, signal(ctx, others));
      provenance.push(got.ledgerRef);
      cite(ctx, got.entities, got.ledgerRef);
      const first = pools[0];
      const merged = mergeRankedLists([
        { ids: first.entities.map((e) => e.entityId), weight: 0.5 },
        { ids: got.entities.map((e) => e.entityId), weight: 0.5 },
      ]);
      const byId = new Map([...first.entities, ...got.entities].map((e) => [e.entityId, e]));
      pools[0] = { ...first, entities: merged.map((id) => byId.get(id) as QlooEntity) };
      rebalanced = true;
      ctx.guardReasons.push(`The headliner was dominating the partner ranking; the ${specs[0].tileGeohash ? "first tile" : "near-venue list"} was rebalanced with the co-bill.`);
    }
  }

  const names = seedNames(seeds);
  const tileByGh = new Map(top.map((t) => [t.geohash, t]));
  const twinByPool = new Map<string, PoolHouseTwin>();
  for (const p of pools) if (p.house) twinByPool.set(p.ledgerRef, p.house);
  const excludedCats = excludedCategoriesFor(ctx);
  const { partners, report } = scorePartnersWithReport(pools, top, {
    weekday: streetDay(ctx),
    categoryTags: categoryTagMap(ctx.pins),
    excludeEntityIds: excludeIds,
    excludeCategories: excludedCats,
    extraChips: (e, c): Chip[] => {
      const chips: Chip[] = [];
      const t = c.tileGeohash ? tileByGh.get(c.tileGeohash) : undefined;
      if (t && ctx.billHeatRef) chips.push({ label: `in a ${t.lift.toFixed(2)}x lift tile`, ledgerRef: ctx.billHeatRef });
      const best = [...(e.explainability ?? [])].sort((a, b) => b.score - a.score)[0];
      const who = best ? names.get(best.entityId) : undefined;
      if (best && who && best.score >= 0.5) chips.push({ label: `most influenced by ${who}`, ledgerRef: c.ledgerRef });
      const twin = twinByPool.get(c.ledgerRef);
      if (twin) chips.push({ label: houseTwinChipLabel(twin.ranks.get(e.entityId) ?? null, c.qlooRank, twin.size), ledgerRef: twin.ledgerRef });
      return chips;
    },
  });
  const cleaned = partners.map((p) => ({ ...p, entity: clean(ctx, p.entity) }));
  const tileCount = new Set(cleaned.map((p) => p.tileGeohash ?? "near-venue")).size;
  const dayName = streetDay(ctx).charAt(0).toUpperCase() + streetDay(ctx).slice(1, 3);
  let summary = `${plural(cleaned.length, "partner")} in ${plural(tileCount, "area")}, at most 2 of a kind per area.`;
  if (report.droppedClosed > 0) summary += ` Dropped ${plural(report.droppedClosed, "place")} marked closed.`;
  if (report.droppedHoursClosed > 0) summary += ` Dropped ${plural(report.droppedHoursClosed, "place")} closed on the street-team day.`;
  if (report.hoursUnknown > 0) summary += ` ${report.hoursUnknown.toLocaleString("en-US")} list no hours for ${dayName}: call first.`;
  if (widenedRadius > 0) reasons.push(`${plural(widenedRadius, "area")} had fewer than ${MIN_POOL} places within 2 km, so the search widened to 3.5 km.`);
  if (widenedCats > 0) reasons.push(`${plural(widenedCats, "area search", "area searches")} also took in more types of place.`);
  if (report.belowMinimum) reasons.push(`Found ${cleaned.length} partners; the list aims for 15. The signal is thin, so treat this as a starting list.`);
  if (rebalanced) reasons.push("The headliner was dominating the ranking, so the list was rebalanced with the co-bill.");
  if (twinFailures.length > 0) reasons.push(`The usual-crowd search failed for ${twinFailures.join(", ")}, so those places have no usual-crowd rank.`);
  if (report.penalized > 0) {
    summary += ` ${report.penalized.toLocaleString("en-US")} of ${plural(cleaned.length, "pick")} also rank for the room's usual crowd, so their scores were marked down (more when the two ranks are close).`;
  }
  if (report.droppedCategory > 0) {
    summary += ` ${plural(report.droppedCategory, "place")} left out by category (${ctx.operator.allAges === true ? "all-ages show" : "your exclusions"}).`;
  }
  let status: PartnersCard["status"] = cleaned.length === 0 ? "empty" : "ok";
  if (status === "ok" && (widenedRadius > 0 || widenedCats > 0 || report.belowMinimum || tiles.length < PARTNER_TILES || cats.skipped.length > 0 || rebalanced || worstDrop.share === "some")) status = "partial";
  if (report.belowMinimum) ctx.thinSignal = true;
  if (status === "empty" && reasons.length === 0) reasons.push("No place passed the filters.");
  const limits = ["Suggested, not affiliated: no partner has agreed to anything."];
  if (twinByPool.size > 0) limits.push(HOUSE_TWIN_LIMIT);
  base.card = envelope(status, summary, cleaned, provenance, reasons.length > 0 ? reasons.join(" ") : undefined, limits);
  base.partners = cleaned;
  base.report = report;
  base.pools = pools;
  base.poolSpecs = specs;
  return base;
}
