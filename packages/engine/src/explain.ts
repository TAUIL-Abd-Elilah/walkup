/**
 * "Why this place" for one partner, from data the run already has: the Qloo
 * tags that tie it to this bill's crowd, its area and distance from the venue,
 * one thing the street team can ask for (a fixed table by category), a
 * confidence word with a one-line reason, and the limits line.
 *
 * Tags: the place's own Qloo tags, minus category tags, policy-denied tags
 * and, unless the show is adults only, alcohol tags. Tags the bill itself
 * carries come first, then tags more places on this list share, then Qloo's
 * order; at most 3.
 *
 * Confidence: count the concerns (picked near the venue instead of in a top
 * area, the search widened, a short list, a rank in the lower half, no hours
 * for the street-team day, a thin signal for the whole bill). None is "high",
 * one is "medium", two or more is "low".
 */
import type { GeoPoint, Partner, PartnerConfidence, PartnerExplain, QlooEntity, QlooTag, Weekday } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "./category";
import { haversineM } from "./geohash";
import { roundTo } from "./num";
import { findAlcoholTerm, isDeniedTag } from "./policy";
import { dayName, joinAnd } from "./steps";

export const PARTNER_LIMITS = "Suggested, not affiliated: no partner has agreed to anything.";

/** A partner list shorter than this makes a rank coarse (a concern). */
export const SMALL_POOL = 15;
export const MAX_EXPLAIN_TAGS = 3;

export interface ActivationRule {
  categories: readonly string[];
  /** The ask on any show. */
  text: string;
  /** The ask when Ticketmaster says the show is adults only and the operator has not said all ages. */
  adultsText?: string;
}

/**
 * One ask per kind of place, for the categories pinned in config/tags.json. Bars get a listening night only on
 * adults-only shows. Record stores are not here: their tag could not be pinned on Oct 15.
 */
export const ACTIVATION_RULES: readonly ActivationRule[] = [
  { categories: ["book_store", "clothing_store"], text: "Ask for a poster in the window and a ticket drop at the counter." },
  { categories: ["barber_shop", "barbershop", "beauty_salon", "hair_salon"], text: "Ask to leave flyers and a card at each chair." },
  { categories: DEFAULT_BAR_CATEGORIES, text: "Ask to put up a poster.", adultsText: "Ask for a poster and a pre-show listening night." },
  { categories: ["cafe", "coffee", "coffee_shop", "tea_house"], text: "Ask to leave table cards." },
];
/** Restaurants and every other kind of place. */
export const DEFAULT_ACTIVATION = "Ask to leave flyers at the counter.";

export function activationFor(category: string, opts: { adultsOnly: boolean }): string {
  const key = category.trim().toLowerCase();
  const rule = ACTIVATION_RULES.find((r) => r.categories.includes(key));
  if (!rule) return DEFAULT_ACTIVATION;
  return opts.adultsOnly && rule.adultsText ? rule.adultsText : rule.text;
}

/** Category key in words, singular and plural ("record_store" -> record store / record stores). */
const CATEGORY_WORDS: Record<string, [string, string]> = {
  bar: ["bar", "bars"],
  pub: ["pub", "pubs"],
  sports_bar: ["sports bar", "sports bars"],
  restaurant: ["restaurant", "restaurants"],
  soul_food: ["soul food place", "soul food places"],
  cafe: ["cafe", "cafes"],
  record_store: ["record store", "record stores"],
  book_store: ["book store", "book stores"],
  clothing_store: ["clothing store", "clothing stores"],
  barber_shop: ["barbershop", "barbershops"],
  beauty_salon: ["beauty salon", "beauty salons"],
  night_club: ["night club", "night clubs"],
  bakery: ["bakery", "bakeries"],
  other: ["place", "places"],
};

export function categoryWord(category: string, plural = false): string {
  const w = CATEGORY_WORDS[category];
  if (w) return plural ? w[1] : w[0];
  const base = category.replace(/_/g, " ").trim() || "place";
  return plural ? `${base}s` : base;
}

