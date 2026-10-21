/**
 * Which Qloo tags say something about a crowd's taste, and how to show them.
 *
 * Qloo returns many tags that are true but are not taste: age bands ("35 44"),
 * gender, payment methods and card brands ("Credit cards", "American
 * Express"), amenities and services ("Dine in", "Wheelchair accessible
 * restroom", "Parking"), times of day, place types ("Place", "Restaurant"),
 * places and nationalities ("United States", "Memphis", "American",
 * "English"), occupations ("Musician") and words that fit nearly any act or
 * room ("Guitar", "Casual", "Clean"). None of them belongs in "why this
 * place", in "what's different" or in copy. `isTasteTag` keeps the rest, after
 * the policy denylist (`isDeniedTag`).
 *
 * `displayTagName` fixes Qloo's odd casing ("VERSATILE", "DedicateD",
 * "vintage") and `dedupeTags` drops a tag whose id or name was already listed
 * ("Guitar" comes back under two namespaces).
 */
import type { QlooTag } from "@walkup/contracts";
import { isDeniedTag } from "./policy";

/** Namespaces that are never taste (matched against the tag id and its type). */
export const NON_TASTE_TAG_PREFIXES: readonly string[] = [
  // Demographics.
  "urn:tag:age_range:",
  "urn:tag:age:",
  "urn:tag:gender:",
  "urn:tag:demographic",
  // Payment, price and endorsements.
  "urn:tag:payments:",
  "urn:tag:payment:",
  "urn:tag:credit_card:",
  "urn:tag:endorsement:",
  "urn:tag:price",
  "urn:tag:cost_description:",
  "urn:tag:hotel_rating:",
  // Amenities, services and logistics.
  "urn:tag:amenity:",
  "urn:tag:amenities:",
  "urn:tag:accessibility:",
  "urn:tag:parking:",
  "urn:tag:service_options:",
  "urn:tag:service_type:",
  "urn:tag:planning:",
  "urn:tag:children:",
  "urn:tag:pets:",
  "urn:tag:recycling:",
  "urn:tag:not_for_display:",
  "urn:tag:resy:",
  "urn:tag:time_of_day_fit:",
  "urn:tag:visit_intent:",
  "urn:tag:event:",
  "urn:tag:activity_type:",
  "urn:tag:dining_options:",
  "urn:tag:offerings:",
  "urn:tag:noise_level:",
  "urn:tag:view:",
  // Geography.
  "urn:tag:region:",
  "urn:tag:nationality:",
  "urn:tag:language:",
  "urn:tag:location:",
  "urn:tag:geo",
  "urn:tag:neighborhood",
  "urn:tag:nearby_attraction:",
  "urn:tag:setting:",
  // What a thing is, not who likes it.
  "urn:tag:category:",
  "urn:tag:genre:place",
  "urn:tag:subtype",
  "urn:tag:occupation:",
  "urn:tag:wikipedia_category:",
];

/** Names that say nothing about a crowd, or are not taste (compared lower case, punctuation as spaces). */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
  "place",
  "places",
  "restaurant",
  "restaurants",
  "food",
  "music",
  "musician",
  "musicians",
  "artist",
  "artists",
  "producer",
  "producers",
  "songwriter",
  "songwriters",
  "singer",
  "singers",
  "vocals",
  "voice",
  "singing",
  "guitar",
  "drums",
  "piano",
  "bass",
  "keyboard",
  "moderate",
  "casual",
  "clean",
  "convenient",
  "functional",
  "utilitarian",
  "professional",
  "business friendly",
  "commuter centric",
  "value oriented",
  "small scale",
  "spacious",
  "dark lighting",
  "large group",
  "large groups",
  "sexy",
  "grown",
  "evening",
  "afternoon",
  "morning",
  "night",
  "dine in",
  "takeout",
  "delivery",
  "socializing",
  "dining drinking",
  "other",
  "united states",
  "usa",
  "us",
  "america",
  "american",
  "english",
  "bottled water",
  "water",
  "soft drinks",
  "sodas",
  "soda",
  "beverages",
  "drinks",
  // Religious dietary labels: never used to describe a crowd.
  "halal",
  "kosher",
]);

