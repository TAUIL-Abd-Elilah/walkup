/**
 * Narration guard (deterministic validator). The narrator may cite only entity
 * ids, geohashes and numbers that this run produced, and copy may use only
 * allowlisted tags. Any unit that breaks a rule is dropped and counted:
 *
 *  - summary: checked sentence by sentence;
 *  - tileWhy[i]: its geohash must be a fact, and its text must pass;
 *  - partnerLines[i]: its entityId must be a fact, and its text must pass;
 *  - copyHooks[i] (optional): every tagId must be allowlisted (at least one), its text must pass,
 *    and, when `legalAgeEnforced` is given and not true, it must not mention alcohol.
 *
 * A text passes when it contains no UUID-like entity id outside the facts, no
 * geohash-like token (6-12 geohash characters with a digit and a letter) outside
 * the facts, no urn:tag outside the allowlist, no ledger ref outside `ledgerRefs`
 * (when given), no number outside the facts (see `numberMatchesFacts`), no denied
 * term (policy.ts) or denied tag name, and no sales label ("soft show", "tracking
 * behind"). Known names (entities, tiles, acts, allowlisted tag names, hours
 * strings) are masked first, so "Club 21" or "90s R&B" do not count as numbers.
 *
 * Number matching (numberMatchesFacts): "1,850" = 1850; "41%" = 41 percent = 0.41; a cited number
 * matches a fact when the fact rounds to it at the cited precision ("1.4x"
 * matches 1.37; "41%" matches 0.4127). Signs are ignored. "10k" matches facts
 * that round to 10 thousand. A small set of trivial integers (default 0-3) is
 * always allowed when written without "%" or "k".
 */
import type { CopyHook, GuardReport, StreetSheet } from "@walkup/contracts";
import { isFiniteNumber, roundTo } from "./num";
import { findAlcoholTerm, findDeniedTerm, normalizeForMatch } from "./policy";

export type Narration = NonNullable<StreetSheet["narration"]>;

export interface NarrationInput extends Narration {
  copyHooks?: CopyHook[];
}

export interface NarrationFacts {
  entityIds: Iterable<string>;
  geohashes: Iterable<string>;
  numbers: Iterable<number>;
  allowlistTagIds: Iterable<string>;
  allowlistTagNames: Iterable<string>;
  /** Entity, tile, act and venue names and hours strings from this run (masked before scanning). */
  names?: Iterable<string>;
  /** Names of tags the allowlist removed (in memory only). */
  deniedTagNames?: Iterable<string>;
  /** Tags the allowlist step removed; added to the report's deniedTagCount. */
  deniedTagCount?: number;
  /** When given, [Q9]-style references must be in this set. */
  ledgerRefs?: Iterable<string>;
}

export interface GuardOptions {
  /** Integers always allowed when written plainly. Default [0, 1, 2, 3]. */
  trivialNumbers?: readonly number[];
  /** Phrases that label a show's sales. Default SALES_LABEL_PATTERNS. */
  bannedPhrases?: readonly RegExp[];
  /**
   * Ticketmaster's legalAgeEnforced for the show. Unless it is true, copy hooks
   * (fan-facing) that mention alcohol are dropped. Undefined skips the check.
   */
  legalAgeEnforced?: boolean | null;
}

export const DEFAULT_TRIVIAL_NUMBERS: readonly number[] = [0, 1, 2, 3];

/** A real show is never labelled "soft" or "tracking". */
export const SALES_LABEL_PATTERNS: readonly RegExp[] = [
  /\bsoft[\s-]+(?:show|shows|ticket|tickets|sales|night|date|dates|house|seller|sellers|market)\b/i,
  /\b(?:show|sales|tickets?|night|date|house|it)\s+(?:is|are|looks?|looking|seems?|running|trending)\s+(?:a\s+bit\s+|very\s+|pretty\s+)?soft(?:er)?\b/i,
  /\bsell(?:s|ing)?\s+(?:a\s+bit\s+|very\s+)?soft(?:ly|er)?\b/i,
  /\btracking\s+(?:soft|softly|behind|below|under|slow|slowly|poorly|badly|well|ahead)\b/i,
  /\b(?:show|sales|tickets?)\s+(?:is|are)\s+tracking\b/i,
  /\bslow(?:er)?\s+(?:ticket\s+)?(?:seller|sellers|sales)\b/i,
  /\bunder-?sold\b/i,
];

