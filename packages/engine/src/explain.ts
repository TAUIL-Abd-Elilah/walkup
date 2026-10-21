/**
 * "Why this place" for one partner, from data the run already has: the Qloo
 * tags that tie it to this bill's crowd, its area and distance from the venue,
 * one thing the street team can ask for (a fixed table by category), a
 * confidence word with a one-line reason, and the limits line.
 *
 * Tags: the place's own Qloo taste tags (`isTasteTag`: no place types, age
 * bands, payment, amenities, geography or generic words, nothing
 * policy-denied) and, unless the show is adults only, no alcohol tags; each
 * name once, cased for display. Tags the bill itself carries come first, then
 * tags more places on this list share (a tag on more than half of a list of 4
 * or more says nothing about this place and goes last), then Qloo's order; at
 * most 3.
 *
 * Confidence: a score that starts at 1, gains a point for each piece of
 * evidence (a rank in the top tenth of its list or the top 3; the room's usual
 * crowd ranks it at least 10 places lower or not at all; a taste tag shared
 * with the bill) and loses one for each concern (picked near the venue
 * instead of in a top area, the search widened, a short list, a rank in the
 * lower half, the room's usual crowd ranks it higher, no hours for the
 * street-team day). 2 or more is "high", 1 is "medium", 0 or less is "low", so
 * places on one list differ by what is known about each of them. A thin signal
 * for the whole bill caps every place at "medium" (and is said once in each
 * reason) rather than marking every place down alike.
 *
 * Limits: the partner line, plus "call first" when no hours are listed for
 * the street-team day, and the other street-team days the place is closed.
 */
import type { GeoPoint, Partner, PartnerConfidence, PartnerExplain, QlooEntity, QlooTag, Weekday } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "./category";
import { haversineM } from "./geohash";
import { roundTo } from "./num";
import { hoursOnDay } from "./hours";
import { findAlcoholTerm } from "./policy";
import { dayName, joinAnd } from "./steps";
import { displayTagName, isTasteTag, tagNameKey } from "./tasteTags";

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
  /** Partners on the list; a tag on more than half of a list of 4 or more goes last. */
  listSize?: number;
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
    if (!t.name || t.name.trim() === "") return;
    if (!isTasteTag(t)) return;
    if (!opts.adultsOnly && alcoholTag(t)) return;
    usable.push({ tag: t, i });
  });
  const bill = opts.billTagIds ?? new Set<string>();
  const counts = opts.tagCounts ?? new Map<string, number>();
  const size = opts.listSize ?? 0;
  const everywhere = (id: string) => (size >= 4 && (counts.get(id) ?? 0) > size / 2 ? 1 : 0);
  usable.sort((a, b) => {
    const ba = bill.has(a.tag.id) ? 1 : 0;
    const bb = bill.has(b.tag.id) ? 1 : 0;
    return bb - ba || everywhere(a.tag.id) - everywhere(b.tag.id) || (counts.get(b.tag.id) ?? 0) - (counts.get(a.tag.id) ?? 0) || a.i - b.i;
  });
  const out: { id: string; name: string }[] = [];
  const names = new Set<string>();
  for (const { tag } of usable) {
    const key = tagNameKey(tag.name);
    if (names.has(key)) continue;
    names.add(key);
    out.push({ id: tag.id, name: displayTagName(tag.name) });
    if (out.length >= (opts.max ?? MAX_EXPLAIN_TAGS)) break;
  }
  return out;
}

