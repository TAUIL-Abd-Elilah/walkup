/**
 * Copy and persistence policy: which Qloo tags may appear in copy, chips or
 * stored data, and person-tag stripping.
 *
 * Matching rule for the denied keywords (decided here, tested in policy.test.ts):
 * text is lower-cased, accents are removed and every run of non-alphanumeric
 * characters (spaces, ":", "_", "-", "/") becomes a single space. Then:
 *   - "substring" keywords match anywhere, as the contract describes
 *     ("religio" blocks "religion" and "irreligious"; "ethnic" blocks
 *     "multiethnic"; "political" blocks "apolitical");
 *   - "word" keywords, whose letters occur inside everyday words, must be a
 *     whole word, optionally plural: "race" blocks "race", "races" and
 *     "race_relations" but not "racecar", "grace", "terrace", "embrace" or
 *     "horse racing"; "gay" blocks "gay" but not "Gaylord" or "Marvin Gaye".
 * Only "race" and "gay" (plus a few engine additions such as "islam", which
 * would otherwise block "Islamorada") are word keywords. The rule errs toward
 * blocking: "Christiana" is blocked because it contains "christian". The guard
 * masks this run's entity names before scanning narration, so a partner whose
 * name contains a keyword is not dropped for its name alone.
 */
import { DENIED_TAG_KEYWORDS, DENIED_TAG_PREFIXES, type QlooEntity, type QlooTag } from "@walkup/contracts";

export type TermMode = "substring" | "word";

export interface DeniedTerm {
  term: string;
  mode: TermMode;
}

/** Contract keywords whose letters occur inside ordinary words; matched as whole words. */
const WORD_MODE_KEYWORDS: ReadonlySet<string> = new Set(["gay", "race"]);

/** Engine-side additions (defence in depth). Never relaxes the contract list. */
export const EXTRA_DENIED_TERMS: readonly DeniedTerm[] = [
  { term: "racial", mode: "substring" },
  { term: "racism", mode: "word" },
  { term: "racist", mode: "word" },
  { term: "islam", mode: "word" },
  { term: "islamic", mode: "word" },
  { term: "hindu", mode: "word" },
  { term: "hinduism", mode: "word" },
  { term: "sikh", mode: "word" },
  { term: "buddhis", mode: "substring" },
  { term: "evangelical", mode: "substring" },
  { term: "atheis", mode: "substring" },
  { term: "transgender", mode: "substring" },
  { term: "bisexual", mode: "substring" },
  { term: "homosexual", mode: "substring" },
  { term: "queer", mode: "word" },
  { term: "sexuality", mode: "word" },
  { term: "sexual orientation", mode: "word" },
  { term: "politics", mode: "substring" },
  { term: "partisan", mode: "substring" },
  // Ethnicity and heritage outside urn:tag:ethnicity (media keyword tags such as
  // urn:tag:keyword:media:african_american reach the copy allowlist through Q14).
  // "Black comedy" (a film genre) and "Latin" (a music genre) stay allowed.
  { term: "african american", mode: "word" },
  { term: "black american", mode: "word" },
  { term: "black owned", mode: "word" },
  { term: "black people", mode: "word" },
  { term: "black culture", mode: "word" },
  { term: "black community", mode: "word" },
  { term: "asian american", mode: "word" },
  { term: "arab american", mode: "word" },
  { term: "native american", mode: "word" },
  { term: "indigenous", mode: "word" },
  { term: "hispanic", mode: "word" },
  { term: "latino", mode: "word" },
  { term: "latina", mode: "word" },
  { term: "latinx", mode: "word" },
  { term: "chicano", mode: "word" },
  { term: "chicana", mode: "word" },
  { term: "caucasian", mode: "word" },
  // Religion: denominations and congregations (declared by the operator, never inferred).
  { term: "judaism", mode: "word" },
  { term: "mormon", mode: "substring" },
  { term: "protestant", mode: "substring" },
  { term: "pentecostal", mode: "substring" },
  { term: "baptist", mode: "word" },
  { term: "methodist", mode: "word" },
  { term: "congregation", mode: "substring" },
  { term: "churchgoer", mode: "substring" },
  // Gender identity.
  { term: "nonbinary", mode: "word" },
  { term: "non binary", mode: "word" },
  // Health (never inferred).
  { term: "mental health", mode: "word" },
  { term: "mental illness", mode: "word" },
  { term: "disabilit", mode: "substring" },
  { term: "disabled", mode: "word" },
  { term: "diabet", mode: "substring" },
  { term: "cancer", mode: "word" },
  { term: "hiv", mode: "word" },
  { term: "addiction", mode: "word" },
  { term: "pregnan", mode: "substring" },
  { term: "obesity", mode: "word" },
];