export interface NumberToken {
  raw: string;
  /** Absolute value as written (commas removed), before % or k scaling. */
  value: number;
  decimals: number;
  percent: boolean;
  thousands: boolean;
}

const NUM_RE = /(?<![\p{L}\p{N}_.]|\p{L}-)(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+))?(\s?%|\s*per\s?cent\b)?([kK](?!\p{L}))?/gu;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URN_RE = /\burn:[a-z_]+(?::[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)+/gi;
const GEOHASH_LIKE_RE = /(?<![\p{L}\p{N}_])[0-9bcdefghjkmnpqrstuvwxyz]{6,12}(?![\p{L}\p{N}_])/giu;
const LEDGER_REF_RE = /(?<![\p{L}\p{N}_])[QTPCLA]\d{1,4}(?![\p{L}\p{N}_])/gu;

/** Number tokens in free text. Digits glued to a preceding letter ("Q9", "B2B", "I-95") are identifiers, not numbers. */
export function extractNumberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const intPart = (m[1] ?? "").replace(/,/g, "");
    const frac = m[2] ?? "";
    const value = Number(frac ? `${intPart}.${frac}` : intPart);
    if (!Number.isFinite(value)) continue;
    out.push({ raw: m[0].trim(), value, decimals: frac.length, percent: !!m[3], thousands: !!m[4] });
  }
  return out;
}

type ScaleKind = "x1" | "x100" | "d100" | "d1000";