export interface ConfidenceInput {
  qlooRank: number;
  /**
   * The place's rank in the same search for the room's usual crowd: a number, null when it is not on that list,
   * undefined when no such search ran (no evidence either way).
   */
  houseRank?: number | null;
  /** Size of the usual crowd's list (null houseRank counts only when this is above 0). */
  houseListSize?: number;
  /** Names of the place's shown tags that the bill's own acts carry too. */
  billTagNames?: readonly string[];
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

/** A house-rank gap at least this big is evidence the place belongs to this crowd, not the room's usual one. */
export const CONFIDENCE_HOUSE_GAP = 10;

/** Confidence and a one-line reason (see the module comment). */
export function partnerConfidence(i: ConfidenceInput): { confidence: PartnerConfidence; why: string } {
  const day = dayName(i.day);
  const strengths: string[] = [];
  if (i.qlooRank <= Math.max(3, Math.ceil(i.poolSize * 0.1))) strengths.push("near the top of its list");
  if (i.houseRank === null && (i.houseListSize ?? 0) > 0) strengths.push(`not in the room's usual crowd's top ${i.houseListSize}`);
  else if (typeof i.houseRank === "number" && i.houseRank - i.qlooRank >= CONFIDENCE_HOUSE_GAP) {
    strengths.push(`the room's usual crowd ranks it ${i.houseRank - i.qlooRank} places lower`);
  }
  const shared = (i.billTagNames ?? []).find((n) => n.trim() !== "");
  if (shared) strengths.push(`it shares the bill's ${shared} tag`);
  const concerns: string[] = [];
  if (i.widenedRadiusM !== null && i.widenedCategories) concerns.push(`the search widened to ${i.widenedRadiusM.toLocaleString("en-US")} m and to more kinds of places`);
  else if (i.widenedRadiusM !== null) concerns.push(`the search widened to ${i.widenedRadiusM.toLocaleString("en-US")} m`);
  else if (i.widenedCategories) concerns.push("the search took in more kinds of places");
  if (i.poolSize < SMALL_POOL) concerns.push("the list was short");
  if (i.poolSize > 0 && i.qlooRank > i.poolSize / 2) concerns.push("it ranked in the lower half");
  if (typeof i.houseRank === "number" && i.houseRank < i.qlooRank) concerns.push("the room's usual crowd ranks it higher");
  if (!i.hoursKnown) concerns.push(`no hours are listed for ${day}`);
  const score = 1 + strengths.length - concerns.length - (i.inTopArea ? 0 : 1);
  let confidence: PartnerConfidence = score >= 2 ? "high" : score === 1 ? "medium" : "low";
  if (i.thinSignal) {
    if (confidence === "high") confidence = "medium";
    concerns.push("this bill's signal is thin");
  }
  const of = i.poolSize > 0 ? ` of ${i.poolSize}` : "";
  const where = i.inTopArea ? "in a top area" : "near the venue, not in a top area";
  // "near the top of its list" only adds words to "Rank 2 of 28": the reason names the other strengths.
  const said = strengths.filter((x) => x !== "near the top of its list");
  const plus = said.length > 0 ? `; ${joinAnd(said)}` : "";
  if (concerns.length === 0) return { confidence, why: `Rank ${i.qlooRank}${of} ${where}${plus}, open ${day}.` };
  return { confidence, why: `Rank ${i.qlooRank}${of} ${where}${plus}, but ${joinAnd(concerns)}.` };
}

export interface ExplainContext {
  venue: GeoPoint;
  /** The street-team day the hours were checked for. */
  day: Weekday | string;
  /** Every street-team day (the first is `day`): the limits name the other days the place is closed. */
  days?: readonly Weekday[];
  /** Partners on the list (for the "on most of the list" tag rule). */
  listSize?: number;
  /** Ticketmaster says adults only and the operator has not said all ages. */
  adultsOnly: boolean;
  thinSignal: boolean;
  billTagIds?: ReadonlySet<string>;
  tagCounts?: ReadonlyMap<string, number>;
}

export interface ExplainPartnerInput {
  partner: Pick<Partner, "entity" | "category" | "qlooRank" | "tileGeohash" | "tileName" | "hoursOnDay"> & Partial<Pick<Partner, "houseRank">>;
  /** Size of the usual crowd's list the partner was compared with (for "not in its top N"). */
  houseListSize?: number;
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

/** The street-team days after the first on which the place's hours say it is closed (unknown hours never count). */
function closedOtherDays(entity: Pick<QlooEntity, "properties">, ctx: ExplainContext): Weekday[] {
  const first = typeof ctx.day === "string" ? ctx.day.toLowerCase() : "";
  return [...new Set(ctx.days ?? [])].filter((d) => d !== first && hoursOnDay(entity.properties?.hours, d).status === "closed");
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
  const tags = explainTags(p.entity, {
    adultsOnly: ctx.adultsOnly,
    ...(ctx.billTagIds ? { billTagIds: ctx.billTagIds } : {}),
    ...(ctx.tagCounts ? { tagCounts: ctx.tagCounts } : {}),
    ...(ctx.listSize !== undefined ? { listSize: ctx.listSize } : {}),
  });
  const billTagNames = ctx.billTagIds ? tags.filter((t) => ctx.billTagIds?.has(t.id)).map((t) => t.name) : [];
  const conf = partnerConfidence({
    qlooRank: p.qlooRank,
    ...(p.houseRank !== undefined ? { houseRank: p.houseRank } : {}),
    ...(i.houseListSize !== undefined ? { houseListSize: i.houseListSize } : {}),
    billTagNames,
    poolSize: i.poolSize,
    inTopArea: p.tileGeohash !== null,
    widenedRadiusM: i.widenedRadiusM ?? null,
    widenedCategories: i.widenedCategories ?? false,
    hoursKnown,
    day: ctx.day,
    thinSignal: ctx.thinSignal,
  });
  const closedOn = closedOtherDays(p.entity, ctx);
  const limits = [PARTNER_LIMITS];
  if (!hoursKnown) limits.push(`No hours listed for ${dayName(ctx.day)}: call first.`);
  if (closedOn.length > 0) limits.push(`Closed ${joinAnd(closedOn.map(dayName))}: visit on ${dayName(ctx.day)}.`);
  const out: PartnerExplain = {
    tags,
    activation: activationFor(p.category, { adultsOnly: ctx.adultsOnly }),
    confidence: conf.confidence,
    confidenceWhy: conf.why,
    limits: limits.join(" "),
    ledgerRefs: [...new Set([i.poolRef, i.twinRef ?? ""].filter((r) => r !== ""))],
  };
  const area = p.tileName ?? i.areaName;
  if (area) out.areaName = area;
  const km = distanceFromVenueKm(p.entity, ctx.venue);
  if (km !== undefined) out.distanceKm = km;
  return out;
}