/** Engine-side prefix additions (namespaces that are sensitive under any spelling). */
export const EXTRA_DENIED_PREFIXES: readonly string[] = [
  "urn:tag:politic",
  "urn:tag:religio",
  "urn:tag:ethnic",
  "urn:tag:sexual_orientation",
  "urn:tag:gender_identity",
  "urn:tag:customer_identity",
];

export const DENIED_TERMS: readonly DeniedTerm[] = [
  ...DENIED_TAG_KEYWORDS.map((term): DeniedTerm => ({ term, mode: WORD_MODE_KEYWORDS.has(term) ? "word" : "substring" })),
  ...EXTRA_DENIED_TERMS,
];

const ALL_PREFIXES: readonly string[] = [...DENIED_TAG_PREFIXES, ...EXTRA_DENIED_PREFIXES].map((p) => p.toLowerCase());

/** Lower-case, strip accents, collapse every non-alphanumeric run to one space, pad with spaces. */
export function normalizeForMatch(s: string): string {
  const base = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${base} `;
}

function termHit(normalized: string, t: DeniedTerm): boolean {
  const term = normalizeForMatch(t.term).trim();
  if (term === "") return false;
  if (t.mode === "substring") return normalized.includes(term);
  return normalized.includes(` ${term} `) || normalized.includes(` ${term}s `);
}

/** The first denied term found in `text` (matching rule above), or null. */
export function findDeniedTerm(text: string | null | undefined): string | null {
  if (!text) return null;
  const n = normalizeForMatch(text);
  for (const t of DENIED_TERMS) if (termHit(n, t)) return t.term;
  return null;
}

export function containsDeniedTerm(text: string | null | undefined): boolean {
  return findDeniedTerm(text) !== null;
}

/**
 * Denied namespaces that are commercial or noisy rather than sensitive. Their
 * tags never reach copy, but their names (often everyday words such as
 * "Moderate" or "Music") are not banned from narration.
 */
const NON_SENSITIVE_PREFIXES: readonly string[] = [
  "urn:tag:credit_card:",
  "urn:tag:hotel_rating:",
  "urn:tag:cost_description:",
  "urn:tag:wikipedia_category:",
];

const SENSITIVE_PREFIXES: readonly string[] = ALL_PREFIXES.filter((p) => !NON_SENSITIVE_PREFIXES.includes(p));

function hasPrefixIn(s: string | undefined, prefixes: readonly string[]): boolean {
  if (!s) return false;
  const lower = s.trim().toLowerCase();
  const withColon = lower.endsWith(":") ? lower : `${lower}:`;
  return prefixes.some((p) => lower.startsWith(p) || withColon.startsWith(p));
}

function hasDeniedPrefix(s: string | undefined): boolean {
  return hasPrefixIn(s, ALL_PREFIXES);
}

function tagHasDeniedTerm(tag: QlooTag | string): boolean {
  if (typeof tag === "string") return containsDeniedTerm(tag);
  return containsDeniedTerm(tag.id) || containsDeniedTerm(tag.name) || containsDeniedTerm(tag.type) || containsDeniedTerm(tag.subtype);
}

/** True when a tag may never appear in copy, chips or persisted data. Accepts a tag or a bare id. */
export function isDeniedTag(tag: QlooTag | string | null | undefined): boolean {
  if (!tag) return false;
  if (typeof tag === "string") return hasDeniedPrefix(tag) || tagHasDeniedTerm(tag);
  if (hasDeniedPrefix(tag.id) || hasDeniedPrefix(tag.type)) return true;
  return tagHasDeniedTerm(tag);
}

/**
 * Denied for a sensitive reason (identity, religion, politics, sexuality): a
 * sensitive namespace or a denied keyword. Commercial namespaces (credit card,
 * hotel rating, cost description, Wikipedia category) are denied but not sensitive.
 */
export function isSensitiveTag(tag: QlooTag | string | null | undefined): boolean {
  if (!tag || !isDeniedTag(tag)) return false;
  if (tagHasDeniedTerm(tag)) return true;
  if (typeof tag === "string") return hasPrefixIn(tag, SENSITIVE_PREFIXES);
  return hasPrefixIn(tag.id, SENSITIVE_PREFIXES) || hasPrefixIn(tag.type, SENSITIVE_PREFIXES);
}

export interface CopyAllowlist<T extends QlooTag = QlooTag> {
  /** Allowed tag ids. */
  allowed: Set<string>;
  /** Allowed tags, de-duplicated by id, in first-seen order. */
  tags: T[];
  /** Allowed tag names, de-duplicated (case-insensitive), in first-seen order. */
  names: string[];
  /** Number of distinct denied tag ids removed. */
  deniedCount: number;
  /**
   * Names of the tags denied for a sensitive reason (`isSensitiveTag`), for the
   * narration guard's phrase check. In-memory only: never persist or render it.
   */
  deniedNames: string[];
}

/** Applies the denylist to candidate copy tags (Q14 and partner ambience tags). */
export function buildCopyAllowlist<T extends QlooTag>(tags: readonly (T | null | undefined)[]): CopyAllowlist<T> {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  const out: T[] = [];
  const names: string[] = [];
  const nameSeen = new Set<string>();
  const deniedNames: string[] = [];
  const deniedNameSeen = new Set<string>();
  for (const t of tags ?? []) {
    if (!t || typeof t.id !== "string" || t.id.trim() === "") continue;
    const id = t.id.trim();
    if (isDeniedTag(t)) {
      denied.add(id);
      const nm = (t.name ?? "").trim();
      if (nm && isSensitiveTag(t) && !deniedNameSeen.has(nm.toLowerCase())) {
        deniedNameSeen.add(nm.toLowerCase());
        deniedNames.push(nm);
      }
      continue;
    }
    if (denied.has(id) || allowed.has(id)) continue;
    allowed.add(id);
    out.push(t);
    const nm = (t.name ?? "").trim();
    if (nm && !nameSeen.has(nm.toLowerCase())) {
      nameSeen.add(nm.toLowerCase());
      names.push(nm);
    }
  }
  return { allowed, tags: out, names, deniedCount: denied.size, deniedNames };
}

export const PERSON_SUBTYPES: readonly string[] = ["urn:entity:person"];

export function isPersonEntity(entity: Pick<QlooEntity, "subtype">, personSubtypes: readonly string[] = PERSON_SUBTYPES): boolean {
  return personSubtypes.includes((entity.subtype ?? "").trim().toLowerCase());
}

/** Person entities lose all tags before anything is persisted. Other entities are returned unchanged. */
export function stripPersonTags<E extends QlooEntity>(entity: E, personSubtypes: readonly string[] = PERSON_SUBTYPES): E {
  if (!isPersonEntity(entity, personSubtypes)) return entity;
  return { ...entity, tags: [] };
}

/** Person entities lose all tags; every other entity loses its denied tags. */
export function sanitizeEntityTags<E extends QlooEntity>(entity: E, personSubtypes: readonly string[] = PERSON_SUBTYPES): E {
  if (isPersonEntity(entity, personSubtypes)) return { ...entity, tags: [] };
  const tags = (entity.tags ?? []).filter((t) => !isDeniedTag(t));
  return tags.length === (entity.tags ?? []).length ? entity : { ...entity, tags };
}

/**
 * Alcohol words for fan-facing copy on shows that are not 21+ (the age rule
 * comes from Ticketmaster's ageRestrictions only). Whole words, plural allowed.
 */
export const ALCOHOL_TERMS: readonly string[] = [
  "beer",
  "wine",
  "cocktail",
  "whiskey",
  "whisky",
  "bourbon",
  "vodka",
  "tequila",
  "mezcal",
  "liquor",
  "booze",
  "brewery",
  "brewpub",
  "happy hour",
  "bar crawl",
  "pub crawl",
  "ipa",
  "lager",
  "spirits",
  "mixology",
  "margarita",
  "sangria",
  "mimosa",
  "champagne",
  "prosecco",
  "soju",
  "rum",
  "gin",
  // Drinking venues: fan-facing copy may not send an all-ages crowd to a bar.
  "bar",
  "pub",
  "tavern",
  "taproom",
  "saloon",
  "nightclub",
  "night club",
];

/** The first alcohol term in `text` (whole word, plural allowed; "21+" also counts), or null. */
export function findAlcoholTerm(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/(?<![\p{L}\p{N}])21\s*\+/u.test(text)) return "21+";
  const n = normalizeForMatch(text);
  for (const term of ALCOHOL_TERMS) {
    if (termHit(n, { term, mode: "word" })) return term;
  }
  return null;
}

/**
 * Political candidates and campaigns are out of scope for every entry point (web, MCP, skill). A short,
 * conservative word list applied to what the caller typed (event text, partner names); it does not try to
 * classify artists or venues.
 */
const POLITICAL_RE =
  /\b(campaign (?:rally|event|stop|kickoff|fundraiser)|political rally|get out the vote|for (?:president|senate|senator|congress|governor|mayor|city council|state assembly|school board)|election (?:night|rally|party)|super ?pac)\b/i;

export function looksPolitical(text: string | null | undefined): boolean {
  return !!text && POLITICAL_RE.test(text);
}