/** Tag id -> how many of the given partners carry it (each partner counted once). */
export function partnerTagCounts(partners: readonly Pick<Partner, "entity">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of partners) {
    for (const id of new Set((p.entity.tags ?? []).map((t) => t.id))) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

function alcoholTag(t: QlooTag): boolean {
  const tail = (t.id.split(":").pop() ?? "").replace(/_/g, " ");
  return findAlcoholTerm(t.name) !== null || findAlcoholTerm(tail) !== null;
}

export interface ExplainTagOptions {
  /** Tag ids the bill's own acts carry (they rank first). */
  billTagIds?: ReadonlySet<string>;
  /** Tag id -> partners on this list that carry it (more shared ranks higher). */
  tagCounts?: ReadonlyMap<string, number>;
  /** Alcohol tags are kept only on adults-only shows. */
  adultsOnly: boolean;
  max?: number;
}

/** The tags that tie the place to this crowd, best first (see the module comment). */
export function explainTags(entity: Pick<QlooEntity, "tags">, opts: ExplainTagOptions): { id: string; name: string }[] {
  const seen = new Set<string>();
  const usable: { tag: QlooTag; i: number }[] = [];
  (entity.tags ?? []).forEach((t, i) => {
    if (!t || typeof t.id !== "string" || seen.has(t.id)) return;
    seen.add(t.id);
    if (t.id.startsWith("urn:tag:category:")) return;
    if (!t.name || t.name.trim() === "") return;
    if (isDeniedTag(t)) return;
    if (!opts.adultsOnly && alcoholTag(t)) return;
    usable.push({ tag: t, i });
  });
  const bill = opts.billTagIds ?? new Set<string>();
  const counts = opts.tagCounts ?? new Map<string, number>();
  usable.sort((a, b) => {
    const ba = bill.has(a.tag.id) ? 1 : 0;
    const bb = bill.has(b.tag.id) ? 1 : 0;
    return bb - ba || (counts.get(b.tag.id) ?? 0) - (counts.get(a.tag.id) ?? 0) || a.i - b.i;
  });
  return usable.slice(0, opts.max ?? MAX_EXPLAIN_TAGS).map(({ tag }) => ({ id: tag.id, name: tag.name.trim() }));
}

export interface ConfidenceInput {
  qlooRank: number;
  /** Places in the Qloo list the partner came from. */
  poolSize: number;
  /** False when the place came from the near-venue list, not a top area. */
  inTopArea: boolean;
  /** Radius the search widened to (m), or null when it did not widen. */
  widenedRadiusM: number | null;
  widenedCategories: boolean;
  /** True when the place lists hours for the street-team day. */
  hoursKnown: boolean;
  day: Weekday | string;
  /** True when the whole bill's signal is thin. */
  thinSignal: boolean;
}

/** Confidence and a one-line reason (see the module comment). */
export function partnerConfidence(i: ConfidenceInput): { confidence: PartnerConfidence; why: string } {
  const day = dayName(i.day);
  const concerns: string[] = [];
  if (i.widenedRadiusM !== null && i.widenedCategories) concerns.push(`the search widened to ${i.widenedRadiusM.toLocaleString("en-US")} m and to more kinds of places`);
  else if (i.widenedRadiusM !== null) concerns.push(`the search widened to ${i.widenedRadiusM.toLocaleString("en-US")} m`);
  else if (i.widenedCategories) concerns.push("the search took in more kinds of places");
  if (i.poolSize < SMALL_POOL) concerns.push("the list was short");
  if (i.poolSize > 0 && i.qlooRank > i.poolSize / 2) concerns.push("it ranked in the lower half");
  if (!i.hoursKnown) concerns.push(`no hours are listed for ${day}`);
  if (i.thinSignal) concerns.push("this bill's signal is thin");
  const count = concerns.length + (i.inTopArea ? 0 : 1);
  const confidence: PartnerConfidence = count === 0 ? "high" : count === 1 ? "medium" : "low";
  const of = i.poolSize > 0 ? ` of ${i.poolSize}` : "";
  const where = i.inTopArea ? "in a top area" : "near the venue, not in a top area";
  if (concerns.length === 0) return { confidence, why: `Rank ${i.qlooRank}${of} ${where}, open ${day}.` };
  return { confidence, why: `Rank ${i.qlooRank}${of} ${where}, but ${joinAnd(concerns)}.` };
}

export interface ExplainContext {
  venue: GeoPoint;
  /** The street-team day the hours were checked for. */
  day: Weekday | string;
  /** Ticketmaster says adults only and the operator has not said all ages. */
  adultsOnly: boolean;
  thinSignal: boolean;
  billTagIds?: ReadonlySet<string>;
  tagCounts?: ReadonlyMap<string, number>;
}

export interface ExplainPartnerInput {
  partner: Pick<Partner, "entity" | "category" | "qlooRank" | "tileGeohash" | "tileName" | "hoursOnDay">;
  /** Size of the Qloo list it came from (the call's result count). */
  poolSize: number;
  /** Ledger ids: the pool call, then its house twin when one ran. */
  poolRef: string;
  twinRef?: string | null;
  widenedRadiusM?: number | null;
  widenedCategories?: boolean;
  /** Area name when the partner has no tile name (e.g. from the gazetteer at its location). */
  areaName?: string;
}

/** Straight-line km from the venue, one decimal; undefined without a location. */
export function distanceFromVenueKm(entity: Pick<QlooEntity, "location">, venue: GeoPoint): number | undefined {
  const loc = entity.location;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || !Number.isFinite(venue.lat) || !Number.isFinite(venue.lon)) return undefined;
  return roundTo(haversineM(venue, loc) / 1000, 1);
}

export function explainPartner(i: ExplainPartnerInput, ctx: ExplainContext): PartnerExplain {
  const p = i.partner;
  const hoursKnown = typeof p.hoursOnDay === "string" && p.hoursOnDay.trim() !== "";
  const conf = partnerConfidence({
    qlooRank: p.qlooRank,
    poolSize: i.poolSize,
    inTopArea: p.tileGeohash !== null,
    widenedRadiusM: i.widenedRadiusM ?? null,
    widenedCategories: i.widenedCategories ?? false,
    hoursKnown,
    day: ctx.day,
    thinSignal: ctx.thinSignal,
  });
  const out: PartnerExplain = {
    tags: explainTags(p.entity, { adultsOnly: ctx.adultsOnly, ...(ctx.billTagIds ? { billTagIds: ctx.billTagIds } : {}), ...(ctx.tagCounts ? { tagCounts: ctx.tagCounts } : {}) }),
    activation: activationFor(p.category, { adultsOnly: ctx.adultsOnly }),
    confidence: conf.confidence,
    confidenceWhy: conf.why,
    limits: hoursKnown ? PARTNER_LIMITS : `${PARTNER_LIMITS} No hours listed for ${dayName(ctx.day)}: call first.`,
    ledgerRefs: [...new Set([i.poolRef, i.twinRef ?? ""].filter((r) => r !== ""))],
  };
  const area = p.tileName ?? i.areaName;
  if (area) out.areaName = area;
  const km = distanceFromVenueKm(p.entity, ctx.venue);
  if (km !== undefined) out.distanceKm = km;
  return out;
}
