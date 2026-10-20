/**
 * Copy policy checks used by the narration guard.
 *
 * Text is checked after "protected" strings (entity names, tile names, tag
 * names, ids) are blanked out, so a place called "Soft Spot" or a tag named
 * "soft rock" does not trip the word rules, and digits inside a name do not
 * count as cited numbers.
 */
import { DENIED_TAG_KEYWORDS, DENIED_TAG_PREFIXES } from "@walkup/contracts";
import { findDeniedTerm, isDeniedTag as engineIsDeniedTag } from "@walkup/engine";

export interface TagLike {
  id: string;
  name?: string | undefined;
}

/**
 * Narrator-side prefix additions to the contracts denylist (defence in depth;
 * never relaxes it). Customer-identity place tags describe who a place serves,
 * which copy must never echo.
 */
export const EXTRA_DENIED_TAG_PREFIXES = ["urn:tag:customer_identity:"] as const;

/**
 * Contracts rule (denied namespace prefix on the id, or denied keyword anywhere
 * in id or name), plus the engine's denylist (identity, religion and health
 * terms that arrive outside the denied namespaces, e.g. media keyword tags), so
 * the narrator never allows a tag the engine's copy allowlist would deny.
 */
export function isDeniedTag(tag: TagLike): boolean {
  const id = tag.id.toLowerCase();
  if (DENIED_TAG_PREFIXES.some((p) => id.startsWith(p))) return true;
  if (EXTRA_DENIED_TAG_PREFIXES.some((p) => id.startsWith(p))) return true;
  const hay = `${id} ${(tag.name ?? "").toLowerCase()}`;
  if (DENIED_TAG_KEYWORDS.some((k) => hay.includes(k))) return true;
  return engineIsDeniedTag({ id: tag.id, name: tag.name ?? "" });
}

