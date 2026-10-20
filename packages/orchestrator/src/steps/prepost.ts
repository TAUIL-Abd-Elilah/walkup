/**
 * Q10: pre/post-show spots near the venue, open on show night, with the
 * house-signal twin for the delta rank and the load balancer. Bars are never
 * fan-facing unless Ticketmaster says the show is 21+.
 */
import type { PrePostSpot, QlooEntity, StreetSheetCards } from "@walkup/contracts";
import { buildPrePostSpots, hoursOnDay, resolveCategory } from "@walkup/engine";
import { categoryTagMap, categoryUrns, PREPOST_CATEGORIES } from "../tags";
import { cite, clean, droppedFrom, droppedReason, envelope, failure, node, plural, signal, venuePoint, type HouseSet, type RunContext, type Seed } from "../context";
import { excludedCategoriesFor } from "./partners";

export const PREPOST_RADIUS_M = 1500;
export const PREPOST_RADIUS_WIDE_M = 2500;
export const MIN_SPOTS = 6;
/** Share of attendance assumed to visit any pre/post spot (heuristic, editable). */
export const OUTING_RATE = 0.2;
/** Assumed capacity per spot until the operator edits it. */
export const DEFAULT_SPOT_CAPACITY = 120;
export const OPEN_CHIP = "near the room, open on show night";
export const CALL_AHEAD_CHIP = "near the room, no hours listed for show night: call ahead";

type PrePostCard = StreetSheetCards["prePost"];

/** True when a not_found note is among the card's reasons. */
function drop10(reasons: readonly string[]): boolean {
  return reasons.some((r) => r.includes("(Q10)"));
}

/** Spots left out by type this run (operator exclusions; every bar when the operator says all ages). */
export interface PrePostTypeDrops {
  count: number;
  reason: "all-ages show" | "your exclusions";
}

const TYPE_DROPS = new WeakMap<RunContext, PrePostTypeDrops>();

/** The spots runPrePost left out by type (null before it ran or when none were). */
export function prePostTypeDrops(ctx: RunContext): PrePostTypeDrops | null {
  return TYPE_DROPS.get(ctx) ?? null;
}

/**
 * The operator's type exclusions, applied before the spots are picked so the
 * list still fills from the rest: excluded categories, and every bar category
 * when the operator says all ages (Ticketmaster's 21+ never relaxes that).
 */
function dropByType(ctx: RunContext, entities: QlooEntity[]): QlooEntity[] {
  const excluded = new Set(excludedCategoriesFor(ctx));
  if (excluded.size === 0) return entities;
  const tags = categoryTagMap(ctx.pins);
  const kept = entities.filter((e) => !excluded.has(resolveCategory(e, { categoryTags: tags })));
  const count = entities.length - kept.length;
  if (count > 0) TYPE_DROPS.set(ctx, { count, reason: ctx.operator.allAges === true ? "all-ages show" : "your exclusions" });
  return kept;
}

