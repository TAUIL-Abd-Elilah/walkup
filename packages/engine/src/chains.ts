/**
 * National-chain matcher over a hand-kept list of brand names
 * (config/chains.json). Pure: the caller passes the list.
 *
 * Both sides are normalized the same way: accents stripped, lower case,
 * apostrophes and periods removed ("Dunkin'" -> "dunkin", "T.J. Maxx" ->
 * "tj maxx"), "&" and "+" read as "and", every other run of punctuation a
 * space, and a leading "the" dropped. Matching is on whole words:
 *
 *  - a place matches a brand key (its name or an alias) when its words equal
 *    the key's words, or start with them ("Starbucks Coffee Company",
 *    "Potbelly Sandwich Shop", "Outback Steakhouse Tysons");
 *  - an `exact` entry (a common word or a town name: "Target", "Gap",
 *    "Burlington") never matches as the start of a longer name. It matches the
 *    whole name, the whole name with a trailing store number ("Target 1234"),
 *    or the part before " - ", " | ", " @ ", "(" or "," ("Gap (Georgetown)").
 *
 * So "Jerry's Seafood" does not match "Jerry's Subs & Pizza", and "Pho Deluxe
 * Tysons" matches nothing: a word shared with a brand is not enough.
 *
 * The list is one signal of four (`chainSignals`): Qloo's own description of
 * the place ("Casual sports-bar chain ..."), a store-locator website, and the
 * same name or website at three or more places the run saw catch chains the
 * list misses. Brands marked `adult` on the list, adult-entertainment tags and
 * descriptions make a place adult-themed (`isAdultThemed`): never a street-team
 * stop. `chainSummary` words the count the way the list shows it.
 */
import type { QlooEntity } from "@walkup/contracts";
import { haversineM } from "./geohash";

export interface ChainEntry {
  name: string;
  aliases?: readonly string[];
  kind?: string;
  /** Match only as the whole name (see the module comment). */
  exact?: boolean;
  /** An adult-themed brand (servers in revealing uniforms): never a street-team stop. */
  adult?: boolean;
}

export interface ChainList {
  chains: readonly ChainEntry[];
}

export interface ChainIndex {
  /** Number of brand keys (names and aliases) indexed. */
  readonly size: number;
  /** The canonical brand name the place name matches, or null. */
  match(name: string): string | null;
  /** True when the place name matches a brand marked `adult`. Absent on hand-built indexes: no brand is adult. */
  isAdult?(name: string): boolean;
}