/** Dedupes by id, drops denied tags and nameless tags, keeps input order. */
export function cleanAllowlist<T extends { id: string; name: string }>(tags: ReadonlyArray<T>): {
  allowed: T[];
  deniedCount: number;
} {
  const seen = new Set<string>();
  const allowed: T[] = [];
  let deniedCount = 0;
  for (const t of tags) {
    if (!t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    if (isDeniedTag(t)) {
      deniedCount += 1;
      continue;
    }
    if (!t.name.trim()) continue;
    allowed.push(t);
  }
  return { allowed, deniedCount };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces every case-insensitive occurrence of each protected string with a space. Longest first. */
export function blankProtected(text: string, protectedStrings: ReadonlyArray<string>): string {
  let out = text;
  const sorted = [...new Set(protectedStrings.filter((s) => s.trim().length > 1))].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    out = out.replace(new RegExp(escapeRegExp(s), "gi"), " ");
  }
  return out;
}

/**
 * Alcohol words. Allowed only when the ticketing age policy says 21+
 * (Ticketmaster legalAgeEnforced, never inferred from Qloo).
 */
const ALCOHOL =
  /\b(alcohol\w*|beers?|wines?|winer(?:y|ies)|cocktails?|brewer(?:y|ies)|brewpubs?|liquors?|booze|boozy|whiske?ys?|whiskies|bourbons?|tequilas?|vodkas?|mezcal|margaritas?|happy hours?|drink specials?|ipas?|lagers?|ales|open bar)\b|\b21\s*(?:\+|and (?:over|up)|or older)/i;

/** First alcohol word in `text`, or null. */
export function alcoholWord(text: string): string | null {
  const m = ALCOHOL.exec(text);
  return m ? m[0] : null;
}

/** True when a tag's id or name is about alcohol (e.g. "urn:tag:menu_highlight:qloo:craft_cocktails"). */
export function isAlcoholTag(tag: TagLike): boolean {
  const hay = `${tag.id} ${tag.name ?? ""}`.toLowerCase().replace(/[^a-z0-9+]+/g, " ");
  return alcoholWord(hay) !== null;
}

/** Words that describe a real show's sales: never used. */
const SHOW_STATUS = /\b(soft|softness|tracking|struggl\w*|undersold|underselling|slow[- ]sell\w*|selling poorly|poor sales)\b/i;
/** Product-copy words this project does not use. */
const HYPE = /\b(ai[- ]powered|revolutionary|taste\w*|culture\w*|game[- ]chang\w*)\b/i;

export interface PolicyOptions {
  /** False unless the show is 21+ per the ticketing age policy; then alcohol words are a problem. Default true. */
  alcoholAllowed?: boolean;
}

/**
 * Returns the first policy problem in `text`, or null. `protectedStrings` are
 * blanked first (see module note).
 */
export function policyProblem(
  text: string,
  protectedStrings: ReadonlyArray<string>,
  opts: PolicyOptions = {},
): string | null {
  const t = blankProtected(text, protectedStrings);
  if (!text.trim()) return "empty text";
  if (t.includes("!")) return "exclamation mark";
  if (opts.alcoholAllowed === false) {
    const a = alcoholWord(t);
    if (a) return `alcohol word "${a}" on a show that is not 21+`;
  }
  const status = SHOW_STATUS.exec(t);
  if (status) return `show-status word "${status[1]}"`;
  const hype = HYPE.exec(t);
  if (hype) return `banned word "${hype[1]}"`;
  const lower = t.toLowerCase();
  for (const k of DENIED_TAG_KEYWORDS) {
    // The keyword is not repeated: guard reasons are stored with the sheet.
    if (new RegExp(`\\b${escapeRegExp(k)}`).test(lower)) return "denied keyword";
  }
  // The engine's wider list (identity, religion, health). The word is not repeated in the reason.
  if (findDeniedTerm(t)) return "denied identity, religion or health term";
  return null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export interface AllowedNumbers {
  /** Numeric facts from the run (as rendered to the model). */
  values: number[];
  /** Exact numeric literals taken from names, addresses, hours and dates ("1801", "66"). */
  literals: Set<string>;
}

/** Numbers not glued to a preceding letter or digit: "1.84x", "87%", "1,200", "21+". Skips "dn6m9q". */
const NUMBER_TOKEN = /(?<![A-Za-z0-9.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

export function numericTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN) ?? [];
}

export function literalNumbersIn(text: string): string[] {
  return numericTokens(text).map((t) => t.replace(/,/g, ""));
}

function decimalsOf(token: string): number {
  const dot = token.indexOf(".");
  return dot < 0 ? 0 : token.length - dot - 1;
}

/**
 * A token is allowed when it equals a literal from the run, or equals a run
 * value (or that value x100, for shares and percentiles) rounded to the
 * token's own number of decimals. Sign is ignored ("down 3 ranks").
 */
export function isAllowedNumber(token: string, allowed: AllowedNumbers): boolean {
  const clean = token.replace(/,/g, "");
  if (allowed.literals.has(clean)) return true;
  const value = Number(clean);
  if (!Number.isFinite(value)) return false;
  const d = Math.min(decimalsOf(clean), 6);
  // Within half a step of the token's last digit: 1.65 may be written 1.7 (toFixed gives "1.6" for the float 1.65).
  const half = 0.5 * 10 ** -d + 1e-9;
  const target = Math.abs(value);
  for (const v of allowed.values) {
    const a = Math.abs(v);
    if (Math.abs(a - target) <= half) return true;
    if (a <= 1 && Math.abs(a * 100 - target) <= half) return true;
  }
  return false;
}

/** First number in `text` that is not in the run, or null. Protected strings are blanked first. */
export function unlistedNumber(
  text: string,
  allowed: AllowedNumbers,
  protectedStrings: ReadonlyArray<string>,
): string | null {
  const t = blankProtected(text, protectedStrings);
  for (const tok of numericTokens(t)) {
    if (!isAllowedNumber(tok, allowed)) return tok;
  }
  return null;
}
