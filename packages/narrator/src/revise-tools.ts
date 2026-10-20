/**
 * The revise tools: what the operator can change on a finished sheet by typing
 * a note ("All ages: no bars", "skip Germantown", "only Saturday").
 *
 * Six strict tools. Their enums come from the sheet being revised (the area
 * names and geohashes on it, the place-type keys), so the model can only pick
 * values that exist. Every call is checked again here (`checkReviseCall`)
 * before it is used, which also covers the rules interpreter and test mocks.
 */
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { WEEKDAYS, type Weekday } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import { z } from "zod";

export const REVISE_TOOL_NAMES = [
  "set_all_ages",
  "exclude_partner_categories",
  "exclude_areas",
  "set_street_team_days",
  "set_radius",
  "ask_operator",
] as const;
export type ReviseToolName = (typeof REVISE_TOOL_NAMES)[number];

export const RADIUS_MIN_KM = 5;
export const RADIUS_MAX_KM = 60;
/** Longest instruction accepted (characters, after trimming). */
export const MAX_INSTRUCTION_CHARS = 300;
export const MAX_QUESTION_CHARS = 300;

/** One area on the sheet: a top lift tile or a tile partners came from. */
export interface ReviseArea {
  /** Gazetteer name, when the tile has one. Several tiles can share a name. */
  name: string | null;
  geohash: string;
  /** Partners on the sheet in this tile. */
  partners: number;
}

/** One place type (an @walkup/engine `resolveCategory` key) and how many of each the sheet holds. */
export interface ReviseCategory {
  key: string;
  partners: number;
  spots: number;
}

/**
 * The compact view of a sheet the interpreter reads. No contact emails, no
 * ledger, no partner names: only what the tools can change and what they act on.
 */
export interface ReviseSummary {
  show: {
    acts: string[];
    venue: string;
    city: string;
    date: string;
    weekday: Weekday;
    /** From Ticketmaster's age policy only. */
    agePolicy: "21+" | "all ages" | "not listed";
  };
  settings: {
    allAges: boolean;
    streetTeamDays: Weekday[];
    radiusKm: number;
    excludeCategories: string[];
    excludeAreas: string[];
  };
  areas: ReviseArea[];
  categories: ReviseCategory[];
  partners: number;
  spots: number;
}

export type ReviseCall =
  | { tool: "set_all_ages"; input: { allAges: boolean } }
  | { tool: "exclude_partner_categories"; input: { categories: string[] } }
  | { tool: "exclude_areas"; input: { areas: string[] } }
  | { tool: "set_street_team_days"; input: { days: Weekday[] } }
  | { tool: "set_radius"; input: { km: number } }
  | { tool: "ask_operator"; input: { question: string } };

// ---------------------------------------------------------------------------
// Choices taken from the sheet
// ---------------------------------------------------------------------------

/** Area values the tools accept: every distinct name on the sheet, then every geohash. */
export function areaChoices(summary: Pick<ReviseSummary, "areas">): string[] {
  const names = new Set<string>();
  for (const a of summary.areas) if (a.name && a.name.trim()) names.add(a.name.trim());
  return [...names, ...new Set(summary.areas.map((a) => a.geohash))];
}

export function categoryChoices(summary: Pick<ReviseSummary, "categories">): string[] {
  return [...new Set(summary.categories.map((c) => c.key))];
}

/** The bar keys among the sheet's place types ("bar", "pub", ...). */
export function barKeys(summary: Pick<ReviseSummary, "categories">): string[] {
  const choices = new Set(categoryChoices(summary));
  return DEFAULT_BAR_CATEGORIES.filter((k) => choices.has(k));
}

// ---------------------------------------------------------------------------
// Tool definitions (strict; enums from the sheet)
// ---------------------------------------------------------------------------

export function buildReviseTools(summary: ReviseSummary): BetaTool[] {
  const areas = areaChoices(summary);
  const cats = categoryChoices(summary);
  const tools: BetaTool[] = [
    {
      name: "set_all_ages",
      description:
        "Mark the show all ages (true) or clear that mark (false). All ages leaves out bar partners and pre/post spots led by alcohol. " +
        "It can only add restrictions: when Ticketmaster lists the show as 21+, false does not lift that.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { allAges: { type: "boolean", description: "true: the show is all ages. false: clear the operator's all-ages mark." } },
        required: ["allAges"],
        additionalProperties: false,
      },
    },
    {
      name: "exclude_partner_categories",
      description:
        "Leave these place types out of the partner list and the pre/post spots. Keys are the sheet's place types; " +
        'for "no bars" pass every bar key (bar, pub, sports_bar, night_club ...) on the list.',
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          categories: { type: "array", items: { type: "string", enum: cats }, description: "Place-type keys to leave out." },
        },
        required: ["categories"],
        additionalProperties: false,
      },
    },
    {
      name: "exclude_areas",
      description:
        "Skip these areas: no lift tile and no partners there. Use the area names or geohashes listed in <sheet>. " +
        "A name shared by several tiles skips all of them.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          areas: { type: "array", items: { type: "string", enum: areas.length > 0 ? areas : ["none"] }, description: "Area names or geohashes from <sheet>." },
        },
        required: ["areas"],
        additionalProperties: false,
      },
    },
    {
      name: "set_street_team_days",
      description: "The days the street team works. Partner opening hours are checked against the first day.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          days: { type: "array", items: { type: "string", enum: [...WEEKDAYS] }, description: "Weekdays in lower case, one to seven of them." },
        },
        required: ["days"],
        additionalProperties: false,
      },
    },
    {
      name: "set_radius",
      description: `Search radius around the venue in km, from ${RADIUS_MIN_KM} to ${RADIUS_MAX_KM}. Convert miles to km first.`,
      strict: true,
      input_schema: {
        type: "object",
        properties: { km: { type: "number", description: `Kilometres, ${RADIUS_MIN_KM} to ${RADIUS_MAX_KM}.` } },
        required: ["km"],
        additionalProperties: false,
      },
    },
    {
      name: "ask_operator",
      description:
        "Ask the operator one short question instead of changing anything, when the note is unclear, asks for something these tools cannot do, " +
        "or names an area or place type that is not on the sheet. Never guess.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { question: { type: "string", description: "One plain question, under 30 words." } },
        required: ["question"],
        additionalProperties: false,
      },
    },
  ];
  return tools;
}

