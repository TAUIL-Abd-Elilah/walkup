/**
 * The rules interpreter: reads common revise notes without a model and turns
 * them into the same tool calls the model would make. It runs when no
 * Anthropic key is set (fixture mode, tests) and when the model call fails.
 *
 * Understood, in any order, separated by commas, "and", ";" or ":":
 *   "all ages", "family show", "under 21s welcome"      -> set_all_ages(true)
 *   "not all ages", "21+", "adults only"                 -> set_all_ages(false)
 *   "no bars", "skip cafes", "without record stores"     -> exclude_partner_categories
 *   "skip Germantown", "not in West Nashville", "no dq9cgz" -> exclude_areas (names or geohashes on the sheet)
 *   "only Saturday", "Friday and Saturday", "no Sunday"  -> set_street_team_days
 *   "within 10 km", "6 miles", "radius 25km"             -> set_radius (5 to 60 km)
 *
 * Anything else, an area name that matches more than one area, or a value out
 * of range gives a plain question and no change. It never guesses.
 */
import { WEEKDAYS, type Weekday } from "@walkup/contracts";
import {
  barKeys,
  categoryChoices,
  mergeReviseCalls,
  RADIUS_MAX_KM,
  RADIUS_MIN_KM,
  type ReviseCall,
  type ReviseSummary,
} from "./revise-tools";

export interface RulesReading {
  calls: ReviseCall[];
  /** Set when a part of the note could not be read; no call is then applied. */
  question: string | null;
}

const KM_PER_MILE = 1.609344;