interface CompiledFacts {
  entityIds: Set<string>;
  geohashes: Set<string>;
  numbers: number[];
  index: Map<string, Set<string>>;
  allowTagIds: Set<string>;
  mask: RegExp | null;
  deniedPhrases: string[];
  ledgerRefs: Set<string> | null;
  trivial: Set<number>;
  banned: readonly RegExp[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileFacts(facts: NarrationFacts, opts: GuardOptions): CompiledFacts {
  const lower = (xs: Iterable<string> | undefined) => new Set([...(xs ?? [])].filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()));
  const nameList = [...(facts.names ?? []), ...(facts.allowlistTagNames ?? [])]
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter((n) => n.length >= 3 && (/\p{L}/u.test(n) || n.includes(":")));
  const uniqNames = [...new Set(nameList)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const mask = uniqNames.length > 0 ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${uniqNames.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  return {
    entityIds: lower(facts.entityIds),
    geohashes: lower(facts.geohashes),
    numbers: [...(facts.numbers ?? [])].filter((n) => isFiniteNumber(n)).map((n) => Math.abs(n)),
    index: new Map(),
    allowTagIds: new Set([...(facts.allowlistTagIds ?? [])].map((x) => x.trim())),
    mask,
    deniedPhrases: [...(facts.deniedTagNames ?? [])]
      .map((n) => normalizeForMatch(n))
      .filter((n) => n.trim().length >= 3),
    ledgerRefs: facts.ledgerRefs ? new Set([...facts.ledgerRefs].map((r) => r.trim())) : null,
    trivial: new Set(opts.trivialNumbers ?? DEFAULT_TRIVIAL_NUMBERS),
    banned: opts.bannedPhrases ?? SALES_LABEL_PATTERNS,
  };
}

function keyOf(x: number, d: number): string {
  return roundTo(x, d).toFixed(d);
}

function factIndex(cf: CompiledFacts, kind: ScaleKind, d: number): Set<string> {
  const k = `${kind}:${d}`;
  let s = cf.index.get(k);
  if (!s) {
    s = new Set<string>();
    for (const f of cf.numbers) {
      const v = kind === "x100" ? f * 100 : kind === "d100" ? f / 100 : kind === "d1000" ? f / 1000 : f;
      s.add(keyOf(v, d));
    }
    cf.index.set(k, s);
  }
  return s;
}

/** True when the cited number is a fact of this run (or trivial). See the module comment. */
function numberMatchesFacts(tok: NumberToken, cf: CompiledFacts): boolean {
  if (!tok.percent && !tok.thousands && tok.decimals === 0 && cf.trivial.has(tok.value)) return true;
  const d = Math.min(tok.decimals, 10);
  const target = keyOf(tok.value, d);
  const kinds: ScaleKind[] = tok.percent ? ["x100", "x1"] : tok.thousands ? ["d1000"] : d > 0 && tok.value <= 1 ? ["x1", "d100"] : ["x1"];
  return kinds.some((kind) => factIndex(cf, kind, d).has(target));
}

/** Every rule a text breaks (empty when it passes). */
function textViolations(text: string, cf: CompiledFacts): { violations: string[]; denied: boolean } {
  const violations: string[] = [];
  let denied = false;
  const src = typeof text === "string" ? text : "";

  for (const m of src.matchAll(UUID_RE)) {
    if (!cf.entityIds.has(m[0].toLowerCase())) violations.push(`entity id ${m[0]} not in this run`);
  }
  for (const m of src.matchAll(URN_RE)) {
    const urn = m[0];
    if (/^urn:tag:/i.test(urn) && !cf.allowTagIds.has(urn)) violations.push(`tag ${urn} not on the allowlist`);
  }
  let work = src.replace(UUID_RE, " ").replace(URN_RE, " ");
  if (cf.mask) work = work.replace(cf.mask, " ");

  for (const m of work.matchAll(GEOHASH_LIKE_RE)) {
    const tok = m[0].toLowerCase();
    if (!/\d/.test(tok) || !/[a-z]/.test(tok)) continue;
    if (!cf.geohashes.has(tok)) violations.push(`geohash ${tok} not in this run`);
  }
  work = work.replace(GEOHASH_LIKE_RE, (t) => (/\d/.test(t) && /[a-z]/i.test(t) ? " " : t));

  for (const m of work.matchAll(LEDGER_REF_RE)) {
    if (cf.ledgerRefs && !cf.ledgerRefs.has(m[0])) violations.push(`ledger ref ${m[0]} not in this run`);
  }
  work = work.replace(LEDGER_REF_RE, " ");

  for (const tok of extractNumberTokens(work)) {
    if (!numberMatchesFacts(tok, cf)) violations.push(`number ${tok.raw} not in this run's results`);
  }

  const normalized = normalizeForMatch(work);
  if (findDeniedTerm(work) !== null || cf.deniedPhrases.some((p) => normalized.includes(p))) {
    // The term itself is not written into the report: reports are persisted.
    violations.push("denied term");
    denied = true;
  }
  if (
    cf.banned.some((re) => {
      re.lastIndex = 0;
      return re.test(work);
    })
  ) {
    violations.push("sales label");
  }
  return { violations, denied };
}

export interface GuardResult<N extends NarrationInput> {
  narration: N;
  report: GuardReport;
}

function splitSentences(s: string): string[] {
  return s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** Validates narration against this run's facts. Returns a cleaned copy and the report; never mutates the input. */
export function validateNarration<N extends NarrationInput>(narration: N, facts: NarrationFacts, opts: GuardOptions = {}): GuardResult<N> {
  const cf = compileFacts(facts, opts);
  const reasons: string[] = [];
  let dropped = 0;
  let deniedDrops = 0;
  const checkUnit = (unit: string, text: string, extra: string[] = []): boolean => {
    const { violations, denied } = textViolations(text, cf);
    const all = [...extra, ...violations];
    if (all.length === 0) return true;
    dropped++;
    if (denied) deniedDrops++;
    reasons.push(`${unit}: ${all.join("; ")}`);
    return false;
  };

  const sentences = splitSentences(narration.summary ?? "");
  const keptSentences = sentences.filter((s, i) => checkUnit(`summary sentence ${i + 1}`, s));

  const tileWhy = (narration.tileWhy ?? []).filter((t, i) => {
    const gh = (t?.geohash ?? "").trim().toLowerCase();
    const extra = cf.geohashes.has(gh) ? [] : [`tile ${gh || "(none)"} not in this run`];
    return checkUnit(`tileWhy[${i}]`, t?.text ?? "", extra);
  });

  const partnerLines = (narration.partnerLines ?? []).filter((p, i) => {
    const id = (p?.entityId ?? "").trim().toLowerCase();
    const extra = cf.entityIds.has(id) ? [] : [`entity ${p?.entityId || "(none)"} not in this run`];
    return checkUnit(`partnerLines[${i}]`, p?.text ?? "", extra);
  });

  const out: N = { ...narration, summary: keptSentences.join(" "), tileWhy, partnerLines };
  if (narration.copyHooks) {
    out.copyHooks = narration.copyHooks.filter((h, i) => {
      const ids = h?.tagIds ?? [];
      const extra: string[] = [];
      if (ids.length === 0) extra.push("copy hook cites no allowlisted tag");
      for (const id of ids) if (!cf.allowTagIds.has(id)) extra.push(`tag ${id} not on the allowlist`);
      if (opts.legalAgeEnforced !== undefined && opts.legalAgeEnforced !== true && findAlcoholTerm(h?.text ?? "") !== null) {
        extra.push("alcohol in fan-facing copy on a show that is not 21+");
      }
      return checkUnit(`copyHooks[${i}]`, h?.text ?? "", extra);
    });
  }

  const base = isFiniteNumber(facts.deniedTagCount) ? Math.max(0, Math.floor(facts.deniedTagCount)) : 0;
  return { narration: out, report: { dropped, reasons, deniedTagCount: base + deniedDrops } };
}

/** Checks one free-text string against the facts (e.g. a templated line or an arm-F answer). */
export function findTextViolations(text: string, facts: NarrationFacts, opts: GuardOptions = {}): string[] {
  return textViolations(text, compileFacts(facts, opts)).violations;
}

/**
 * Object keys whose values are never citable facts. Coordinates would otherwise
 * let "36 fans" pass because a tile sits at latitude 36.16.
 */
export const DEFAULT_FACT_SKIP_KEYS: readonly string[] = ["lat", "lon", "lng", "latitude", "longitude"];

/**
 * Collects every finite number inside values (deep), for building
 * `NarrationFacts.numbers` from this run's computed results. With
 * `includeStrings`, numbers written inside strings ("1,850 seats") are added too.
 * Values under `skipKeys` (default: coordinate fields) are ignored.
 */
export function collectFactNumbers(
  values: readonly unknown[],
  opts: { includeStrings?: boolean; maxDepth?: number; skipKeys?: readonly string[] } = {},
): number[] {
  const out = new Set<number>();
  const seen = new WeakSet<object>();
  const maxDepth = opts.maxDepth ?? 12;
  const skip = new Set((opts.skipKeys ?? DEFAULT_FACT_SKIP_KEYS).map((k) => k.toLowerCase()));
  const walk = (v: unknown, depth: number): void => {
    if (depth > maxDepth || v === null || v === undefined) return;
    if (typeof v === "number") {
      if (Number.isFinite(v)) out.add(v);
      return;
    }
    if (typeof v === "string") {
      if (opts.includeStrings) for (const t of extractNumberTokens(v)) out.add(t.thousands ? t.value * 1000 : t.value);
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v instanceof Map) {
      for (const x of v.values()) walk(x, depth + 1);
      return;
    }
    if (v instanceof Set) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!skip.has(k.toLowerCase())) walk(x, depth + 1);
    }
  };
  for (const v of values) walk(v, 0);
  return [...out].sort((a, b) => a - b);
}
