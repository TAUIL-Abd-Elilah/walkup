/**
 * Every fixed value of the P1 protocol in one place, copied from the sealed plan
 * (docs/preregistration/p1-plan.md) and its contract (evals/p1/ARMS.md). Prompts and the
 * tool definition are verbatim. Changing any value here is a protocol deviation and must
 * be logged in docs/preregistration/p1-deviations.md.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";

export const SEED = 20261013;

// ---------------------------------------------------------------------------
// Clubs (plan §6, ARMS.md conventions)
// ---------------------------------------------------------------------------

export const CLUBS = ["american_outlaws", "arsenal_america", "lfc_olsc"] as const;
export type ClubKey = (typeof CLUBS)[number];

export function isClubKey(s: string): s is ClubKey {
  return (CLUBS as readonly string[]).includes(s);
}

/** Club display names used in both model prompts (ARMS.md conventions, verbatim). */
export const CLUB_DISPLAY_NAMES: Record<ClubKey, string> = {
  arsenal_america: "Arsenal FC",
  lfc_olsc: "Liverpool FC",
  american_outlaws: "USMNT (US men's national soccer team)",
};

/** Preregistered brand-entity search names, tried in this order (§6). */
export const CLUB_BRAND_NAMES: Record<ClubKey, readonly string[]> = {
  arsenal_america: ["Arsenal F.C.", "Arsenal FC", "Arsenal Football Club", "Arsenal"],
  lfc_olsc: ["Liverpool F.C.", "Liverpool FC", "Liverpool Football Club", "Liverpool"],
  american_outlaws: [
    "United States men's national soccer team",
    "United States Men's National Team",
    "U.S. Men's National Soccer Team",
    "USMNT",
  ],
};

/** A brand is accepted only with a tag id containing this (§6). */
export const BRAND_TAG_MARKER = "sports_organization";

// ---------------------------------------------------------------------------
// Tags (§8)
// ---------------------------------------------------------------------------

export const PIN_WORDS = ["bar", "pub", "sports bar", "irish pub"] as const;
export type PinWord = (typeof PIN_WORDS)[number];
/** Preferred namespace when several tags match a word. */
export const PIN_PREFERRED_PREFIX = "urn:tag:category:place";
/** The same four categories in config/tags.json (cross-checked, never used instead of the §8 pin). */
export const CONFIG_TAG_KEYS: Record<PinWord, string> = {
  bar: "bar",
  pub: "pub",
  "sports bar": "sports_bar",
  "irish pub": "irish_pub",
};

// ---------------------------------------------------------------------------
// Resolution (§7) and arms (§8)
// ---------------------------------------------------------------------------

export const NAME_SIM_THRESHOLD = 0.85;
export const FALLBACK_SIM_THRESHOLD = 0.95;
export const RESOLVE_RADIUS_M = 300;
export const METRO_RADIUS_M = 25_000;
/** Filter honoured check: any Q-signal / Q-pop entity farther than this from P stops the run. */
export const FILTER_CHECK_M = 26_000;
/** /search radius is in miles. */
export const PRIMARY_SEARCH_RADIUS_MILES = 1;
export const FALLBACK_SEARCH_RADIUS_MILES = 16;
export const SEARCH_TAKE = 20;
export const ARM_TAKE = 50;
export const DERBY_TAKE = 10;
/** Google Places Text Search, whole run including resolution (§8 Budget). */
export const PLACES_TOTAL_CAP = 2500;
export const PLACES_PAGE_SIZE = 20;
export const F_MAX_TOOL_CALLS = 5;
export const F_KEEP = 50;
export const L_KEEP = 3;
export const STALE_PAGE_YEARS = 2;
export const CLOSED_STATUSES = ["CLOSED_PERMANENTLY", "CLOSED_TEMPORARILY"] as const;

/** Run order (§8 "Order"): Q-pop, Q-signal, F, L, Q-derby. */
export const ARMS = ["Q-pop", "Q-signal", "F", "L", "Q-derby"] as const;
export type ArmName = (typeof ARMS)[number];

/** Accepts "Q-signal", "q_signal", "QSIGNAL", ... (as analyze.canonical_arm). */
export function canonicalArm(name: string): ArmName {
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  const table: Record<string, ArmName> = { qsignal: "Q-signal", qpop: "Q-pop", f: "F", l: "L", qderby: "Q-derby" };
  const arm = table[key];
  if (!arm) throw new Error(`unknown arm "${name}" (use Q-signal, Q-pop, F, L, Q-derby)`);
  return arm;
}

