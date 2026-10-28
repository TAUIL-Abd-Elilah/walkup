/**
 * The "Claude alone" baseline (evals/llm-baseline/protocol.md), pure parts: no network, no file access.
 *
 * - `extractBill` reads one recorded live sheet into what the model is asked for: per numbered area with
 *   partners, the area's label, Walkup's partner search point and radius, and how many places of each type
 *   Walkup lists there.
 * - `buildPrompt` / `answerSchema` / `parseAnswer`: the fixed prompt, the JSON shape and how an answer is read.
 * - `namesMatch` / `pickMatch` / `checkPlace`: how a returned name is checked against Qloo /search results.
 * - `summarize` / `resultSentence`: the published counts and the sentence the protocol fixes for each outcome.
 */
import type { LedgerEntry, LiftTile, Partner, QlooEntity, StreetSheet, Weekday } from "@walkup/contracts";
import { chainSignals, clockHours, haversineM, hoursOnDay, isClosedEntity, type ChainIndex, type ChainList } from "@walkup/engine";
import { partnerAreaLabel } from "@walkup/exports/format";
import { nameTokens, tokenSetRatio } from "@walkup/narrator";

// ---------------------------------------------------------------------------
// Fixed settings (protocol section 2 and 4)
// ---------------------------------------------------------------------------

export const PROTOCOL_FILE = "evals/llm-baseline/protocol.md";

/** The four recorded live bills, in the order they are reported. */
export const BASELINE_PLANS = [
  { key: "giddens", planId: "1cfdc829-7814-4759-a624-9047a53994b7" },
  { key: "flo", planId: "afc936c1-21cf-4846-a21e-9f5d39c2a58a" },
  { key: "greensky", planId: "455629e6-ec44-4494-a69b-6154e4433c65" },
  { key: "roots", planId: "fe1ff2bc-9547-4b5c-a69c-f456769afde0" },
] as const;

export const MODEL_TEMPERATURE = 0;
export const MODEL_MAX_TOKENS = 2000;
/** One retry per area when the call fails or the answer is not the JSON shape. */
export const MAX_ATTEMPTS_PER_AREA = 2;
export const MAX_MODEL_CALLS = 40;
export const MAX_QLOO_CALLS = 400;

/** /search for one returned name: place results within this many miles of the area centre (Qloo's /search unit). */
export const SEARCH_RADIUS_MILES = 15;
export const SEARCH_TAKE = 10;
/** Token-set similarity a name pair needs (the overlap rule in packages/narrator/src/overlap.ts). */
export const NAME_MIN_SIMILARITY = 0.85;

/**
 * Words that cannot carry a match alone: when the only words two names share are from this list, they do not
 * match ("The Pub" is not "Irish Pub"). "the" is already dropped by `nameTokens`.
 */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "at",
  "bar",
  "barber",
  "barbershop",
  "bakery",
  "bistro",
  "books",
  "brewing",
  "cafe",
  "club",
  "co",
  "coffee",
  "company",
  "deli",
  "diner",
  "grill",
  "house",
  "inn",
  "kitchen",
  "lounge",
  "market",
  "of",
  "on",
  "pizza",
  "pub",
  "records",
  "restaurant",
  "room",
  "salon",
  "shop",
  "store",
  "tap",
  "tavern",
  "wine",
]);

/** Walkup's category keys as plain words for the prompt. */
export const TYPE_LABEL: Readonly<Record<string, string>> = {
  bakery: "bakery",
  bar: "bar",
  barber_shop: "barber shop",
  beauty_salon: "beauty salon",
  book_store: "bookstore",
  cafe: "cafe",
  clothing_store: "clothing store",
  cocktail_bar: "cocktail bar",
  lounge: "lounge",
  pool_hall: "pool hall",
  pub: "pub",
  restaurant: "restaurant",
  sports_bar: "sports bar",
  wine_bar: "wine bar",
};