/** Card and wallet brands and payment words. */
const PAYMENT_RE = /\b(?:american express|amex|visa|mastercard|master card|discover card|apple pay|google pay|samsung pay|paypal|venmo|cash app|zelle|nfc|mobile payments?|credit cards?|debit cards?|contactless|checks?)\b/;
/** Age bands and other demographic labels: "35 44", "18-24", "55+", "Gen Z", "Millennials". */
const DEMOGRAPHIC_RE = /^(?:\d{1,2}\s*(?:to|and)?\s*\d{1,2}|\d{1,2}\s*(?:plus|and over|and up)?|male|female|men|women|gen z|gen x|millennials?|boomers?|baby boomers)$/;

function words(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

function hasPrefix(s: string | undefined, prefixes: readonly string[]): boolean {
  if (!s) return false;
  const lower = s.trim().toLowerCase();
  const withColon = lower.endsWith(":") ? lower : `${lower}:`;
  return prefixes.some((p) => lower.startsWith(p) || withColon.startsWith(p));
}

/** True for a name that is never taste: generic, a payment word, or a demographic label. */
export function isNonTasteName(name: string | null | undefined): boolean {
  const n = words(name ?? "");
  if (n === "") return true;
  if (GENERIC_NAMES.has(n)) return true;
  if (PAYMENT_RE.test(n)) return true;
  return DEMOGRAPHIC_RE.test(n.replace(/\+/g, " plus").trim());
}

/** True when the tag says something about taste and passes the policy denylist (see the module comment). */
export function isTasteTag(tag: Pick<QlooTag, "id" | "name"> & { type?: string | undefined; subtype?: string | undefined }): boolean {
  if (!tag || typeof tag.id !== "string" || tag.id.trim() === "") return false;
  if (isDeniedTag(tag as QlooTag)) return false;
  if (hasPrefix(tag.id, NON_TASTE_TAG_PREFIXES) || hasPrefix(tag.type, NON_TASTE_TAG_PREFIXES) || hasPrefix(tag.subtype, NON_TASTE_TAG_PREFIXES)) return false;
  return !isNonTasteName(tag.name);
}

/**
 * The name as a sheet shows it: trimmed, a shouted or oddly cased word in
 * normal case ("VERSATILE" -> "Versatile", "DedicateD" -> "Dedicated"), the
 * first letter upper case ("vintage" -> "Vintage"). Short capitals stay
 * ("R&B", "DJ", "EDM").
 */
export function displayTagName(name: string): string {
  const fixed = name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => {
      const letters = w.replace(/[^A-Za-z]/g, "");
      if (letters.length >= 4 && letters === letters.toUpperCase()) return w.charAt(0) + w.slice(1).toLowerCase();
      if (/[a-z][A-Z]+$/.test(w) && !/^(?:Mc|Mac|O')/.test(w)) return w.charAt(0) + w.slice(1).toLowerCase();
      return w;
    })
    .join(" ");
  return fixed.charAt(0).toUpperCase() + fixed.slice(1);
}

/** The key two tags share when they read the same ("Guitar" under two namespaces, "Soulful" twice). */
export function tagNameKey(name: string): string {
  return words(name).replace(/\s+/g, " ");
}

/** Tags without repeats: a later tag with an id or a name already listed is dropped. Order is kept. */
export function dedupeTags<T extends { id: string; name: string }>(tags: readonly T[]): T[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const out: T[] = [];
  for (const t of tags) {
    if (!t || typeof t.id !== "string") continue;
    const key = tagNameKey(t.name ?? "");
    if (ids.has(t.id) || (key !== "" && names.has(key))) continue;
    ids.add(t.id);
    if (key !== "") names.add(key);
    out.push(t);
  }
  return out;
}