export const BAR_STATUSES = [
  "stale_page",
  "no_metro",
  "no_brand",
  "unresolved",
  "closed",
  "out_of_radius",
  "analyzed",
] as const;
export type BarStatus = (typeof BAR_STATUSES)[number];

/** Arms CSV (input to analyze.py --arms), ARMS.md §7. */
export const ARMS_CSV_COLUMNS = [
  "club",
  "metro",
  "bar_key",
  "arm",
  "rank_or_blank",
  "candidates_n",
  "bar_club",
  "listing_role",
  "resolution_via",
  "entity_id",
] as const;

/** Bars status file (input to analyze.py --bars), ARMS.md §1. */
export const BARS_STATUS_COLUMNS = [
  "club",
  "bar_key",
  "metro",
  "status",
  "entity_id",
  "google_place_id",
  "resolution_via",
] as const;

/** §13 viability gate metros (display name, state). */
export const VIABILITY_METROS: readonly { name: string; state: string }[] = [
  { name: "Houston", state: "TX" },
  { name: "Chicago", state: "IL" },
  { name: "Durham", state: "NC" },
];
export const VIABILITY_MIN_RESOLVED = 6;
export const VIABILITY_MIN_TOP50 = 3;

/** Same identity the ground-truth collector used (plan §3). */
export const USER_AGENT = "WalkupResearch/0.1 (contact via repo)";

// ---------------------------------------------------------------------------
// Model arms (§8, ARMS.md §4 and §5), verbatim
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT =
  "You are a research assistant helping a live-event marketing team understand local venues. Follow the instructions in the user message and answer only in the requested JSON format.";

export function fPrompt(metroDisplay: string, state: string, clubDisplay: string): string {
  return `Rank up to 50 bars and pubs in ${metroDisplay}, ${state} that fans of ${clubDisplay} love. Use the places_search tool to find candidates. Return only place ids that the tool returned, best first.`;
}

export function lPrompt(clubDisplay: string, metroDisplay: string, state: string): string {
  return `Name the bar or pub where the official ${clubDisplay} supporters' group in ${metroDisplay}, ${state} watches matches. Give up to 3 names, most likely first.`;
}

export const PLACES_SEARCH_TOOL: Tool = {
  name: "places_search",
  description:
    "Search Google Places near the metro. Returns up to 20 places with id, name, address, rating, userRatingCount and businessStatus.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Free-text place search, e.g. 'soccer pub'." } },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

export const TOOL_BUDGET_MESSAGE = "tool budget reached; give your answer now";
export const F_EFFORT = "medium" as const;
export const L_EFFORT = "low" as const;
export const MODEL_MAX_TOKENS = 16000;
/**
 * Safety stop for the F tool loop (not in the plan, which caps tool calls, not turns):
 * after this many model turns without a final answer the conversation counts as failed.
 */
export const F_MAX_TURNS = 12;

// ---------------------------------------------------------------------------
// Metro display name (port of centroids.metro_display_name)
// ---------------------------------------------------------------------------

const SUFFIXES = [
  "metropolitan government",
  "metro government",
  "consolidated government",
  "unified government",
  "urban county",
  "city and borough",
  "municipality",
  "borough",
  "village",
  "township",
  "charter township",
  "plantation",
  "city",
  "town",
  "cdp",
  "ccd",
  "comunidad",
  "zona urbana",
];
const CONSOLIDATED = /metropolitan government|metro government|consolidated government|unified government|urban county/i;

/**
 * "Nashville-Davidson metropolitan government (balance)" -> "Nashville"; "Durham city" -> "Durham".
 * Same steps as evals/p1/centroids.py metro_display_name.
 */
export function metroDisplayName(gazetteerName: string): string {
  let name = (gazetteerName ?? "").trim().replace(/\s*\(balance\)\s*$/, "");
  if (CONSOLIDATED.test(name)) name = name.split(/[-/]/, 1)[0] as string;
  const low = name.toLowerCase();
  const bySize = [...SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suf of bySize) {
    if (low.endsWith(` ${suf}`)) return name.slice(0, name.length - suf.length - 1).trim();
  }
  return name.trim();
}