export function typeLabel(key: string): string {
  return TYPE_LABEL[key] ?? key.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Inputs from a recorded sheet
// ---------------------------------------------------------------------------

export interface WalkupPick {
  name: string;
  entityId: string;
  category: string;
  chain: boolean;
  lat: number | null;
  lon: number | null;
  /** Metres from the area's search point. */
  distanceM: number | null;
  isClosed: boolean;
  /** Hours on the check day as Walkup's reader sees them. */
  dayStatus: "open" | "closed" | "unknown";
}

export interface AreaType {
  key: string;
  label: string;
  count: number;
}

export interface AreaAsk {
  /** 1-5, as numbered on the sheet. */
  area: number;
  geohash: string;
  label: string;
  /** Walkup's partner search point for this area. */
  lat: number;
  lon: number;
  /** Walkup's partner search radius here (the widened one when the search widened). */
  radiusM: number;
  types: AreaType[];
  asked: number;
  walkup: WalkupPick[];
}

export interface BillAsk {
  key: string;
  planId: string;
  acts: string[];
  headliner: string;
  venue: string;
  city: string;
  state: string;
  date: string;
  weekday: Weekday;
  streetTeamDays: Weekday[];
  /** The day hours are checked on: the first street-team day, as Walkup checks it. */
  checkDay: Weekday;
  areas: AreaAsk[];
}

const POINT_RE = /^POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/;
const PARTNER_TILE_NOTE_RE = /\bpartners, tile (\d+)\b/;

export interface PartnerSearch {
  lat: number;
  lon: number;
  radiusM: number;
}

/** Walkup's partner pool request per numbered area, from the sheet's ledger. A later (widened) request replaces an earlier one. */
export function partnerSearches(ledger: readonly LedgerEntry[]): Map<number, PartnerSearch> {
  const out = new Map<number, PartnerSearch>();
  for (const e of ledger) {
    const m = PARTNER_TILE_NOTE_RE.exec(e.note ?? "");
    if (!m) continue;
    const p = POINT_RE.exec(String(e.params["filter.location"] ?? "").trim());
    const r = Number(e.params["filter.location.radius"]);
    if (!p || !Number.isFinite(r)) continue;
    out.set(Number(m[1]), { lon: Number(p[1]), lat: Number(p[2]), radiusM: r });
  }
  return out;
}

const DAY_NAME: Readonly<Record<Weekday, string>> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export function dayName(d: Weekday): string {
  return DAY_NAME[d];
}

function dayStatus(e: QlooEntity, day: Weekday): "open" | "closed" | "unknown" {
  const h = hoursOnDay(e.properties?.hours, day);
  if (h.status === "closed") return "closed";
  return h.status === "open" && clockHours(h) !== null ? "open" : "unknown";
}

function located(e: QlooEntity): { lat: number; lon: number } | null {
  const l = e.location;
  return l && Number.isFinite(l.lat) && Number.isFinite(l.lon) ? { lat: l.lat, lon: l.lon } : null;
}

/** The ask for one recorded sheet. Throws when the sheet's partner areas cannot be tied to its ledger. */
export function extractBill(key: string, planId: string, sheet: StreetSheet): BillAsk {
  const searches = partnerSearches(sheet.ledger);
  const tiles = sheet.cards.liftMap.results.tiles;
  const tileMap = new Map<string, LiftTile>(tiles.map((t) => [t.geohash, t]));
  const partners: Partner[] = sheet.cards.partners.results;
  const streetTeamDays = [...(sheet.operator.streetTeamDays ?? [])];
  const checkDay = streetTeamDays[0] ?? sheet.bill.weekday;
  const areaOf = (geohash: string): { area: number; search: PartnerSearch } => {
    const t = tileMap.get(geohash);
    if (!t) throw new Error(`${key}: partner area ${geohash} is not on the lift map`);
    for (const [n, s] of searches) {
      if (Math.abs(s.lat - t.lat) < 1e-4 && Math.abs(s.lon - t.lon) < 1e-4) return { area: n, search: s };
    }
    throw new Error(`${key}: no partner search in the ledger for area ${geohash}`);
  };
  const byArea = new Map<string, AreaAsk>();
  for (const p of partners) {
    const g = p.tileGeohash;
    if (!g) throw new Error(`${key}: partner ${p.entity.name} has no area`);
    let a = byArea.get(g);
    if (!a) {
      const { area, search } = areaOf(g);
      a = { area, geohash: g, label: partnerAreaLabel(p, tileMap), lat: search.lat, lon: search.lon, radiusM: search.radiusM, types: [], asked: 0, walkup: [] };
      byArea.set(g, a);
    }
    const loc = located(p.entity);
    a.walkup.push({
      name: p.entity.name,
      entityId: p.entity.entityId,
      category: p.category,
      chain: p.chain === true,
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      distanceM: loc ? Math.round(haversineM({ lat: a.lat, lon: a.lon }, loc)) : null,
      isClosed: isClosedEntity(p.entity),
      dayStatus: dayStatus(p.entity, checkDay),
    });
    const ty = a.types.find((x) => x.key === p.category);
    if (ty) ty.count++;
    else a.types.push({ key: p.category, label: typeLabel(p.category), count: 1 });
    a.asked++;
  }
  const venue = sheet.bill.venue;
  const acts = sheet.bill.acts.map((x) => x.name);
  return {
    key,
    planId,
    acts,
    headliner: sheet.bill.acts.find((x) => x.role === "headliner")?.name ?? acts[0] ?? "",
    venue: venue.name,
    city: venue.city,
    state: venue.state ?? "",
    date: sheet.bill.date,
    weekday: sheet.bill.weekday,
    streetTeamDays,
    checkDay,
    areas: [...byArea.values()].sort((x, y) => x.area - y.area),
  };
}

// ---------------------------------------------------------------------------
// Prompt and answer (protocol section 3)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT =
  "You help a concert promoter plan a street team: people who visit local businesses in the weeks before a show " +
  "and ask to leave flyers or posters. You have no tools and no web access. Answer from what you know.";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Sunday, February 28, 2027" from "2027-02-28" and its weekday. */
export function longDate(iso: string, weekday: Weekday): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return `${dayName(weekday)}, ${iso}`;
  return `${dayName(weekday)}, ${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "2" for 2000 m, "3.5" for 3500 m. */
export function kmText(m: number): string {
  return String(Math.round(m / 100) / 10);
}

export function buildPrompt(bill: BillAsk, area: AreaAsk): { system: string; user: string } {
  const days = joinAnd(bill.streetTeamDays.map(dayName));
  const km = kmText(area.radiusM);
  const lines = [
    `Show: ${joinAnd(bill.acts)} at ${bill.venue}, ${bill.city}, ${bill.state}, on ${longDate(bill.date, bill.weekday)}.`,
    `The street team goes out on ${days} before the show.`,
    "",
    `Area: ${area.label}. Only places within ${km} km of latitude ${area.lat}, longitude ${area.lon}.`,
    "",
    `Name exactly ${area.asked} local businesses in this area where the team could ask to leave flyers: places this show's fans are likely to go, open on ${days}. No national chains. Give exactly this many of each type:`,
    ...area.types.map((t) => `- ${t.label}: ${t.count}`),
    "",
    'Answer with JSON only, in this shape: {"places": [{"name": "...", "type": "...", "address": "... or null", "reason": "one short line"}]}.',
    `"type" is one of: ${area.types.map((t) => t.label).join(", ")}. Real places only.`,
  ];
  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