/** The normalized form both sides are compared in (see the module comment). */
export function normalizeChainName(name: string): string {
  return (typeof name === "string" ? name : "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´.]/g, "")
    .replace(/[&+]/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the (?=\S)/, "");
}

/** Trailing store numbers: "starbucks 1234", "target store 0567", "gap no 12". */
function withoutStoreNumber(norm: string): string {
  return norm.replace(/(?: (?:store|no|number|unit|location|ste))? [a-z]?\d+[a-z]?$/, "").trim();
}

/** The part of a raw name before a separator that usually starts a location: " - ", " | ", " @ ", "(", ",". */
function headOf(raw: string): string | null {
  const m = /\s[-–—|@]\s|\(|,/.exec(raw);
  return m && m.index > 0 ? raw.slice(0, m.index) : null;
}

interface Key {
  words: string[];
  text: string;
  exact: boolean;
  canonical: string;
}

const COMPILED = new WeakMap<object, ChainIndex>();

/** Builds the lookup once per list. Entries without a usable name are skipped. */
export function compileChains(list: ChainList | readonly ChainEntry[]): ChainIndex {
  const cached = COMPILED.get(list);
  if (cached) return cached;
  const entries: readonly ChainEntry[] = Array.isArray(list) ? list : ((list as ChainList).chains ?? []);
  const byFirst = new Map<string, Key[]>();
  const adult = new Set<string>();
  let size = 0;
  for (const e of entries) {
    if (!e || typeof e.name !== "string") continue;
    const canonical = e.name.trim();
    if (e.adult === true) adult.add(canonical);
    for (const raw of [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]) {
      const text = normalizeChainName(raw);
      if (!text) continue;
      const words = text.split(" ");
      const first = words[0] as string;
      const list = byFirst.get(first) ?? [];
      if (list.some((k) => k.text === text)) continue;
      list.push({ words, text, exact: e.exact === true, canonical });
      byFirst.set(first, list);
      size++;
    }
  }
  // Longest key first, so "Starbucks Reserve" is tried before "Starbucks" (same brand either way).
  for (const keys of byFirst.values()) keys.sort((a, b) => b.words.length - a.words.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  const index: ChainIndex = {
    size,
    match(name: string): string | null {
      if (typeof name !== "string" || !name.trim()) return null;
      const full = normalizeChainName(name);
      const head = headOf(name);
      const variants = new Set([full, withoutStoreNumber(full)]);
      if (head) {
        const h = normalizeChainName(head);
        variants.add(h);
        variants.add(withoutStoreNumber(h));
      }
      for (const v of variants) {
        if (!v) continue;
        const words = v.split(" ");
        for (const k of byFirst.get(words[0] as string) ?? []) {
          if (v === k.text) return k.canonical;
          // Not an exact entry: the key's words start the name ("starbucks coffee company").
          if (!k.exact && v.startsWith(`${k.text} `)) return k.canonical;
        }
      }
      return null;
    },
    isAdult(name: string): boolean {
      const brand = index.match(name);
      return brand !== null && adult.has(brand);
    },
  };
  COMPILED.set(list, index);
  return index;
}

/** A compiled index as is, or a list compiled (once). */
export function chainIndex(list: ChainList | ChainIndex | readonly ChainEntry[]): ChainIndex {
  return typeof (list as ChainIndex).match === "function" ? (list as ChainIndex) : compileChains(list as ChainList | readonly ChainEntry[]);
}

/** The canonical chain name a place name matches on the list, or null. */
export function chainOf(name: string, list: ChainList | ChainIndex | readonly ChainEntry[]): string | null {
  return chainIndex(list).match(name);
}

/** True when the place name matches a brand on the hand-kept chain list. */
export function isChain(name: string, list: ChainList | ChainIndex | readonly ChainEntry[]): boolean {
  return chainOf(name, list) !== null;
}

// ---------------------------------------------------------------------------
// Chain signals beyond the list, and adult-themed places
// ---------------------------------------------------------------------------

/** Why a place counts as a national chain. */
export type ChainReason = "list" | "description" | "locations" | "website";

export interface ChainSignal {
  /** The brand: the list's canonical name, else the place's own name. */
  brand: string;
  reason: ChainReason;
}

export interface ChainSignalOptions {
  /** The same name (or the same website) at this many different places makes a chain. Default 3. */
  minLocations?: number;
}

export const CHAIN_MIN_LOCATIONS = 3;

/** Qloo's one-line description calls it a chain ("Casual sports-bar chain serving wings ..."), not "non-chain" or "chain link". */
const CHAIN_WORD_RE = /(?<![-\w])(?<!\bnon[- ])(?<!\bnot a )(?<!\bno )chains?\b(?![- ]?(?:link|saw|mail|reaction|smoking))|\bfranchise (?:location|outlet|store)\b|\bfranchised\b/i;

/** A store locator URL: locations.brand.com, stores.brand.com, /locations/us/md/..., /store/2093, /locations/1145-laurel. */
const LOCATOR_HOST_RE = /^(?:locations?|stores?|restaurants?|local)\./i;
const LOCATOR_PATH_RE = /\/(?:locations?|stores?|restaurants?|store-locator)\/(?:[a-z]{2}\/|us\/|\d)/i;

/** Hosts many unrelated businesses share (ordering, booking, social and site-builder platforms). */
const SHARED_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "square.site",
  "squareup.com",
  "toasttab.com",
  "order.online",
  "business.site",
  "google.com",
  "goo.gl",
  "wixsite.com",
  "wix.com",
  "godaddysites.com",
  "weebly.com",
  "squarespace.com",
  "wordpress.com",
  "myshopify.com",
  "yelp.com",
  "tripadvisor.com",
  "opentable.com",
  "resy.com",
  "exploretock.com",
  "clover.com",
  "spothopperapp.com",
  "menufy.com",
  "chownow.com",
  "doordash.com",
  "ubereats.com",
  "grubhub.com",
  "popmenu.com",
  "bentobox.com",
  "booksy.com",
  "vagaro.com",
  "styleseat.com",
  "schedulicity.com",
  "glossgenius.com",
];

function parseUrl(url: string): URL | null {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
}

/** Lower-case host without "www.", or null for no URL or a shared platform (reserved test domains included). */
function ownHost(url: unknown): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  const u = parseUrl(url.trim());
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\d?\./, "");
  if (!host.includes(".")) return null;
  if (SHARED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return host;
}

/** Lower-case host without "www.", or null for no URL, a shared platform or a reserved test domain. */
export function websiteHost(url: unknown): string | null {
  const host = ownHost(url);
  if (!host) return null;
  if (/\.(?:test|example|invalid|localhost)$/.test(host) || /^example\.(?:com|net|org)$/.test(host)) return null;
  return host;
}

function websiteOf(e: QlooEntity): string | null {
  const p = e.properties ?? {};
  for (const key of ["website", "url"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function descriptionOf(e: QlooEntity): string {
  const p = e.properties ?? {};
  const v = p.short_description ?? p.description;
  return typeof v === "string" ? v : "";
}

/** The name two stores of one brand share: normalized, with a store number or a trailing " - Location" dropped. */
function locationKey(name: string): string {
  const head = /\s[-–—|@]\s|\(/.exec(name);
  const base = head && head.index > 0 ? name.slice(0, head.index) : name;
  return normalizeChainName(base)
    .replace(/(?: (?:store|no|number|unit|location|ste))? [a-z]?\d+[a-z]?$/, "")
    .trim();
}

/**
 * Which of `entities` are national (or large regional) chains, by entity id.
 * In order: the hand-kept list (`list`, when given); Qloo's description of
 * the place calling it a chain or a franchise; a store-locator website
 * ("locations.outback.com", ".../locations/md/laurel/..."); and the same name
 * (unless those places have websites of their own on different domains:
 * independent places that share a common name), or the same website, at
 * `minLocations` (3) or more different places among `entities` (pass every
 * place the run saw, not just one list). Places with no signal are absent
 * from the map.
 */
export function chainSignals(
  entities: readonly QlooEntity[],
  list: ChainList | ChainIndex | readonly ChainEntry[] | null | undefined,
  opts: ChainSignalOptions = {},
): Map<string, ChainSignal> {
  const min = Math.max(2, Math.floor(opts.minLocations ?? CHAIN_MIN_LOCATIONS));
  const index = list ? chainIndex(list) : null;
  const out = new Map<string, ChainSignal>();
  const byName = new Map<string, { ids: Set<string>; name: string; hosts: Set<string> }>();
  const byHost = new Map<string, Set<string>>();
  const seen = new Map<string, QlooEntity>();
  for (const e of entities) {
    const id = typeof e?.entityId === "string" ? e.entityId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.set(id, e);
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const key = name ? locationKey(name) : "";
    if (key) {
      const g = byName.get(key) ?? { ids: new Set<string>(), name, hosts: new Set<string>() };
      g.ids.add(id);
      const own = ownHost(websiteOf(e));
      if (own) g.hosts.add(own);
      byName.set(key, g);
    }
    const host = websiteHost(websiteOf(e));
    if (host) byHost.set(host, (byHost.get(host) ?? new Set<string>()).add(id));
  }
  for (const [id, e] of seen) {
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const listed = index && name ? index.match(name) : null;
    if (listed) {
      out.set(id, { brand: listed, reason: "list" });
      continue;
    }
    if (CHAIN_WORD_RE.test(descriptionOf(e))) {
      out.set(id, { brand: name, reason: "description" });
      continue;
    }
    const url = websiteOf(e);
    const host = websiteHost(url);
    const u = url && host ? parseUrl(url) : null;
    if (u && (LOCATOR_HOST_RE.test(u.hostname.replace(/^www\d?\./i, "")) || LOCATOR_PATH_RE.test(u.pathname))) {
      out.set(id, { brand: name, reason: "website" });
      continue;
    }
    const sameName = name ? byName.get(locationKey(name)) : undefined;
    if (sameName && sameName.ids.size >= min && sameName.hosts.size <= 1) {
      out.set(id, { brand: sameName.name, reason: "locations" });
      continue;
    }
    if (host && (byHost.get(host)?.size ?? 0) >= min) out.set(id, { brand: name, reason: "locations" });
  }
  return out;
}

/** Two place entries closer than this (m) with the same name are one business listed twice. */
export const SAME_BUSINESS_M = 150;

function sameNameKey(name: unknown): string {
  return typeof name === "string" ? locationKey(name) : "";
}

/**
 * True when two different Qloo entries are one business: the same name (store number and a trailing " - Location"
 * aside), or one name the start of the other ("Praline Bakery" and "Praline Bakery & Bistro"), within
 * `SAME_BUSINESS_M` of each other. Without both locations, only the same name at the same street address counts.
 */
export function isSameBusiness(a: QlooEntity, b: QlooEntity): boolean {
  if (a.entityId === b.entityId) return true;
  const na = sameNameKey(a.name);
  const nb = sameNameKey(b.name);
  if (!na || !nb) return false;
  const named = na === nb || na.startsWith(`${nb} `) || nb.startsWith(`${na} `);
  if (!named) return false;
  const la = a.location;
  const lb = b.location;
  if (la && lb && Number.isFinite(la.lat) && Number.isFinite(la.lon) && Number.isFinite(lb.lat) && Number.isFinite(lb.lon)) {
    return haversineM(la, lb) <= SAME_BUSINESS_M;
  }
  const addr = (e: QlooEntity) => {
    const v = e.properties?.address;
    return typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "";
  };
  return na === nb && addr(a) !== "" && addr(a) === addr(b);
}

/** Place-type tags of adult entertainment. */
const ADULT_PLACE_TAG_RE =
  /^urn:tag:(?:category|genre):place:(?:[a-z0-9_]+:)*(?:adult_entertainment(?:_club)?|strip_club|gentlemens_club|adult_store|sex_shop|erotic_[a-z_]+|adult_[a-z_]*club)$/i;
/** How Qloo's description reads for one: "female servers in themed uniforms", "strip club", "exotic dancers". */
const ADULT_TEXT_RE =
  /\b(?:strip ?club|gentlem[ae]n'?s club|adult entertainment|exotic danc|topless|nude dancers|female servers|waitresses in|servers in (?:skimpy|revealing|tight|short)|scantily[- ]clad|bikini[- ]clad|lingerie[- ]clad|breastaurant)/i;

/**
 * True for an adult-themed place: an adult-entertainment place tag, a
 * description that says so ("female servers in themed uniforms", "strip
 * club"), or a brand the chain list marks `adult` (Hooters, Twin Peaks).
 * Never a street-team stop, on any show.
 */
export function isAdultThemed(e: QlooEntity, list?: ChainList | ChainIndex | readonly ChainEntry[] | null): boolean {
  if ((e.tags ?? []).some((t) => typeof t?.id === "string" && ADULT_PLACE_TAG_RE.test(t.id))) return true;
  if (ADULT_TEXT_RE.test(descriptionOf(e))) return true;
  if (list && typeof e.name === "string" && chainIndex(list).isAdult?.(e.name)) return true;
  return false;
}

/** Default cap on national chains per list: they fill a slot only when local places run out, and at most this many. */
export const MAX_CHAINS_PER_LIST = 2;

export interface ChainCount {
  /** Chains on the list. */
  kept: number;
  /** Rows on the list. */
  listed: number;
  /** Eligible chains not on the list (a local place took the slot, or the cap). */
  leftOut: number;
  /** Of those, the ones only the cap kept off. */
  capped: number;
  /** The cap. */
  cap: number;
}

/**
 * The card's chain sentence, matching the list: "2 of 15 partners are national chains, listed last: no local place
 * filled their slot. 4 more chains left off: 3 for local places, 1 by the limit of 2 per list.", "3 national chains
 * left off for local places." Null when no chain was eligible.
 */
export function chainSummary(c: ChainCount, noun: readonly [string, string] = ["partner", "partners"]): string | null {
  if (c.kept <= 0 && c.leftOut <= 0) return null;
  const n = (x: number) => x.toLocaleString("en-US");
  const parts: string[] = [];
  if (c.kept > 0) {
    const one = c.kept === 1;
    parts.push(`${n(c.kept)} of ${n(c.listed)} ${c.listed === 1 ? noun[0] : noun[1]} ${one ? "is a national chain" : "are national chains"}, listed last: no local place filled ${one ? "its" : "their"} slot.`);
  }
  if (c.leftOut > 0) {
    const local = c.leftOut - c.capped;
    const head = `${n(c.leftOut)} ${c.kept > 0 ? "more " : "national "}${c.leftOut === 1 ? "chain" : "chains"} left off`;
    const forLocal = "for local places";
    const byCap = `by the limit of ${c.cap} per list`;
    if (local > 0 && c.capped > 0) parts.push(`${head}: ${n(local)} ${forLocal}, ${n(c.capped)} ${byCap}.`);
    else parts.push(`${head} ${c.capped > 0 ? byCap : forLocal}.`);
  }
  return parts.join(" ");
}