export async function runPrePost(ctx: RunContext, seeds: Seed[], house: HouseSet, venueEntityId: string | null): Promise<PrePostCard> {
  const empty: PrePostSpot[] = [];
  const cats = categoryUrns(ctx.pins, PREPOST_CATEGORIES);
  const exclude = venueEntityId ? [venueEntityId] : [];
  const provenance: string[] = [];
  const reasons: string[] = [];
  if (cats.skipped.length > 0) reasons.push(`skipped ${plural(cats.skipped.length, "kind", "kinds")} of place that have no Qloo tag set up yet (${cats.skipped.join(", ")})`);
  const ask = async (radiusM: number, label: string, level: "bill" | "venue", sig: ReturnType<typeof signal>, extra?: Record<string, string[]>) => {
    node(ctx, label, level);
    const r = await ctx.qloo.placeInsights({
      signalEntities: sig,
      point: venuePoint(ctx),
      radiusM,
      tags: cats.urns,
      operator: "union",
      hours: ctx.bill.weekday,
      excludeEntities: exclude,
      explainability: true,
      take: 25,
      ...(extra ? { extra } : {}),
    });
    provenance.push(r.ledgerRef);
    return r;
  };
  let radiusM = PREPOST_RADIUS_M;
  let billEntities: QlooEntity[] = [];
  let billRef = "";
  try {
    let r = await ask(radiusM, "Q10 pre/post", "bill", signal(ctx, seeds));
    if (r.value.length < MIN_SPOTS) {
      radiusM = PREPOST_RADIUS_WIDE_M;
      r = await ask(radiusM, "Q10 pre/post (2,500 m)", "bill", signal(ctx, seeds));
      reasons.push(`fewer than ${MIN_SPOTS} spots came back inside 1.5 km, so the search widened to 2,500 m`);
    }
    const drop = droppedFrom(r.meta, signal(ctx, seeds));
    if (drop.share === "all") {
      // No usable signal: the order is general popularity, never shown as this bill's spots.
      return envelope("error", "Before and after the show", empty, provenance, droppedReason(drop, "Q10") ?? undefined);
    }
    const dropLine = droppedReason(drop, "Q10");
    if (dropLine) reasons.push(dropLine.replace(/.$/, ""));
    billEntities = r.value;
    billRef = r.ledgerRef;
    cite(ctx, billEntities, billRef);
  } catch (err) {
    return failure(err, empty, "Before and after the show");
  }

  // House-signal twin (weekly per venue): the room's usual spots, for the delta rank.
  let twinIds: string[] | null = null;
  let twinRef: string | undefined;
  try {
    if (house.baseline === "house" && house.ids.length > 0) {
      const r = await ask(radiusM, "Q10 house twin", "venue", house.ids);
      twinIds = r.value.map((e) => e.entityId);
      twinRef = r.ledgerRef;
    } else if (house.tag) {
      const r = await ask(radiusM, "Q10 house twin (tag baseline)", "venue", [], { "signal.interests.tags": [house.tag] });
      twinIds = r.value.map((e) => e.entityId);
      twinRef = r.ledgerRef;
    }
  } catch {
    reasons.push("the same search for the room's usual crowd failed, so the spots have no usual-crowd rank");
  }

  const { spots, report } = buildPrePostSpots(dropByType(ctx, billEntities), {
    attendance: ctx.operator.capacity,
    outingRate: OUTING_RATE,
    defaultCapacity: DEFAULT_SPOT_CAPACITY,
    legalAgeEnforced: ctx.bill.legalAgeEnforced,
    houseTwinIds: twinIds,
    ledgerRef: billRef,
    ...(twinRef ? { houseLedgerRef: twinRef } : {}),
    weekday: ctx.bill.weekday,
    maxSpots: 8,
    excludeEntityIds: exclude,
    categoryTags: categoryTagMap(ctx.pins),
    chipLabel: OPEN_CHIP,
  });
  // Closed spots are already dropped. A spot whose hours are not listed for show night is kept, but never
  // presented as open: its chip and the card say "call ahead".
  let unknownHours = 0;
  const cleaned = spots.map((s) => {
    const known = hoursOnDay(s.entity.properties?.hours, ctx.bill.weekday).status === "open";
    if (known) return { ...s, entity: clean(ctx, s.entity) };
    unknownHours++;
    const chips = s.chips.map((c) => (c.label === OPEN_CHIP ? { ...c, label: CALL_AHEAD_CHIP } : c));
    return { ...s, entity: clean(ctx, s.entity), chips };
  });
  const km = (radiusM / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const balanced = report.capacityApplied ? ", with the crowd spread across them by assumed capacity" : "";
  let summary =
    unknownHours === 0
      ? `${plural(cleaned.length, "spot")} within ${km} km open on show night${balanced}.`
      : `${plural(cleaned.length, "spot")} within ${km} km${balanced}: ${(cleaned.length - unknownHours).toLocaleString("en-US")} open on show night, ${unknownHours} with no hours listed (call ahead).`;
  const barsHeld = cleaned.filter((s) => !s.fanFacingAllowed).length;
  if (barsHeld > 0) {
    summary +=
      ctx.bill.legalAgeEnforced === false
        ? " All-ages show: bars stay on your list but off anything fans see."
        : " Ticketmaster doesn't list an age policy, so bars stay on your list but off anything fans see.";
  }
  if (report.droppedClosed > 0) summary += ` Dropped ${plural(report.droppedClosed, "place")} marked closed.`;
  const typeDrops = prePostTypeDrops(ctx);
  if (typeDrops) summary += ` ${plural(typeDrops.count, "place")} left out by type (${typeDrops.reason}).`;
  if (!report.capacityApplied) reasons.push("no capacity entered, so shares follow rank only");
  let status: PrePostCard["status"] = cleaned.length === 0 ? "empty" : "ok";
  if (status === "ok" && (radiusM > PREPOST_RADIUS_M || cleaned.length < MIN_SPOTS)) status = "partial";
  if (status === "ok" && (cats.skipped.length > 0 || drop10(reasons))) status = "partial";
  if (status === "empty" && reasons.length === 0) reasons.push("no spot near the room passed the filters");
  const joined = reasons.join("; ");
  const reason = joined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` : undefined;
  return envelope(status, summary, cleaned, provenance, status === "ok" ? undefined : reason, [
    "Expected shares are a heuristic with assumed capacities, not a forecast.",
  ]);
}