/** The strict JSON schema sent as the response format. */
export function answerSchema(area: AreaAsk): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["places"],
    properties: {
      places: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "address", "reason"],
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: area.types.map((t) => t.label) },
            address: { anyOf: [{ type: "string" }, { type: "null" }] },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

export interface ReturnedPlace {
  name: string;
  type: string;
  address: string | null;
  reason: string;
}

export interface ParsedAnswer {
  /** Distinct non-empty names, in order, at most `asked`. */
  places: ReturnedPlace[];
  /** Items in the answer before trimming to `asked` and dropping blanks and repeats. */
  rawCount: number;
  /** Items dropped because the same name came earlier in the same answer. */
  repeatsInAnswer: number;
  /** Items past `asked`. */
  extra: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Reads the model's text; null when it is not the JSON shape (the area is retried once). */
export function parseAnswer(text: string, asked: number): ParsedAnswer | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let body: unknown;
  try {
    body = JSON.parse(t);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { places?: unknown }).places)) return null;
  const items = (body as { places: unknown[] }).places;
  const out: ReturnedPlace[] = [];
  const seen = new Set<string>();
  let repeats = 0;
  let extra = 0;
  for (const it of items) {
    const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
    const name = str(o.name);
    if (!name) continue;
    const k = nameTokens(name).join(" ") || name.toLowerCase();
    if (seen.has(k)) {
      repeats++;
      continue;
    }
    if (out.length >= asked) {
      extra++;
      continue;
    }
    seen.add(k);
    const address = str(o.address);
    out.push({ name, type: str(o.type), address: address || null, reason: str(o.reason) });
  }
  return { places: out, rawCount: items.length, repeatsInAnswer: repeats, extra };
}