// ---------------------------------------------------------------------------
// Checking a call (model, rules or a mock)
// ---------------------------------------------------------------------------

const SetAllAges = z.strictObject({ allAges: z.boolean() });
const Categories = z.strictObject({ categories: z.array(z.string().trim().min(1).max(40)).min(1).max(20) });
const Areas = z.strictObject({ areas: z.array(z.string().trim().min(1).max(80)).min(1).max(20) });
const Days = z.strictObject({ days: z.array(z.enum(WEEKDAYS)).min(1).max(7) });
const Radius = z.strictObject({ km: z.number().finite() });
const Ask = z.strictObject({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

export type CheckedCall = { ok: true; call: ReviseCall } | { ok: false; error: string };

function canonical(values: readonly string[], choices: readonly string[]): { kept: string[]; unknown: string[] } {
  const byLower = new Map(choices.map((c) => [c.toLowerCase(), c]));
  const kept: string[] = [];
  const unknown: string[] = [];
  for (const v of values) {
    const hit = byLower.get(v.trim().toLowerCase());
    if (hit) {
      if (!kept.includes(hit)) kept.push(hit);
    } else unknown.push(v);
  }
  return { kept, unknown };
}

/** Validates one call against the sheet. Values are matched without regard to case and returned in the sheet's spelling. */
export function checkReviseCall(tool: string, input: unknown, summary: ReviseSummary): CheckedCall {
  switch (tool) {
    case "set_all_ages": {
      const p = SetAllAges.safeParse(input);
      return p.success ? { ok: true, call: { tool, input: { allAges: p.data.allAges } } } : { ok: false, error: "set_all_ages needs {allAges: true | false}." };
    }
    case "exclude_partner_categories": {
      const p = Categories.safeParse(input);
      if (!p.success) return { ok: false, error: "exclude_partner_categories needs {categories: [key, ...]} with at least one key." };
      const { kept, unknown } = canonical(p.data.categories, categoryChoices(summary));
      if (unknown.length > 0) return { ok: false, error: `Not a place type on this sheet: ${unknown.join(", ")}. Use the keys listed in <sheet>.` };
      return { ok: true, call: { tool, input: { categories: kept } } };
    }
    case "exclude_areas": {
      const p = Areas.safeParse(input);
      if (!p.success) return { ok: false, error: "exclude_areas needs {areas: [name or geohash, ...]} with at least one value." };
      const { kept, unknown } = canonical(p.data.areas, areaChoices(summary));
      if (unknown.length > 0) return { ok: false, error: `Not an area on this sheet: ${unknown.join(", ")}. Use a name or geohash listed in <sheet>, or ask the operator.` };
      return { ok: true, call: { tool, input: { areas: kept } } };
    }
    case "set_street_team_days": {
      const p = Days.safeParse(input);
      if (!p.success) return { ok: false, error: "set_street_team_days needs {days: [weekday, ...]} in lower case." };
      const days = WEEKDAYS.filter((d) => p.data.days.includes(d));
      return { ok: true, call: { tool, input: { days } } };
    }
    case "set_radius": {
      const p = Radius.safeParse(input);
      if (!p.success) return { ok: false, error: "set_radius needs {km: number}." };
      const km = Math.round(p.data.km * 10) / 10;
      if (km < RADIUS_MIN_KM || km > RADIUS_MAX_KM) return { ok: false, error: `The radius must be ${RADIUS_MIN_KM} to ${RADIUS_MAX_KM} km; ${km} km is outside it. Ask the operator.` };
      return { ok: true, call: { tool, input: { km } } };
    }
    case "ask_operator": {
      const p = Ask.safeParse(input);
      return p.success ? { ok: true, call: { tool, input: { question: p.data.question } } } : { ok: false, error: "ask_operator needs {question: string}." };
    }
    default:
      return { ok: false, error: `Unknown tool "${tool}". Available: ${REVISE_TOOL_NAMES.join(", ")}.` };
  }
}

/**
 * Folds repeated calls: the last set_* call of a kind wins (set_all_ages: true
 * wins, the more restrictive value), exclusions are merged, and the first question is kept. Order follows first appearance.
 */
export function mergeReviseCalls(calls: readonly ReviseCall[]): ReviseCall[] {
  const out: ReviseCall[] = [];
  for (const c of calls) {
    const i = out.findIndex((o) => o.tool === c.tool);
    if (i === -1) {
      out.push(c);
      continue;
    }
    const prev = out[i] as ReviseCall;
    if (c.tool === "exclude_partner_categories" && prev.tool === "exclude_partner_categories") {
      out[i] = { tool: c.tool, input: { categories: [...new Set([...prev.input.categories, ...c.input.categories])] } };
    } else if (c.tool === "exclude_areas" && prev.tool === "exclude_areas") {
      out[i] = { tool: c.tool, input: { areas: [...new Set([...prev.input.areas, ...c.input.areas])] } };
    } else if (c.tool === "set_all_ages" && prev.tool === "set_all_ages") {
      // All ages only ever adds restrictions: a later "false" never undoes a "true" from the same note.
      out[i] = { tool: c.tool, input: { allAges: prev.input.allAges || c.input.allAges } };
    } else if (c.tool !== "ask_operator") {
      out[i] = c;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain labels (shared with the orchestrator's change list)
// ---------------------------------------------------------------------------

const CATEGORY_WORDS: Record<string, [string, string]> = {
  bar: ["bar", "bars"],
  pub: ["pub", "pubs"],
  irish_pub: ["Irish pub", "Irish pubs"],
  sports_bar: ["sports bar", "sports bars"],
  wine_bar: ["wine bar", "wine bars"],
  cocktail_bar: ["cocktail bar", "cocktail bars"],
  beer_bar: ["beer bar", "beer bars"],
  dive_bar: ["dive bar", "dive bars"],
  brewery: ["brewery", "breweries"],
  brewpub: ["brewpub", "brewpubs"],
  lounge: ["lounge", "lounges"],
  night_club: ["night club", "night clubs"],
  nightclub: ["night club", "night clubs"],
  restaurant: ["restaurant", "restaurants"],
  cafe: ["cafe", "cafes"],
  record_store: ["record store", "record stores"],
  book_store: ["bookstore", "bookstores"],
  clothing_store: ["clothing store", "clothing stores"],
  barber_shop: ["barbershop", "barbershops"],
  beauty_salon: ["beauty salon", "beauty salons"],
  bakery: ["bakery", "bakeries"],
  soul_food: ["soul food place", "soul food places"],
};

/** "record_store" -> "record store" (one) or "record stores" (many). */
export function categoryWord(key: string, many = true): string {
  const w = CATEGORY_WORDS[key];
  if (w) return many ? w[1] : w[0];
  const plain = key.replace(/_/g, " ").trim();
  return many && !plain.endsWith("s") ? `${plain}s` : plain;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Place types in words. When every bar key the sheet knows is in the list,
 * they read as one group ("bars and other drinking places").
 */
export function categoriesInWords(keys: readonly string[], summary?: Pick<ReviseSummary, "categories">): string {
  const set = [...new Set(keys)];
  const bars = summary ? barKeys(summary) : [];
  const allBars = bars.length > 1 && bars.every((k) => set.includes(k));
  const rest = allBars ? set.filter((k) => !bars.includes(k)) : set;
  const words = rest.map((k) => categoryWord(k));
  if (allBars) words.unshift("bars and other drinking places");
  return joinAnd(words);
}

export function dayWord(d: Weekday): string {
  return d.charAt(0).toUpperCase() + d.slice(1);
}

function areaWord(value: string, summary: ReviseSummary): string {
  const byGh = summary.areas.find((a) => a.geohash.toLowerCase() === value.toLowerCase());
  if (byGh) return byGh.name ? `${byGh.name} (${byGh.geohash})` : `area ${byGh.geohash}`;
  return value;
}

/** One plain line per call, e.g. "Left out bars and other drinking places". */
export function describeReviseCall(call: ReviseCall, summary: ReviseSummary): string {
  switch (call.tool) {
    case "set_all_ages":
      return call.input.allAges
        ? "Marked the show all ages, so no bar partners or drink-led spots"
        : summary.show.agePolicy === "21+"
          ? "Cleared the all-ages mark; Ticketmaster still lists the show as 21+"
          : "Cleared the all-ages mark";
    case "exclude_partner_categories":
      return `Left out ${categoriesInWords(call.input.categories, summary)}`;
    case "exclude_areas":
      return `Skipped ${joinAnd(call.input.areas.map((a) => areaWord(a, summary)))}`;
    case "set_street_team_days":
      return `Street team works ${joinAnd(call.input.days.map(dayWord))}${call.input.days.length === 1 ? " only" : ""}`;
    case "set_radius":
      return `Search radius set to ${call.input.km.toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
    case "ask_operator":
      return `Asked: ${call.input.question}`;
  }
}
