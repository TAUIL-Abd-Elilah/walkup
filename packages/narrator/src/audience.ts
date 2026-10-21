/**
 * Audience and identity tags: tags that describe people (who the fans are) rather than the music or the
 * place. They never appear in fan copy or in the "What's different" list. Pure: no SDK, no network.
 */

/** Tag namespaces whose every tag describes people. */
export const AUDIENCE_TAG_PREFIXES = [
  "urn:tag:audience:",
  "urn:audience:",
  "urn:tag:gender:",
  "urn:tag:age_range:",
  "urn:tag:demographic",
  "urn:tag:generation:",
  "urn:tag:customer_identity:",
  "urn:tag:identity",
  "urn:tag:language:",
  "urn:tag:nationality:",
  "urn:tag:ethnicity:",
  "urn:tag:religion:",
  "urn:tag:sexuality:",
  "urn:tag:political",
  "urn:tag:inclusivity:",
] as const;

/**
 * Words and phrases that describe people (matched case-insensitively as whole words, with "-" and "_" read
 * as spaces). Kept to words that are not also music genres ("Spirituals", "Soul" stay allowed).
 */
export const AUDIENCE_WORDS = [
  "diverse",
  "diversity",
  "supportive",
  "civic minded",
  "news savvy",
  "socially conscious",
  "social justice",
  "identity",
  "male",
  "males",
  "female",
  "females",
  "men",
  "women",
  "man",
  "woman",
  "english",
  "lgbt",
  "lgbtq",
  "lgbtqia",
  "queer",
  "gay",
  "lesbian",
  "transgender",
  "nonbinary",
  "non binary",
  "ethnic",
  "ethnicity",
  "minority",
  "minorities",
  "immigrant",
  "immigrants",
  "millennial",
  "millennials",
  "gen z",
  "gen x",
  "generation z",
  "boomer",
  "boomers",
  "youthful",
  "seniors",
  "retirees",
  "veterans",
  "students",
  "parents",
  "moms",
  "dads",
  "progressive",
  "conservative",
  "liberal",
  "activist",
  "activists",
  "feminist",
  "religious",
  "faith",
] as const;

/** Lower case, "&" as "and", hyphens, underscores and other punctuation as spaces, single spaces. */
export function normalizeWords(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const AUDIENCE_NORMALIZED = AUDIENCE_WORDS.map((w) => normalizeWords(w));

/** The first audience word in `text` (normalized form, trimmed), or null. */
export function audienceWordIn(text: string, extra: ReadonlyArray<string> = []): string | null {
  const hay = normalizeWords(text);
  for (const w of [...AUDIENCE_NORMALIZED, ...extra.map((x) => normalizeWords(x))]) {
    if (w.trim() && hay.includes(w)) return w.trim();
  }
  return null;
}

/**
 * True for tags that describe people: an audience/identity namespace on the id, or an audience word in the
 * name (or, for a bare id, in its last segment). Accepts a tag object, a tag id ("urn:...") or a tag name.
 */
export function isAudienceTag(tag: { id?: string; name?: string } | string): boolean {
  const t = typeof tag === "string" ? (tag.trim().toLowerCase().startsWith("urn:") ? { id: tag } : { name: tag }) : tag;
  const id = (t.id ?? "").trim().toLowerCase();
  if (id && AUDIENCE_TAG_PREFIXES.some((p) => id.startsWith(p))) return true;
  if (t.name && audienceWordIn(t.name) !== null) return true;
  if (id && !t.name) {
    const tail = id.split(":").pop() ?? "";
    if (tail && audienceWordIn(tail) !== null) return true;
  }
  return false;
}