/** The name without a trailing note in brackets ("Laurel Tap House (unverified)" -> "Laurel Tap House"). Exploratory only. */
export function stripNote(name: string): string {
  const s = name.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return s || name.trim();
}

// ---------------------------------------------------------------------------
// Checking one name (protocol section 4)
// ---------------------------------------------------------------------------

/** Normalised names match: token-set similarity >= 0.85, and the shared words are not all generic. */
export function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join(" ") === tb.join(" ")) return true;
  if (tokenSetRatio(a, b) < NAME_MIN_SIMILARITY) return false;
  const sb = new Set(tb);
  const shared = [...new Set(ta)].filter((t) => sb.has(t));
  return shared.some((t) => !GENERIC_WORDS.has(t));
}

export interface Match {
  entity: QlooEntity;
  distanceM: number | null;
}

/** The matching result nearest the area centre (a result without a location sorts last), or null. */
export function pickMatch(name: string, results: readonly QlooEntity[], centre: { lat: number; lon: number }): Match | null {
  let best: Match | null = null;
  for (const e of results) {
    if (!e || typeof e.name !== "string" || !namesMatch(name, e.name)) continue;
    const loc = located(e);
    const d = loc ? haversineM(centre, loc) : null;
    if (!best || (d !== null && (best.distanceM === null || d < best.distanceM))) best = { entity: e, distanceM: d };
  }
  return best;
}

export type Outcome = "usable" | "not_found" | "outside_area" | "closed" | "not_open" | "chain" | "repeat";

export interface NameCheck {
  area: number;
  name: string;
  type: string;
  reason: string;
  found: boolean;
  qlooName: string | null;
  entityId: string | null;
  distanceM: number | null;
  inArea: boolean;
  closed: boolean;
  dayStatus: "open" | "closed" | "unknown" | null;
  /** Hours on the other street-team days, recorded for reference only. */
  otherDays: Record<string, "open" | "closed" | "unknown">;
  chain: boolean;
  chainReason: string | null;
  repeat: boolean;
  onWalkupList: boolean;
  outcome: Outcome;
}

/**
 * Checks for one name. `chains` is chainSignals over every place this bill's searches returned inside their
 * searched area; `seenIds` holds the Qloo places already counted for this bill (a repeat is not usable twice).
 */
export function checkName(
  input: { area: AreaAsk; place: ReturnedPlace; match: Match | null; checkDay: Weekday; otherDays: readonly Weekday[] },
  chains: ReadonlyMap<string, { reason: string }>,
  walkupIds: ReadonlySet<string>,
  seenIds: Set<string>,
): NameCheck {
  const { area, place, match } = input;
  const e = match?.entity ?? null;
  const inArea = !!match && match.distanceM !== null && match.distanceM <= area.radiusM;
  const closed = !!e && inArea && isClosedEntity(e);
  const ds = e && inArea ? dayStatus(e, input.checkDay) : null;
  const other: Record<string, "open" | "closed" | "unknown"> = {};
  if (e && inArea) for (const d of input.otherDays) other[d] = dayStatus(e, d);
  const chain = !!e && inArea && chains.has(e.entityId);
  const repeat = !!e && seenIds.has(e.entityId);
  if (e) seenIds.add(e.entityId);
  const onWalkupList = (!!e && walkupIds.has(e.entityId)) || area.walkup.some((w) => namesMatch(place.name, w.name));
  let outcome: Outcome;
  if (!match) outcome = "not_found";
  else if (!inArea) outcome = "outside_area";
  else if (closed) outcome = "closed";
  else if (ds === "closed") outcome = "not_open";
  else if (chain) outcome = "chain";
  else if (repeat) outcome = "repeat";
  else outcome = "usable";
  return {
    area: area.area,
    name: place.name,
    type: place.type,
    reason: place.reason,
    found: !!match,
    qlooName: e?.name ?? null,
    entityId: e?.entityId ?? null,
    distanceM: match?.distanceM === null || match?.distanceM === undefined ? null : Math.round(match.distanceM),
    inArea,
    closed,
    dayStatus: ds,
    otherDays: other,
    chain,
    chainReason: e && chain ? (chains.get(e.entityId)?.reason ?? null) : null,
    repeat,
    onWalkupList,
    outcome,
  };
}