/** "all ages", "family show", "under 21s welcome", "kids welcome". */
const ALL_AGES_RE = /\ball[- ]?ages?\b|\bfamily([- ]friendly)?( show)?\b|\bunder[- ]?(21|18)s?( are)?( welcome)?\b|\bkids?( are)? welcome\b/;
/** "not all ages", "remove the all ages mark": the negation governs "all ages" directly. */
const CLEAR_ALL_AGES_RE = /\b(not|isn'?t|no longer|undo|clear|remove|drop)\s+(the\s+|an?\s+)?all[- ]?ages?\b/;
/** "21+", "adults only", "no under 21s", "not for under 18s", "not family friendly". */
const ADULTS_RE =
  /\b21 ?\+|\b21 and (over|up)\b|\badults? only\b|\bover[- ]?21\b|\b(no|not for)\s+(the\s+)?under[- ]?(21|18)s?\b|\bnot\s+(a\s+)?family([- ]friendly)?\b|\bno\s+(kids|family|families)\b/;
/** "no 21+ venues": about places, not the show's age policy. */
const NO_ADULT_PLACES_RE = /\b(no|without|skip)\s+21 ?\+/;
const ALL_AGES_QUESTION = 'Should I mark this show all ages, or leave the age policy as Ticketmaster lists it? Say "all ages" or "not all ages", and "no bars" to leave bars out.';

/** Place-type words -> keys. "bars" is special: every bar key on the sheet. */
const CATEGORY_SYNONYMS: [RegExp, string[] | "bars"][] = [
  [/^(bars?|drinking( places| spots)?|alcohol|booze|drinks|bars? and clubs)$/, "bars"],
  [/^(pubs?)$/, ["pub", "irish_pub"]],
  [/^((night ?)?clubs?)$/, ["night_club", "nightclub"]],
  [/^(breweries|brewery|brewpubs?|taprooms?)$/, ["brewery", "brewpub"]],
  [/^(sports bars?)$/, ["sports_bar"]],
  [/^(wine bars?)$/, ["wine_bar"]],
  [/^(cocktail bars?)$/, ["cocktail_bar"]],
  [/^(dive bars?)$/, ["dive_bar"]],
  [/^(lounges?)$/, ["lounge"]],
  [/^(restaurants?|food|eateries|diners?|dinner spots?)$/, ["restaurant"]],
  [/^(soul food( places| spots)?)$/, ["soul_food"]],
  [/^(cafes?|cafés?|coffee( shops?| places| spots)?|coffeeshops?)$/, ["cafe"]],
  [/^(record (stores?|shops?)|vinyl( shops?| stores?)?|records)$/, ["record_store"]],
  [/^(book ?(stores?|shops?)|books)$/, ["book_store"]],
  [/^(clothing( stores?| shops?)?|clothes( shops?| stores?)?|boutiques?|vintage( shops?| stores?)?)$/, ["clothing_store"]],
  [/^(barbers?|barber ?shops?)$/, ["barber_shop"]],
  [/^((hair |beauty )?salons?|beauty)$/, ["beauty_salon"]],
  [/^(bakery|bakeries)$/, ["bakery"]],
];

const DAY_WORDS: [RegExp, Weekday][] = [
  [/^(mon|mondays?)$/, "monday"],
  [/^(tue|tues|tuesdays?)$/, "tuesday"],
  [/^(wed|weds|wednesdays?)$/, "wednesday"],
  [/^(thu|thur|thurs|thursdays?)$/, "thursday"],
  [/^(fri|fridays?)$/, "friday"],
  [/^(sat|saturdays?)$/, "saturday"],
  [/^(sun|sundays?)$/, "sunday"],
];

const EXCLUDE_RE =
  /^(?:please\s+)?(?:no|not|none|without|skip|skipping|drop|exclude|remove|avoid|cut|ditch|lose|leave out|leave off|take out|stay out of|stay away from|nothing in|nothing from|not in|no partners in|no places in|no more)\s+(?:in\s+|from\s+|of\s+)?(.+)$/;
const FILLER_RE = /\b(please|thanks|thank you|ok|okay|keep|stay|it|can you|could you|let'?s|make it|make the|set it to|set|the show is|this show is|it'?s|its|is|a|an|the|show|plan|sheet|instead|too|also|just|for|this|that|us|me)\b/g;
const TARGET_NOISE_RE = /\b(the|any|more|area|areas|neighbou?rhoods?|parts?|places|spots|partners|on the list|please)\b/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits a note into clauses: on punctuation, and on "and"/"but"/"then" when a new instruction starts after it. */
export function splitClauses(note: string): string[] {
  const starts = "(?:no|not|skip|drop|exclude|without|remove|avoid|leave|only|just|within|inside|under|radius|keep|make|set|all|undo|street|search|stay|cut)";
  return normalize(note)
    .split(/[;,!?\n:()]+|\.(?!\d)|\s+-\s+|\s+—\s+/)
    .flatMap((c) => c.split(/\s+(?=(?:within|inside)\s+\d)/))
    .flatMap((c) => c.split(new RegExp(`\\s+(?:and|but|then|also|plus)\\s+(?=${starts}\\b)`)))
    .map((c) => c.trim())
    .filter(Boolean);
}

function listItems(text: string): string[] {
  return text
    .split(/\s*(?:,|\/|\+|\bor\b|\band\b|\bnor\b)\s*/)
    .map((t) => t.replace(TARGET_NOISE_RE, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function categoriesFor(word: string, summary: ReviseSummary): string[] | null {
  const choices = new Set(categoryChoices(summary));
  for (const [re, keys] of CATEGORY_SYNONYMS) {
    if (!re.test(word)) continue;
    const wanted = keys === "bars" ? barKeys(summary) : keys.filter((k) => choices.has(k));
    return wanted.length > 0 ? wanted : null;
  }
  // A key typed as is ("record_store").
  const key = word.replace(/\s+/g, "_");
  return choices.has(key) ? [key] : null;
}

type AreaMatch = { kind: "one"; values: string[] } | { kind: "many"; names: string[] } | { kind: "none" };

function wordsIn(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** An area by geohash, exact name, or a word run inside one name. Several different names: ambiguous. */
function areaFor(word: string, summary: ReviseSummary): AreaMatch {
  const w = word.trim().toLowerCase();
  const gh = summary.areas.find((a) => a.geohash.toLowerCase() === w);
  if (gh) return { kind: "one", values: [gh.geohash] };
  const names = [...new Set(summary.areas.map((a) => a.name).filter((n): n is string => !!n))];
  const exact = names.find((n) => n.toLowerCase() === w || wordsIn(n).join(" ") === wordsIn(w).join(" "));
  if (exact) return { kind: "one", values: [exact] };
  const target = wordsIn(w);
  if (target.length === 0) return { kind: "none" };
  const hits = names.filter((n) => {
    const ws = wordsIn(n);
    for (let i = 0; i + target.length <= ws.length; i++) if (target.every((t, j) => ws[i + j] === t)) return true;
    return false;
  });
  if (hits.length === 1) return { kind: "one", values: hits };
  if (hits.length > 1) return { kind: "many", names: hits };
  return { kind: "none" };
}

function dayOf(word: string): Weekday | null {
  for (const [re, d] of DAY_WORDS) if (re.test(word)) return d;
  return null;
}

function daysIn(clause: string): Weekday[] {
  const found = new Set<Weekday>();
  for (const w of clause.split(/[^a-z]+/)) {
    const d = dayOf(w);
    if (d) found.add(d);
  }
  return WEEKDAYS.filter((d) => found.has(d));
}

function areaExamples(summary: ReviseSummary): string {
  const named = [...new Set(summary.areas.map((a) => a.name).filter((n): n is string => !!n))].slice(0, 3);
  return named.length > 0 ? ` (on this sheet: ${named.join(", ")})` : "";
}

/** The plain question for a note the rules cannot read. */
export function unclearQuestion(part: string | null, summary: ReviseSummary): string {
  const what = part ? `I couldn't tell what "${part}" should change.` : "I couldn't tell what to change.";
  return (
    `${what} I can mark the show all ages, leave out a type of place (bars, cafes, book stores), skip an area${areaExamples(summary)}, ` +
    `set the street-team days, or set the search radius (${RADIUS_MIN_KM} to ${RADIUS_MAX_KM} km). What should I change?`
  );
}

interface ClauseResult {
  calls: ReviseCall[];
  question?: string;
  /** The clause asked to leave things out; a bare list in the next clause continues it. */
  excluding?: boolean;
}

function exclusionTargets(items: string[], summary: ReviseSummary, current: Weekday[]): ClauseResult {
  const cats: string[] = [];
  const areas: string[] = [];
  const dropDays: Weekday[] = [];
  for (const item of items) {
    const day = dayOf(item);
    if (day) {
      dropDays.push(day);
      continue;
    }
    const c = categoriesFor(item, summary);
    if (c) {
      cats.push(...c);
      continue;
    }
    const a = areaFor(item, summary);
    if (a.kind === "one") {
      areas.push(...a.values);
      continue;
    }
    if (a.kind === "many") return { calls: [], question: `"${item}" matches more than one area: ${a.names.join(", ")}. Which should I skip?` };
    return { calls: [], question: `"${item}" isn't a type of place or an area on this sheet${areaExamples(summary)}. What should I leave out?` };
  }
  const calls: ReviseCall[] = [];
  if (cats.length > 0) calls.push({ tool: "exclude_partner_categories", input: { categories: [...new Set(cats)] } });
  if (areas.length > 0) calls.push({ tool: "exclude_areas", input: { areas: [...new Set(areas)] } });
  if (dropDays.length > 0) {
    const left = current.filter((d) => !dropDays.includes(d));
    if (left.length === 0) return { calls: [], question: "That leaves the street team no days. Which days should they work?" };
    calls.push({ tool: "set_street_team_days", input: { days: left } });
  }
  return { calls, excluding: true };
}

function readClause(clause: string, summary: ReviseSummary, prevExcluding: boolean): ClauseResult | null {
  const c = clause.trim();

  // All ages, or clearing it. "Not" must govern "all ages" directly; a clause that
  // says both ("all ages, not 21+") is caught at the note level and asked about.
  if (NO_ADULT_PLACES_RE.test(c)) return { calls: [], question: ALL_AGES_QUESTION };
  if (CLEAR_ALL_AGES_RE.test(c) || ADULTS_RE.test(c)) {
    const rest = c.replace(new RegExp(CLEAR_ALL_AGES_RE.source, "g"), " ").replace(new RegExp(ADULTS_RE.source, "g"), " ");
    if (ALL_AGES_RE.test(rest)) return { calls: [], question: ALL_AGES_QUESTION };
    return { calls: [{ tool: "set_all_ages", input: { allAges: false } }] };
  }
  const allAges = ALL_AGES_RE.exec(c);
  if (allAges) {
    const calls: ReviseCall[] = [{ tool: "set_all_ages", input: { allAges: true } }];
    // "all ages no bars" read as one clause when the comma was missing; only the matched phrase is removed.
    const rest = c
      .replace(allAges[0], " ")
      .replace(/\b(for|the|crowd|audience|show|since|because|as|so|it'?s|its|is|this|an?)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (rest && rest !== c) {
      const more = readClause(rest, summary, false);
      if (more?.question) return more;
      if (more) calls.push(...more.calls);
    }
    return { calls };
  }

  // Radius.
  const r = /(\d+(?:\.\d+)?)\s*(km|kms|kilomet(?:er|re)s?|k|mi|miles?)\b/.exec(c);
  if (r && /\b(within|inside|under|radius|around|max|maximum|up to|no more than|keep|stay|search|of the room|of the venue|from the room|from the venue)\b|^\d/.test(c)) {
    const n = Number(r[1]);
    const km = /^mi/.test(r[2] ?? "") ? n * KM_PER_MILE : n;
    const rounded = Math.round(km * 10) / 10;
    if (!(rounded >= RADIUS_MIN_KM && rounded <= RADIUS_MAX_KM)) {
      return { calls: [], question: `Walkup searches ${RADIUS_MIN_KM} to ${RADIUS_MAX_KM} km from the room, and ${rounded} km is outside that. What radius should I use?` };
    }
    return { calls: [{ tool: "set_radius", input: { km: rounded } }] };
  }

  // Leaving things out (place types, areas, days).
  const ex = EXCLUDE_RE.exec(c);
  if (ex && ex[1]) {
    const items = listItems(ex[1]);
    if (items.length > 0) return exclusionTargets(items, summary, summary.settings.streetTeamDays);
  }

  // Street-team days ("only saturday", "friday and saturday", "street team on sat").
  const days = daysIn(c);
  if (days.length > 0) {
    const leftover = c
      // Not "of": "Saturday instead of Thursday" must not read as both days. Not a bare "out", "let" or a closing "go":
      // "Saturday is out for our crew", "let Saturday go", "Thursday can go" and "Saturday is going out" drop a day, so
      // they get the question; "go out on Saturday" and "goes Saturday" still read as that day.
      .replace(/\b(only|just|go(?:es|ing)? out(?=\s+[a-z])|go(?:es)?(?=\s+[a-z])|for|our|crew|have|street|team|teams?|works?|working|on|days?|and|or|to|the|instead|please|us|we|they|be|should|can|is|are|weekdays?)\b/g, " ")
      .split(/[^a-z]+/)
      .filter((w) => w && !dayOf(w));
    if (leftover.length === 0) return { calls: [{ tool: "set_street_team_days", input: { days } }] };
  }

  // A bare list after "no bars, cafes".
  if (prevExcluding) {
    const items = listItems(c);
    if (items.length > 0 && items.every((i) => categoriesFor(i, summary) !== null || areaFor(i, summary).kind === "one")) {
      return exclusionTargets(items, summary, summary.settings.streetTeamDays);
    }
  }

  // Nothing but filler ("please", "thanks").
  if (c.replace(FILLER_RE, " ").replace(/[^a-z0-9]+/g, "").length === 0) return { calls: [] };
  return null;
}

/** Reads a note with fixed rules. A question comes back (and no calls) when any part is unclear. */
export function readRevisionByRules(summary: ReviseSummary, instruction: string): RulesReading {
  const clauses = splitClauses(instruction);
  if (clauses.length === 0) return { calls: [], question: unclearQuestion(null, summary) };
  const calls: ReviseCall[] = [];
  let excluding = false;
  for (const clause of clauses) {
    const r = readClause(clause, summary, excluding);
    if (!r) return { calls: [], question: unclearQuestion(clause, summary) };
    if (r.question) return { calls: [], question: r.question };
    calls.push(...r.calls);
    excluding = r.excluding === true;
  }
  if (calls.length === 0) return { calls: [], question: unclearQuestion(null, summary) };
  // One note that both sets and clears all ages is unclear: ask, never let the last one win.
  const ages = new Set(calls.flatMap((c) => (c.tool === "set_all_ages" ? [c.input.allAges] : [])));
  if (ages.size > 1) return { calls: [], question: ALL_AGES_QUESTION };
  return { calls: mergeReviseCalls(calls), question: null };
}