/** Places the chain rule looks at: every search result inside the area it was searched for, once each. */
export function chainPool(searched: ReadonlyArray<{ area: AreaAsk; results: readonly QlooEntity[] }>): QlooEntity[] {
  const out = new Map<string, QlooEntity>();
  for (const { area, results } of searched) {
    for (const e of results) {
      const loc = located(e);
      if (!loc || !e.entityId || out.has(e.entityId)) continue;
      if (haversineM({ lat: area.lat, lon: area.lon }, loc) <= area.radiusM) out.set(e.entityId, e);
    }
  }
  return [...out.values()];
}

/** Walkup's existing national-chain rule over a pool (hand-kept list, description, store-locator site, 3+ places). */
export function chainFlags(pool: readonly QlooEntity[], list: ChainList | ChainIndex): Map<string, { reason: string }> {
  const out = new Map<string, { reason: string }>();
  for (const [id, s] of chainSignals(pool, list)) out.set(id, { reason: s.reason });
  return out;
}

// ---------------------------------------------------------------------------
// Counts and the published sentence (protocol sections 5 and 6)
// ---------------------------------------------------------------------------

export interface Counts {
  asked: number;
  returned: number;
  foundInQloo: number;
  foundInArea: number;
  notFound: number;
  outsideArea: number;
  closed: number;
  notOpen: number;
  hoursNotListed: number;
  chain: number;
  repeat: number;
  usable: number;
  onWalkupList: number;
  /** First failing check per name, in the protocol's order. */
  byOutcome: Record<Outcome, number>;
}

export interface WalkupCounts {
  listed: number;
  /** Partners the sheet marks as national chains (Walkup's own rule, as run). */
  chains: number;
  /** listed - chains: Walkup's picks pass the area, closed and hours checks by construction. */
  usable: number;
  /** The same name search run on Walkup's own picks (calibration): found within 15 miles / inside the area. */
  calibrationFound: number | null;
  calibrationInArea: number | null;
}

export function emptyOutcomes(): Record<Outcome, number> {
  return { usable: 0, not_found: 0, outside_area: 0, closed: 0, not_open: 0, chain: 0, repeat: 0 };
}

export function countChecks(asked: number, checks: readonly NameCheck[]): Counts {
  const by = emptyOutcomes();
  for (const c of checks) by[c.outcome]++;
  const inArea = checks.filter((c) => c.inArea);
  return {
    asked,
    returned: checks.length,
    foundInQloo: checks.filter((c) => c.found).length,
    foundInArea: inArea.length,
    notFound: checks.filter((c) => !c.found).length,
    outsideArea: checks.filter((c) => c.found && !c.inArea).length,
    closed: inArea.filter((c) => c.closed).length,
    notOpen: inArea.filter((c) => c.dayStatus === "closed").length,
    hoursNotListed: inArea.filter((c) => c.dayStatus === "unknown").length,
    chain: inArea.filter((c) => c.chain).length,
    repeat: checks.filter((c) => c.repeat).length,
    usable: by.usable,
    onWalkupList: checks.filter((c) => c.onWalkupList).length,
    byOutcome: by,
  };
}

export function addCounts(a: Counts, b: Counts): Counts {
  const by = emptyOutcomes();
  for (const k of Object.keys(by) as Outcome[]) by[k] = a.byOutcome[k] + b.byOutcome[k];
  return {
    asked: a.asked + b.asked,
    returned: a.returned + b.returned,
    foundInQloo: a.foundInQloo + b.foundInQloo,
    foundInArea: a.foundInArea + b.foundInArea,
    notFound: a.notFound + b.notFound,
    outsideArea: a.outsideArea + b.outsideArea,
    closed: a.closed + b.closed,
    notOpen: a.notOpen + b.notOpen,
    hoursNotListed: a.hoursNotListed + b.hoursNotListed,
    chain: a.chain + b.chain,
    repeat: a.repeat + b.repeat,
    usable: a.usable + b.usable,
    onWalkupList: a.onWalkupList + b.onWalkupList,
    byOutcome: by,
  };
}

export function walkupCounts(bill: BillAsk, calibration?: { found: number; inArea: number }): WalkupCounts {
  const picks = bill.areas.flatMap((a) => a.walkup);
  const chains = picks.filter((p) => p.chain).length;
  return {
    listed: picks.length,
    chains,
    usable: picks.length - chains,
    calibrationFound: calibration?.found ?? null,
    calibrationInArea: calibration?.inArea ?? null,
  };
}

/** The miss reasons in the protocol's order, as published. */
export const MISS_LABEL: Readonly<Record<Exclude<Outcome, "usable">, string>> = {
  not_found: "not found in Qloo",
  outside_area: "found in Qloo, but outside the area",
  closed: "marked closed in Qloo",
  not_open: "closed on the street-team day",
  chain: "a national chain",
  repeat: "a repeat of an earlier name",
};

const MISS_ORDER: readonly Exclude<Outcome, "usable">[] = ["not_found", "outside_area", "closed", "not_open", "chain", "repeat"];

/** The most common first-failing check, or null when every name passed. Ties go to the earlier check. */
export function topMiss(c: Counts): { outcome: Exclude<Outcome, "usable">; count: number } | null {
  let best: { outcome: Exclude<Outcome, "usable">; count: number } | null = null;
  for (const o of MISS_ORDER) {
    const n = c.byOutcome[o];
    if (n > 0 && (!best || n > best.count)) best = { outcome: o, count: n };
  }
  return best;
}

function names(n: number): string {
  return n === 1 ? "1 name" : `${n.toLocaleString("en-US")} names`;
}

/**
 * The result in the protocol's fixed words (section 6). `day` is the street-team day hours were checked on.
 * Numbers are filled in; nothing else changes with the outcome except the comparison clause and the miss line.
 */
export function resultSentences(claude: Counts, walkup: WalkupCounts, day: string): string[] {
  const out: string[] = [];
  out.push(
    `Asked for the same ${claude.asked} places in the same areas, Claude alone named ${claude.usable} that Qloo finds in the area, ` +
      `not marked closed, not closed on ${day} and not a national chain. Walkup's list has ${walkup.usable} of ${walkup.listed}.`,
  );
  if (claude.usable > walkup.usable) out.push("On this check, Claude alone did better than Walkup.");
  else if (claude.usable === walkup.usable) out.push("On this check, Claude alone did as well as Walkup.");
  else out.push("On this check, Claude alone did worse than Walkup.");
  const miss = topMiss(claude);
  out.push(miss ? `The most common miss: ${MISS_LABEL[miss.outcome]} (${names(miss.count)} of ${claude.returned}).` : "Every name passed.");
  out.push(`${claude.onWalkupList} of Claude's ${claude.returned} names are also on Walkup's list.`);
  if (walkup.calibrationInArea !== null) {
    out.push(
      `The same name search found ${walkup.calibrationInArea} of Walkup's ${walkup.listed} picks in their areas, so a name it misses ` +
        "is not proof that the place does not exist.",
    );
  }
  return out;
}

/** What the comparison shows and does not show (fixed, protocol section 7). */
export const SHOWS =
  "whether a model with no tools, asked for the same number and kinds of places in the same areas, names places Qloo can find there, not marked closed, open on the street-team day and not national chains.";
export const DOES_NOT_SHOW =
  "which list sells more tickets, or that a name Qloo does not find does not exist. Walkup's own picks pass the area, closed and hours checks by construction: they come from the same Qloo place data.";
